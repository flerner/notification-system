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
