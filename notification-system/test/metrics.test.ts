import http from "node:http";
import { Registry } from "prom-client";
import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { createRegistry, startMetricsServer } from "../src/infra/metrics.js";
import { httpMetrics } from "../src/api/http-metrics.js";
import type { Redis } from "ioredis";
import { RedisCache } from "../src/infra/cache.js";
import { NotificationMetrics } from "../src/notifications/metrics.js";
import { RedisRateLimiter } from "../src/notifications/rate-limit.js";
import { NotificationProcessor } from "../src/notifications/processor.js";
import { DEAD_LETTER_QUEUE } from "../src/notifications/queues.js";
import { RetryPolicy } from "../src/notifications/retry.js";
import { CircuitBreaker } from "../src/providers/circuit-breaker.js";
import { GuardedProvider } from "../src/providers/guarded.js";
import { ProviderError, type ChannelProvider, type DeliveryRequest } from "../src/providers/provider.js";
import { registerCircuitGauge } from "../src/worker/metrics.js";
import {
  authed,
  buildTestApp,
  FakePublisher,
  InMemoryNotificationRepository,
  InMemoryRateLimiter,
  InMemorySettingsRepository,
  silentLogger,
} from "./fakes.js";

// Current value of one series, or 0 if it has never been used. A histogram is one metric whose
// series are named name_count, name_sum and name_bucket, so series are searched by their own name.
async function value(registry: Registry, name: string, labels: Record<string, string> = {}): Promise<number> {
  const series = (await registry.getMetricsAsJSON())
    .flatMap((m) => m.values.map((v) => ({ name: (v as { metricName?: string }).metricName ?? m.name, labels: v.labels as Record<string, string>, value: v.value })))
    .filter((v) => v.name === name && Object.entries(labels).every(([k, want]) => v.labels[k] === want));
  return series.reduce((sum, v) => sum + v.value, 0);
}
// Number of observations recorded in a histogram.
const observations = (registry: Registry, name: string, labels: Record<string, string> = {}) =>
  value(registry, `${name}_count`, labels);

