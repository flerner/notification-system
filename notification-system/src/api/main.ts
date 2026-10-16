import pg from "pg";
import { Redis } from "ioredis";
import { pino } from "pino";
import { loadConfig } from "../infra/config.js";
import { migrate } from "../infra/migrate.js";
import { PgClientRepository } from "../clients/repository.js";
import { RedisCache } from "../infra/cache.js";
import { createRegistry, startMetricsServer } from "../infra/metrics.js";
import { RabbitPublisher } from "../infra/rabbit.js";
import { NotificationMetrics } from "../notifications/metrics.js";
import { PgNotificationRepository } from "../notifications/repository.js";
import { allQueues } from "../notifications/queues.js";
import { startRelay } from "../notifications/relay.js";
import { NotificationService } from "../notifications/service.js";
import { PgSettingsRepository } from "../notifications/settings.js";
import {
  CachedTemplateRepository,
  PgTemplateRepository,
} from "../notifications/templates.js";
import { PgUserRepository } from "../users/repository.js";
import { buildServer } from "./server.js";

const config = loadConfig();
const logger = pino({ level: config.LOG_LEVEL });
const registry = createRegistry();
const metrics = new NotificationMetrics(registry);

const db = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: 10,
  connectionTimeoutMillis: 2000,
});
db.on("error", (err) =>
  logger.error({ err }, "idle postgres connection error"),
);
const redis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  commandTimeout: 500,
});
const rabbit = new RabbitPublisher(
  config.RABBITMQ_URL,
  allQueues(config.RETRY_DELAYS_MS),
  logger,
);

await migrate(db, config.MIGRATIONS_DIR);

const users = new PgUserRepository(db);
const templates = new CachedTemplateRepository(
  new PgTemplateRepository(db),
  new RedisCache(redis, logger, metrics),
  config.TEMPLATE_CACHE_TTL_SECONDS,
  metrics,
);
const notifications = new NotificationService(
  users,
  new PgNotificationRepository(db),
  templates,
  rabbit,
  logger,
  metrics,
);

const app = buildServer({
  logger,
  users,
  notifications,
  templates,
  settings: new PgSettingsRepository(db),
  clients: new PgClientRepository(db),
  registry,
  healthChecks: [
    { name: "postgres", check: async () => void (await db.query("SELECT 1")) },
    { name: "redis", check: async () => void (await redis.ping()) },
    { name: "rabbitmq", check: () => rabbit.check() },
  ],
});

const metricsServer = startMetricsServer(registry, config.METRICS_PORT);

const stopRelay = startRelay(
  notifications,
  { intervalMs: config.RELAY_INTERVAL_MS, minAgeMs: config.RELAY_MIN_AGE_MS },
  logger,
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    stopRelay();
    metricsServer.close();
    await new Promise((resolve) => server.close(resolve));
    await rabbit.close();
    await db.end();
    redis.disconnect();
    process.exit(0);
  });
}

const server = app.listen(config.PORT);
