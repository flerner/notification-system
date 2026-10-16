import pg from "pg";

// Makes sure the database the integration tests will empty exists, and refuses the development one.
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return;

  const target = new URL(url);
  const name = decodeURIComponent(target.pathname.slice(1));
  if (!name.endsWith("_test")) {
    throw new Error(
      `TEST_DATABASE_URL points at "${name}". The Postgres tests empty their tables, so the database name must end in _test. Use npm run test:integration.`,
    );
  }

  const admin = new pg.Client({ connectionString: url.replace(target.pathname, "/postgres") });
  await admin.connect();
  try {
    const { rowCount } = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
    if (rowCount === 0) await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
}
