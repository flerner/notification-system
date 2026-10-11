import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { buildTestApp } from "./fakes.js";

let t: ReturnType<typeof buildTestApp>;
beforeEach(() => {
  t = buildTestApp();
});

const send = (payload: object) => request(t.app).post("/v1/notifications").send(payload);

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
    request(t.app).post("/v1/notifications").set("Idempotency-Key", key).send(payload);

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