describe("pipeline metrics, seen through the processor", () => {
  class Scripted implements ChannelProvider {
    name = "mock-email";
    behaviour: () => Promise<void> = async () => {};
    async send(_req: DeliveryRequest) {
      return this.behaviour();
    }
  }
  const transient = () => Promise.reject(new ProviderError("503", true));
  const permanent = () => Promise.reject(new ProviderError("invalid token", false));

  let registry: Registry;
  let repo: InMemoryNotificationRepository;
  let settings: InMemorySettingsRepository;
  let limiter: InMemoryRateLimiter;
  let provider: Scripted;
  let breaker: CircuitBreaker;
  let processor: NotificationProcessor;

  // One NotificationMetrics per registry: registering the same metric names twice would be an error.
  let metrics: NotificationMetrics;
  const build = () =>
    new NotificationProcessor(
      repo,
      settings,
      limiter,
      { email: new GuardedProvider(provider, breaker, 1000) },
      new FakePublisher(),
      new RetryPolicy([1000, 5000]),
      silentLogger,
      1000,
      metrics,
    );
  const store = () =>
    repo
      .insertPending([{ requestId: "r", userId: "1", clientId: "c", channel: "email", platform: null, destination: "a@x.com", queue: "email", payload: { body: "B" } }])
      .then(([n]) => n!);

  beforeEach(() => {
    registry = new Registry();
    metrics = new NotificationMetrics(registry);
    repo = new InMemoryNotificationRepository();
    settings = new InMemorySettingsRepository();
    limiter = new InMemoryRateLimiter();
    provider = new Scripted();
    breaker = new CircuitBreaker({ failureThreshold: 100, cooldownMs: 1000 });
    processor = build();
  });

  it("counts a delivery, times the provider call and the whole journey", async () => {
    await processor.process((await store()).id, "email");

    expect(await value(registry, "notifications_sent_total", { channel: "email" })).toBe(1);
    expect(await observations(registry, "provider_call_duration_seconds", { provider: "mock-email", outcome: "ok" })).toBe(1);
    expect(await observations(registry, "notification_end_to_end_seconds", { channel: "email" })).toBe(1);
  });

  it("counts a retry that was scheduled, and the failed provider call", async () => {
    provider.behaviour = transient;
    await processor.process((await store()).id, "email");

    expect(await value(registry, "notification_retries_total", { channel: "email" })).toBe(1);
    expect(await observations(registry, "provider_call_duration_seconds", { outcome: "error" })).toBe(1);
    expect(await value(registry, "notifications_sent_total")).toBe(0);
  });

  it("counts giving up, with the reason", async () => {
    provider.behaviour = permanent;
    await processor.process((await store()).id, "email");
    expect(await value(registry, "notifications_failed_total", { channel: "email", reason: "permanent" })).toBe(1);

    provider.behaviour = transient;
    const n = await store();
    for (let i = 0; i < 3; i++) await processor.process(n.id, "email"); // 3 attempts is the maximum here
    expect(await value(registry, "notifications_failed_total", { channel: "email", reason: "exhausted" })).toBe(1);
    expect(await value(registry, "notification_retries_total", { channel: "email" })).toBe(2);
  });

  it("counts a skip, by reason", async () => {
    const optedOut = await store();
    settings.optedOut.add(`${optedOut.userId}:email`);
    await processor.process(optedOut.id, "email");
    settings.optedOut.clear();
    expect(await value(registry, "notifications_skipped_total", { channel: "email", reason: "opt_out" })).toBe(1);

    limiter = new InMemoryRateLimiter({ max: 0, windowSeconds: 60 });
    processor = build();
    await processor.process((await store()).id, "email");
    expect(await value(registry, "notifications_skipped_total", { channel: "email", reason: "rate_limit" })).toBe(1);
  });

  it("counts a duplicate message that was dropped", async () => {
    const n = await store();
    await processor.process(n.id, "email");
    await processor.process(n.id, "email");
    expect(await value(registry, "notifications_deduplicated_total", { layer: "claim" })).toBe(1);
    expect(await value(registry, "notifications_sent_total")).toBe(1); // sent once, not twice
  });

  it("counts a message held back by an open circuit", async () => {
    breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 10_000 });
    processor = build();
    provider.behaviour = transient;
    await processor.process((await store()).id, "email"); // opens the circuit

    await processor.process((await store()).id, "email");

    expect(await value(registry, "notification_circuit_held_total", { queue: "email" })).toBe(1);
  });

  it("does not touch the dead-letter queue when counting (it is the broker's number, not ours)", async () => {
    expect(DEAD_LETTER_QUEUE).toBe("dead-letter");
    expect((await registry.getMetricsAsJSON()).some((m) => m.name.includes("dead"))).toBe(false);
  });
});

// A Redis that fails every command, like one that is down or too slow.
const brokenRedis = new Proxy({}, { get: () => async () => { throw new Error("redis down"); } }) as unknown as Redis;

describe("Redis failures that are absorbed are still counted", () => {
  it("counts each call the rate limiter lets through because Redis is down", async () => {
    const registry = new Registry();
    const limits = { push: { max: 1, windowSeconds: 60 }, sms: { max: 1, windowSeconds: 60 }, email: { max: 1, windowSeconds: 60 } };
    const limiter = new RedisRateLimiter(brokenRedis, limits, silentLogger, new NotificationMetrics(registry));

    expect(await limiter.allow("1", "email")).toBe(true);
    expect(await limiter.allow("1", "email")).toBe(true); // over the limit of 1, but nothing can be checked

    expect(await value(registry, "redis_errors_total", { component: "rate_limiter" })).toBe(2);
  });

  it("counts failed cache reads, writes and invalidations", async () => {
    const registry = new Registry();
    const cache = new RedisCache(brokenRedis, silentLogger, new NotificationMetrics(registry));

    await cache.get("k");
    await cache.set("k", "v", 60);
    await cache.del("k");

    expect(await value(registry, "redis_errors_total", { component: "template_cache" })).toBe(3);
  });
});

