import type pg from "pg";
import type { Platform } from "../users/repository.js";
import type { Channel } from "./queues.js";
import { isTerminal, predecessors, type Status } from "./state.js";

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
  status: Status;
  attempts: number;
  createdAt: Date;
}

export type NewNotification = Omit<Notification, "id" | "status" | "attempts" | "createdAt">;

// What we remember about an Idempotency-Key.
export interface IdempotencyRecord {
  requestId: string;
  requestHash: string;
  notifications: Notification[];
}

// Thrown by insertPending when the Idempotency-Key was already used (possibly a moment ago by a
// concurrent request). The caller then looks the original up and replays it.
export class DuplicateKeyError extends Error {}

// Final statuses for notifications deliberately not sent.
export type SkippedStatus = "SKIPPED_OPT_OUT" | "SKIPPED_RATE_LIMITED";

export type ClaimResult =
  | { outcome: "claimed"; notification: Notification }
  // Someone else is working on it and their lease has not expired: try again later.
  | { outcome: "busy" }
  // Already SENT or FAILED: nothing left to do, the message can be dropped.
  | { outcome: "done" }
  | { outcome: "missing" };

export interface NotificationRepository {
  // Atomic: every destination of the request is stored or none is. With `idempotency`, the key
  // is stored in the same transaction; throws DuplicateKeyError if it already exists.
  insertPending(rows: NewNotification[], idempotency?: { key: string; hash: string }): Promise<Notification[]>;
  findByKey(key: string): Promise<IdempotencyRecord | null>;
  markPublished(ids: string[]): Promise<void>;
  // Rows the broker never confirmed and that are old enough not to be a publish in flight.
  findUnpublished(olderThanMs: number, limit: number): Promise<Notification[]>;

  // Atomically takes the right to send this notification for `leaseMs`. Of N concurrent
  // callers, exactly one gets "claimed".
  claim(id: string, leaseMs: number): Promise<ClaimResult>;
  // Return false when the notification was not in a state that allows the change.
  markSent(id: string): Promise<boolean>;
  markFailed(id: string, error: string): Promise<boolean>;
  // The attempt ended without sending because of a rule, not an error (the user opted out, or has
  // reached the rate limit).
  // Final. `detail` says why and is kept in last_error.
  markSkipped(id: string, status: SkippedStatus, detail: string): Promise<boolean>;
  // The delivery failed with a retryable error: park it until its retry message comes back.
  markRetrying(id: string, error: string): Promise<boolean>;
}

const COLUMNS = `id, request_id AS "requestId", user_id AS "userId", channel, platform,
  destination, queue, payload, status, attempts, created_at AS "createdAt"`;

export class PgNotificationRepository implements NotificationRepository {
  constructor(private readonly db: pg.Pool) {}

  async insertPending(
    rows: NewNotification[],
    idempotency?: { key: string; hash: string },
  ): Promise<Notification[]> {
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      if (idempotency) {
        // If a concurrent transaction is inserting the same key, this statement WAITS until it
        // commits or rolls back, then either inserts (it rolled back) or does nothing (it won).
        // That wait is what makes two simultaneous identical requests safe.
        const { rowCount } = await client.query(
          `INSERT INTO idempotency_keys (key, request_hash, request_id) VALUES ($1, $2, $3)
           ON CONFLICT (key) DO NOTHING`,
          [idempotency.key, idempotency.hash, rows[0]!.requestId],
        );
        if (rowCount === 0) throw new DuplicateKeyError(idempotency.key);
      }
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

  async findByKey(key: string): Promise<IdempotencyRecord | null> {
    const { rows } = await this.db.query(
      `SELECT request_id AS "requestId", request_hash AS "requestHash" FROM idempotency_keys WHERE key = $1`,
      [key],
    );
    if (rows.length === 0) return null;
    const { rows: notifications } = await this.db.query(
      `SELECT ${COLUMNS} FROM notifications WHERE request_id = $1 ORDER BY created_at, id`,
      [rows[0].requestId],
    );
    return { ...rows[0], notifications };
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

  async claim(id: string, leaseMs: number): Promise<ClaimResult> {
    // One statement, so the check and the change cannot be separated by another worker. A row in
    // SENDING can only be claimed again once its lease has run out (the worker is presumed dead).
    const { rows } = await this.db.query(
      `UPDATE notifications
       SET status = 'SENDING', attempts = attempts + 1,
           lease_expires_at = now() + ($2 * interval '1 millisecond')
       WHERE id = $1 AND status = ANY($3) AND (status <> 'SENDING' OR lease_expires_at < now())
       RETURNING ${COLUMNS}`,
      [id, leaseMs, predecessors("SENDING")],
    );
    if (rows.length === 1) return { outcome: "claimed", notification: rows[0] };

    // Not claimed: find out why, so the caller knows whether to wait or to drop the message.
    const { rows: current } = await this.db.query("SELECT status FROM notifications WHERE id = $1", [id]);
    if (current.length === 0) return { outcome: "missing" };
    return { outcome: isTerminal(current[0].status) ? "done" : "busy" };
  }

  async markSent(id: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE notifications SET status = 'SENT', sent_at = now(), last_error = NULL
       WHERE id = $1 AND status = ANY($2)`,
      [id, predecessors("SENT")],
    );
    return rowCount === 1;
  }

  async markSkipped(id: string, status: SkippedStatus, detail: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      "UPDATE notifications SET status = $2, last_error = $3, lease_expires_at = NULL WHERE id = $1 AND status = ANY($4)",
      [id, status, detail, predecessors(status)],
    );
    return rowCount === 1;
  }

  async markRetrying(id: string, error: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      "UPDATE notifications SET status = 'RETRYING', last_error = $2, lease_expires_at = NULL WHERE id = $1 AND status = ANY($3)",
      [id, error, predecessors("RETRYING")],
    );
    return rowCount === 1;
  }

  async markFailed(id: string, error: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      "UPDATE notifications SET status = 'FAILED', last_error = $2 WHERE id = $1 AND status = ANY($3)",
      [id, error, predecessors("FAILED")],
    );
    return rowCount === 1;
  }
}
