import { z } from "zod";

const schema = z.object({
  PORT: z.coerce.number().int().default(3000),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  RABBITMQ_URL: z.string().url(),
  // The relay republishes notifications the broker never confirmed. MIN_AGE keeps it away from
  // publishes that are still in flight.
  RELAY_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  RELAY_MIN_AGE_MS: z.coerce.number().int().positive().default(10000),
  // How long a template stays cached. An update invalidates it immediately; this is the worst case
  // if that invalidation could not reach Redis.
  TEMPLATE_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  // Worker only. WORKER_QUEUES lets one process serve a subset (e.g. only "sms") so channels can
  // be scaled independently. Empty means all queues.
  WORKER_QUEUES: z.string().default("").transform((v) => v.split(",").map((q) => q.trim()).filter(Boolean)),
  WORKER_PREFETCH: z.coerce.number().int().positive().default(5),
  // How long a worker owns a notification it is sending. Must exceed the slowest provider call.
  // If a worker dies, its notification is picked up again after this long.
  CLAIM_LEASE_MS: z.coerce.number().int().positive().default(60000),
  // Retry backoff: one retry per delay, so N delays means N+1 attempts in total. Comma separated.
  // The api and the worker must agree on it (both declare the retry queues).
  RETRY_DELAYS_MS: z
    .string()
    .default("5000,30000,120000")
    .transform((v) => v.split(",").map((d) => Number(d.trim())))
    .refine((ds) => ds.length > 0 && ds.every((d) => Number.isInteger(d) && d > 0), {
      message: "must be a comma separated list of positive integers",
    }),
  // A provider call that takes longer than this counts as a (retryable) failure. Keep it well below
  // CLAIM_LEASE_MS.
  PROVIDER_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  // Circuit breaker, per provider: open after this many consecutive transient failures, stay open
  // for the cooldown.
  BREAKER_FAILURE_THRESHOLD: z.coerce.number().int().positive().default(5),
  BREAKER_COOLDOWN_MS: z.coerce.number().int().positive().default(30000),
  // Mock providers: simulated delivery time and failure probability.
  MOCK_LATENCY_MS: z.coerce.number().int().nonnegative().default(50),
  MOCK_FAILURE_RATE: z.coerce.number().min(0).max(1).default(0),
  MIGRATIONS_DIR: z.string().default("migrations"),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration: ${parsed.error.message}`);
  }
  return parsed.data;
}
