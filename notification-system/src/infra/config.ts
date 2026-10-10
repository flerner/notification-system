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
  // Worker only. WORKER_QUEUES lets one process serve a subset (e.g. only "sms") so channels can
  // be scaled independently. Empty means all queues.
  WORKER_QUEUES: z.string().default("").transform((v) => v.split(",").map((q) => q.trim()).filter(Boolean)),
  WORKER_PREFETCH: z.coerce.number().int().positive().default(5),
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
