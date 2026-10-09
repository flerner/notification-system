// Dev-only: fills the database with a few users and devices so there is something to look at.
// Safe to run repeatedly: existing rows are left alone, only missing ones are added.
//   npm run seed          (needs `docker compose up -d`, talks to Postgres on localhost:5432)
import pg from "pg";
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
  const { rows } = await pool.query(
    "SELECT (SELECT count(*) FROM users)::int AS users, (SELECT count(*) FROM devices)::int AS devices",
  );
  console.log(`Seeded. Database now has ${rows[0].users} users and ${rows[0].devices} devices.`);
} finally {
  await pool.end();
}
