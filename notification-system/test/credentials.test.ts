import { beforeEach, describe, expect, it } from "vitest";
import { authenticate, generateCredentials, hashSecret } from "../src/clients/credentials.js";
import { InMemoryClientRepository } from "./fakes.js";

describe("hashSecret", () => {
  it("is deterministic and does not contain the secret", () => {
    expect(hashSecret("s3cret")).toBe(hashSecret("s3cret"));
    expect(hashSecret("s3cret")).not.toContain("s3cret");
    expect(hashSecret("s3cret")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs for different secrets", () => {
    expect(hashSecret("a")).not.toBe(hashSecret("b"));
  });
});

describe("generateCredentials", () => {
  it("makes a key and a long random secret, different every time", () => {
    const a = generateCredentials();
    const b = generateCredentials();
    expect(a.appKey).toMatch(/^ak_[0-9a-f]{24}$/);
    expect(a.secret).toMatch(/^sk_[A-Za-z0-9_-]{43}$/); // 32 random bytes
    expect(a.appKey).not.toBe(b.appKey);
    expect(a.secret).not.toBe(b.secret);
  });
});

describe("authenticate", () => {
  let clients: InMemoryClientRepository;
  beforeEach(async () => {
    clients = new InMemoryClientRepository();
    await clients.create({ appKey: "billing", name: "Billing service", secretHash: hashSecret("right") });
  });

  it("accepts the right key and secret", async () => {
    expect(await authenticate(clients, "billing", "right")).toEqual({ id: "billing", name: "Billing service" });
  });

  it("refuses a wrong secret", async () => {
    expect(await authenticate(clients, "billing", "wrong")).toBeNull();
  });

  it("refuses an unknown key", async () => {
    expect(await authenticate(clients, "nobody", "right")).toBeNull();
  });

  it("refuses a revoked client even with the right secret", async () => {
    clients.revoke("billing");
    expect(await authenticate(clients, "billing", "right")).toBeNull();
  });

  it("refuses an empty secret", async () => {
    expect(await authenticate(clients, "billing", "")).toBeNull();
  });
});
