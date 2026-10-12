import type { Logger } from "pino";
import type { MessagePublisher } from "../infra/rabbit.js";
import { ProviderError } from "../providers/provider.js";
import type { GuardedProvider } from "../providers/guarded.js";
import { DEAD_LETTER_QUEUE, retryQueueName } from "./queues.js";
import type { Notification, NotificationRepository } from "./repository.js";
import { NotificationMetrics } from "./metrics.js";
import type { RateLimiter } from "./rate-limit.js";
import type { SettingsRepository } from "./settings.js";
import type { RetryPolicy } from "./retry.js";

// "done":         nothing more to do with this message, acknowledge it.
// "busy":         another worker holds the notification; try the message again soon.
// "circuit_open": the provider is considered down; try the message again after a longer pause.
export type ProcessResult = "done" | "busy" | "circuit_open";

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
// Before sending, a user who has opted out of the channel is skipped (SKIPPED_OPT_OUT, final), and
// so is one who has already received their limit for the channel (SKIPPED_RATE_LIMITED, final).
//
// When delivery fails (a ProviderError, see GuardedProvider):
//  - permanent error            -> FAILED now, nothing to retry.
//  - retryable, attempts left   -> RETRYING, and the message goes to a retry queue that hands it
//                                  back to the main queue after the backoff delay.
//  - retryable, no attempts left-> FAILED.
// FAILED rows are also announced on the dead-letter queue (best effort: the row is the truth).
//
// Only infrastructure errors (the database or broker is down) are thrown, so the consumer can
// leave the message on the queue.
export class NotificationProcessor {
  constructor(
    private readonly notifications: NotificationRepository,
    private readonly settings: SettingsRepository,
    private readonly limiter: RateLimiter,
    private readonly providers: Record<string, GuardedProvider>,
    private readonly publisher: MessagePublisher,
    private readonly policy: RetryPolicy,
    private readonly log: Logger,
    // Must be longer than the slowest provider call (the provider timeout), or a healthy worker
    // loses its claim.
    private readonly leaseMs: number,
    private readonly metrics: NotificationMetrics = new NotificationMetrics(),
  ) {}

  // `queue` is the queue this message came from; it tells us which provider is needed before we
  // have loaded the notification.
  async process(notificationId: string, queue: string): Promise<ProcessResult> {
    const provider = this.providers[queue];
    if (!provider) throw new Error(`no provider configured for queue ${queue}`);

    // Before claiming: a notification must not use up an attempt against a provider that is down.
    if (provider.isOpen()) {
      this.metrics.circuitHeld(queue);
      return "circuit_open";
    }

    const claim = await this.notifications.claim(notificationId, this.leaseMs);
    switch (claim.outcome) {
      case "missing":
        // Rows are stored before they are queued, so this should not happen.
        this.log.warn(
          { notificationId },
          "queued notification not found, dropping",
        );
        return "done";
      case "done":
        this.log.info(
          { notificationId },
          "already handled, skipping duplicate message",
        );
        this.metrics.duplicateDropped();
        return "done";
      case "busy":
        return "busy";
    }

    const n = claim.notification;

    // Checked here, at the last moment before sending, and not when the request was accepted: the
    // notification may have waited in a queue (or a retry queue) while the user opted out. Every
    // attempt checks again.
    if (!(await this.settings.isOptedIn(n.userId, n.channel))) {
      await this.notifications.markSkipped(
        n.id,
        "SKIPPED_OPT_OUT",
        `user ${n.userId} opted out of ${n.channel}`,
      );
      this.log.info(
        {
          notificationId,
          userId: n.userId,
          channel: n.channel,
          reason: "opt_out",
        },
        "notification skipped",
      );
      this.metrics.skipped(n.channel, "opt_out");
      return "done";
    }

    //only attempt 1 because retries are not counted against the rate limit
    if (n.attempts === 1 && !(await this.limiter.allow(n.userId, n.channel))) {
      const { max, windowSeconds } = this.limiter.limitFor(n.channel);
      await this.notifications.markSkipped(
        n.id,
        "SKIPPED_RATE_LIMITED",
        `rate limit reached for user ${n.userId}: ${max} ${n.channel} per ${windowSeconds}s`,
      );
      this.log.info(
        {
          notificationId,
          userId: n.userId,
          channel: n.channel,
          reason: "rate_limit",
        },
        "notification skipped",
      );
      this.metrics.skipped(n.channel, "rate_limit");
      return "done";
    }

    const started = Date.now();
    try {
      await provider.send({
        notificationId: n.id,
        idempotencyKey: n.id,
        destination: n.destination,
        payload: n.payload,
      });
    } catch (err) {
      this.metrics.providerCall(n.channel, provider.name, "error", (Date.now() - started) / 1000);
      return this.handleFailure(n, provider.name, err as ProviderError);
    }
    this.metrics.providerCall(n.channel, provider.name, "ok", (Date.now() - started) / 1000);
    const recorded = await this.notifications.markSent(n.id);
    this.metrics.sent(n.channel, (Date.now() - n.createdAt.getTime()) / 1000);
    this.log.info(
      {
        notificationId,
        queue: n.queue,
        provider: provider.name,
        attempt: n.attempts,
        ms: Date.now() - started,
        recorded,
      },
      "notification sent",
    );
    return "done";
  }

  private async handleFailure(
    n: Notification,
    providerName: string,
    err: ProviderError,
  ): Promise<ProcessResult> {
    if (!err.retryable) return this.giveUp(n, err.message, "permanent");

    const delay = this.policy.delayAfter(n.attempts);
    if (delay === undefined) return this.giveUp(n, err.message, "exhausted");

    // Row first, message second: the row says RETRYING even if the publish below fails. In that
    // case the error propagates, the original message goes back on the queue, and a worker claims
    // the notification again (sooner than the backoff, which is acceptable).
    const parked = await this.notifications.markRetrying(n.id, err.message);
    if (!parked) return "done"; // someone else finished or took it over meanwhile
    await this.publisher.publish(retryQueueName(n.queue, delay), {
      notificationId: n.id,
    });
    this.metrics.retryScheduled(n.channel);
    this.log.warn(
      {
        notificationId: n.id,
        queue: n.queue,
        provider: providerName,
        attempt: n.attempts,
        retryInMs: delay,
        err: err.message,
      },
      "delivery failed, will retry",
    );
    return "done";
  }

  private async giveUp(
    n: Notification,
    error: string,
    reason: "permanent" | "exhausted",
  ): Promise<ProcessResult> {
    await this.notifications.markFailed(n.id, error);
    this.metrics.failed(n.channel, reason);
    // An alert-level log: M10 turns these (and the dead-letter queue depth) into a Grafana alert.
    this.log.error(
      {
        event: "notification_failed",
        notificationId: n.id,
        queue: n.queue,
        attempts: n.attempts,
        reason,
        err: error,
      },
      "notification failed for good",
    );
    try {
      await this.publisher.publish(DEAD_LETTER_QUEUE, {
        notificationId: n.id,
        queue: n.queue,
        reason,
        error,
        attempts: n.attempts,
      });
    } catch (err) {
      // The row already says FAILED; failing to announce it must not make the worker redo the send.
      this.log.error(
        { err, notificationId: n.id },
        "could not publish to the dead-letter queue",
      );
    }
    return "done";
  }
}
