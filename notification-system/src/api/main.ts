import pg from "pg";
import { Redis } from "ioredis";
import amqp from "amqplib";
import { loadConfig } from "../infra/config.js";
import { migrate } from "../infra/migrate.js";
import { PgUserRepository } from "../users/repository.js";
import { buildServer } from "./server.js";

const config = loadConfig();

// Pool size is deliberate: Postgres defaults to max 100 connections total and we will run
// several api/worker replicas, so each process takes a small, bounded slice.
const db = new pg.Pool({ connectionString: config.DATABASE_URL, max: 10, connectionTimeoutMillis: 2000 });
const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1, lazyConnect: false });

// Schema is applied before we accept traffic. Trade-off: a slow or failing migration delays
// startup; the advisory lock in migrate() keeps concurrent replicas safe.
await migrate(db, config.MIGRATIONS_DIR);

const app = buildServer({
  logLevel: config.LOG_LEVEL,
  users: new PgUserRepository(db),
  healthChecks: [
    { name: "postgres", check: async () => void (await db.query("SELECT 1")) },
    { name: "redis", check: async () => void (await redis.ping()) },
    {
      // Opening a connection per check is fine at health-check frequency; M3 will hold one
      // long-lived channel for publishing and this check will reuse it.
      name: "rabbitmq",
      check: async () => {
        const conn = await amqp.connect(config.RABBITMQ_URL);
        await conn.close();
      },
    },
  ],
});

// Docker sends SIGTERM on stop; closing cleanly lets in-flight requests finish.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    // Stop accepting connections; the callback fires once in-flight requests finish.
    await new Promise((resolve) => server.close(resolve));
    await db.end();
    redis.disconnect();
    process.exit(0);
  });
}

const server = app.listen(config.PORT);
