import { TimeoutError, withTimeout } from "../infra/timeout.js";
import type { CircuitBreaker } from "./circuit-breaker.js";
import { ProviderError, type ChannelProvider, type DeliveryRequest } from "./provider.js";

// A provider plus the protections every call needs: a timeout, a circuit breaker, and errors
// normalised to ProviderError so the processor only ever has to ask `retryable`.
export class GuardedProvider {
  constructor(
    private readonly provider: ChannelProvider,
    private readonly breaker: CircuitBreaker,
    private readonly timeoutMs: number,
  ) {}

  get name(): string {
    return this.provider.name;
  }

  // True while the provider is considered down: the caller should not even try.
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
        // The provider answered, it just refused this notification: it is healthy.
        this.breaker.recordSuccess();
        throw err;
      }
      this.breaker.recordFailure();
      if (err instanceof ProviderError) throw err;
      // Timeouts and anything unexpected: assume temporary. The attempt limit bounds the retries.
      const reason = err instanceof TimeoutError ? `${this.name} ${err.message}` : `${this.name}: ${String((err as Error)?.message ?? err)}`;
      throw new ProviderError(reason, true);
    }
    this.breaker.recordSuccess();
  }
}