describe("circuit state gauge", () => {
  it("reports each provider's breaker at the moment of the scrape", async () => {
    const registry = new Registry();
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 10_000 });
    const guarded = new GuardedProvider({ name: "mock-sms", send: async () => {} }, breaker, 1000);
    registerCircuitGauge(registry, { sms: guarded });

    expect(await value(registry, "provider_circuit_state", { provider: "mock-sms" })).toBe(0);
    breaker.recordFailure();
    expect(await value(registry, "provider_circuit_state", { provider: "mock-sms" })).toBe(2);
  });
});

describe("API metrics", () => {
  it("counts accepted notifications per channel and recognised retries", async () => {
    const registry = new Registry();
    const t = buildTestApp();
    const metrics = new NotificationMetrics(registry);
    // a service wired with metrics, over the same fakes
    const { NotificationService } = await import("../src/notifications/service.js");
    const service = new NotificationService(t.users, t.notificationRows, t.templates, t.publisher, silentLogger, metrics);
    const user = await t.users.createUser({ email: "a@x.com" });
    const send = () => service.send({ clientId: "c", userId: user.id, channel: "email", content: { kind: "text", body: "hi" } }, "evt-1");

    await send();
    await send(); // the same Idempotency-Key again

    expect(await value(registry, "notifications_accepted_total", { channel: "email" })).toBe(1);
    expect(await value(registry, "notifications_deduplicated_total", { layer: "request" })).toBe(1);
  });

  it("labels requests by route pattern, not by URL, so ids do not create new series", async () => {
    const registry = new Registry();
    const t = buildTestApp();
    const { buildServer } = await import("../src/api/server.js");
    const app = buildServer({ logger: silentLogger, healthChecks: [], users: t.users, notifications: t.notifications, settings: t.settings, templates: t.templates, clients: t.clients, registry });
    const user = await t.users.createUser({ email: "a@x.com" });

    for (let i = 0; i < 3; i++) await authed(app).get(`/users/${user.id}/settings`);
    await authed(app).get("/users/999/settings"); // another id, same route

    const route = "/users/:id/settings";
    expect(await value(registry, "http_requests_total", { method: "GET", route, status: "200" })).toBe(3);
    expect(await value(registry, "http_requests_total", { method: "GET", route, status: "404" })).toBe(1);
    const labels = (await registry.getMetricsAsJSON()).flatMap((m) => m.values.map((v) => (v.labels as Record<string, string>).route));
    expect(labels.filter((r) => r?.includes(user.id) || r?.includes("999"))).toEqual([]);
    expect(await observations(registry, "http_request_duration_seconds", { route })).toBe(4);
  });

  it("labels refused and unknown requests by why they were not handled", async () => {
    const registry = new Registry();
    const t = buildTestApp();
    const { buildServer } = await import("../src/api/server.js");
    const app = buildServer({ logger: silentLogger, healthChecks: [], users: t.users, notifications: t.notifications, settings: t.settings, templates: t.templates, clients: t.clients, registry });

    await request(app).post("/users").send({}); // no credentials
    await authed(app).get("/no/such/route");

    expect(await value(registry, "http_requests_total", { route: "unauthenticated", status: "401" })).toBe(1);
    expect(await value(registry, "http_requests_total", { route: "unmatched", status: "404" })).toBe(1);
  });
});

describe("the metrics server", () => {
  const get = (port: number, path: string, method = "GET") =>
    new Promise<{ status: number; body: string; type: string }>((resolve, reject) => {
      http.request({ port, path, method }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode!, body, type: String(res.headers["content-type"]) }));
      }).on("error", reject).end();
    });

  it("serves the registry on /metrics in Prometheus format, and nothing else", async () => {
    const registry = createRegistry();
    new NotificationMetrics(registry).sent("email", 1.5);
    const server = startMetricsServer(registry, 0);
    await new Promise((r) => server.once("listening", r));
    const port = (server.address() as { port: number }).port;
    try {
      const ok = await get(port, "/metrics");
      expect(ok.status).toBe(200);
      expect(ok.type).toContain("text/plain");
      expect(ok.body).toContain('notifications_sent_total{channel="email"} 1');
      expect(ok.body).toContain("process_cpu_user_seconds_total"); // the standard process metrics are included
      expect((await get(port, "/anything-else")).status).toBe(404);
      expect((await get(port, "/metrics", "POST")).status).toBe(404);
    } finally {
      server.close();
    }
  });
});
