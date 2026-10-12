import { Redis } from "ioredis";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/infra/config.js";
import { parseRateLimit, RedisRateLimiter } from "../src/notifications/rate-limit.js";
import { silentLogger } from "./fakes.js";

describe("parseRateLimit", () => {
  it("reads max and window seconds", () => {
    expect(parseRateLimit("20/3600")).toEqual({ max: 20, windowSeconds: 3600 });
  });
});

describe("rate limit configuration", () => {
  const env = { DATABASE_URL: "postgres://x/y", REDIS_URL: "redis://x", RABBITMQ_URL: "amqp://x" };

  it("has a limit for each channel by default", () => {
    const c = loadConfig(env);
    expect([c.RATE_LIMIT_PUSH, c.RATE_LIMIT_SMS, c.RATE_LIMIT_EMAIL]).toEqual(["20/3600", "5/3600", "10/3600"]);
  });

  it.each(["abc", "5", "5/", "/60", "0/60", "5/0", "-1/60", "5/60/1"])("rejects %s", (bad) => {
    expect(() => loadConfig({ ...env, RATE_LIMIT_SMS: bad })).toThrow(/Invalid configuration/);
  });
});

// A Redis that fails every command, like one that is down or too slow.
const broken = new Proxy({}, { get: () => async () => { throw new Error("redis down"); } }) as unknown as Redis;
const limits = { push: { max: 3, windowSeconds: 60 }, sms: { max: 2, windowSeconds: 60 }, email: { max: 3, windowSeconds: 60 } };

describe("RedisRateLimiter when Redis is failing", () => {
  it("allows the notification instead of blocking everything (fails open)", async () => {
    const limiter = new RedisRateLimiter(broken, limits, silentLogger);
    for (let i = 0; i < 10; i++) expect(await limiter.allow("1", "sms")).toBe(true);
  });

  it("reports the limit configured for each channel", () => {
    const limiter = new RedisRateLimiter(broken, limits, silentLogger);
    expect(limiter.limitFor("sms")).toEqual({ max: 2, windowSeconds: 60 });
  });
});

// Integration test against a real Redis (the counting is a Lua script, so only Redis can test it).
// Skipped unless TEST_REDIS_URL is set, e.g.:   TEST_REDIS_URL=redis://localhost:6379 npm test
const url = process.env.TEST_REDIS_URL;

describe.skipIf(!url)("RedisRateLimiter (real Redis)", () => {
  const redis = new Redis(url!);
  const run = `${Date.now()}`; // user ids are unique per run, so reruns never see old counters
  let n = 0;
  let user: string;
  const limiter = (windowSeconds = 60) =>
    new RedisRateLimiter(redis, { push: { max: 3, windowSeconds }, sms: { max: 3, windowSeconds }, email: { max: 3, windowSeconds } }, silentLogger);

  beforeEach(() => {
    user = `u${run}-${n++}`;
  });
  afterAll(async () => {
    for (const k of await redis.keys(`ratelimit:*:u${run}-*`)) await redis.del(k);
    redis.disconnect();
  });

  it("allows up to the limit, then refuses", async () => {
    const l = limiter();
    const results = [];
    for (let i = 0; i < 5; i++) results.push(await l.allow(user, "email"));
    expect(results).toEqual([true, true, true, false, false]);
  });

  it("of many concurrent callers, exactly `max` are allowed", async () => {
    const l = limiter();
    const results = await Promise.all(Array.from({ length: 50 }, () => l.allow(user, "email")));
    expect(results.filter(Boolean)).toHaveLength(3);
  });

  it("counts each user and each channel separately", async () => {
    const l = limiter();
    for (let i = 0; i < 3; i++) await l.allow(user, "email");
    expect(await l.allow(user, "email")).toBe(false);
    expect(await l.allow(user, "sms")).toBe(true); // another channel
    expect(await l.allow(`${user}-other`, "email")).toBe(true); // another user
  });

  it("starts counting again when the window ends", async () => {
    const l = limiter(1);
    for (let i = 0; i < 3; i++) await l.allow(user, "email");
    expect(await l.allow(user, "email")).toBe(false);

    await new Promise((r) => setTimeout(r, 1200));

    expect(await l.allow(user, "email")).toBe(true);
  });

  it("the counter always has an expiry, and the window starts at the first notification", async () => {
    const l = limiter(60);
    await l.allow(user, "push");
    const ttl = await redis.ttl(`ratelimit:push:${user}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
    await l.allow(user, "push"); // a later notification does not push the end of the window out
    expect(await redis.ttl(`ratelimit:push:${user}`)).toBeLessThanOrEqual(ttl);
  });

  it("repairs a counter that lost its expiry, so a user can never be blocked for good", async () => {
    await redis.set(`ratelimit:email:${user}`, "99"); // no TTL: as if the expiry had been lost
    const l = limiter(60);
    expect(await l.allow(user, "email")).toBe(false);
    expect(await redis.ttl(`ratelimit:email:${user}`)).toBeGreaterThan(0);
  });
});
