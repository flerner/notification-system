import { beforeEach, describe, expect, it } from "vitest";
import { NotificationProcessor } from "../src/notifications/processor.js";
import type { ChannelProvider, DeliveryRequest } from "../src/providers/provider.js";
import { InMemoryNotificationRepository, silentLogger } from "./fakes.js";

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

beforeEach(async () => {
  repo = new InMemoryNotificationRepository();
  email = new RecordingProvider("email-provider");
  sms = new RecordingProvider("sms-provider");
  processor = new NotificationProcessor(repo, { email, sms }, silentLogger);
});

const store = (queue: string, destination: string) =>
  repo
    .insertPending([
      { requestId: "r", userId: "1", channel: queue === "email" ? "email" : "sms", platform: null, destination, queue, payload: { subject: "S", body: "B" } },
    ])
    .then(([n]) => n!);

describe("NotificationProcessor.process", () => {
  it("sends through the provider for the notification's queue and marks it SENT", async () => {
    const n = await store("email", "a@x.com");
    await processor.process(n.id);

    expect(email.calls).toEqual([{ notificationId: n.id, destination: "a@x.com", payload: { subject: "S", body: "B" } }]);
    expect(sms.calls).toHaveLength(0);
    expect(repo.rows[0]).toMatchObject({ status: "SENT" });
    expect(repo.rows[0]!.sentAt).toBeDefined();
  });

  it("records a provider failure on the row instead of throwing", async () => {
    const n = await store("sms", "+14155550123");
    sms.failWith = new Error("provider unavailable");

    await expect(processor.process(n.id)).resolves.toBeUndefined();

    expect(repo.rows[0]).toMatchObject({ status: "FAILED", lastError: "provider unavailable" });
  });

  it("drops a message whose notification does not exist", async () => {
    await expect(processor.process("missing")).resolves.toBeUndefined();
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
