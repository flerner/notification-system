import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { authenticate, hashSecret } from "../src/clients/credentials.js";
import { PgClientRepository } from "../src/clients/repository.js";
import { migrate } from "../src/infra/migrate.js";
import { DuplicateKeyError, PgNotificationRepository, type NewNotification } from "../src/notifications/repository.js";
import { PgUserRepository } from "../src/users/repository.js";

// Integration test against a real Postgres. Skipped unless TEST_DATABASE_URL is set, see
// users.pg.test.ts. It EMPTIES the clients, users, notifications and idempotency_keys tables.
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("clients and per-client idempotency (real Postgres)", () => {
  let pool: pg.Pool;
  let userId: string;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url });
    await migrate(pool, "migrations");
  });
  beforeEach(async () => {
    await pool.query("TRUNCATE clients, users, devices, notifications, idempotency_keys RESTART IDENTITY CASCADE");
    userId = (await new PgUserRepository(pool).createUser({ email: "a@x.com" })).id;
  });
  afterAll(() => pool.end());

  describe("clients", () => {
    it("stores a client with the hash of its secret, never the secret", async () => {
      const clients = new PgClientRepository(pool);
      await clients.create({ appKey: "billing", name: "Billing", secretHash: hashSecret("s3cret") });

      const { rows } = await pool.query("SELECT * FROM clients");
      expect(JSON.stringify(rows)).not.toContain("s3cret");
      expect(await authenticate(clients, "billing", "s3cret")).toEqual({ id: "billing", name: "Billing" });
      expect(await authenticate(clients, "billing", "nope")).toBeNull();
      expect(await authenticate(clients, "other", "s3cret")).toBeNull();
    });

    it("refuses a client once it is revoked", async () => {
      const clients = new PgClientRepository(pool);
      await clients.create({ appKey: "billing", name: "Billing", secretHash: hashSecret("s3cret") });
      await pool.query("UPDATE clients SET revoked_at = now() WHERE app_key = 'billing'");
      expect(await authenticate(clients, "billing", "s3cret")).toBeNull();
    });

    it("does not allow two clients with the same key", async () => {
      const clients = new PgClientRepository(pool);
      await clients.create({ appKey: "billing", name: "Billing", secretHash: hashSecret("a") });
      await expect(clients.create({ appKey: "billing", name: "Other", secretHash: hashSecret("b") })).rejects.toThrow();
    });
  });

  describe("idempotency keys belong to a client", () => {
    const row = (clientId: string, requestId: string): NewNotification => ({
      requestId, userId, clientId, channel: "email", platform: null, destination: "a@x.com", queue: "email", payload: { body: "x" },
    });
    const idA = "00000000-0000-4000-8000-00000000000a";
    const idB = "00000000-0000-4000-8000-00000000000b";

    it("two clients can use the same key; each finds only its own", async () => {
      const repo = new PgNotificationRepository(pool);
      const [a] = await repo.insertPending([row("client-a", idA)], { key: "evt-1", hash: "h" });
      const [b] = await repo.insertPending([row("client-b", idB)], { key: "evt-1", hash: "h" });

      expect((await repo.findByKey("client-a", "evt-1"))!.notifications.map((n) => n.id)).toEqual([a!.id]);
      expect((await repo.findByKey("client-b", "evt-1"))!.notifications.map((n) => n.id)).toEqual([b!.id]);
      expect(await repo.findByKey("client-c", "evt-1")).toBeNull();
    });

    it("the same client using the same key twice is still refused", async () => {
      const repo = new PgNotificationRepository(pool);
      await repo.insertPending([row("client-a", idA)], { key: "evt-1", hash: "h" });
      await expect(repo.insertPending([row("client-a", idB)], { key: "evt-1", hash: "h" })).rejects.toBeInstanceOf(DuplicateKeyError);
    });

    it("stores which client asked for each notification", async () => {
      const repo = new PgNotificationRepository(pool);
      const [n] = await repo.insertPending([row("client-a", idA)]);
      const { rows } = await pool.query("SELECT client_id FROM notifications WHERE id = $1", [n!.id]);
      expect(rows[0].client_id).toBe("client-a");
    });

    it("refuses a notification that names no client", async () => {
      await expect(
        pool.query(
          `INSERT INTO notifications (request_id, user_id, channel, destination, queue, payload)
           VALUES ($1, $2, 'email', 'a@x.com', 'email', '{}')`,
          [idA, userId],
        ),
      ).rejects.toThrow(/client_id/);
    });
  });
});
