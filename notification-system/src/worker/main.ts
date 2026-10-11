import pg from "pg";
import { pino } from "pino";
import { loadConfig } from "../infra/config.js";
import { QUEUES } from "../notifications/queues.js";
import { NotificationProcessor } from "../notifications/processor.js";
import { PgNotificationRepository } from "../notifications/repository.js";
import { buildProviders } from "../providers/index.js";
import { startWorker } from "./consumer.js";

const config = loadConfig();
const logger = pino({ level: config.LOG_LEVEL });

const queues = config.WORKER_QUEUES.length > 0 ? config.WORKER_QUEUES : [...QUEUES];
const unknown = queues.filter((q) => !(QUEUES as readonly string[]).includes(q));
if (unknown.length > 0) throw new Error(`Unknown WORKER_QUEUES: ${unknown.join(", ")}`);

// Pool size: each message holds a connection only for the short queries (the provider call
// happens between them), so a small pool serves prefetch x queues concurrent messages.
const db = new pg.Pool({ connectionString: config.DATABASE_URL, max: 10, connectionTimeoutMillis: 5000 });

const providers = buildProviders({ latencyMs: config.MOCK_LATENCY_MS, failureRate: config.MOCK_FAILURE_RATE });
const missing = queues.filter((q) => !providers[q]);
if (missing.length > 0) throw new Error(`No provider configured for: ${missing.join(", ")}`);

const processor = new NotificationProcessor(new PgNotificationRepository(db), providers, logger, config.CLAIM_LEASE_MS);

const worker = await startWorker(
  { url: config.RABBITMQ_URL, queues, prefetch: config.WORKER_PREFETCH, requeueDelayMs: 1000 },
  processor,
  logger,
);
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
    await db.end();
    process.exit(0);
  });
}
