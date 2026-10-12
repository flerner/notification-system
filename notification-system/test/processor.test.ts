import { beforeEach, describe, expect, it } from "vitest";
import { NotificationProcessor } from "../src/notifications/processor.js";
import { DEAD_LETTER_QUEUE } from "../src/notifications/queues.js";
import { RetryPolicy } from "../src/notifications/retry.js";
import { CircuitBreaker } from "../src/providers/circuit-breaker.js";
import { GuardedProvider } from "../src/providers/guarded.js";
import { MockProvider } from "../src/providers/mock.js";
import { ProviderError, type ChannelProvider, type DeliveryRequest } from "../src/providers/provider.js";
import { FakePublisher, InMemoryNotificationRepository, InMemoryRateLimiter, InMemorySettingsRepository, silentLogger } from "./fakes.js";

const LEASE = 1000;
const DELAYS = [1000, 5000]; // -> at most 3 attempts

// A provider whose behaviour each test scripts.
class ScriptedProvider implements ChannelProvider {
  calls: DeliveryRequest[] = [];
  behaviour: () => Promise<void> = async () => {};
  constructor(readonly name: string) {}
  async send(req: DeliveryRequest) {
    this.calls.push(req);
    return this.behaviour();
  }
}
const transient = () => Promise.reject(new ProviderError("503 service unavailable", true));
const permanent = () => Promise.reject(new ProviderError("invalid device token", false));

let repo: InMemoryNotificationRepository;
let settings: InMemorySettingsRepository;
let limiter: InMemoryRateLimiter;
let publisher: FakePublisher;
let email: ScriptedProvider;
let breaker: CircuitBreaker;
let processor: NotificationProcessor;
let clock: number;

function build(provider: ChannelProvider = email) {
  return new NotificationProcessor(
    repo,
    settings,
    limiter,
    { email: new GuardedProvider(provider, breaker, 1000), sms: new GuardedProvider(new ScriptedProvider("sms"), new CircuitBreaker({ failureThreshold: 5, cooldownMs: 1000 }), 1000) },
    publisher,
    new RetryPolicy(DELAYS),
    silentLogger,
    LEASE,
  );
}

beforeEach(() => {
  clock = 1_000_000;
  repo = new InMemoryNotificationRepository();
  repo.now = () => clock;
  settings = new InMemorySettingsRepository();
  limiter = new InMemoryRateLimiter();
  publisher = new FakePublisher();
  email = new ScriptedProvider("email-provider");
  // High threshold: only the circuit breaker tests below want the circuit to open.
  breaker = new CircuitBreaker({ failureThreshold: 100, cooldownMs: 10_000 }, () => clock);
  processor = build();
});

const store = (queue = "email", destination = "a@x.com") =>
  repo
    .insertPending([
      { requestId: "r", userId: "1", clientId: "c", channel: queue === "email" ? "email" : "sms", platform: null, destination, queue, payload: { subject: "S", body: "B" } },
    ])
    .then(([n]) => n!);
const run = (id: string, queue = "email") => processor.process(id, queue);
const row = () => repo.rows[0]!;

describe("delivery", () => {
  it("sends through the provider for the queue and marks the notification SENT", async () => {
    const n = await store();
    expect(await run(n.id)).toBe("done");

    expect(email.calls).toEqual([
      { notificationId: n.id, idempotencyKey: n.id, destination: "a@x.com", payload: { subject: "S", body: "B" } },
    ]);
    expect(row()).toMatchObject({ status: "SENT", attempts: 1 });
    expect(publisher.published).toEqual([]); // no retry, no dead letter
  });

  it("drops a message whose notification does not exist", async () => {
    expect(await run("missing")).toBe("done");
    expect(email.calls).toHaveLength(0);
  });

  it("throws when a queue has no provider, so the problem is loud", async () => {
    const n = await store();
    await expect(run(n.id, "push.ios")).rejects.toThrow(/no provider configured/);
  });

  it("lets infrastructure errors propagate so the message stays on the queue", async () => {
    const n = await store();
    repo.markSent = async () => {
      throw new Error("database down");
    };
    await expect(run(n.id)).rejects.toThrow("database down");
  });
});

