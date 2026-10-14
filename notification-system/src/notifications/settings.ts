import type pg from "pg";
import { UserNotFoundError } from "../users/repository.js";
import type { Channel } from "./queues.js";

// The user's choice of which channels may reach them Book: Ch. 10, "Notification setting".
// Deliberately NOT cached: this is consent. A stale cache entry would send to someone who has
// just opted out, and a primary-key lookup is cheap at our volume.
export interface SettingsRepository {
  // No row means the user never chose, which counts as opted in.
  isOptedIn(userId: string, channel: Channel): Promise<boolean>;
  // Throws UserNotFoundError for an unknown user.
  setOptIn(userId: string, channel: Channel, optIn: boolean): Promise<void>;
  // Every channel with its effective value, or null if the user does not exist.
  list(userId: string): Promise<Record<Channel, boolean> | null>;
}

const FOREIGN_KEY_VIOLATION = "23503";

export class PgSettingsRepository implements SettingsRepository {
  constructor(private readonly db: pg.Pool) {}

  async isOptedIn(userId: string, channel: Channel): Promise<boolean> {
    const { rows } = await this.db.query(
      "SELECT opt_in FROM notification_settings WHERE user_id = $1 AND channel = $2",
      [userId, channel],
    );
    return rows.length === 0 ? true : rows[0].opt_in;
  }

  async setOptIn(userId: string, channel: Channel, optIn: boolean): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO notification_settings (user_id, channel, opt_in) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, channel) DO UPDATE SET opt_in = EXCLUDED.opt_in, updated_at = now()`,
        [userId, channel, optIn],
      );
    } catch (err) {
      if ((err as { code?: string }).code === FOREIGN_KEY_VIOLATION) {
        throw new UserNotFoundError(`user ${userId} not found`);
      }
      throw err;
    }
  }

  async list(userId: string): Promise<Record<Channel, boolean> | null> {
    const { rowCount } = await this.db.query("SELECT 1 FROM users WHERE id = $1", [userId]);
    if (rowCount === 0) return null;
    const { rows } = await this.db.query("SELECT channel, opt_in FROM notification_settings WHERE user_id = $1", [userId]);
    const settings = { push: true, sms: true, email: true };
    for (const r of rows) settings[r.channel as Channel] = r.opt_in;
    return settings;
  }
}
