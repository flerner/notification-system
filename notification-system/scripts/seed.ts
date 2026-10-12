// Dev-only: fills the database with a few users and devices so there is something to look at.
// Safe to run repeatedly: existing rows are left alone, only missing ones are added.
//   npm run seed          (needs `docker compose up -d`, talks to Postgres on localhost:5432)
import pg from "pg";
import { hashSecret } from "../src/clients/credentials.js";
import { migrate } from "../src/infra/migrate.js";

const url = process.env.DATABASE_URL ?? "postgres://notif:notif@localhost:5432/notifications";

const users = [
  { email: "ana@example.com", phone: "+14155550101" },
  { email: "bob@example.com", phone: null },
  { email: null, phone: "+14155550103" }, // reachable by SMS only
];

const devices = [
  { email: "ana@example.com", platform: "ios", token: "seed-ios-ana" },
  { email: "ana@example.com", platform: "android", token: "seed-android-ana" },
  { email: "bob@example.com", platform: "web", token: "seed-web-bob" },
];

const templates = [
  { name: "order-shipped", channel: "email", subject: "Your order {{order_id}} has shipped", body: "Hi {{name}}, your order {{order_id}} is on its way and should arrive on {{eta}}." },
  { name: "order-shipped", channel: "sms", subject: null, body: "Order {{order_id}} shipped. ETA {{eta}}." },
  { name: "order-shipped", channel: "push", subject: "Order shipped", body: "{{name}}, order {{order_id}} arrives {{eta}}." },
];

// A client with well-known credentials so the examples in the notes and scripts work. Development
// only: anyone who reads this file knows the secret. Real clients come from `npm run create-client`.
export const DEMO_APP_KEY = "demo-key";
export const DEMO_SECRET = "demo-secret";

const pool = new pg.Pool({ connectionString: url, max: 2 });
try {
  await migrate(pool, "migrations"); // so it also works on an empty database
  for (const u of users) {
    await pool.query("INSERT INTO users (email, phone) VALUES ($1, $2) ON CONFLICT DO NOTHING", [u.email, u.phone]);
  }
  for (const d of devices) {
    await pool.query(
      "INSERT INTO devices (user_id, platform, token) SELECT id, $2, $3 FROM users WHERE email = $1 ON CONFLICT (token) DO NOTHING",
      [d.email, d.platform, d.token],
    );
  }
  await pool.query("INSERT INTO clients (app_key, name, secret_hash) VALUES ($1, 'demo (development only)', $2) ON CONFLICT DO NOTHING", [
    DEMO_APP_KEY,
    hashSecret(DEMO_SECRET),
  ]);
  for (const t of templates) {
    await pool.query(
      "INSERT INTO templates (name, channel, subject, body) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING",
      [t.name, t.channel, t.subject, t.body],
    );
  }
  const { rows } = await pool.query(
    "SELECT (SELECT count(*) FROM users)::int AS users, (SELECT count(*) FROM devices)::int AS devices, (SELECT count(*) FROM templates)::int AS templates",
  );
  console.log(`Demo client: ${DEMO_APP_KEY} / ${DEMO_SECRET}   (curl -u ${DEMO_APP_KEY}:${DEMO_SECRET} ...)`);
  console.log(`Seeded. Database now has ${rows[0].users} users, ${rows[0].devices} devices and ${rows[0].templates} templates.`);
} finally {
  await pool.end();
}