describe("idempotency (layer 2)", () => {
  it("does not send again when the same message is delivered twice", async () => {
    const n = await store();
    await run(n.id);
    expect(await run(n.id)).toBe("done"); // the duplicate is acknowledged and dropped

    expect(email.calls).toHaveLength(1);
    expect(row().attempts).toBe(1);
  });

  it("does not send a FAILED notification again", async () => {
    const n = await store();
    email.behaviour = permanent;
    await run(n.id);
    email.behaviour = async () => {};

    await run(n.id);
    expect(email.calls).toHaveLength(1);
  });

  it("sends once when many duplicates of the message are processed concurrently", async () => {
    const n = await store();
    const results = await Promise.all(Array.from({ length: 10 }, () => run(n.id)));

    expect(email.calls).toHaveLength(1);
    expect(results.every((r) => r === "done" || r === "busy")).toBe(true);
  });

  it("answers busy, not done, while another worker holds a live claim", async () => {
    const n = await store();
    await repo.claim(n.id, LEASE);
    expect(await run(n.id)).toBe("busy");
    expect(email.calls).toHaveLength(0);
  });

  it("takes over a notification whose worker died, once the lease has expired", async () => {
    const n = await store();
    await repo.claim(n.id, LEASE); // worker A claims, then crashes

    clock += LEASE + 1;
    expect(await run(n.id)).toBe("done");

    expect(email.calls).toHaveLength(1);
    expect(row()).toMatchObject({ status: "SENT", attempts: 2 });
  });

  // The worst case: the provider delivered, then the worker died before recording SENT.
  async function crashAfterSend(provider: ChannelProvider) {
    const p = build(provider);
    const n = await store();
    const realMarkSent = repo.markSent.bind(repo);
    repo.markSent = async () => {
      throw new Error("worker crashed");
    };
    await expect(p.process(n.id, "email")).rejects.toThrow("worker crashed");
    repo.markSent = realMarkSent; // a fresh worker takes over...
    clock += LEASE + 1; // ...once the lease has run out
    await p.process(n.id, "email");
  }

  it("a provider that honours the idempotency key delivers exactly once even after a crash", async () => {
    const provider = new MockProvider("dedupes", { latencyMs: 0, failureRate: 0 }, () => 1, async () => {});
    await crashAfterSend(provider);

    expect(provider.deliveries).toBe(1);
    expect(provider.suppressed).toBe(1);
    expect(row().status).toBe("SENT");
  });

  it("a provider without such a key receives it twice: the duplicate we accept instead of a loss", async () => {
    await crashAfterSend(email);
    expect(email.calls).toHaveLength(2);
    expect(row().status).toBe("SENT");
  });
});

describe("retries", () => {
  it("parks a retryable failure as RETRYING and queues it on the first retry queue", async () => {
    const n = await store();
    email.behaviour = transient;

    expect(await run(n.id)).toBe("done"); // the original message is acknowledged

    expect(row()).toMatchObject({ status: "RETRYING", attempts: 1, lastError: "503 service unavailable" });
    expect(publisher.published).toEqual([{ queue: "email.retry.1000", message: { notificationId: n.id } }]);
  });

  it("backs off further on each failure: the second retry goes to the longer queue", async () => {
    const n = await store();
    email.behaviour = transient;
    await run(n.id); // attempt 1 fails
    await run(n.id); // the retry message comes back: attempt 2 fails

    expect(row()).toMatchObject({ status: "RETRYING", attempts: 2 });
    expect(publisher.published.map((p) => p.queue)).toEqual(["email.retry.1000", "email.retry.5000"]);
  });

  it("succeeds on a retry when the provider has recovered", async () => {
    const n = await store();
    email.behaviour = transient;
    await run(n.id);
    email.behaviour = async () => {};
    await run(n.id);

    expect(row()).toMatchObject({ status: "SENT", attempts: 2 });
    expect(publisher.published.map((p) => p.queue)).toEqual(["email.retry.1000"]); // nothing dead-lettered
  });

  it("gives up after the last attempt: FAILED, and announced on the dead-letter queue", async () => {
    const n = await store();
    email.behaviour = transient;
    await run(n.id);
    await run(n.id);
    await run(n.id); // attempt 3 = maxAttempts

    expect(row()).toMatchObject({ status: "FAILED", attempts: 3, lastError: "503 service unavailable" });
    expect(publisher.published.at(-1)).toEqual({
      queue: DEAD_LETTER_QUEUE,
      message: { notificationId: n.id, queue: "email", reason: "exhausted", error: "503 service unavailable", attempts: 3 },
    });
    expect(publisher.published.filter((p) => p.queue.includes("retry"))).toHaveLength(2); // no 3rd retry
  });

  it("does not retry a permanent failure: FAILED at once", async () => {
    const n = await store();
    email.behaviour = permanent;

    expect(await run(n.id)).toBe("done");

    expect(row()).toMatchObject({ status: "FAILED", attempts: 1, lastError: "invalid device token" });
    expect(publisher.published).toEqual([
      {
        queue: DEAD_LETTER_QUEUE,
        message: { notificationId: n.id, queue: "email", reason: "permanent", error: "invalid device token", attempts: 1 },
      },
    ]);
  });

  it("treats an error that is not a ProviderError as retryable", async () => {
    const n = await store();
    email.behaviour = () => Promise.reject(new Error("socket hang up"));
    await run(n.id);
    expect(row().status).toBe("RETRYING");
  });

  it("still records FAILED when the dead-letter queue cannot be reached", async () => {
    const n = await store();
    email.behaviour = permanent;
    publisher.failQueues.add(DEAD_LETTER_QUEUE);

    expect(await run(n.id)).toBe("done"); // must not throw: that would make the worker send it again
    expect(row().status).toBe("FAILED");
  });

  it("when the retry message cannot be published, the error propagates and the notification is picked up again", async () => {
    const n = await store();
    email.behaviour = transient;
    publisher.down = true;
    await expect(run(n.id)).rejects.toThrow("broker down"); // the consumer puts the original message back

    expect(row().status).toBe("RETRYING"); // the row is already parked
    publisher.down = false;
    email.behaviour = async () => {};
    await run(n.id); // the redelivered original message claims it from RETRYING
    expect(row()).toMatchObject({ status: "SENT", attempts: 2 });
  });
});

