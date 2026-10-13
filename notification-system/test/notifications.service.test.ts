import { beforeEach, describe, expect, it } from "vitest";
import { IdempotencyKeyReuseError, NoDestinationError, UnknownUserError } from "../src/notifications/service.js";
import { TemplateNotFoundError, TemplateParamError } from "../src/notifications/templates.js";
import { buildTestApp } from "./fakes.js";

const CLIENT = "client-a";
let t: ReturnType<typeof buildTestApp>;
beforeEach(() => {
  t = buildTestApp();
});

async function userWith(contact: { email?: string; phone?: string }, devices: { platform: "ios" | "android"; token: string }[] = []) {
  const user = await t.users.createUser(contact);
  for (const d of devices) await t.users.registerDevice({ userId: user.id, ...d });
  return user;
}
const content = { kind: "text" as const, body: "hello" };

describe("NotificationService.send", () => {
  it("stores one row and queues it on the channel's queue", async () => {
    const user = await userWith({ email: "a@x.com" });
    const { notifications } = await t.notifications.send({ clientId: CLIENT, userId: user.id, channel: "email", content });

    expect(t.notificationRows.rows).toHaveLength(1);
    expect(t.notificationRows.rows[0]).toMatchObject({ destination: "a@x.com", queue: "email", status: "PENDING" });
    expect(t.publisher.published).toEqual([{ queue: "email", message: { notificationId: notifications[0]!.id } }]);
    expect(t.notificationRows.rows[0]!.publishedAt).not.toBeNull();
  });

  it("fans a push out to every device, each on its platform's queue", async () => {
    const user = await userWith({ email: "a@x.com" }, [
      { platform: "ios", token: "t-ios" },
      { platform: "android", token: "t-android" },
    ]);
    const { requestId, notifications } = await t.notifications.send({ clientId: CLIENT, userId: user.id, channel: "push", content });

    expect(notifications.map((n) => n.queue).sort()).toEqual(["push.android", "push.ios"]);
    expect(new Set(notifications.map((n) => n.requestId))).toEqual(new Set([requestId]));
    expect(t.publisher.published).toHaveLength(2);
  });

  it("still accepts and stores the notification when the broker is down", async () => {
    const user = await userWith({ phone: "+14155550123" });
    t.publisher.down = true;

    const { notifications } = await t.notifications.send({ clientId: CLIENT, userId: user.id, channel: "sms", content });

    expect(notifications).toHaveLength(1);
    expect(t.notificationRows.rows[0]!.publishedAt).toBeNull(); // nothing lost, just not queued yet
  });

  it("rejects an unknown user and stores nothing", async () => {
    await expect(t.notifications.send({ clientId: CLIENT, userId: "999", channel: "email", content })).rejects.toBeInstanceOf(UnknownUserError);
    expect(t.notificationRows.rows).toHaveLength(0);
  });

  it.each([
    ["email", { phone: "+14155550123" }],
    ["sms", { email: "a@x.com" }],
    ["push", { email: "a@x.com" }], // no devices
  ] as const)("rejects %s when the user has no destination for it", async (channel, contact) => {
    const user = await userWith(contact);
    await expect(t.notifications.send({ clientId: CLIENT, userId: user.id, channel, content })).rejects.toBeInstanceOf(NoDestinationError);
    expect(t.notificationRows.rows).toHaveLength(0);
  });
});

describe("NotificationService.relayUnpublished", () => {
  it("queues notifications that were stored while the broker was down", async () => {
    const user = await userWith({ email: "a@x.com" });
    t.publisher.down = true;
    await t.notifications.send({ clientId: CLIENT, userId: user.id, channel: "email", content });
    expect(t.publisher.published).toHaveLength(0);

    t.publisher.down = false; // broker recovers
    expect(await t.notifications.relayUnpublished(0)).toBe(1);

    expect(t.publisher.published).toHaveLength(1);
    expect(t.notificationRows.rows[0]!.publishedAt).not.toBeNull();
  });

  it("does nothing once everything is published", async () => {
    const user = await userWith({ email: "a@x.com" });
    await t.notifications.send({ clientId: CLIENT, userId: user.id, channel: "email", content });
    expect(await t.notifications.relayUnpublished(0)).toBe(0);
    expect(t.publisher.published).toHaveLength(1);
  });

  it("leaves rows unpublished while the broker is still down", async () => {
    const user = await userWith({ email: "a@x.com" });
    t.publisher.down = true;
    await t.notifications.send({ clientId: CLIENT, userId: user.id, channel: "email", content });
    expect(await t.notifications.relayUnpublished(0)).toBe(0);
    expect(t.notificationRows.rows[0]!.publishedAt).toBeNull();
  });
});

