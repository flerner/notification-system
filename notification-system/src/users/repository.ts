import type pg from "pg";

export type Platform = "ios" | "android" | "web";

export interface User {
  id: string; // bigint comes back from Postgres as a string; we keep it a string end to end
  email: string | null;
  phone: string | null;
}

export interface Device {
  id: string;
  userId: string;
  platform: Platform;
  token: string;
}

// Thrown when the email or phone already belongs to another user.
export class DuplicateContactError extends Error {}
// Thrown when registering a device for a user that does not exist.
export class UserNotFoundError extends Error {}

export interface Contacts {
  user: User;
  devices: Device[];
}

export interface UserRepository {
  // Everything we can reach this user with, or null if the user does not exist.
  findContacts(userId: string): Promise<Contacts | null>;
  createUser(input: { email?: string; phone?: string }): Promise<User>;
  // Idempotent: registering the same token again updates the existing row.
  registerDevice(input: { userId: string; platform: Platform; token: string }): Promise<Device>;
}

// Postgres error codes we translate into domain errors.
const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";

export class PgUserRepository implements UserRepository {
  constructor(private readonly db: pg.Pool) {}

  async findContacts(userId: string): Promise<Contacts | null> {
    const { rows: users } = await this.db.query("SELECT id, email, phone FROM users WHERE id = $1", [userId]);
    if (users.length === 0) return null;
    const { rows: devices } = await this.db.query(
      `SELECT id, user_id AS "userId", platform, token FROM devices WHERE user_id = $1 ORDER BY id`,
      [userId],
    );
    return { user: users[0], devices };
  }

  async createUser(input: { email?: string; phone?: string }): Promise<User> {
    try {
      const { rows } = await this.db.query(
        "INSERT INTO users (email, phone) VALUES ($1, $2) RETURNING id, email, phone",
        [input.email ?? null, input.phone ?? null],
      );
      return rows[0];
    } catch (err) {
      if ((err as { code?: string }).code === UNIQUE_VIOLATION) {
        throw new DuplicateContactError("email or phone already registered");
      }
      throw err;
    }
  }

  async registerDevice(input: { userId: string; platform: Platform; token: string }): Promise<Device> {
    try {
      // The token is globally unique. If it already exists we re-point it at this user and
      // platform instead of failing: the same phone may log into a different account.
      const { rows } = await this.db.query(
        `INSERT INTO devices (user_id, platform, token) VALUES ($1, $2, $3)
         ON CONFLICT (token) DO UPDATE
           SET user_id = EXCLUDED.user_id, platform = EXCLUDED.platform, updated_at = now()
         RETURNING id, user_id AS "userId", platform, token`,
        [input.userId, input.platform, input.token],
      );
      return rows[0];
    } catch (err) {
      if ((err as { code?: string }).code === FOREIGN_KEY_VIOLATION) {
        throw new UserNotFoundError(`user ${input.userId} not found`);
      }
      throw err;
    }
  }
}
