import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../src/infra/migrate.js";
import { PgNotificationRepository, type NewNotification } from "../src/notifications/repository.js";
import { PgUserRepository } from "../src/users/repository.js";

// Integration test against a real Postgres. Skipped unless TEST_DATABASE_URL is set, see
// users.pg.test.ts. It EMPTIES the users, devices and notifications tables.
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("PgNotificationRepository (real Postgres)", () => {
  let pool: pg.Pool;
  let repo: PgNotificationRepository;
  let userId: string;

  const row = (over: Partial<NewNotification> = {}): NewNotification => ({
    requestId: "7b1f0f0e-8b8e-4b52-9a57-0f3f5a9d2c11",
    userId,
    channel: "email",
    platform: null,
    destination: "a@x.com",
    queue: "email",
    payload: { subject: "Hi", body: "hello" },
    ...over,
  });

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url });
    await migrate(pool, "migrations");
  });
  beforeEach(async () => {
    await pool.query("TRUNCATE users, devices, notifications RESTART IDENTITY CASCADE");
    userId = (await new PgUserRepository(pool).createUser({ email: "a@x.com" })).id;
    repo = new PgNotificationRepository(pool);
  });
  afterAll(() => pool.end());

  it("stores rows as PENDING and unpublished, round-tripping the payload", async () => {
    const [n] = await repo.insertPending([row()]);
    expect(n).toMatchObject({ status: "PENDING", payload: { subject: "Hi", body: "hello" }, queue: "email" });
    const stuck = await repo.findUnpublished(0, 10);
    expect(stuck.map((s) => s.id)).toEqual([n!.id]);
  });

  it("stores nothing when one row of the request is invalid (atomic)", async () => {
    const bad = row({ channel: "push", platform: null }); // violates the push-needs-platform CHECK
    await expect(repo.insertPending([row(), bad])).rejects.toThrow();
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM notifications");
    expect(rows[0].n).toBe(0);
  });

  it("stops returning a row once it is marked published", async () => {
    const [a, b] = await repo.insertPending([row(), row()]);
    await repo.markPublished([a!.id]);
    expect((await repo.findUnpublished(0, 10)).map((s) => s.id)).toEqual([b!.id]);
  });

  it("records the delivery outcome: SENT, or FAILED with the error", async () => {
    const [a, b] = await repo.insertPending([row(), row()]);
    await repo.markSent(a!.id);
    await repo.markFailed(b!.id, "provider unavailable");
    const { rows } = await pool.query("SELECT id, status, sent_at IS NOT NULL AS sent, last_error FROM notifications");
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId[a!.id]).toMatchObject({ status: "SENT", sent: true, last_error: null });
    expect(byId[b!.id]).toMatchObject({ status: "FAILED", sent: false, last_error: "provider unavailable" });
    expect((await repo.findById(a!.id))?.status).toBe("SENT");
    expect(await repo.findById("00000000-0000-0000-0000-000000000000")).toBeNull();
  });

  it("ignores rows younger than the minimum age (a publish may still be in flight)", async () => {
    await repo.insertPending([row()]);
    expect(await repo.findUnpublished(60_000, 10)).toHaveLength(0);
  });
});
