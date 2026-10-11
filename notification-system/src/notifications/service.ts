import { createHash, randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { MessagePublisher } from "../infra/rabbit.js";
import type { UserRepository } from "../users/repository.js";
import {
  DuplicateKeyError,
  type IdempotencyRecord,
  type NewNotification,
  type Notification,
  type NotificationRepository,
  type Payload,
} from "./repository.js";
import { queueFor, type Channel } from "./queues.js";

// The user exists but has nothing to deliver to on this channel (no phone, no devices, ...).
export class NoDestinationError extends Error {}
export class UnknownUserError extends Error {}
// The same Idempotency-Key was sent with a different request: a bug on the caller's side.
export class IdempotencyKeyReuseError extends Error {}

export interface SendRequest {
  userId: string;
  channel: Channel;
  payload: Payload;
}

export interface SendResult {
  requestId: string;
  notifications: Notification[];
  // True when this call returned the result of an earlier call with the same Idempotency-Key.
  replayed: boolean;
}

export class NotificationService {
  constructor(
    private readonly users: UserRepository,
    private readonly notifications: NotificationRepository,
    private readonly publisher: MessagePublisher,
    private readonly log: Logger,
  ) {}

  // Persist first, publish second. Once the rows are stored the request is accepted: even if
  // RabbitMQ is down right now, relayUnpublished() will deliver them to the queue later.
  //
  // With an idempotencyKey, calling this again with the same key and the same request does not
  // create anything new: it returns the original result (replayed = true). The key is checked
  // first, so a replay still works if the user's contacts changed in the meantime.
  async send(req: SendRequest, idempotencyKey?: string): Promise<SendResult> {
    const hash = requestHash(req);
    if (idempotencyKey) {
      const existing = await this.notifications.findByKey(idempotencyKey);
      if (existing) return this.replay(existing, hash);
    }

    const contacts = await this.users.findContacts(req.userId);
    if (!contacts) throw new UnknownUserError(`user ${req.userId} not found`);

    const requestId = randomUUID();
    const rows = this.destinationsFor(req.channel, contacts).map(
      (d): NewNotification => ({
        requestId,
        userId: req.userId,
        channel: req.channel,
        platform: d.platform,
        destination: d.destination,
        queue: queueFor(req.channel, d.platform),
        payload: req.payload,
      }),
    );
    if (rows.length === 0) throw new NoDestinationError(`user ${req.userId} has no destination for ${req.channel}`);

    let notifications: Notification[];
    try {
      notifications = await this.notifications.insertPending(rows, idempotencyKey ? { key: idempotencyKey, hash } : undefined);
    } catch (err) {
      // Lost a race: a concurrent request with the same key committed between our check above
      // and our insert. The database picked the winner; we return its result.
      if (err instanceof DuplicateKeyError && idempotencyKey) {
        const existing = await this.notifications.findByKey(idempotencyKey);
        if (existing) return this.replay(existing, hash);
      }
      throw err;
    }
    await this.publish(notifications);
    return { requestId, notifications, replayed: false };
  }

  private replay(existing: IdempotencyRecord, hash: string): SendResult {
    if (existing.requestHash !== hash) {
      throw new IdempotencyKeyReuseError("Idempotency-Key was already used with a different request");
    }
    // Not published again: if the original publish failed, the relay takes care of it.
    return { requestId: existing.requestId, notifications: existing.notifications, replayed: true };
  }

  // Safety net for notifications that were stored but never reached the broker (crash between
  // the two steps, broker outage). Run periodically. May publish a message twice if two
  // instances overlap; that is acceptable because consumers are idempotent (M5).
  async relayUnpublished(
    olderThanMs: number,
    batchSize = 100,
  ): Promise<number> {
    const stuck = await this.notifications.findUnpublished(
      olderThanMs,
      batchSize,
    );
    return this.publish(stuck);
  }

  // Returns how many were confirmed by the broker. Never throws for a broker failure: the rows
  // simply stay unpublished and the relay retries them.
  private async publish(notifications: Notification[]): Promise<number> {
    const results = await Promise.allSettled(
      notifications.map((n) =>
        this.publisher.publish(n.queue, { notificationId: n.id }),
      ),
    );
    const published: string[] = [];
    results.forEach((r, i) => {
      const n = notifications[i]!;
      if (r.status === "fulfilled") published.push(n.id);
      else
        this.log.warn(
          { err: r.reason, notificationId: n.id, queue: n.queue },
          "publish failed, relay will retry",
        );
    });
    try {
      await this.notifications.markPublished(published);
    } catch (err) {
      // Worst case the relay publishes these again; duplicates are harmless.
      this.log.error({ err }, "could not mark notifications as published");
    }
    return published.length;
  }

  private destinationsFor(
    channel: Channel,
    {
      user,
      devices,
    }: NonNullable<Awaited<ReturnType<UserRepository["findContacts"]>>>,
  ): { destination: string; platform: NewNotification["platform"] }[] {
    switch (channel) {
      case "email":
        return user.email ? [{ destination: user.email, platform: null }] : [];
      case "sms":
        return user.phone ? [{ destination: user.phone, platform: null }] : [];
      case "push":
        return devices.map((d) => ({
          destination: d.token,
          platform: d.platform,
        }));
    }
  }
}

// Fingerprint of what the caller asked for, to tell "the same request retried" from "the same key
// reused for something else".
function requestHash(req: SendRequest): string {
  return createHash("sha256")
    .update(JSON.stringify([req.userId, req.channel, req.payload.subject ?? null, req.payload.body]))
    .digest("hex");
}
