import { beforeEach, describe, expect, it } from "vitest";
import { NoDestinationError, UnknownUserError } from "../src/notifications/service.js";
import { buildTestApp } from "./fakes.js";

let t: ReturnType<typeof buildTestApp>;
beforeEach(() => {
  t = buildTestApp();
});

async function userWith(contact: { email?: string; phone?: string }, devices: { platform: "ios" | "android"; token: string }[] = []) {
  const user = await t.users.createUser(contact);
  for (const d of devices) await t.users.registerDevice({ userId: user.id, ...d });
  return user;
}
const payload = { body: "hello" };

describe("NotificationService.send", () => {
  it("stores one row and queues it on the channel's queue", async () => {
    const user = await userWith({ email: "a@x.com" });
    const { notifications } = await t.notifications.send({ userId: user.id, channel: "email", payload });

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
    const { requestId, notifications } = await t.notifications.send({ userId: user.id, channel: "push", payload });

    expect(notifications.map((n) => n.queue).sort()).toEqual(["push.android", "push.ios"]);
    expect(new Set(notifications.map((n) => n.requestId))).toEqual(new Set([requestId]));
    expect(t.publisher.published).toHaveLength(2);
  });

  it("still accepts and stores the notification when the broker is down", async () => {
    const user = await userWith({ phone: "+14155550123" });
    t.publisher.down = true;

    const { notifications } = await t.notifications.send({ userId: user.id, channel: "sms", payload });

    expect(notifications).toHaveLength(1);
    expect(t.notificationRows.rows[0]!.publishedAt).toBeNull(); // nothing lost, just not queued yet
  });

  it("rejects an unknown user and stores nothing", async () => {
    await expect(t.notifications.send({ userId: "999", channel: "email", payload })).rejects.toBeInstanceOf(UnknownUserError);
    expect(t.notificationRows.rows).toHaveLength(0);
  });

  it.each([
    ["email", { phone: "+14155550123" }],
    ["sms", { email: "a@x.com" }],
    ["push", { email: "a@x.com" }], // no devices
  ] as const)("rejects %s when the user has no destination for it", async (channel, contact) => {
    const user = await userWith(contact);
    await expect(t.notifications.send({ userId: user.id, channel, payload })).rejects.toBeInstanceOf(NoDestinationError);
    expect(t.notificationRows.rows).toHaveLength(0);
  });
});

describe("NotificationService.relayUnpublished", () => {
  it("queues notifications that were stored while the broker was down", async () => {
    const user = await userWith({ email: "a@x.com" });
    t.publisher.down = true;
    await t.notifications.send({ userId: user.id, channel: "email", payload });
    expect(t.publisher.published).toHaveLength(0);

    t.publisher.down = false; // broker recovers
    expect(await t.notifications.relayUnpublished(0)).toBe(1);

    expect(t.publisher.published).toHaveLength(1);
    expect(t.notificationRows.rows[0]!.publishedAt).not.toBeNull();
  });

  it("does nothing once everything is published", async () => {
    const user = await userWith({ email: "a@x.com" });
    await t.notifications.send({ userId: user.id, channel: "email", payload });
    expect(await t.notifications.relayUnpublished(0)).toBe(0);
    expect(t.publisher.published).toHaveLength(1);
  });

  it("leaves rows unpublished while the broker is still down", async () => {
    const user = await userWith({ email: "a@x.com" });
    t.publisher.down = true;
    await t.notifications.send({ userId: user.id, channel: "email", payload });
    expect(await t.notifications.relayUnpublished(0)).toBe(0);
    expect(t.notificationRows.rows[0]!.publishedAt).toBeNull();
  });
});
