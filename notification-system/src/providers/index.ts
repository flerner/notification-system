import { MockProvider, type MockOptions } from "./mock.js";
import type { ChannelProvider } from "./provider.js";

// Which provider serves which queue. To use a real service, replace the entry with a class that
// implements ChannelProvider; nothing else changes.
export function buildProviders(opts: MockOptions): Record<string, ChannelProvider> {
  return {
    "push.ios": new MockProvider("mock-apns", opts),
    "push.android": new MockProvider("mock-fcm", opts),
    "push.web": new MockProvider("mock-webpush", opts),
    sms: new MockProvider("mock-sms", opts),
    email: new MockProvider("mock-email", opts),
  };
}
