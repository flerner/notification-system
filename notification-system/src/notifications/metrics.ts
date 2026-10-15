import { Counter, Histogram, Registry } from "prom-client";

export class NotificationMetrics {
  private readonly acceptedTotal: Counter<"channel">;
  private readonly deduplicatedTotal: Counter<"layer">;
  private readonly sentTotal: Counter<"channel">;
  private readonly failedTotal: Counter<"channel" | "reason">;
  private readonly skippedTotal: Counter<"channel" | "reason">;
  private readonly retriesTotal: Counter<"channel">;
  private readonly circuitHeldTotal: Counter<"queue">;
  private readonly redisErrorsTotal: Counter<"component">;
  private readonly templateCacheTotal: Counter<"result">;
  private readonly providerCallSeconds: Histogram<"channel" | "provider" | "outcome">;
  private readonly endToEndSeconds: Histogram<"channel">;

  constructor(registry: Registry = new Registry()) {
    const registers = [registry];
    this.acceptedTotal = new Counter({
      name: "notifications_accepted_total",
      help: "Notifications stored and queued by the API (one per destination).",
      labelNames: ["channel"],
      registers,
    });
    this.deduplicatedTotal = new Counter({
      name: "notifications_deduplicated_total",
      help: "Repeats recognised and not processed again. layer=request: a retried API call (same Idempotency-Key). layer=claim: a duplicate queue message for a notification already handled.",
      labelNames: ["layer"],
      registers,
    });
    this.sentTotal = new Counter({
      name: "notifications_sent_total",
      help: "Notifications delivered to the provider.",
      labelNames: ["channel"],
      registers,
    });
    this.failedTotal = new Counter({
      name: "notifications_failed_total",
      help: "Notifications given up on. reason=permanent: the provider refused it for good. reason=exhausted: every attempt failed.",
      labelNames: ["channel", "reason"],
      registers,
    });
    this.skippedTotal = new Counter({
      name: "notifications_skipped_total",
      help: "Notifications deliberately not sent. reason=opt_out or rate_limit.",
      labelNames: ["channel", "reason"],
      registers,
    });
    this.retriesTotal = new Counter({
      name: "notification_retries_total",
      help: "Failed attempts that were scheduled for another try.",
      labelNames: ["channel"],
      registers,
    });
    this.circuitHeldTotal = new Counter({
      name: "notification_circuit_held_total",
      help: "Messages put back because their provider's circuit breaker was open.",
      labelNames: ["queue"],
      registers,
    });
    this.redisErrorsTotal = new Counter({
      name: "redis_errors_total",
      help: "Redis calls that failed and were absorbed (cache read as a miss, rate limiter let the notification through).",
      labelNames: ["component"],
      registers,
    });
    this.templateCacheTotal = new Counter({
      name: "template_cache_lookups_total",
      help: "Template lookups by result (hit or miss).",
      labelNames: ["result"],
      registers,
    });
    this.providerCallSeconds = new Histogram({
      name: "provider_call_duration_seconds",
      help: "How long calls to the delivery provider take, by outcome.",
      labelNames: ["channel", "provider", "outcome"],
      buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers,
    });
    this.endToEndSeconds = new Histogram({
      name: "notification_end_to_end_seconds",
      help: "Time from the API accepting a notification to the provider accepting it. Includes queueing and retry waits.",
      labelNames: ["channel"],
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300],
      registers,
    });
  }

  accepted(channel: string, count: number): void {
    this.acceptedTotal.inc({ channel }, count);
  }
  replayed(): void {
    this.deduplicatedTotal.inc({ layer: "request" });
  }
  duplicateDropped(): void {
    this.deduplicatedTotal.inc({ layer: "claim" });
  }
  sent(channel: string, endToEndSeconds: number): void {
    this.sentTotal.inc({ channel });
    this.endToEndSeconds.observe({ channel }, endToEndSeconds);
  }
  failed(channel: string, reason: "permanent" | "exhausted"): void {
    this.failedTotal.inc({ channel, reason });
  }
  skipped(channel: string, reason: "opt_out" | "rate_limit"): void {
    this.skippedTotal.inc({ channel, reason });
  }
  retryScheduled(channel: string): void {
    this.retriesTotal.inc({ channel });
  }
  circuitHeld(queue: string): void {
    this.circuitHeldTotal.inc({ queue });
  }
  redisError(component: "template_cache" | "rate_limiter"): void {
    this.redisErrorsTotal.inc({ component });
  }
  templateCache(result: "hit" | "miss"): void {
    this.templateCacheTotal.inc({ result });
  }
  providerCall(channel: string, provider: string, outcome: "ok" | "error", seconds: number): void {
    this.providerCallSeconds.observe({ channel, provider, outcome }, seconds);
  }
}
