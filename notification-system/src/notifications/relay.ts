import type { Logger } from "pino";
import type { NotificationService } from "./service.js";

// Runs relayUnpublished() on a timer. The `running` flag stops a slow run from overlapping
// with the next tick. Returns a function that stops the timer (used on shutdown).
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
      const n = await service.relayUnpublished(opts.minAgeMs);
      if (n > 0) log.info({ count: n }, "relay published stuck notifications");
    } catch (err) {
      log.error({ err }, "relay run failed");
    } finally {
      running = false;
    }
  }, opts.intervalMs);
  return () => clearInterval(timer);
}
