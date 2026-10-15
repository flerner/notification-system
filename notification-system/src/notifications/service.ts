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
import { NotificationMetrics } from "./metrics.js";
import { queueFor, type Channel } from "./queues.js";
import { render, TemplateNotFoundError, type Params, type TemplateRepository } from "./templates.js";

const IMMEDIATE_WINDOW_MS = 1000;

export class NoDestinationError extends Error {}
export class UnknownUserError extends Error {}
export class IdempotencyKeyReuseError extends Error {}

export type Content =
  | { kind: "text"; subject?: string; body: string }
  | { kind: "template"; name: string; params: Params };

export interface SendRequest {
  clientId: string;
  sendAt?: Date;
  userId: string;
  channel: Channel;
  content: Content;
}

export interface SendResult {
  requestId: string;
  notifications: Notification[];
  replayed: boolean;
}

export class NotificationService {
  constructor(
    private readonly users: UserRepository,
    private readonly notifications: NotificationRepository,
    private readonly templates: TemplateRepository,
    private readonly publisher: MessagePublisher,
    private readonly log: Logger,
    private readonly metrics: NotificationMetrics = new NotificationMetrics(),
  ) {}

  // Persist first, publish second. Once the rows are stored the request is accepted: even if
  // RabbitMQ is down right now, relayUnpublished() will deliver them to the queue later.
  async send(req: SendRequest, idempotencyKey?: string): Promise<SendResult> {
    const hash = requestHash(req);
    if (idempotencyKey) {
      const existing = await this.notifications.findByKey(req.clientId, idempotencyKey);
      if (existing) return this.replay(existing, hash);
    }

    const contacts = await this.users.findContacts(req.userId);
    if (!contacts) throw new UnknownUserError(`user ${req.userId} not found`);

    const destinations = this.destinationsFor(req.channel, contacts);
    if (destinations.length === 0) throw new NoDestinationError(`user ${req.userId} has no destination for ${req.channel}`);

    // Rendered now, so what is stored and queued is the final text: a later edit of the template
    // cannot change a notification that is already waiting, and a missing template or parameter
    // is reported to the caller instead of failing later in a worker.
    const payload = await this.resolve(req.channel, req.content);

    // Contacts are resolved now, not at send time: a notification scheduled for next week goes to
    // the devices the user has today. (Resolving later would need the contact lookup in the worker.)
    const deferred = req.sendAt !== undefined && req.sendAt.getTime() > Date.now() + IMMEDIATE_WINDOW_MS;

    const requestId = randomUUID();
    const rows = destinations.map(
      (d): NewNotification => ({
        requestId,
        userId: req.userId,
        clientId: req.clientId,
        channel: req.channel,
        platform: d.platform,
        destination: d.destination,
        queue: queueFor(req.channel, d.platform),
        payload,
        sendAt: deferred ? req.sendAt : null,
      }),
    );

    let notifications: Notification[];
    try {
      notifications = await this.notifications.insertPending(rows, idempotencyKey ? { key: idempotencyKey, hash } : undefined);
    } catch (err) {
      // Lost a race: a concurrent request with the same key committed between our check above
      // and our insert. The database picked the winner; we return its result.
      if (err instanceof DuplicateKeyError && idempotencyKey) {
        const existing = await this.notifications.findByKey(req.clientId, idempotencyKey);
        if (existing) return this.replay(existing, hash);
      }
      throw err;
    }
    this.metrics.accepted(req.channel, notifications.length);
    if (!deferred) await this.publish(notifications);
    return { requestId, notifications, replayed: false };
  }

  private async resolve(channel: Channel, content: Content): Promise<Payload> {
    if (content.kind === "text") return { subject: content.subject, body: content.body };
    const template = await this.templates.find(content.name, channel);
    if (!template) throw new TemplateNotFoundError(`template "${content.name}" has no ${channel} version`);
    return {
      subject: template.subject === undefined ? undefined : render(template.subject, content.params),
      body: render(template.body, content.params),
    };
  }

  private replay(existing: IdempotencyRecord, hash: string): SendResult {
    if (existing.requestHash !== hash) {
      throw new IdempotencyKeyReuseError("Idempotency-Key was already used with a different request");
    }
    this.metrics.replayed();
    return { requestId: existing.requestId, notifications: existing.notifications, replayed: true };
  }

  // Safety net for notifications that were stored but never reached the broker (crash between
  // the two steps, broker outage). Run periodically. May publish a message twice if two
  // instances overlap; that is acceptable because consumers are idempotent (see the claim in processor.ts).
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
// reused for something else". It covers the request as sent (template name and parameters), not
// the rendered text, so a retry still matches after the template has been edited.
function requestHash(req: SendRequest): string {
  const c = req.content;
  const content =
    c.kind === "text"
      ? ["text", c.subject ?? null, c.body]
      : ["template", c.name, Object.entries(c.params).sort(([a], [b]) => a.localeCompare(b))];
  return createHash("sha256")
    .update(JSON.stringify([req.userId, req.channel, content, req.sendAt?.getTime() ?? null]))
    .digest("hex");
}
