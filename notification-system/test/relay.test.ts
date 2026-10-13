import { describe, expect, it } from "vitest";
import { drainRelay } from "../src/notifications/relay.js";

// A service whose relay finds `due` notifications, and publishes up to the batch size each call.
function stubService(due: number, confirmedOf = (n: number) => n) {
  const calls: number[] = [];
  return {
    calls,
    async relayUnpublished(_minAgeMs: number, batchSize = 100) {
      const batch = Math.min(due, batchSize);
      due -= batch;
      calls.push(batch);
      return confirmedOf(batch);
    },
  };
}

describe("drainRelay", () => {
  it("keeps going while batches are full, so many due at once do not wait for later ticks", async () => {
    const service = stubService(250);
    expect(await drainRelay(service, 0)).toBe(250);
    expect(service.calls).toEqual([100, 100, 50]);
  });

  it("does one call when there is little to do", async () => {
    const service = stubService(3);
    expect(await drainRelay(service, 0)).toBe(3);
    expect(service.calls).toEqual([3]);
  });

  it("does one call and stops when nothing is due", async () => {
    const service = stubService(0);
    expect(await drainRelay(service, 0)).toBe(0);
    expect(service.calls).toEqual([0]);
  });

  it("stops when the broker refuses some, because trying again at once would only fail again", async () => {
    const service = stubService(500, (n) => Math.floor(n / 2)); // only half of each batch is confirmed
    expect(await drainRelay(service, 0)).toBe(50);
    expect(service.calls).toEqual([100]);
  });

  it("stops after the batch limit, so one tick cannot run for ever", async () => {
    const service = stubService(1_000_000);
    expect(await drainRelay(service, 0, 100, 5)).toBe(500);
    expect(service.calls).toHaveLength(5);
  });
});
