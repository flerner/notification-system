import { beforeEach, describe, expect, it } from "vitest";
import { NotificationProcessor } from "../src/notifications/processor.js";
import { MockProvider } from "../src/providers/mock.js";
import type { ChannelProvider, DeliveryRequest } from "../src/providers/provider.js";
import { InMemoryNotificationRepository, silentLogger } from "./fakes.js";

const LEASE = 1000;

class RecordingProvider implements ChannelProvider {
  calls: DeliveryRequest[] = [];
  failWith?: Error;
  constructor(readonly name: string) {}
  async send(req: DeliveryRequest) {
    this.calls.push(req);
    if (this.failWith) throw this.failWith;
  }
}

let repo: InMemoryNotificationRepository;
let email: RecordingProvider;
let sms: RecordingProvider;
let processor: NotificationProcessor;
let clock: number;

beforeEach(() => {
  clock = 1_000_000;
  repo = new InMemoryNotificationRepository();
  repo.now = () => clock;
  email = new RecordingProvider("email-provider");
  sms = new RecordingProvider("sms-provider");
  processor = new NotificationProcessor(repo, { email, sms }, silentLogger, LEASE);
});

const store = (queue: string, destination: string) =>
  repo
    .insertPending([
      { requestId: "r", userId: "1", channel: queue === "email" ? "email" : "sms", platform: null, destination, queue, payload: { subject: "S", body: "B" } },
    ])
    .then(([n]) => n!);

describe("NotificationProcessor.process: delivery", () => {
  it("sends through the provider for the notification's queue and marks it SENT", async () => {
    const n = await store("email", "a@x.com");
    expect(await processor.process(n.id)).toBe("done");

    expect(email.calls).toEqual([
      { notificationId: n.id, idempotencyKey: n.id, destination: "a@x.com", payload: { subject: "S", body: "B" } },
    ]);
    expect(sms.calls).toHaveLength(0);
    expect(repo.rows[0]).toMatchObject({ status: "SENT", attempts: 1 });
    expect(repo.rows[0]!.sentAt).toBeDefined();
  });

  it("records a provider failure on the row instead of throwing", async () => {
    const n = await store("sms", "+14155550123");
    sms.failWith = new Error("provider unavailable");

    expect(await processor.process(n.id)).toBe("done");

    expect(repo.rows[0]).toMatchObject({ status: "FAILED", lastError: "provider unavailable" });
  });

  it("drops a message whose notification does not exist", async () => {
    expect(await processor.process("missing")).toBe("done");
    expect(email.calls).toHaveLength(0);
  });

  it("throws when a queue has no provider, so the problem is loud", async () => {
    const n = await store("push.ios", "token");
    await expect(processor.process(n.id)).rejects.toThrow(/no provider configured/);
  });

  it("lets infrastructure errors propagate so the message stays on the queue", async () => {
    const n = await store("email", "a@x.com");
    repo.markSent = async () => {
      throw new Error("database down");
    };
    await expect(processor.process(n.id)).rejects.toThrow("database down");
  });
});

describe("NotificationProcessor.process: idempotency (layer 2)", () => {
  it("does not send again when the same message is delivered twice", async () => {
    const n = await store("email", "a@x.com");
    await processor.process(n.id);
    expect(await processor.process(n.id)).toBe("done"); // the duplicate is acknowledged and dropped

    expect(email.calls).toHaveLength(1);
    expect(repo.rows[0]!.attempts).toBe(1);
  });

  it("does not send a FAILED notification again either", async () => {
    const n = await store("email", "a@x.com");
    email.failWith = new Error("nope");
    await processor.process(n.id);
    email.failWith = undefined;

    await processor.process(n.id);
    expect(email.calls).toHaveLength(1);
  });

  it("sends once when many duplicates of the message are processed concurrently", async () => {
    const n = await store("email", "a@x.com");
    const results = await Promise.all(Array.from({ length: 10 }, () => processor.process(n.id)));

    expect(email.calls).toHaveLength(1);
    expect(results.filter((r) => r === "busy").length + results.filter((r) => r === "done").length).toBe(10);
  });

  it("answers busy, not done, while another worker holds a live claim", async () => {
    const n = await store("email", "a@x.com");
    await repo.claim(n.id, LEASE); // another worker took it and is still sending

    expect(await processor.process(n.id)).toBe("busy");
    expect(email.calls).toHaveLength(0);
  });

  it("takes over a notification whose worker died, once the lease has expired", async () => {
    const n = await store("email", "a@x.com");
    await repo.claim(n.id, LEASE); // worker A claims, then crashes: it never reports back

    clock += LEASE + 1;
    expect(await processor.process(n.id)).toBe("done");

    expect(email.calls).toHaveLength(1);
    expect(repo.rows[0]).toMatchObject({ status: "SENT", attempts: 2 });
  });
});

describe("NotificationProcessor.process: crash after the provider accepted (layer 3)", () => {
  // The worst case: the provider delivered, then the worker died before recording SENT.
  async function crashAfterSend(provider: MockProvider) {
    const p = new NotificationProcessor(repo, { email: provider }, silentLogger, LEASE);
    const n = await store("email", "a@x.com");
    const realMarkSent = repo.markSent.bind(repo);
    repo.markSent = async () => {
      throw new Error("worker crashed");
    };
    await expect(p.process(n.id)).rejects.toThrow("worker crashed");
    repo.markSent = realMarkSent; // a fresh worker takes over
    clock += LEASE + 1; // ...once the lease has run out
    await p.process(n.id);
    return n;
  }

  it("a provider that honours the idempotency key delivers exactly once", async () => {
    const provider = new MockProvider("dedupes", { latencyMs: 0, failureRate: 0 }, () => 1, async () => {});
    await crashAfterSend(provider);

    expect(provider.deliveries).toBe(1);
    expect(provider.suppressed).toBe(1);
    expect(repo.rows[0]!.status).toBe("SENT");
  });

  it("a provider without such a key receives it twice: the duplicate we accept instead of a loss", async () => {
    const plain = new RecordingProvider("no-dedupe");
    const p = new NotificationProcessor(repo, { email: plain }, silentLogger, LEASE);
    const n = await store("email", "a@x.com");
    const realMarkSent = repo.markSent.bind(repo);
    repo.markSent = async () => {
      throw new Error("worker crashed");
    };
    await expect(p.process(n.id)).rejects.toThrow();
    repo.markSent = realMarkSent;
    clock += LEASE + 1;
    await p.process(n.id);

    expect(plain.calls).toHaveLength(2); // documented trade-off
    expect(repo.rows[0]!.status).toBe("SENT"); // but the notification is never lost
  });
});
