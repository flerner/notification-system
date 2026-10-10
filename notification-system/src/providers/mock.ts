import type { ChannelProvider, DeliveryRequest } from "./provider.js";

export interface MockOptions {
  latencyMs: number;
  failureRate: number; // 0 = never fails, 1 = always fails
}

// Stand-in for a real provider so the project runs with no credentials. Latency and failures
// are configurable, which lets us demonstrate slow providers, retries and dashboards.
// `random` and `sleep` are injectable so tests are instant and deterministic.
export class MockProvider implements ChannelProvider {
  constructor(
    readonly name: string,
    private readonly opts: MockOptions,
    private readonly random: () => number = Math.random,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  async send(_req: DeliveryRequest): Promise<void> {
    await this.sleep(this.opts.latencyMs);
    if (this.random() < this.opts.failureRate) {
      throw new Error(`${this.name}: simulated provider failure`);
    }
  }
}
