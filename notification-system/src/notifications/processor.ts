import type { Logger } from "pino";
import type { ChannelProvider } from "../providers/provider.js";
import type { NotificationRepository } from "./repository.js";

// "done": nothing more to do with this message, acknowledge it.
// "busy": another worker holds the notification; try the message again later.
export type ProcessResult = "done" | "busy";

// Handles one queue message. Messages are delivered AT LEAST once (a crash before the ack makes
// the broker redeliver; the relay may publish twice), so this must be safe to run repeatedly
// for the same notification:
//
//  1. claim() atomically takes the notification for a lease. Of several workers handling
//     duplicates of the same message, exactly one wins; the others get "busy" or "done".
//  2. If the winner crashes, its lease expires and a later redelivery claims the row again.
//     That may send twice (the first attempt could have gone out before the crash). We accept
//     a possible duplicate over a certain loss.
//  3. The provider gets the notification id as idempotency key, so providers that honour it
//     drop the repeated send.
//
// A provider failure is an expected outcome and is recorded; only infrastructure errors (e.g.
// the database is down) are thrown, so the consumer can leave the message on the queue.
// Until M6 a provider failure is final (FAILED); there is no retry yet.
export class NotificationProcessor {
  constructor(
    private readonly notifications: NotificationRepository,
    private readonly providers: Record<string, ChannelProvider>,
    private readonly log: Logger,
    // Must be longer than the slowest provider call, or a healthy worker loses its claim.
    private readonly leaseMs: number,
  ) {}

  async process(notificationId: string): Promise<ProcessResult> {
    const claim = await this.notifications.claim(notificationId, this.leaseMs);
    switch (claim.outcome) {
      case "missing":
        // Rows are stored before they are queued, so this should not happen.
        this.log.warn({ notificationId }, "queued notification not found, dropping");
        return "done";
      case "done":
        this.log.info({ notificationId }, "already handled, skipping duplicate message");
        return "done";
      case "busy":
        return "busy";
    }

    const n = claim.notification;
    const provider = this.providers[n.queue];
    if (!provider) throw new Error(`no provider configured for queue ${n.queue}`);

    const started = Date.now();
    try {
      await provider.send({
        notificationId: n.id,
        idempotencyKey: n.id,
        destination: n.destination,
        payload: n.payload,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.notifications.markFailed(n.id, message);
      this.log.warn({ notificationId, queue: n.queue, provider: provider.name, err: message }, "delivery failed");
      return "done";
    }
    const recorded = await this.notifications.markSent(n.id);
    this.log.info(
      { notificationId, queue: n.queue, provider: provider.name, attempt: n.attempts, ms: Date.now() - started, recorded },
      "notification sent",
    );
    return "done";
  }
}
