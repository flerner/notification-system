import { CircuitBreaker, type BreakerOptions } from "./circuit-breaker.js";
import { GuardedProvider } from "./guarded.js";
import { MockProvider } from "./mock.js";
import type { ChannelProvider } from "./provider.js";

export interface ProvidersOptions {
  latencyMs: number;
  failureRate: number;
  timeoutMs: number;
  breaker: BreakerOptions;
}

// Which provider serves which queue, each with its own circuit breaker (one provider being down
// must not stop the others). To use a real service, replace the entry with a class that
// implements ChannelProvider; nothing else changes.
export function buildProviders(opts: ProvidersOptions): Record<string, GuardedProvider> {
  const mock = (name: string): ChannelProvider => new MockProvider(name, opts);
  const guard = (provider: ChannelProvider) => new GuardedProvider(provider, new CircuitBreaker(opts.breaker), opts.timeoutMs);
  return {
    "push.ios": guard(mock("mock-apns")),
    "push.android": guard(mock("mock-fcm")),
    "push.web": guard(mock("mock-webpush")),
    sms: guard(mock("mock-sms")),
    email: guard(mock("mock-email")),
  };
}
