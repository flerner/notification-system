import pg from "pg";
import { generateCredentials, hashSecret } from "../src/clients/credentials.js";
import { PgClientRepository } from "../src/clients/repository.js";
import { migrate } from "../src/infra/migrate.js";

const name = process.argv[2];
if (!name) {
  console.error("usage: npm run create-client -- <name>");
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? "postgres://notif:notif@localhost:5432/notifications",
  max: 2,
});
try {
  await migrate(pool, "migrations");
  const { appKey, secret } = generateCredentials();
  await new PgClientRepository(pool).create({ appKey, name, secretHash: hashSecret(secret) });
  console.log(`Created client "${name}". Keep the secret: it is not shown again.\n`);
  console.log(`  appKey: ${appKey}`);
  console.log(`  secret: ${secret}\n`);
  console.log(`  curl -u ${appKey}:${secret} localhost:3000/v1/templates/order-shipped/email`);
} finally {
  await pool.end();
}
