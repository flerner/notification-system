import { beforeEach, describe, expect, it } from "vitest";
import { authed, buildTestApp } from "./fakes.js";

let t: ReturnType<typeof buildTestApp>;
beforeEach(() => {
  t = buildTestApp();
});

describe("settings endpoints", () => {
  it("everything is on until the user chooses otherwise", async () => {
    const user = await t.users.createUser({ email: "a@x.com" });
    const res = await authed(t.app).get(`/users/${user.id}/settings`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ userId: user.id, push: true, sms: true, email: true });
  });

  it("opts a user out of one channel only, and back in", async () => {
    const user = await t.users.createUser({ email: "a@x.com" });
    const out = await authed(t.app).put(`/users/${user.id}/settings/sms`).send({ optIn: false });
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ userId: user.id, channel: "sms", optIn: false });
    expect((await authed(t.app).get(`/users/${user.id}/settings`)).body).toMatchObject({ sms: false, email: true, push: true });

    await authed(t.app).put(`/users/${user.id}/settings/sms`).send({ optIn: true });
    expect((await authed(t.app).get(`/users/${user.id}/settings`)).body.sms).toBe(true);
  });

  it("404 for an unknown user", async () => {
    expect((await authed(t.app).get("/users/999/settings")).status).toBe(404);
    expect((await authed(t.app).put("/users/999/settings/email").send({ optIn: false })).status).toBe(404);
  });

  it.each([
    ["an unknown channel", "/users/1/settings/pigeon", { optIn: true }],
    ["a missing optIn", "/users/1/settings/email", {}],
    ["optIn that is not a boolean", "/users/1/settings/email", { optIn: "no" }],
    ["a non-numeric user id", "/users/abc/settings/email", { optIn: true }],
  ])("rejects %s with 400", async (_name, url, body) => {
    expect((await authed(t.app).put(url).send(body)).status).toBe(400);
  });
});

describe("template endpoints", () => {
  const put = (name: string, channel: string, body: object) => authed(t.app).put(`/v1/templates/${name}/${channel}`).send(body);

  it("creates, reads and updates a template", async () => {
    const created = await put("welcome", "email", { subject: "Hi {{name}}", body: "Welcome {{name}}" });
    expect(created.status).toBe(200);
    expect(created.body).toEqual({ name: "welcome", channel: "email", subject: "Hi {{name}}", body: "Welcome {{name}}" });

    await put("welcome", "email", { body: "Updated" });
    const read = await authed(t.app).get("/v1/templates/welcome/email");
    expect(read.status).toBe(200);
    expect(read.body.body).toBe("Updated");
  });

  it("404 for a template that does not exist for that channel", async () => {
    await put("welcome", "email", { body: "x" });
    expect((await authed(t.app).get("/v1/templates/welcome/sms")).status).toBe(404);
  });

  it.each([
    ["an empty body", "welcome", "email", { body: "" }],
    ["a missing body", "welcome", "email", {}],
    ["a bad channel", "welcome", "pigeon", { body: "x" }],
    ["a bad name", "Not A Name", "email", { body: "x" }],
  ])("rejects %s with 400", async (_n, name, channel, body) => {
    expect((await put(name, channel, body)).status).toBe(400);
  });
});

describe("POST /v1/notifications with a template", () => {
  const send = (payload: object) => authed(t.app).post("/v1/notifications").send(payload);

  beforeEach(async () => {
    await authed(t.app).put("/v1/templates/shipped/email").send({ subject: "Order {{order}}", body: "Hi {{name}}" });
  });

  it("renders the template with the params", async () => {
    const user = await t.users.createUser({ email: "a@x.com" });
    const res = await send({ userId: user.id, channel: "email", template: "shipped", params: { name: "Ana", order: 5 } });

    expect(res.status).toBe(202);
    expect(t.notificationRows.rows[0]!.payload).toEqual({ subject: "Order 5", body: "Hi Ana" });
  });

  it("422 for an unknown template and for a missing parameter", async () => {
    const user = await t.users.createUser({ email: "a@x.com" });
    expect((await send({ userId: user.id, channel: "email", template: "nope", params: {} })).status).toBe(422);
    const missing = await send({ userId: user.id, channel: "email", template: "shipped", params: { name: "Ana" } });
    expect(missing.status).toBe(422);
    expect(missing.body.error).toContain("order");
  });

  it.each([
    ["neither body nor template", { channel: "email" }],
    ["a template together with a body", { channel: "email", template: "shipped", body: "x" }],
    ["a template together with a subject", { channel: "email", template: "shipped", subject: "x" }],
    ["params without a template", { channel: "email", body: "x", params: { a: 1 } }],
    ["a param value that is an object", { channel: "email", template: "shipped", params: { a: { b: 1 } } }],
  ])("rejects %s with 400", async (_n, payload) => {
    expect((await send({ userId: "1", ...payload })).status).toBe(400);
  });
});
