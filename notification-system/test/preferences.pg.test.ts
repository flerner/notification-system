import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../src/infra/migrate.js";
import { PgSettingsRepository } from "../src/notifications/settings.js";
import { PgTemplateRepository } from "../src/notifications/templates.js";
import { PgUserRepository, UserNotFoundError } from "../src/users/repository.js";

// Integration test against a real Postgres. Skipped unless TEST_DATABASE_URL is set, see
// users.pg.test.ts. It EMPTIES the users, notifications, templates and related tables.
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("settings and templates (real Postgres)", () => {
  let pool: pg.Pool;
  let settings: PgSettingsRepository;
  let templates: PgTemplateRepository;
  let userId: string;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url });
    await migrate(pool, "migrations");
  });
  beforeEach(async () => {
    await pool.query("TRUNCATE users, devices, notifications, idempotency_keys, templates RESTART IDENTITY CASCADE");
    userId = (await new PgUserRepository(pool).createUser({ email: "a@x.com" })).id;
    settings = new PgSettingsRepository(pool);
    templates = new PgTemplateRepository(pool);
  });
  afterAll(() => pool.end());

  describe("settings", () => {
    it("a user who never chose is opted in to every channel", async () => {
      expect(await settings.isOptedIn(userId, "email")).toBe(true);
      expect(await settings.list(userId)).toEqual({ push: true, sms: true, email: true });
    });

    it("opting out affects only that channel, and can be undone", async () => {
      await settings.setOptIn(userId, "sms", false);
      expect(await settings.isOptedIn(userId, "sms")).toBe(false);
      expect(await settings.isOptedIn(userId, "email")).toBe(true);
      expect(await settings.list(userId)).toEqual({ push: true, sms: false, email: true });

      await settings.setOptIn(userId, "sms", true);
      expect(await settings.isOptedIn(userId, "sms")).toBe(true);
    });

    it("keeps one row per user and channel however often it is changed", async () => {
      await settings.setOptIn(userId, "push", false);
      await settings.setOptIn(userId, "push", false);
      await settings.setOptIn(userId, "push", true);
      const { rows } = await pool.query("SELECT count(*)::int AS n FROM notification_settings");
      expect(rows[0].n).toBe(1);
    });

    it("an unknown user is reported, not silently accepted", async () => {
      await expect(settings.setOptIn("999", "email", false)).rejects.toBeInstanceOf(UserNotFoundError);
      expect(await settings.list("999")).toBeNull();
    });

    it("the database refuses a channel it does not know", async () => {
      await expect(
        pool.query("INSERT INTO notification_settings (user_id, channel, opt_in) VALUES ($1, 'pigeon', true)", [userId]),
      ).rejects.toThrow();
    });
  });

  describe("templates", () => {
    it("stores a template and reads it back", async () => {
      await templates.upsert({ name: "welcome", channel: "email", subject: "Hi {{name}}", body: "Welcome {{name}}" });
      expect(await templates.find("welcome", "email")).toEqual({
        name: "welcome",
        channel: "email",
        subject: "Hi {{name}}",
        body: "Welcome {{name}}",
      });
    });

    it("a template without a subject comes back without one", async () => {
      await templates.upsert({ name: "code", channel: "sms", body: "Your code: {{code}}" });
      expect((await templates.find("code", "sms"))?.subject).toBeUndefined();
    });

    it("updating replaces the text and keeps a single row", async () => {
      await templates.upsert({ name: "welcome", channel: "email", subject: "Old", body: "Old body" });
      await templates.upsert({ name: "welcome", channel: "email", body: "New body" });

      const found = await templates.find("welcome", "email");
      expect(found).toEqual({ name: "welcome", channel: "email", subject: undefined, body: "New body" });
      const { rows } = await pool.query("SELECT count(*)::int AS n FROM templates");
      expect(rows[0].n).toBe(1);
    });

    it("the same name can exist once per channel", async () => {
      await templates.upsert({ name: "welcome", channel: "email", body: "email text" });
      await templates.upsert({ name: "welcome", channel: "sms", body: "sms text" });
      expect((await templates.find("welcome", "sms"))?.body).toBe("sms text");
      expect((await templates.find("welcome", "email"))?.body).toBe("email text");
      expect(await templates.find("welcome", "push")).toBeNull();
    });
  });
});
