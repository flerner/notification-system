import { ProviderError, type ChannelProvider, type DeliveryRequest } from "./provider.js";

export interface MockOptions {
  latencyMs: number;
  failureRate: number; // 0 = never fails, 1 = always fails
}

// Stand-in for a real provider so the project runs with no credentials. Latency and failures
// are configurable, which lets us demonstrate slow providers, retries and dashboards.
// A destination containing "invalid" always fails permanently, like a bad device token would.
// `random` and `sleep` are injectable so tests are instant and deterministic.
//
// Like a provider with idempotency support, it delivers a given idempotencyKey only once:
// repeating a send for a key it already delivered succeeds without delivering again.
// (The memory of keys is unbounded here; real providers expire them after a while.)
export class MockProvider implements ChannelProvider {
  private readonly delivered = new Set<string>();
  deliveries = 0; // how many messages really "went out"
  suppressed = 0; // repeated sends ignored thanks to the key

  constructor(
    readonly name: string,
    private readonly opts: MockOptions,
    private readonly random: () => number = Math.random,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  async send(req: DeliveryRequest): Promise<void> {
    await this.sleep(this.opts.latencyMs);
    if (this.delivered.has(req.idempotencyKey)) {
      this.suppressed++;
      return;
    }
    if (req.destination.includes("invalid")) {
      throw new ProviderError(`${this.name}: invalid destination`, false);
    }
    if (this.random() < this.opts.failureRate) {
      throw new ProviderError(`${this.name}: simulated provider failure`, true);
    }
    this.delivered.add(req.idempotencyKey);
    this.deliveries++;
  }
}