describe("circuit breaker", () => {
  beforeEach(() => {
    breaker = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 10_000 }, () => clock);
    processor = build();
  });

  it("does not claim or call the provider while the circuit is open", async () => {
    const [a, b, c] = [await store(), await store(), await store()];
    email.behaviour = transient;
    await run(a.id);
    await run(b.id); // 2 consecutive failures: threshold reached
    expect(breaker.isOpen()).toBe(true);

    expect(await run(c.id)).toBe("circuit_open");

    const third = repo.rows.find((r) => r.id === c.id)!;
    expect(third).toMatchObject({ status: "PENDING", attempts: 0 }); // no attempt was burned
    expect(email.calls).toHaveLength(2);
  });

  it("lets calls through again after the cooldown, and a success closes the circuit", async () => {
    const [a, b, c] = [await store(), await store(), await store()];
    email.behaviour = transient;
    await run(a.id);
    await run(b.id);
    clock += 10_000; // cooldown over
    email.behaviour = async () => {};

    expect(await run(c.id)).toBe("done");

    expect(repo.rows.find((r) => r.id === c.id)!.status).toBe("SENT");
    expect(breaker.state).toBe("closed");
  });

  it("permanent failures do not open the circuit", async () => {
    email.behaviour = permanent;
    for (let i = 0; i < 5; i++) await run((await store()).id);
    expect(breaker.isOpen()).toBe(false);
  });
});

describe("opt-out", () => {
  it("skips a notification whose user opted out of the channel, and never calls the provider", async () => {
    const n = await store();
    settings.optedOut.add(`${n.userId}:email`);

    expect(await run(n.id)).toBe("done");

    expect(email.calls).toHaveLength(0);
    expect(row()).toMatchObject({ status: "SKIPPED_OPT_OUT", attempts: 1 });
    expect(row().lastError).toContain("opted out of email");
    expect(publisher.published).toEqual([]); // not a failure: no retry, no dead letter
  });

  it("only the opted-out channel is affected", async () => {
    const n = await store();
    settings.optedOut.add(`${n.userId}:sms`);
    await run(n.id);
    expect(row().status).toBe("SENT");
  });

  it("a skipped notification stays skipped when a duplicate of its message arrives", async () => {
    const n = await store();
    settings.optedOut.add(`${n.userId}:email`);
    await run(n.id);
    settings.optedOut.clear(); // the user opts back in afterwards

    expect(await run(n.id)).toBe("done");
    expect(email.calls).toHaveLength(0);
    expect(row().status).toBe("SKIPPED_OPT_OUT");
  });

  it("is checked on every attempt: a user who opts out while a retry waits is not sent to", async () => {
    const n = await store();
    email.behaviour = transient;
    await run(n.id); // attempt 1 fails, waits as RETRYING
    expect(row().status).toBe("RETRYING");

    settings.optedOut.add(`${n.userId}:email`); // the user opts out while the retry message waits
    email.behaviour = async () => {};
    await run(n.id);

    expect(row()).toMatchObject({ status: "SKIPPED_OPT_OUT", attempts: 2 });
    expect(email.calls).toHaveLength(1); // only the first, failed attempt ever reached the provider
  });

  it("lets a settings lookup failure propagate so the message stays on the queue", async () => {
    const n = await store();
    settings.isOptedIn = async () => {
      throw new Error("database down");
    };
    await expect(run(n.id)).rejects.toThrow("database down");
    expect(email.calls).toHaveLength(0);
  });
});

