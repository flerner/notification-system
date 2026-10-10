import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { MessagePublisher } from "../infra/rabbit.js";
import type { UserRepository } from "../users/repository.js";
import type {
  NewNotification,
  Notification,
  NotificationRepository,
  Payload,
} from "./repository.js";
import { queueFor, type Channel } from "./queues.js";

// The user exists but has nothing to deliver to on this channel (no phone, no devices, ...).
export class NoDestinationError extends Error {}
export class UnknownUserError extends Error {}

export interface SendRequest {
  userId: string;
  channel: Channel;
  payload: Payload;
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
  async send(
    req: SendRequest,
  ): Promise<{ requestId: string; notifications: Notification[] }> {
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
    if (rows.length === 0)
      throw new NoDestinationError(
        `user ${req.userId} has no destination for ${req.channel}`,
      );

    //store to postgres. Notifications are now safe they will be sent to the queue even if the broker is down right now. The relay will retry.
    const notifications = await this.notifications.insertPending(rows);
    //publish to rabbitMQ
    await this.publish(notifications);
    return { requestId, notifications };
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
