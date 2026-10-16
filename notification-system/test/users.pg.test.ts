import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../src/infra/migrate.js";
import { PgNotificationRepository } from "../src/notifications/repository.js";
import { DuplicateContactError, PgUserRepository, UserNotFoundError } from "../src/users/repository.js";

// Integration test against a real Postgres (the constraints are the behavior under test).
// Skipped unless TEST_DATABASE_URL is set, e.g.:
//   npm run test:integration
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

  describe("when a device token moves to another user", () => {
    const push = (userId: string, destination: string) => ({
      requestId: "00000000-0000-0000-0000-000000000001",
      userId,
      clientId: "c",
      channel: "push" as const,
      platform: "android" as const,
      destination,
      queue: "push.android",
      payload: { body: "hi" },
    });
    const statusOf = async (id: string) =>
      (await pool.query("SELECT status FROM notifications WHERE id = $1", [id])).rows[0].status;

    it("skips what is still waiting for the previous owner, and nothing else", async () => {
      await pool.query("TRUNCATE notifications");
      const notifications = new PgNotificationRepository(pool);
      const a = await repo.createUser({ email: "a@x.com" });
      const b = await repo.createUser({ email: "b@x.com" });
      await repo.registerDevice({ userId: a.id, platform: "android", token: "shared" });

      const [waiting, retrying, sending, forOther, forNew] = await notifications.insertPending([
        push(a.id, "shared"),
        push(a.id, "shared"),
        push(a.id, "shared"),
        push(a.id, "another-token"),
        push(b.id, "shared"),
      ]);
      await notifications.claim(retrying!.id, 60_000);
      await notifications.markRetrying(retrying!.id, 1, "503");
      await notifications.claim(sending!.id, 60_000);

      await repo.registerDevice({ userId: b.id, platform: "android", token: "shared" });

      expect(await statusOf(waiting!.id)).toBe("SKIPPED_STALE_DESTINATION");
      expect(await statusOf(retrying!.id)).toBe("SKIPPED_STALE_DESTINATION");
      expect(await statusOf(sending!.id)).toBe("SENDING");
      expect(await statusOf(forOther!.id)).toBe("PENDING");
      expect(await statusOf(forNew!.id)).toBe("PENDING");
      expect((await notifications.claim(waiting!.id, 60_000)).outcome).toBe("done");
    });

    it("leaves everything alone when the same user registers the token again", async () => {
      await pool.query("TRUNCATE notifications");
      const notifications = new PgNotificationRepository(pool);
      const a = await repo.createUser({ email: "a@x.com" });
      await repo.registerDevice({ userId: a.id, platform: "android", token: "mine" });
      const [n] = await notifications.insertPending([push(a.id, "mine")]);

      await repo.registerDevice({ userId: a.id, platform: "android", token: "mine" });

      expect(await statusOf(n!.id)).toBe("PENDING");
    });
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
