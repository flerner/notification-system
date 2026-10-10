import pg from "pg";
import { Redis } from "ioredis";
import { pino } from "pino";
import { loadConfig } from "../infra/config.js";
import { migrate } from "../infra/migrate.js";
import { RabbitPublisher } from "../infra/rabbit.js";
import { PgNotificationRepository } from "../notifications/repository.js";
import { QUEUES } from "../notifications/queues.js";
import { startRelay } from "../notifications/relay.js";
import { NotificationService } from "../notifications/service.js";
import { PgUserRepository } from "../users/repository.js";
import { buildServer } from "./server.js";

const config = loadConfig();
const logger = pino({ level: config.LOG_LEVEL });

// Pool size is deliberate: Postgres defaults to max 100 connections total and we will run
// several api/worker replicas, so each process takes a small, bounded slice.
const db = new pg.Pool({ connectionString: config.DATABASE_URL, max: 10, connectionTimeoutMillis: 2000 });
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1, lazyConnect: false });
const rabbit = new RabbitPublisher(config.RABBITMQ_URL, QUEUES, logger);

// Schema is applied before we accept traffic. Trade-off: a slow or failing migration delays
// startup; the advisory lock in migrate() keeps concurrent replicas safe.
await migrate(db, config.MIGRATIONS_DIR);

const users = new PgUserRepository(db);
const notifications = new NotificationService(users, new PgNotificationRepository(db), rabbit, logger);

const app = buildServer({
  logger,
  users,
  notifications,
  healthChecks: [
    { name: "postgres", check: async () => void (await db.query("SELECT 1")) },
    { name: "redis", check: async () => void (await redis.ping()) },
    { name: "rabbitmq", check: () => rabbit.check() },
  ],
});

const stopRelay = startRelay(
  notifications,
  { intervalMs: config.RELAY_INTERVAL_MS, minAgeMs: config.RELAY_MIN_AGE_MS },
  logger,
);

// Docker sends SIGTERM on stop; closing cleanly lets in-flight requests finish.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    stopRelay();
    // Stop accepting connections; the callback fires once in-flight requests finish.
    await new Promise((resolve) => server.close(resolve));
    await rabbit.close();
    await db.end();
    redis.disconnect();
    process.exit(0);
  });
}

const server = app.listen(config.PORT);
