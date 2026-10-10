import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { buildTestApp } from "./fakes.js";

let app: ReturnType<typeof buildTestApp>["app"];
beforeEach(() => {
  app = buildTestApp().app;
});

const createUser = (payload: object) => request(app).post("/users").send(payload);

describe("POST /users", () => {
  it("creates a user with an email, lowercasing it", async () => {
    const res = await createUser({ email: "Ana@Example.com" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ email: "ana@example.com", phone: null });
  });

  it.each([
    ["no contact at all", {}],
    ["an invalid email", { email: "not-an-email" }],
    ["a phone without country code", { phone: "4155550123" }],
    ["a phone with letters", { phone: "+1415abc" }],
  ])("rejects %s with 400", async (_name, payload) => {
    expect((await createUser(payload)).status).toBe(400);
  });

  it("rejects malformed JSON with 400", async () => {
    const res = await request(app).post("/users").set("content-type", "application/json").send("{not json");
    expect(res.status).toBe(400);
  });

  it("returns 409 when the email differs only by case", async () => {
    await createUser({ email: "ana@example.com" });
    expect((await createUser({ email: "ANA@example.com" })).status).toBe(409);
  });
});

describe("POST /users/:id/devices", () => {
  const register = (id: string, payload: object) => request(app).post(`/users/${id}/devices`).send(payload);

  it("registers a device for an existing user", async () => {
    const { id } = (await createUser({ email: "a@x.com" })).body;
    const res = await register(id, { platform: "ios", token: "tok-1" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ userId: id, platform: "ios", token: "tok-1" });
  });

  it("is idempotent: registering the same token twice yields the same device", async () => {
    const { id } = (await createUser({ email: "a@x.com" })).body;
    const first = (await register(id, { platform: "ios", token: "tok-1" })).body;
    const second = (await register(id, { platform: "ios", token: "tok-1" })).body;
    expect(second.id).toBe(first.id);
  });

  it("returns 404 for an unknown user", async () => {
    expect((await register("999", { platform: "ios", token: "t" })).status).toBe(404);
  });

  it("rejects an unknown platform and a non-numeric user id with 400", async () => {
    const { id } = (await createUser({ email: "a@x.com" })).body;
    expect((await register(id, { platform: "blackberry", token: "t" })).status).toBe(400);
    expect((await register("abc", { platform: "ios", token: "t" })).status).toBe(400);
  });
});
