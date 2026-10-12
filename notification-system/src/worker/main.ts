import { Redis } from "ioredis";
import pg from "pg";
import { pino } from "pino";
import { loadConfig } from "../infra/config.js";
import { createRegistry, startMetricsServer } from "../infra/metrics.js";
import { RabbitPublisher } from "../infra/rabbit.js";
import { allQueues, DEAD_LETTER_QUEUE, QUEUES } from "../notifications/queues.js";
import { RetryPolicy } from "../notifications/retry.js";
import { NotificationProcessor } from "../notifications/processor.js";
import { NotificationMetrics } from "../notifications/metrics.js";
import { PgNotificationRepository } from "../notifications/repository.js";
import { parseRateLimit, RedisRateLimiter } from "../notifications/rate-limit.js";
import { PgSettingsRepository } from "../notifications/settings.js";
import { buildProviders } from "../providers/index.js";
import { startWorker } from "./consumer.js";
import { registerCircuitGauge } from "./metrics.js";

const config = loadConfig();
const logger = pino({ level: config.LOG_LEVEL });
const registry = createRegistry();
const metrics = new NotificationMetrics(registry);

const queues = config.WORKER_QUEUES.length > 0 ? config.WORKER_QUEUES : [...QUEUES];
const unknown = queues.filter((q) => !(QUEUES as readonly string[]).includes(q));
if (unknown.length > 0) throw new Error(`Unknown WORKER_QUEUES: ${unknown.join(", ")}`);

// Pool size: each message holds a connection only for the short queries (the provider call
// happens between them), so a small pool serves prefetch x queues concurrent messages.
const db = new pg.Pool({ connectionString: config.DATABASE_URL, max: 10, connectionTimeoutMillis: 5000 });

// The lease is how long a claim is valid; if a provider call may outlast it, a healthy worker
// would lose its claim mid-send and a second worker would send a duplicate.
if (config.CLAIM_LEASE_MS <= config.PROVIDER_TIMEOUT_MS) {
  throw new Error("CLAIM_LEASE_MS must be greater than PROVIDER_TIMEOUT_MS");
}

// Fail fast when Redis is slow or unreachable: the rate limiter then lets the notification through
// (see RedisRateLimiter) instead of holding up the worker.
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false, commandTimeout: 500 });
const limiter = new RedisRateLimiter(
  redis,
  {
    push: parseRateLimit(config.RATE_LIMIT_PUSH),
    sms: parseRateLimit(config.RATE_LIMIT_SMS),
    email: parseRateLimit(config.RATE_LIMIT_EMAIL),
  },
  logger,
  metrics,
);

const providers = buildProviders({
  latencyMs: config.MOCK_LATENCY_MS,
  failureRate: config.MOCK_FAILURE_RATE,
  timeoutMs: config.PROVIDER_TIMEOUT_MS,
  breaker: { failureThreshold: config.BREAKER_FAILURE_THRESHOLD, cooldownMs: config.BREAKER_COOLDOWN_MS },
});
registerCircuitGauge(registry, providers);
const missing = queues.filter((q) => !providers[q]);
if (missing.length > 0) throw new Error(`No provider configured for: ${missing.join(", ")}`);

// Used to schedule retries and to announce notifications we gave up on.
const publisher = new RabbitPublisher(config.RABBITMQ_URL, allQueues(config.RETRY_DELAYS_MS), logger);

const processor = new NotificationProcessor(
  new PgNotificationRepository(db),
  new PgSettingsRepository(db),
  limiter,
  providers,
  publisher,
  new RetryPolicy(config.RETRY_DELAYS_MS),
  logger,
  config.CLAIM_LEASE_MS,
  metrics,
);

const worker = await startWorker(
  { url: config.RABBITMQ_URL, queues, prefetch: config.WORKER_PREFETCH, requeueDelayMs: 1000, circuitOpenDelayMs: 5000 },
  processor,
  logger,
  (message) => publisher.publish(DEAD_LETTER_QUEUE, message),
);
const metricsServer = startMetricsServer(registry, config.METRICS_PORT);
logger.info({ queues, prefetch: config.WORKER_PREFETCH }, "worker started");

// If the broker connection drops we exit and let Docker restart us (restart: unless-stopped).
// That is simpler and more reliable than reconnecting consumers by hand.
worker.lost.then(() => {
  logger.fatal("lost connection to rabbitmq, exiting");
  process.exit(1);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    await worker.stop(); // finishes the messages in progress first
    await publisher.close();
    metricsServer.close();
    await db.end();
    redis.disconnect();
    process.exit(0);
  });
}
