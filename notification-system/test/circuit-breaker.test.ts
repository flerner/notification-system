import { beforeEach, describe, expect, it } from "vitest";
import { CircuitBreaker } from "../src/providers/circuit-breaker.js";

let now: number;
let breaker: CircuitBreaker;
beforeEach(() => {
  now = 1_000_000;
  breaker = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 10_000 }, () => now);
});

const fail = (n: number) => Array.from({ length: n }).forEach(() => breaker.recordFailure());

describe("CircuitBreaker", () => {
  it("starts closed", () => {
    expect(breaker.state).toBe("closed");
    expect(breaker.isOpen()).toBe(false);
  });

  it("opens after the threshold of consecutive failures, not before", () => {
    fail(2);
    expect(breaker.state).toBe("closed");
    fail(1);
    expect(breaker.state).toBe("open");
    expect(breaker.isOpen()).toBe(true);
  });

  it("a success resets the count, so failures must be consecutive", () => {
    fail(2);
    breaker.recordSuccess();
    fail(2);
    expect(breaker.state).toBe("closed");
  });

  it("reports how long until calls are allowed again", () => {
    fail(3);
    now += 4_000;
    expect(breaker.retryAfterMs()).toBe(6_000);
  });

  it("lets calls through again after the cooldown (half open)", () => {
    fail(3);
    now += 10_000;
    expect(breaker.state).toBe("half_open");
    expect(breaker.isOpen()).toBe(false);
    expect(breaker.retryAfterMs()).toBe(0);
  });

  it("closes again when the trial call succeeds", () => {
    fail(3);
    now += 10_000;
    breaker.recordSuccess();
    expect(breaker.state).toBe("closed");
    fail(2); // the failure count started from zero again
    expect(breaker.state).toBe("closed");
  });

  it("opens again, for a full cooldown, when the trial call fails", () => {
    fail(3);
    now += 10_000;
    breaker.recordFailure();
    expect(breaker.state).toBe("open");
    now += 9_000;
    expect(breaker.isOpen()).toBe(true);
    now += 1_000;
    expect(breaker.state).toBe("half_open");
  });

  it("ignores failures of calls that were already in flight when it opened", () => {
    fail(3);
    now += 5_000;
    breaker.recordFailure(); // a straggler: must not extend the cooldown
    now += 5_000;
    expect(breaker.state).toBe("half_open");
  });
});
