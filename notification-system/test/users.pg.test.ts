import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../src/infra/migrate.js";
import { DuplicateContactError, PgUserRepository, UserNotFoundError } from "../src/users/repository.js";

// Integration test against a real Postgres (the constraints are the behavior under test).
// Skipped unless TEST_DATABASE_URL is set, e.g.:
//   TEST_DATABASE_URL=postgres://notif:notif@localhost:5432/notifications npm test
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("PgUserRepository (real Postgres)", () => {
  let pool: pg.Pool;
  let repo: PgUserRepository;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url });
    await migrate(pool, "migrations");
  });
  beforeEach(async () => {
    await pool.query("TRUNCATE users, devices RESTART IDENTITY CASCADE");
    repo = new PgUserRepository(pool);
  });
  afterAll(() => pool.end());

  it("rejects a duplicate email or phone", async () => {
    await repo.createUser({ email: "a@x.com", phone: "+14155550123" });
    await expect(repo.createUser({ email: "a@x.com" })).rejects.toBeInstanceOf(DuplicateContactError);
    await expect(repo.createUser({ phone: "+14155550123" })).rejects.toBeInstanceOf(DuplicateContactError);
  });

  it("refuses a user with no contact (CHECK constraint)", async () => {
    await expect(repo.createUser({})).rejects.toThrow();
  });

  it("registering the same token twice keeps one row", async () => {
    const user = await repo.createUser({ email: "a@x.com" });
    const first = await repo.registerDevice({ userId: user.id, platform: "ios", token: "t" });
    const second = await repo.registerDevice({ userId: user.id, platform: "ios", token: "t" });
    expect(second.id).toBe(first.id);
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM devices");
    expect(rows[0].n).toBe(1);
  });

  it("moves a token to a different user when it is registered again", async () => {
    const a = await repo.createUser({ email: "a@x.com" });
    const b = await repo.createUser({ email: "b@x.com" });
    await repo.registerDevice({ userId: a.id, platform: "android", token: "shared" });
    const moved = await repo.registerDevice({ userId: b.id, platform: "android", token: "shared" });
    expect(moved.userId).toBe(b.id);
  });

  it("throws UserNotFoundError for an unknown user", async () => {
    await expect(repo.registerDevice({ userId: "999", platform: "ios", token: "t" })).rejects.toBeInstanceOf(
      UserNotFoundError,
    );
  });

  it("migrate() is a no-op the second time", async () => {
    expect(await migrate(pool, "migrations")).toEqual([]);
  });
});
