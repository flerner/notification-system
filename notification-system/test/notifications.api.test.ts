import { beforeEach, describe, expect, it } from "vitest";
import { authed, buildTestApp } from "./fakes.js";

let t: ReturnType<typeof buildTestApp>;
beforeEach(() => {
  t = buildTestApp();
});

const send = (payload: object) => authed(t.app).post("/v1/notifications").send(payload);

describe("POST /v1/notifications", () => {
  it("answers 202 with the created notifications", async () => {
    const user = await t.users.createUser({ email: "a@x.com" });
    const res = await send({ userId: user.id, channel: "email", subject: "Hi", body: "hello" });

    expect(res.status).toBe(202);
    expect(res.body.requestId).toBeTruthy();
    expect(res.body.notifications).toEqual([
      expect.objectContaining({ channel: "email", platform: null, status: "PENDING" }),
    ]);
  });

  it("answers 202 even when the broker is down, because the notification is safely stored", async () => {
    const user = await t.users.createUser({ email: "a@x.com" });
    t.publisher.down = true;
    expect((await send({ userId: user.id, channel: "email", body: "hello" })).status).toBe(202);
  });

  it("answers 404 for an unknown user", async () => {
    expect((await send({ userId: "999", channel: "email", body: "x" })).status).toBe(404);
  });

  it("answers 422 when the user cannot be reached on that channel", async () => {
    const user = await t.users.createUser({ email: "a@x.com" });
    expect((await send({ userId: user.id, channel: "sms", body: "x" })).status).toBe(422);
  });

  it.each([
    ["an unknown channel", { userId: "1", channel: "pigeon", body: "x" }],
    ["an empty body", { userId: "1", channel: "email", body: "" }],
    ["a missing body", { userId: "1", channel: "email" }],
    ["a non-numeric userId", { userId: "abc", channel: "email", body: "x" }],
  ])("rejects %s with 400", async (_name, payload) => {
    expect((await send(payload)).status).toBe(400);
  });
});

describe("Idempotency-Key header", () => {
  const sendWithKey = (key: string, payload: object) =>
    authed(t.app).post("/v1/notifications").set("Idempotency-Key", key).send(payload);

  it("replays the original answer on a retry and says so", async () => {
    const user = await t.users.createUser({ email: "a@x.com" });
    const body = { userId: user.id, channel: "email", body: "hello" };

    const first = await sendWithKey("evt-1", body);
    const retry = await sendWithKey("evt-1", body);

    expect(first.status).toBe(202);
    expect(first.headers["idempotent-replayed"]).toBeUndefined();
    expect(retry.status).toBe(202);
    expect(retry.headers["idempotent-replayed"]).toBe("true");
    expect(retry.body.requestId).toBe(first.body.requestId);
    expect(retry.body.notifications[0].id).toBe(first.body.notifications[0].id);
    expect(t.notificationRows.rows).toHaveLength(1);
  });

  it("answers 422 when the key is reused with a different request", async () => {
    const user = await t.users.createUser({ email: "a@x.com" });
    await sendWithKey("evt-1", { userId: user.id, channel: "email", body: "hello" });
    const res = await sendWithKey("evt-1", { userId: user.id, channel: "email", body: "different" });
    expect(res.status).toBe(422);
  });

  it("rejects an over-long key with 400", async () => {
    const user = await t.users.createUser({ email: "a@x.com" });
    const res = await sendWithKey("k".repeat(256), { userId: user.id, channel: "email", body: "x" });
    expect(res.status).toBe(400);
  });
});

describe("sendAt", () => {
  const HOUR = 60 * 60 * 1000;
  const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
  const sendWith = (extra: object) => authed(t.app).post("/v1/notifications").send({ channel: "email", body: "hi", ...extra });

  it("a time in the future is accepted, answered with 202 and the time, and not queued", async () => {
    const user = await t.users.createUser({ email: "a@x.com" });
    const at = iso(HOUR);
    const res = await sendWith({ userId: user.id, sendAt: at });

    expect(res.status).toBe(202);
    expect(res.body.notifications[0]).toMatchObject({ status: "PENDING", sendAt: at });
    expect(t.publisher.published).toHaveLength(0);
  });

  it("a time in the past is accepted and sent now", async () => {
    const user = await t.users.createUser({ email: "a@x.com" });
    const res = await sendWith({ userId: user.id, sendAt: iso(-HOUR) });
    expect(res.status).toBe(202);
    expect(t.publisher.published).toHaveLength(1);
  });

  it("accepts a time written with an offset instead of Z, and keeps it as the same moment", async () => {
    const user = await t.users.createUser({ email: "a@x.com" });
    const instant = new Date(Date.now() + HOUR);
    const withOffset = new Date(instant.getTime() + 2 * HOUR).toISOString().replace("Z", "+02:00"); // same instant, written two hours ahead
    const res = await sendWith({ userId: user.id, sendAt: withOffset });

    expect(res.status).toBe(202);
    expect(res.body.notifications[0].sendAt).toBe(instant.toISOString());
  });

  it.each([
    ["a date that is not a time", "next tuesday"],
    ["a time without an offset", "2026-11-01T09:00:00"],
    ["a plain date", "2026-11-01"],
    ["a number", 1893456000],
  ])("rejects %s with 400", async (_name, bad) => {
    const user = await t.users.createUser({ email: "a@x.com" });
    expect((await sendWith({ userId: user.id, sendAt: bad })).status).toBe(400);
  });

  it("rejects a time more than 30 days ahead, but accepts one just inside the limit", async () => {
    const user = await t.users.createUser({ email: "a@x.com" });
    expect((await sendWith({ userId: user.id, sendAt: iso(31 * 24 * HOUR) })).status).toBe(400);
    expect((await sendWith({ userId: user.id, sendAt: iso(29 * 24 * HOUR) })).status).toBe(202);
  });
});