describe("NotificationService.send: idempotency (layer 1)", () => {
  const send = (userId: string, key?: string, body = "hello") =>
    t.notifications.send({ clientId: CLIENT, userId, channel: "email", content: { kind: "text", body } }, key);

  it("a retry with the same key returns the original notifications and creates nothing new", async () => {
    const user = await userWith({ email: "a@x.com" });
    const first = await send(user.id, "evt-1");
    const retry = await send(user.id, "evt-1");

    expect(first.replayed).toBe(false);
    expect(retry.replayed).toBe(true);
    expect(retry.requestId).toBe(first.requestId);
    expect(retry.notifications.map((n) => n.id)).toEqual(first.notifications.map((n) => n.id));
    expect(t.notificationRows.rows).toHaveLength(1);
    expect(t.publisher.published).toHaveLength(1); // not queued a second time
  });

  it("different keys are different requests", async () => {
    const user = await userWith({ email: "a@x.com" });
    await send(user.id, "evt-1");
    await send(user.id, "evt-2");
    expect(t.notificationRows.rows).toHaveLength(2);
  });

  it("without a key every call is a new request (no deduplication)", async () => {
    const user = await userWith({ email: "a@x.com" });
    await send(user.id);
    await send(user.id);
    expect(t.notificationRows.rows).toHaveLength(2);
  });

  it("rejects the same key reused for a different request", async () => {
    const user = await userWith({ email: "a@x.com" });
    await send(user.id, "evt-1", "hello");
    await expect(send(user.id, "evt-1", "something else")).rejects.toBeInstanceOf(IdempotencyKeyReuseError);
    expect(t.notificationRows.rows).toHaveLength(1);
  });

  it("replays even if the user can no longer be reached, because the key is checked first", async () => {
    const user = await userWith({ email: "a@x.com" });
    const first = await send(user.id, "evt-1");
    t.users.findContacts = async () => null; // e.g. the user was deleted since
    expect((await send(user.id, "evt-1")).requestId).toBe(first.requestId);
  });

  it("returns the winner's result when it loses a race between the key check and the insert", async () => {
    const user = await userWith({ email: "a@x.com" });
    const winner = await send(user.id, "evt-1");
    // Simulate: our findByKey ran before the winner committed, so it saw nothing.
    const realFind = t.notificationRows.findByKey.bind(t.notificationRows);
    let calls = 0;
    t.notificationRows.findByKey = async (c, k) => (calls++ === 0 ? null : realFind(c, k));

    const loser = await send(user.id, "evt-1");

    expect(loser.replayed).toBe(true);
    expect(loser.requestId).toBe(winner.requestId);
    expect(t.notificationRows.rows).toHaveLength(1);
  });
});

describe("NotificationService.send: templates", () => {
  const useTemplate = (userId: string, params: Record<string, string | number | boolean>, key?: string) =>
    t.notifications.send({ clientId: CLIENT, userId, channel: "email", content: { kind: "template", name: "shipped", params } }, key);

  beforeEach(async () => {
    await t.templates.upsert({ name: "shipped", channel: "email", subject: "Order {{order}} shipped", body: "Hi {{name}}, order {{order}} is on its way" });
  });

  it("stores and queues the rendered text, not the template", async () => {
    const user = await userWith({ email: "a@x.com" });
    await useTemplate(user.id, { name: "Ana", order: 1001 });

    expect(t.notificationRows.rows[0]!.payload).toEqual({
      subject: "Order 1001 shipped",
      body: "Hi Ana, order 1001 is on its way",
    });
  });

  it("uses the version for the requested channel", async () => {
    const user = await userWith({ phone: "+14155550123" });
    await t.templates.upsert({ name: "shipped", channel: "sms", body: "Order {{order}} shipped" });

    await t.notifications.send({ clientId: CLIENT, userId: user.id, channel: "sms", content: { kind: "template", name: "shipped", params: { order: 7 } } });

    expect(t.notificationRows.rows[0]!.payload).toEqual({ subject: undefined, body: "Order 7 shipped" });
  });

  it("rejects an unknown template and stores nothing", async () => {
    const user = await userWith({ email: "a@x.com" });
    await expect(
      t.notifications.send({ clientId: CLIENT, userId: user.id, channel: "email", content: { kind: "template", name: "nope", params: {} } }),
    ).rejects.toBeInstanceOf(TemplateNotFoundError);
    expect(t.notificationRows.rows).toHaveLength(0);
  });

  it("rejects a missing parameter and stores nothing", async () => {
    const user = await userWith({ email: "a@x.com" });
    await expect(useTemplate(user.id, { name: "Ana" })).rejects.toBeInstanceOf(TemplateParamError);
    expect(t.notificationRows.rows).toHaveLength(0);
  });

  it("editing the template does not change a notification already stored", async () => {
    const user = await userWith({ email: "a@x.com" });
    await useTemplate(user.id, { name: "Ana", order: 1 });
    await t.templates.upsert({ name: "shipped", channel: "email", body: "COMPLETELY DIFFERENT" });

    expect(t.notificationRows.rows[0]!.payload.body).toBe("Hi Ana, order 1 is on its way");
  });

  it("a retry with the same key and params replays, even if the template was changed or deleted since", async () => {
    const user = await userWith({ email: "a@x.com" });
    const first = await useTemplate(user.id, { name: "Ana", order: 1 }, "evt-1");
    t.templates.items.clear();

    const retry = await useTemplate(user.id, { name: "Ana", order: 1 }, "evt-1");

    expect(retry.replayed).toBe(true);
    expect(retry.requestId).toBe(first.requestId);
  });

  it("the same key with different params is a different request", async () => {
    const user = await userWith({ email: "a@x.com" });
    await useTemplate(user.id, { name: "Ana", order: 1 }, "evt-1");
    await expect(useTemplate(user.id, { name: "Ana", order: 2 }, "evt-1")).rejects.toBeInstanceOf(IdempotencyKeyReuseError);
  });

  it("the order of the params does not matter for the idempotency check", async () => {
    const user = await userWith({ email: "a@x.com" });
    await useTemplate(user.id, { name: "Ana", order: 1 }, "evt-1");
    expect((await useTemplate(user.id, { order: 1, name: "Ana" }, "evt-1")).replayed).toBe(true);
  });
});

