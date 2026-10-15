import { TimeoutError, withTimeout } from "../infra/timeout.js";
import type { CircuitBreaker } from "./circuit-breaker.js";
import { ProviderError, type ChannelProvider, type DeliveryRequest } from "./provider.js";

export class GuardedProvider {
  constructor(
    private readonly provider: ChannelProvider,
    private readonly breaker: CircuitBreaker,
    private readonly timeoutMs: number,
  ) {}

  get name(): string {
    return this.provider.name;
  }

  get state(): "closed" | "open" | "half_open" {
    return this.breaker.state;
  }

  isOpen(): boolean {
    return this.breaker.isOpen();
  }

  retryAfterMs(): number {
    return this.breaker.retryAfterMs();
  }

  async send(req: DeliveryRequest): Promise<void> {
    try {
      await withTimeout(this.provider.send(req), this.timeoutMs);
    } catch (err) {
      if (err instanceof ProviderError && !err.retryable) {
        this.breaker.recordSuccess();
        throw err;
      }
      this.breaker.recordFailure();
      if (err instanceof ProviderError) throw err;
      const reason = err instanceof TimeoutError ? `${this.name} ${err.message}` : `${this.name}: ${String((err as Error)?.message ?? err)}`;
      throw new ProviderError(reason, true);
    }
    this.breaker.recordSuccess();
  }
}
