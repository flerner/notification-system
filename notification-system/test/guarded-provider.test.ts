import { beforeEach, describe, expect, it } from "vitest";
import { CircuitBreaker } from "../src/providers/circuit-breaker.js";
import { GuardedProvider } from "../src/providers/guarded.js";
import { ProviderError, type ChannelProvider, type DeliveryRequest } from "../src/providers/provider.js";

const req: DeliveryRequest = { notificationId: "n", idempotencyKey: "n", destination: "d", payload: { body: "b" } };

let breaker: CircuitBreaker;
const guard = (send: ChannelProvider["send"], timeoutMs = 1000) =>
  new GuardedProvider({ name: "p", send }, breaker, timeoutMs);

beforeEach(() => {
  breaker = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 60_000 });
});

describe("GuardedProvider", () => {
  it("passes a successful send through", async () => {
    await expect(guard(async () => {}).send(req)).resolves.toBeUndefined();
    expect(breaker.state).toBe("closed");
  });

  it("rethrows a permanent error as it is, and does not count it against the provider's health", async () => {
    const g = guard(async () => {
      throw new ProviderError("bad token", false);
    });
    for (let i = 0; i < 5; i++) {
      const err = await g.send(req).catch((e) => e);
      expect(err).toMatchObject({ message: "bad token", retryable: false });
    }
    expect(g.isOpen()).toBe(false);
  });

  it("counts retryable errors and opens the circuit at the threshold", async () => {
    const g = guard(async () => {
      throw new ProviderError("503", true);
    });
    await g.send(req).catch(() => {});
    expect(g.isOpen()).toBe(false);
    await g.send(req).catch(() => {});
    expect(g.isOpen()).toBe(true);
    expect(g.retryAfterMs()).toBeGreaterThan(0);
  });

  it("turns an unexpected error into a retryable ProviderError", async () => {
    const g = guard(async () => {
      throw new Error("ECONNRESET");
    });
    const err = await g.send(req).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ retryable: true });
    expect(err.message).toContain("ECONNRESET");
  });

  it("gives up on a call that takes too long and reports it as retryable", async () => {
    const g = guard(() => new Promise<void>(() => {}), 30); // never answers
    const err = await g.send(req).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ retryable: true });
    expect(err.message).toContain("timed out");
    expect(breaker.state).toBe("closed"); // one failure so far, threshold is 2
  });

  it("a success after failures resets the count", async () => {
    let fail = true;
    const g = guard(async () => {
      if (fail) throw new ProviderError("503", true);
    });
    await g.send(req).catch(() => {});
    fail = false;
    await g.send(req);
    fail = true;
    await g.send(req).catch(() => {});
    expect(g.isOpen()).toBe(false); // failures are not consecutive
  });
});
