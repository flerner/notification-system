import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../src/infra/migrate.js";
import { DuplicateKeyError, PgNotificationRepository, type NewNotification } from "../src/notifications/repository.js";
import { PgUserRepository } from "../src/users/repository.js";

// Integration test against a real Postgres. Skipped unless TEST_DATABASE_URL is set, see
// users.pg.test.ts. It EMPTIES the users, devices, notifications and idempotency_keys tables.
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
    await pool.query("TRUNCATE users, devices, notifications, idempotency_keys RESTART IDENTITY CASCADE");
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
    await repo.claim(a!.id, 60_000);
    await repo.claim(b!.id, 60_000);
    expect(await repo.markSent(a!.id)).toBe(true);
    expect(await repo.markFailed(b!.id, "provider unavailable")).toBe(true);

    const { rows } = await pool.query("SELECT id, status, sent_at IS NOT NULL AS sent, last_error FROM notifications");
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId[a!.id]).toMatchObject({ status: "SENT", sent: true, last_error: null });
    expect(byId[b!.id]).toMatchObject({ status: "FAILED", sent: false, last_error: "provider unavailable" });
  });

  it("ignores rows younger than the minimum age (a publish may still be in flight)", async () => {
    await repo.insertPending([row()]);
    expect(await repo.findUnpublished(60_000, 10)).toHaveLength(0);
  });

  describe("claim (layer 2: workers)", () => {
    it("of many concurrent claims, exactly one wins", async () => {
      const [n] = await repo.insertPending([row()]);
      const results = await Promise.all(Array.from({ length: 8 }, () => repo.claim(n!.id, 60_000)));

      expect(results.filter((r) => r.outcome === "claimed")).toHaveLength(1);
      expect(results.filter((r) => r.outcome === "busy")).toHaveLength(7);
      const { rows } = await pool.query("SELECT status, attempts FROM notifications WHERE id = $1", [n!.id]);
      expect(rows[0]).toMatchObject({ status: "SENDING", attempts: 1 });
    });

    it("lets another worker claim again once the lease has expired (the first worker died)", async () => {
      const [n] = await repo.insertPending([row()]);
      expect((await repo.claim(n!.id, 50)).outcome).toBe("claimed");
      expect((await repo.claim(n!.id, 50)).outcome).toBe("busy");

      await new Promise((r) => setTimeout(r, 80));

      expect((await repo.claim(n!.id, 60_000)).outcome).toBe("claimed");
      const { rows } = await pool.query("SELECT attempts FROM notifications WHERE id = $1", [n!.id]);
      expect(rows[0].attempts).toBe(2);
    });

    it("answers done for a finished notification and missing for an unknown one", async () => {
      const [n] = await repo.insertPending([row()]);
      await repo.claim(n!.id, 60_000);
      await repo.markSent(n!.id);

      expect((await repo.claim(n!.id, 60_000)).outcome).toBe("done");
      expect((await repo.claim("00000000-0000-0000-0000-000000000000", 60_000)).outcome).toBe("missing");
    });

    it("refuses illegal status changes: cannot mark an unclaimed notification SENT", async () => {
      const [n] = await repo.insertPending([row()]);
      expect(await repo.markSent(n!.id)).toBe(false);
      expect(await repo.markFailed(n!.id, "x")).toBe(false);
      const { rows } = await pool.query("SELECT status FROM notifications WHERE id = $1", [n!.id]);
      expect(rows[0].status).toBe("PENDING");
    });

    it("does not let a finished notification change again", async () => {
      const [n] = await repo.insertPending([row()]);
      await repo.claim(n!.id, 60_000);
      await repo.markSent(n!.id);
      expect(await repo.markFailed(n!.id, "late")).toBe(false);
    });

    it("parks a failed attempt as RETRYING, and a worker can claim it again", async () => {
      const [n] = await repo.insertPending([row()]);
      expect(await repo.markRetrying(n!.id, "503")).toBe(false); // not claimed yet: illegal
      await repo.claim(n!.id, 60_000);

      expect(await repo.markRetrying(n!.id, "503 service unavailable")).toBe(true);
      const { rows } = await pool.query("SELECT status, last_error, lease_expires_at FROM notifications WHERE id = $1", [n!.id]);
      expect(rows[0]).toMatchObject({ status: "RETRYING", last_error: "503 service unavailable", lease_expires_at: null });

      const again = await repo.claim(n!.id, 60_000); // no lease to wait for: the retry message is the trigger
      expect(again.outcome).toBe("claimed");
      expect(again.outcome === "claimed" && again.notification.attempts).toBe(2);
    });

    it("a RETRYING notification is not finished: only a claim can move it on", async () => {
      const [n] = await repo.insertPending([row()]);
      await repo.claim(n!.id, 60_000);
      await repo.markRetrying(n!.id, "503");
      expect(await repo.markSent(n!.id)).toBe(false);
      expect(await repo.markFailed(n!.id, "x")).toBe(false);
    });

    it("the database rejects a status outside the state machine", async () => {
      const [n] = await repo.insertPending([row()]);
      await expect(pool.query("UPDATE notifications SET status = 'DELIVERED' WHERE id = $1", [n!.id])).rejects.toThrow();
    });
  });

  describe("idempotency keys (layer 1: API)", () => {
    const requestId = (i: number) => `00000000-0000-4000-8000-00000000000${i}`;

    it("stores the key with the notifications and finds them again", async () => {
      const [n] = await repo.insertPending([row()], { key: "evt-1", hash: "h1" });
      const found = await repo.findByKey("evt-1");
      expect(found).toMatchObject({ requestHash: "h1", requestId: n!.requestId });
      expect(found!.notifications.map((x) => x.id)).toEqual([n!.id]);
      expect(await repo.findByKey("unknown")).toBeNull();
    });

    it("rejects a second insert with the same key and stores nothing from it", async () => {
      await repo.insertPending([row({ requestId: requestId(1) })], { key: "evt-1", hash: "h" });
      await expect(
        repo.insertPending([row({ requestId: requestId(2) })], { key: "evt-1", hash: "h" }),
      ).rejects.toBeInstanceOf(DuplicateKeyError);
      const { rows } = await pool.query("SELECT count(*)::int AS n FROM notifications");
      expect(rows[0].n).toBe(1);
    });

    it("of many simultaneous requests with the same key, exactly one is stored", async () => {
      const attempts = await Promise.allSettled(
        Array.from({ length: 6 }, (_, i) =>
          repo.insertPending([row({ requestId: requestId(i) })], { key: "evt-race", hash: "h" }),
        ),
      );

      expect(attempts.filter((a) => a.status === "fulfilled")).toHaveLength(1);
      for (const a of attempts.filter((a) => a.status === "rejected")) {
        expect((a as PromiseRejectedResult).reason).toBeInstanceOf(DuplicateKeyError);
      }
      const { rows } = await pool.query("SELECT count(*)::int AS n FROM notifications");
      expect(rows[0].n).toBe(1);
    });

    it("does not keep the key when the notifications could not be stored (same transaction)", async () => {
      const bad = row({ channel: "push", platform: null }); // violates the push-needs-platform CHECK
      await expect(repo.insertPending([bad], { key: "evt-bad", hash: "h" })).rejects.toThrow();
      expect(await repo.findByKey("evt-bad")).toBeNull();
    });
  });
});
