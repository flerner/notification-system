import type { Redis } from "ioredis";
import type { Logger } from "pino";
import { NotificationMetrics } from "./metrics.js";
import type { Channel } from "./queues.js";

export interface RateLimit {
  max: number;
  windowSeconds: number;
}

export type RateLimits = Record<Channel, RateLimit>;

export function parseRateLimit(spec: string): RateLimit {
  const [max, windowSeconds] = spec.split("/").map(Number);
  return { max: max!, windowSeconds: windowSeconds! };
}

export interface RateLimiter {
  allow(userId: string, channel: Channel): Promise<boolean>;
  limitFor(channel: Channel): RateLimit;
}

// One Lua script does INCR and EXPIRE together. Redis runs a script without interleaving other
// commands, so (1) concurrent workers each get a distinct count, and exactly `max` of them are
// allowed; and (2) a counter can never be left without an expiry, which would block the user for
// good. The TTL check also repairs a counter that somehow lost its expiry.
const COUNT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 or redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return count
`;

export class RedisRateLimiter implements RateLimiter {
  constructor(
    private readonly redis: Redis,
    private readonly limits: RateLimits,
    private readonly log: Logger,
    private readonly metrics: NotificationMetrics = new NotificationMetrics(),
  ) {}

  limitFor(channel: Channel): RateLimit {
    return this.limits[channel];
  }

  async allow(userId: string, channel: Channel): Promise<boolean> {
    const { max, windowSeconds } = this.limits[channel];
    try {
      const count = (await this.redis.eval(
        COUNT,
        1,
        `ratelimit:${channel}:${userId}`,
        windowSeconds,
      )) as number;
      return count <= max;
    } catch (err) {
      this.log.warn(
        { err, userId, channel },
        "rate limiter unavailable, allowing the notification",
      );
      this.metrics.redisError("rate_limiter");
      return true;
    }
  }
}