describe("NotificationService.send: scheduled notifications", () => {
  const HOUR = 60 * 60 * 1000;
  const inAnHour = () => new Date(Date.now() + HOUR);
  const sendAt = (userId: string, at: Date | undefined, key?: string) =>
    t.notifications.send({ clientId: CLIENT, userId, channel: "email", content: { kind: "text", body: "later" }, sendAt: at }, key);

  it("stores a notification for later but does not queue it", async () => {
    const user = await userWith({ email: "a@x.com" });
    const when = inAnHour();
    const { notifications } = await sendAt(user.id, when);

    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.sendAt).toEqual(when);
    expect(t.publisher.published).toHaveLength(0); // nothing on a queue yet
    expect(t.notificationRows.rows[0]).toMatchObject({ status: "PENDING", publishedAt: null });
  });

  it("an ordinary notification is queued at once and its send time is now", async () => {
    const user = await userWith({ email: "a@x.com" });
    const before = Date.now();
    await sendAt(user.id, undefined);
    expect(t.publisher.published).toHaveLength(1);
    expect(t.notificationRows.rows[0]!.sendAt.getTime()).toBeGreaterThanOrEqual(before - 5);
  });

  it.each([
    ["in the past", () => new Date(Date.now() - HOUR)],
    ["half a second ahead", () => new Date(Date.now() + 500)],
  ])("a time %s means now: queued at once", async (_name, at) => {
    const user = await userWith({ email: "a@x.com" });
    await sendAt(user.id, at());
    expect(t.publisher.published).toHaveLength(1);
  });

  it("is published by the relay once its time has come, and not before", async () => {
    const user = await userWith({ email: "a@x.com" });
    let clock = Date.now();
    t.notificationRows.now = () => clock;
    await sendAt(user.id, new Date(clock + HOUR));

    expect(await t.notifications.relayUnpublished(0)).toBe(0); // not due
    expect(t.publisher.published).toHaveLength(0);

    clock += HOUR + 1; // the time comes
    expect(await t.notifications.relayUnpublished(0)).toBe(1);
    expect(t.publisher.published).toEqual([{ queue: "email", message: { notificationId: "n-1" } }]);
    expect(t.notificationRows.rows[0]!.publishedAt).not.toBeNull();
  });

  it("a push to two devices schedules both, sharing one send time", async () => {
    const user = await userWith({ email: "a@x.com" }, [
      { platform: "ios", token: "t-ios" },
      { platform: "android", token: "t-android" },
    ]);
    const when = inAnHour();
    const { notifications } = await t.notifications.send({ clientId: CLIENT, userId: user.id, channel: "push", content, sendAt: when });
    expect(notifications.map((n) => n.sendAt)).toEqual([when, when]);
    expect(t.publisher.published).toHaveLength(0);
  });

  it("a retry with the same key and the same time replays, and queues nothing", async () => {
    const user = await userWith({ email: "a@x.com" });
    const when = inAnHour();
    const first = await sendAt(user.id, when, "evt-1");
    const retry = await sendAt(user.id, new Date(when.getTime()), "evt-1");

    expect(retry.replayed).toBe(true);
    expect(retry.requestId).toBe(first.requestId);
    expect(t.notificationRows.rows).toHaveLength(1);
  });

  it("the same key with a different time is a different request", async () => {
    const user = await userWith({ email: "a@x.com" });
    await sendAt(user.id, inAnHour(), "evt-1");
    await expect(sendAt(user.id, new Date(Date.now() + 2 * HOUR), "evt-1")).rejects.toBeInstanceOf(IdempotencyKeyReuseError);
    await expect(sendAt(user.id, undefined, "evt-1")).rejects.toBeInstanceOf(IdempotencyKeyReuseError);
  });
});
