import { describe, expect, it } from "vitest";
import { MockProvider } from "../src/providers/mock.js";

const req = { notificationId: "n", destination: "d", payload: { body: "b" } };
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
});
