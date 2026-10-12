import { Writable } from "node:stream";
import { pino } from "pino";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { hashSecret } from "../src/clients/credentials.js";
import { authed, buildTestApp, TEST_KEY, TEST_SECRET } from "./fakes.js";

let t: ReturnType<typeof buildTestApp>;
beforeEach(() => {
  t = buildTestApp();
});

const basic = (key: string, secret: string) => `Basic ${Buffer.from(`${key}:${secret}`).toString("base64")}`;

// Every route family, so none is forgotten when a new one is added.
const protectedRoutes: [string, string][] = [
  ["POST", "/users"],
  ["POST", "/users/1/devices"],
  ["GET", "/users/1/settings"],
  ["PUT", "/users/1/settings/email"],
  ["POST", "/v1/notifications"],
  ["GET", "/v1/templates/welcome/email"],
  ["PUT", "/v1/templates/welcome/email"],
];

describe("routes that need a client", () => {
  it.each(protectedRoutes)("%s %s answers 401 without credentials", async (method, url) => {
    const res = await request(t.app)[method.toLowerCase() as "get"](url).send({});
    expect(res.status).toBe(401);
    expect(res.headers["www-authenticate"]).toContain("Basic");
  });

  it("accepts the right credentials", async () => {
    const res = await authed(t.app).post("/users").send({ email: "a@x.com" });
    expect(res.status).toBe(201);
  });

  it("stays open for the liveness and health checks, which orchestrators call without credentials", async () => {
    expect((await request(t.app).get("/live")).status).toBe(200);
    expect((await request(t.app).get("/health")).status).toBe(200);
  });
});

describe("every kind of bad credential gets the same answer", () => {
  const cases: [string, () => Record<string, string>][] = [
    ["no header", () => ({})],
    ["a different scheme", () => ({ Authorization: "Bearer abc" })],
    ["a header that is not base64 of key:secret", () => ({ Authorization: "Basic !!!" })],
    ["no separator", () => ({ Authorization: `Basic ${Buffer.from("justakey").toString("base64")}` })],
    ["an empty key", () => ({ Authorization: basic("", "secret") })],
    ["an unknown key", () => ({ Authorization: basic("nobody", TEST_SECRET) })],
    ["a wrong secret", () => ({ Authorization: basic(TEST_KEY, "wrong") })],
    ["an over-long header", () => ({ Authorization: "Basic " + "A".repeat(2000) })],
  ];

  it.each(cases)("%s: 401 with the same body", async (_name, headers) => {
    const res = await request(t.app).post("/users").set(headers()).send({ email: "a@x.com" });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "invalid credentials" }); // nothing says which part was wrong
  });

  it("a revoked client is refused at once", async () => {
    expect((await authed(t.app).get("/users/1/settings")).status).not.toBe(401);
    t.clients.revoke(TEST_KEY);
    const res = await authed(t.app).get("/users/1/settings");
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "invalid credentials" });
  });

  it("a secret containing a colon works: only the first colon separates key from secret", async () => {
    await t.clients.create({ appKey: "colon", name: "c", secretHash: hashSecret("pa:ss:word") });
    const res = await request(t.app).post("/users").auth("colon", "pa:ss:word").send({ email: "c@x.com" });
    expect(res.status).toBe(201);
  });

  it("is checked before the body is read: a broken body with no credentials is a 401, not a 400", async () => {
    const res = await request(t.app).post("/users").set("content-type", "application/json").send("{not json");
    expect(res.status).toBe(401);
  });
});

describe("what ends up in the logs", () => {
  function capture() {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, done) {
        lines.push(chunk.toString());
        done();
      },
    });
    return { logger: pino({ level: "info" }, stream), text: () => lines.join("") };
  }

  it("never contains the caller's secret or credentials header", async () => {
    const log = capture();
    const app = buildTestApp([], log.logger).app;
    await authed(app).post("/users").send({ email: "a@x.com" });
    await request(app).post("/users").auth(TEST_KEY, "a-wrong-secret-to-find").send({});

    expect(log.text()).toContain("/users"); // it did log the requests
    expect(log.text()).not.toContain(TEST_SECRET);
    expect(log.text()).not.toContain("a-wrong-secret-to-find");
    expect(log.text().toLowerCase()).not.toContain("authorization");
    expect(log.text()).not.toContain(Buffer.from(`${TEST_KEY}:${TEST_SECRET}`).toString("base64"));
  });

  it("says which client made each request", async () => {
    const log = capture();
    const app = buildTestApp([], log.logger).app;
    await authed(app).get("/users/1/settings");
    expect(log.text()).toContain(`"client":"${TEST_KEY}"`);
  });
});

describe("clients and idempotency keys", () => {
  const send = (key: string, secret: string, idempotencyKey: string, body: string, userId: string) =>
    request(t.app).post("/v1/notifications").auth(key, secret).set("Idempotency-Key", idempotencyKey)
      .send({ userId, channel: "email", body });

  beforeEach(async () => {
    await t.clients.create({ appKey: "client-b", name: "b", secretHash: hashSecret("b-secret") });
  });

  it("two clients can use the same key without affecting each other", async () => {
    const user = await t.users.createUser({ email: "a@x.com" });
    const a = await send(TEST_KEY, TEST_SECRET, "evt-1", "from A", user.id);
    const b = await send("client-b", "b-secret", "evt-1", "from B", user.id);

    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
    expect(b.headers["idempotent-replayed"]).toBeUndefined(); // not a replay of A's request
    expect(b.body.requestId).not.toBe(a.body.requestId);
    expect(t.notificationRows.rows).toHaveLength(2);
  });

  it("a client cannot replay, and so cannot read, another client's request", async () => {
    const user = await t.users.createUser({ email: "a@x.com" });
    const a = await send(TEST_KEY, TEST_SECRET, "evt-1", "secret message", user.id);
    const b = await send("client-b", "b-secret", "evt-1", "secret message", user.id);

    expect(b.body.requestId).not.toBe(a.body.requestId);
    expect(b.body.notifications[0].id).not.toBe(a.body.notifications[0].id);
  });

  it("each client still gets its own replay", async () => {
    const user = await t.users.createUser({ email: "a@x.com" });
    const first = await send("client-b", "b-secret", "evt-1", "hello", user.id);
    const retry = await send("client-b", "b-secret", "evt-1", "hello", user.id);
    expect(retry.headers["idempotent-replayed"]).toBe("true");
    expect(retry.body.requestId).toBe(first.body.requestId);
  });

  it("records which client asked for each notification", async () => {
    const user = await t.users.createUser({ email: "a@x.com" });
    await send(TEST_KEY, TEST_SECRET, "e1", "x", user.id);
    await send("client-b", "b-secret", "e2", "y", user.id);
    expect(t.notificationRows.rows.map((r) => r.clientId)).toEqual([TEST_KEY, "client-b"]);
  });
});
