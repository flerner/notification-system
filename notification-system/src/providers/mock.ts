import { ProviderError, type ChannelProvider, type DeliveryRequest } from "./provider.js";

export interface MockOptions {
  latencyMs: number;
  failureRate: number;
}

export class MockProvider implements ChannelProvider {
  private readonly delivered = new Set<string>();
  deliveries = 0;
  suppressed = 0;

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
