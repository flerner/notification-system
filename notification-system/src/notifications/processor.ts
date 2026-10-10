import type { Logger } from "pino";
import type { ChannelProvider } from "../providers/provider.js";
import type { NotificationRepository } from "./repository.js";

// Handles one queue message: load the notification, hand it to the provider for its queue,
// record the outcome. A provider failure is an expected outcome and is recorded; only
// infrastructure errors (e.g. the database is down) are thrown, so the consumer can leave the
// message on the queue.
//
// Known gaps, on purpose, until later milestones:
//  - M5: a message delivered twice is sent twice (no atomic claim / idempotency yet).
//  - M6: a provider failure is final (FAILED); there is no retry yet.
export class NotificationProcessor {
  constructor(
    private readonly notifications: NotificationRepository,
    private readonly providers: Record<string, ChannelProvider>,
    private readonly log: Logger,
  ) {}

  async process(notificationId: string): Promise<void> {
    const n = await this.notifications.findById(notificationId);
    if (!n) {
      // Rows are stored before they are queued, so this should not happen.
      this.log.warn({ notificationId }, "queued notification not found, dropping");
      return;
    }
    const provider = this.providers[n.queue];
    if (!provider) throw new Error(`no provider configured for queue ${n.queue}`);

    const started = Date.now();
    try {
      await provider.send({ notificationId: n.id, destination: n.destination, payload: n.payload });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.notifications.markFailed(n.id, message);
      this.log.warn({ notificationId, queue: n.queue, provider: provider.name, err: message }, "delivery failed");
      return;
    }
    await this.notifications.markSent(n.id);
    this.log.info({ notificationId, queue: n.queue, provider: provider.name, ms: Date.now() - started }, "notification sent");
  }
}
