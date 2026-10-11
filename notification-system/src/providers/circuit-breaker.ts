export interface BreakerOptions {
  // Consecutive transient failures that open the circuit.
  failureThreshold: number;
  // How long it stays open before calls are allowed again.
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

  // How long until calls are allowed again (0 when they already are).
  retryAfterMs(): number {
    return this.isOpen() ? this.opts.cooldownMs - (this.now() - this.openedAt!) : 0;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.openedAt = null;
  }

  recordFailure(): void {
    const state = this.state;
    if (state === "open") return; // a call that was already in flight when it opened
    if (state === "half_open") {
      this.openedAt = this.now(); // the trial failed: back to open
      return;
    }
    if (++this.failures >= this.opts.failureThreshold) this.openedAt = this.now();
  }
}
