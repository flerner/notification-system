import { describe, expect, it } from "vitest";
import { MockProvider } from "../src/providers/mock.js";
import { ProviderError } from "../src/providers/provider.js";

const req = { notificationId: "n", idempotencyKey: "k", destination: "d", payload: { body: "b" } };
const noSleep = async () => {};

describe("MockProvider", () => {
  it("succeeds when the random draw is above the failure rate", async () => {
    const p = new MockProvider("m", { latencyMs: 0, failureRate: 0.3 }, () => 0.9, noSleep);
    await expect(p.send(req)).resolves.toBeUndefined();
  });

  it("fails when the random draw is below the failure rate", async () => {
    const p = new MockProvider("m", { latencyMs: 0, failureRate: 0.3 }, () => 0.1, noSleep);
    await expect(p.send(req)).rejects.toThrow(/simulated provider failure/);
  });

  it("never fails with a failure rate of 0, and always fails with 1", async () => {
    await expect(new MockProvider("m", { latencyMs: 0, failureRate: 0 }, () => 0, noSleep).send(req)).resolves.toBeUndefined();
    await expect(new MockProvider("m", { latencyMs: 0, failureRate: 1 }, () => 0.999, noSleep).send(req)).rejects.toThrow();
  });

  it("waits for the configured latency", async () => {
    const waited: number[] = [];
    const p = new MockProvider("m", { latencyMs: 120, failureRate: 0 }, Math.random, async (ms) => void waited.push(ms));
    await p.send(req);
    expect(waited).toEqual([120]);
  });

  it("delivers a given idempotency key only once", async () => {
    const p = new MockProvider("m", { latencyMs: 0, failureRate: 0 }, () => 0.9, noSleep);
    await p.send(req);
    await p.send(req); // same key again, e.g. a redelivered message
    await p.send({ ...req, idempotencyKey: "other" });
    expect(p.deliveries).toBe(2);
    expect(p.suppressed).toBe(1);
  });

  it("does not remember a key whose send failed, so a retry can still deliver", async () => {
    let roll = 0.1; // fail first, succeed later
    const p = new MockProvider("m", { latencyMs: 0, failureRate: 0.5 }, () => roll, noSleep);
    await expect(p.send(req)).rejects.toThrow();
    roll = 0.9;
    await p.send(req);
    expect(p.deliveries).toBe(1);
  });

  it("fails with a retryable ProviderError when it simulates a transient failure", async () => {
    const p = new MockProvider("m", { latencyMs: 0, failureRate: 1 }, () => 0, noSleep);
    const err = await p.send(req).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.retryable).toBe(true);
  });

  it("rejects a destination containing 'invalid' permanently, whatever the failure rate", async () => {
    const p = new MockProvider("m", { latencyMs: 0, failureRate: 0 }, () => 0.99, noSleep);
    const err = await p.send({ ...req, destination: "invalid-token-123" }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.retryable).toBe(false);
  });
});
