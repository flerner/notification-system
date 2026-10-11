import type { Redis } from "ioredis";
import type { Logger } from "pino";

// A cache is an optimisation, never a dependency: if it is slow or down, callers must still work
// by reading the source of truth. So these methods never throw; a failed read is a miss.
export interface Cache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
}

export class RedisCache implements Cache {
  constructor(
    private readonly redis: Redis,
    private readonly log: Logger,
  ) {}

  async get(key: string): Promise<string | null> {
    try {
      return await this.redis.get(key);
    } catch (err) {
      this.log.warn({ err, key }, "cache read failed, using the database");
      return null;
    }
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    try {
      await this.redis.set(key, value, "EX", ttlSeconds);
    } catch (err) {
      this.log.warn({ err, key }, "cache write failed");
    }
  }

  async del(key: string): Promise<void> {
    try {
      await this.redis.del(key);
    } catch (err) {
      // The entry may stay stale until its TTL runs out.
      this.log.warn({ err, key }, "cache invalidation failed");
    }
  }
}
