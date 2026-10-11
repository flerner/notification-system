import { describe, expect, it } from "vitest";
import { allQueues, DEAD_LETTER_QUEUE, QUEUES, retryQueueName } from "../src/notifications/queues.js";
import { RetryPolicy } from "../src/notifications/retry.js";

describe("RetryPolicy", () => {
  const policy = new RetryPolicy([5000, 30000, 120000]);

  it("allows one attempt plus one per delay", () => {
    expect(policy.maxAttempts).toBe(4);
  });

  it("returns the delay that follows each attempt, then nothing once attempts are exhausted", () => {
    expect(policy.delayAfter(1)).toBe(5000);
    expect(policy.delayAfter(2)).toBe(30000);
    expect(policy.delayAfter(3)).toBe(120000);
    expect(policy.delayAfter(4)).toBeUndefined();
  });

  it("with no delays there are no retries at all", () => {
    expect(new RetryPolicy([]).delayAfter(1)).toBeUndefined();
  });
});

describe("queue topology", () => {
  const specs = allQueues([5000, 30000]);
  const byName = new Map(specs.map((s) => [s.name, s]));

  it("declares the main queues, a retry queue per delay for each, and one dead-letter queue", () => {
    expect(specs).toHaveLength(QUEUES.length + QUEUES.length * 2 + 1);
    for (const q of QUEUES) {
      expect(byName.has(q)).toBe(true);
      expect(byName.has(retryQueueName(q, 5000))).toBe(true);
      expect(byName.has(retryQueueName(q, 30000))).toBe(true);
    }
    expect(byName.has(DEAD_LETTER_QUEUE)).toBe(true);
  });

  it("makes a retry queue hand its messages back to its own main queue after the delay", () => {
    expect(byName.get("email.retry.5000")!.args).toEqual({
      "x-message-ttl": 5000,
      "x-dead-letter-exchange": "",
      "x-dead-letter-routing-key": "email",
    });
    expect(byName.get("push.ios.retry.30000")!.args).toMatchObject({
      "x-message-ttl": 30000,
      "x-dead-letter-routing-key": "push.ios",
    });
  });
});
