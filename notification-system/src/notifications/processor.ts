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
export class NotificationProcessor {
  constructor(
    private readonly notifications: NotificationRepository,
    private readonly settings: SettingsRepository,
    private readonly limiter: RateLimiter,
    private readonly providers: Record<string, GuardedProvider>,
    private readonly publisher: MessagePublisher,
    private readonly policy: RetryPolicy,
    private readonly log: Logger,
    private readonly leaseMs: number,
    private readonly metrics: NotificationMetrics = new NotificationMetrics(),
  ) {}

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
      this.metrics.providerCall(
        n.channel,
        provider.name,
        "error",
        (Date.now() - started) / 1000,
      );
      return this.handleFailure(n, provider.name, err as ProviderError);
    }
    this.metrics.providerCall(
      n.channel,
      provider.name,
      "ok",
      (Date.now() - started) / 1000,
    );
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

    //if we have no more retries (delay is undefined), give up, otherwise park the notif in corresponding rety queue.
    const delay = this.policy.delayAfter(n.attempts);
    if (delay === undefined) return this.giveUp(n, err.message, "exhausted");

    const parked = await this.notifications.markRetrying(n.id, err.message);
    if (!parked) return "done";
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
      this.log.error(
        { err, notificationId: n.id },
        "could not publish to the dead-letter queue",
      );
    }
    return "done";
  }
}