describe("rate limit", () => {
  const storeFor = (userId: string) =>
    repo
      .insertPending([
        { requestId: "r", userId, clientId: "c", channel: "email", platform: null, destination: "a@x.com", queue: "email", payload: { body: "B" } },
      ])
      .then(([n]) => n!);

  beforeEach(() => {
    limiter = new InMemoryRateLimiter({ max: 2, windowSeconds: 60 });
    processor = build();
  });

  it("sends up to the limit and skips the next ones, recording why", async () => {
    const [a, b, c] = [await store(), await store(), await store()];
    for (const n of [a, b, c]) await run(n.id);

    const status = (id: string) => repo.rows.find((r) => r.id === id)!;
    expect(status(a.id).status).toBe("SENT");
    expect(status(b.id).status).toBe("SENT");
    expect(status(c.id)).toMatchObject({ status: "SKIPPED_RATE_LIMITED", attempts: 1 });
    expect(status(c.id).lastError).toBe("rate limit reached for user 1: 2 email per 60s");
    expect(email.calls).toHaveLength(2); // the third never reached the provider
  });

  it("a skipped notification is not retried and not dead-lettered: nothing failed", async () => {
    await run((await store()).id);
    await run((await store()).id);
    await run((await store()).id);
    expect(publisher.published).toEqual([]);
  });

  it("a skipped notification stays skipped when a duplicate of its message arrives", async () => {
    await run((await store()).id);
    await run((await store()).id);
    const third = await store();
    await run(third.id);
    limiter.counts.clear(); // the window ends

    expect(await run(third.id)).toBe("done");
    expect(repo.rows.find((r) => r.id === third.id)!.status).toBe("SKIPPED_RATE_LIMITED");
    expect(email.calls).toHaveLength(2);
  });

  it("counts each user separately", async () => {
    const mine = [await storeFor("1"), await storeFor("1"), await storeFor("1")];
    const theirs = await storeFor("2");
    for (const n of mine) await run(n.id);
    await run(theirs.id);

    expect(repo.rows.find((r) => r.id === mine[2]!.id)!.status).toBe("SKIPPED_RATE_LIMITED");
    expect(repo.rows.find((r) => r.id === theirs.id)!.status).toBe("SENT");
  });

  it("a retry does not use up another slot: only the first attempt asks the limiter", async () => {
    const n = await store();
    email.behaviour = transient;
    await run(n.id); // attempt 1: takes a slot, fails, waits as RETRYING
    email.behaviour = transient;
    await run(n.id); // attempt 2
    email.behaviour = async () => {};
    await run(n.id); // attempt 3: succeeds

    expect(repo.rows[0]).toMatchObject({ status: "SENT", attempts: 3 });
    expect(limiter.calls).toHaveLength(1);
  });

  it("a notification skipped for opt-out takes no slot", async () => {
    const n = await store();
    settings.optedOut.add(`${n.userId}:email`);
    await run(n.id);
    expect(limiter.calls).toHaveLength(0);
  });

  it("is not asked when the circuit is open: no claim, no slot", async () => {
    breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 10_000 }, () => clock);
    processor = build();
    email.behaviour = transient;
    await run((await store()).id); // opens the circuit
    limiter.calls.length = 0;

    expect(await run((await store()).id)).toBe("circuit_open");
    expect(limiter.calls).toHaveLength(0);
  });

  it("lets a limiter failure propagate if it is thrown (a limiter that fails open never throws)", async () => {
    limiter.allow = async () => {
      throw new Error("boom");
    };
    await expect(run((await store()).id)).rejects.toThrow("boom");
  });
});
