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
  clientId: string;
  channel: Channel;
  platform: Platform | null;
  destination: string;
  queue: string;
  payload: Payload;
  status: Status;
  attempts: number;
  createdAt: Date;
  sendAt: Date;
}

export type NewNotification = Omit<
  Notification,
  "id" | "status" | "attempts" | "createdAt" | "sendAt"
> & { sendAt?: Date | null };

export interface IdempotencyRecord {
  requestId: string;
  requestHash: string;
  notifications: Notification[];
}

export class DuplicateKeyError extends Error {}

export type SkippedStatus = "SKIPPED_OPT_OUT" | "SKIPPED_RATE_LIMITED";

export type ClaimResult =
  | { outcome: "claimed"; notification: Notification }
  | { outcome: "busy" }
  | { outcome: "done" }
  | { outcome: "missing" };

export interface NotificationRepository {
  insertPending(
    rows: NewNotification[],
    idempotency?: { key: string; hash: string },
  ): Promise<Notification[]>;
  findByKey(clientId: string, key: string): Promise<IdempotencyRecord | null>;
  markPublished(ids: string[]): Promise<void>;
  findUnpublished(olderThanMs: number, limit: number): Promise<Notification[]>;

  claim(id: string, leaseMs: number): Promise<ClaimResult>;
  // The outcome of an attempt is recorded only by the worker that holds it: `attempt` is the number
  // claim() returned, and a write from an earlier attempt (a worker whose lease ran out) is refused.
  // Every mark returns false when it was refused.
  markSent(id: string, attempt: number): Promise<boolean>;
  markFailed(id: string, attempt: number, error: string): Promise<boolean>;
  markSkipped(
    id: string,
    attempt: number,
    status: SkippedStatus,
    detail: string,
  ): Promise<boolean>;
  markRetrying(id: string, attempt: number, error: string): Promise<boolean>;
}

const COLUMNS = `id, request_id AS "requestId", user_id AS "userId", client_id AS "clientId", channel, platform,
  destination, queue, payload, status, attempts, created_at AS "createdAt", send_at AS "sendAt"`;

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
        const { rowCount } = await client.query(
          `INSERT INTO idempotency_keys (client_id, key, request_hash, request_id) VALUES ($1, $2, $3, $4)
           ON CONFLICT (client_id, key) DO NOTHING`,
          [
            rows[0]!.clientId,
            idempotency.key,
            idempotency.hash,
            rows[0]!.requestId,
          ],
        );
        if (rowCount === 0) throw new DuplicateKeyError(idempotency.key);
      }
      const created: Notification[] = [];
      for (const r of rows) {
        const { rows: inserted } = await client.query(
          `INSERT INTO notifications (request_id, user_id, client_id, channel, platform, destination, queue, payload, send_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, now())) RETURNING ${COLUMNS}`,
          [
            r.requestId,
            r.userId,
            r.clientId,
            r.channel,
            r.platform,
            r.destination,
            r.queue,
            r.payload,
            r.sendAt ?? null,
          ],
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

  async findByKey(
    clientId: string,
    key: string,
  ): Promise<IdempotencyRecord | null> {
    const { rows } = await this.db.query(
      `SELECT request_id AS "requestId", request_hash AS "requestHash" FROM idempotency_keys
       WHERE client_id = $1 AND key = $2`,
      [clientId, key],
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
    await this.db.query(
      "UPDATE notifications SET published_at = now() WHERE id = ANY($1::uuid[])",
      [ids],
    );
  }

  async findUnpublished(
    olderThanMs: number,
    limit: number,
  ): Promise<Notification[]> {
    const { rows } = await this.db.query(
      `SELECT ${COLUMNS} FROM notifications
       WHERE published_at IS NULL
         AND send_at <= now()
         -- Relies on an immediate notification having send_at = created_at (both default to now() in the
         -- insert's transaction): a later send_at means scheduled, which has no in-flight publish to wait for.
         AND (send_at > created_at OR created_at < now() - ($1 * interval '1 millisecond'))
       ORDER BY send_at LIMIT $2`,
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

    const { rows: current } = await this.db.query(
      "SELECT status FROM notifications WHERE id = $1",
      [id],
    );
    if (current.length === 0) return { outcome: "missing" };
    return { outcome: isTerminal(current[0].status) ? "done" : "busy" };
  }

  async markSent(id: string, attempt: number): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE notifications SET status = 'SENT', sent_at = now(), last_error = NULL
       WHERE id = $1 AND attempts = $3 AND status = ANY($2)`,
      [id, predecessors("SENT"), attempt],
    );
    return rowCount === 1;
  }

  async markSkipped(
    id: string,
    attempt: number,
    status: SkippedStatus,
    detail: string,
  ): Promise<boolean> {
    const { rowCount } = await this.db.query(
      "UPDATE notifications SET status = $2, last_error = $3, lease_expires_at = NULL WHERE id = $1 AND attempts = $5 AND status = ANY($4)",
      [id, status, detail, predecessors(status), attempt],
    );
    return rowCount === 1;
  }

  async markRetrying(id: string, attempt: number, error: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      "UPDATE notifications SET status = 'RETRYING', last_error = $2, lease_expires_at = NULL WHERE id = $1 AND attempts = $4 AND status = ANY($3)",
      [id, error, predecessors("RETRYING"), attempt],
    );
    return rowCount === 1;
  }

  async markFailed(id: string, attempt: number, error: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      "UPDATE notifications SET status = 'FAILED', last_error = $2 WHERE id = $1 AND attempts = $4 AND status = ANY($3)",
      [id, error, predecessors("FAILED"), attempt],
    );
    return rowCount === 1;
  }
}
