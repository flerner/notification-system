import type { Logger } from "pino";
import type { NotificationService } from "./service.js";

// Publishes everything that is due, in batches. One batch is at most `batchSize` notifications, so
// when many are due at once (a thousand scheduled for the same minute) it keeps going instead of
// leaving most of them for later ticks. It stops at the first batch that is not full: nothing more
// is due right now, or the broker refused some and a retry would only fail again.
// `maxBatches` is a safety limit so one tick cannot run for ever.
export async function drainRelay(
  service: Pick<NotificationService, "relayUnpublished">,
  minAgeMs: number,
  batchSize = 100,
  maxBatches = 50,
): Promise<number> {
  let total = 0;
  for (let i = 0; i < maxBatches; i++) {
    const published = await service.relayUnpublished(minAgeMs, batchSize);
    total += published;
    if (published < batchSize) break;
  }
  return total;
}

export function startRelay(
  service: NotificationService,
  opts: { intervalMs: number; minAgeMs: number },
  log: Logger,
): () => void {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const n = await drainRelay(service, opts.minAgeMs);
      if (n > 0) log.info({ count: n }, "relay published due or stuck notifications");
    } catch (err) {
      log.error({ err }, "relay run failed");
    } finally {
      running = false;
    }
  }, opts.intervalMs);
  return () => clearInterval(timer);
}
