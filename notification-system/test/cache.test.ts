import { Redis } from "ioredis";
import { afterAll, describe, expect, it } from "vitest";
import { RedisCache } from "../src/infra/cache.js";
import { silentLogger } from "./fakes.js";

// A Redis that fails every command, like one that is down or too slow.
const broken = new Proxy({}, { get: () => async () => { throw new Error("redis down"); } }) as unknown as Redis;

describe("RedisCache when Redis is failing", () => {
  const cache = new RedisCache(broken, silentLogger);

  it("reports a miss on read instead of throwing", async () => {
    expect(await cache.get("k")).toBeNull();
  });

  it("ignores failed writes and invalidations instead of throwing", async () => {
    await expect(cache.set("k", "v", 60)).resolves.toBeUndefined();
    await expect(cache.del("k")).resolves.toBeUndefined();
  });
});

// Integration test against a real Redis. Skipped unless TEST_REDIS_URL is set, e.g.:
//   npm run test:integration
const url = process.env.TEST_REDIS_URL;

describe.skipIf(!url)("RedisCache (real Redis)", () => {
  const redis = new Redis(url!);
  const cache = new RedisCache(redis, silentLogger);
  const key = `test:cache:${Date.now()}`;
  afterAll(async () => {
    await redis.del(key);
    redis.disconnect();
  });

  it("stores a value with an expiry, reads it back and deletes it", async () => {
    expect(await cache.get(key)).toBeNull();
    await cache.set(key, "value", 60);
    expect(await cache.get(key)).toBe("value");
    expect(await redis.ttl(key)).toBeGreaterThan(0);
    await cache.del(key);
    expect(await cache.get(key)).toBeNull();
  });

  it("a value expires after its time limit", async () => {
    await cache.set(key, "value", 1);
    // Wait until Redis says the key is gone, instead of sleeping for a guessed time: Redis counts
    // the time with its own clock (inside Docker), which can run a little differently from ours.
    const end = Date.now() + 5000;
    while ((await cache.get(key)) !== null) {
      if (Date.now() > end) throw new Error("the value did not expire");
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(await cache.get(key)).toBeNull();
  });
});
