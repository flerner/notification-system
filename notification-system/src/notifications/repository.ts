import type pg from "pg";
import type { Platform } from "../users/repository.js";
import type { Channel } from "./queues.js";

export interface Payload {
  subject?: string;
  body: string;
}

export interface Notification {
  id: string;
  requestId: string;
  userId: string;
  channel: Channel;
  platform: Platform | null;
  destination: string; // email address, phone number or device token
  queue: string;
  payload: Payload;
  status: string;
  createdAt: Date;
}

export type NewNotification = Omit<Notification, "id" | "status" | "createdAt">;

export interface NotificationRepository {
  // Atomic: either every destination of the request is stored or none is.
  insertPending(rows: NewNotification[]): Promise<Notification[]>;
  markPublished(ids: string[]): Promise<void>;
  // Rows the broker never confirmed and that are old enough not to be a publish in flight.
  findUnpublished(olderThanMs: number, limit: number): Promise<Notification[]>;
}

const COLUMNS = `id, request_id AS "requestId", user_id AS "userId", channel, platform,
  destination, queue, payload, status, created_at AS "createdAt"`;

export class PgNotificationRepository implements NotificationRepository {
  constructor(private readonly db: pg.Pool) {}

  async insertPending(rows: NewNotification[]): Promise<Notification[]> {
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      const created: Notification[] = [];
      for (const r of rows) {
        const { rows: inserted } = await client.query(
          `INSERT INTO notifications (request_id, user_id, channel, platform, destination, queue, payload)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${COLUMNS}`,
          [r.requestId, r.userId, r.channel, r.platform, r.destination, r.queue, r.payload],
        );
        created.push(inserted[0]);
      }
      await client.query("COMMIT");
      return created;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async markPublished(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.db.query("UPDATE notifications SET published_at = now() WHERE id = ANY($1::uuid[])", [ids]);
  }

  async findUnpublished(olderThanMs: number, limit: number): Promise<Notification[]> {
    const { rows } = await this.db.query(
      `SELECT ${COLUMNS} FROM notifications
       WHERE published_at IS NULL AND created_at < now() - ($1 * interval '1 millisecond')
       ORDER BY created_at LIMIT $2`,
      [olderThanMs, limit],
    );
    return rows;
  }
}
