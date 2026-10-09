import request from "supertest";
import { describe, expect, it } from "vitest";
import { runHealthChecks } from "../src/infra/health.js";
import { buildServer } from "../src/api/server.js";
import { loadConfig } from "../src/infra/config.js";
import { InMemoryUserRepository } from "./fakes.js";

const up = { name: "up", check: async () => {} };
const down = { name: "down", check: async () => { throw new Error("boom"); } };
const hung = { name: "hung", check: () => new Promise<void>(() => {}) };

describe("runHealthChecks", () => {
  it("is ok when every dependency is up", async () => {
    expect(await runHealthChecks([up])).toEqual({ ok: true, checks: { up: "up" } });
  });

  it("reports a failing dependency as down", async () => {
    const report = await runHealthChecks([up, down]);
    expect(report.ok).toBe(false);
    expect(report.checks).toEqual({ up: "up", down: "down" });
  });

  it("treats a hung dependency as down instead of hanging", async () => {
    const report = await runHealthChecks([hung], 50);
    expect(report.checks.hung).toBe("down");
  });
});

describe("GET /health", () => {
  it("returns 200 when healthy and 503 when a dependency is down", async () => {
    const healthy = buildServer({ logLevel: "silent", healthChecks: [up], users: new InMemoryUserRepository() });
    expect((await request(healthy).get("/health")).status).toBe(200);

    const unhealthy = buildServer({ logLevel: "silent", healthChecks: [down], users: new InMemoryUserRepository() });
    expect((await request(unhealthy).get("/health")).status).toBe(503);
  });
});

describe("loadConfig", () => {
  it("rejects a missing DATABASE_URL", () => {
    expect(() => loadConfig({})).toThrow(/Invalid configuration/);
  });
});
