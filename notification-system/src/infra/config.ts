import { z } from "zod";

const rateLimitSpec = (fallback: string) =>
  z
    .string()
    .regex(
      /^[1-9]\d*\/[1-9]\d*$/,
      "must look like 20/3600 (max per window in seconds)",
    )
    .default(fallback);

const schema = z.object({
  PORT: z.coerce.number().int().default(3000),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  RABBITMQ_URL: z.string().url(),
  RELAY_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  RELAY_MIN_AGE_MS: z.coerce.number().int().positive().default(10000),
  TEMPLATE_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  WORKER_QUEUES: z
    .string()
    .default("")
    .transform((v) =>
      v
        .split(",")
        .map((q) => q.trim())
        .filter(Boolean),
    ),
  WORKER_PREFETCH: z.coerce.number().int().positive().default(5),
  CLAIM_LEASE_MS: z.coerce.number().int().positive().default(60000),
  RETRY_DELAYS_MS: z
    .string()
    .default("5000,30000,120000")
    .transform((v) => v.split(",").map((d) => Number(d.trim())))
    .refine(
      (ds) => ds.length > 0 && ds.every((d) => Number.isInteger(d) && d > 0),
      {
        message: "must be a comma separated list of positive integers",
      },
    ),
  PROVIDER_TIMEOUT_MS: z.coerce.number().int().positive().default(10000),
  BREAKER_FAILURE_THRESHOLD: z.coerce.number().int().positive().default(5),
  BREAKER_COOLDOWN_MS: z.coerce.number().int().positive().default(30000),
  RATE_LIMIT_PUSH: rateLimitSpec("20/3600"),
  RATE_LIMIT_SMS: rateLimitSpec("5/3600"),
  RATE_LIMIT_EMAIL: rateLimitSpec("10/3600"),
  MOCK_LATENCY_MS: z.coerce.number().int().nonnegative().default(50),
  MOCK_FAILURE_RATE: z.coerce.number().min(0).max(1).default(0),
  METRICS_PORT: z.coerce.number().int().default(9464),
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
