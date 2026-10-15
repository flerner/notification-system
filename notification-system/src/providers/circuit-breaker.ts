export interface BreakerOptions {
  failureThreshold: number;
  cooldownMs: number;
}

// Stops us hammering a provider that is down, and stops notifications burning their retry attempts
// against it. closed: normal. open: do not call (for cooldownMs). half_open: the cooldown passed;
// calls are allowed again as a trial: one success closes the circuit, one failure re-opens it.
// (Several trial calls can overlap, which is fine: concurrency is already capped by prefetch.)
export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | null = null;

  constructor(
    private readonly opts: BreakerOptions,
    private readonly now: () => number = Date.now,
  ) {}

  get state(): "closed" | "open" | "half_open" {
    if (this.openedAt === null) return "closed";
    return this.now() - this.openedAt < this.opts.cooldownMs ? "open" : "half_open";
  }

  isOpen(): boolean {
    return this.state === "open";
  }

  retryAfterMs(): number {
    return this.isOpen() ? this.opts.cooldownMs - (this.now() - this.openedAt!) : 0;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.openedAt = null;
  }

  recordFailure(): void {
    const state = this.state;
    if (state === "open") return;
    if (state === "half_open") {
      this.openedAt = this.now();
      return;
    }
    if (++this.failures >= this.opts.failureThreshold) this.openedAt = this.now();
  }
}
