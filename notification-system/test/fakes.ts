import { pino } from "pino";
import { buildServer } from "../src/api/server.js";
import type { MessagePublisher } from "../src/infra/rabbit.js";
import type { NewNotification, Notification, NotificationRepository } from "../src/notifications/repository.js";
import { NotificationService } from "../src/notifications/service.js";
import {
  DuplicateContactError,
  UserNotFoundError,
  type Contacts,
  type Device,
  type Platform,
  type User,
  type UserRepository,
} from "../src/users/repository.js";
import type { HealthCheck } from "../src/infra/health.js";

export const silentLogger = pino({ level: "silent" });

// Behaves like PgUserRepository for the cases the tests care about, with no database.
export class InMemoryUserRepository implements UserRepository {
  private users: User[] = [];
  private devices = new Map<string, Device>(); // keyed by token, like the UNIQUE constraint

  async createUser(input: { email?: string; phone?: string }): Promise<User> {
    const taken = this.users.some(
      (u) => (input.email && u.email === input.email) || (input.phone && u.phone === input.phone),
    );
    if (taken) throw new DuplicateContactError("email or phone already registered");
    const user = { id: String(this.users.length + 1), email: input.email ?? null, phone: input.phone ?? null };
    this.users.push(user);
    return user;
  }

  async registerDevice(input: { userId: string; platform: Platform; token: string }): Promise<Device> {
    if (!this.users.some((u) => u.id === input.userId)) throw new UserNotFoundError("user not found");
    const existing = this.devices.get(input.token);
    const device = { id: existing?.id ?? String(this.devices.size + 1), ...input };
    this.devices.set(input.token, device);
    return device;
  }

  async findContacts(userId: string): Promise<Contacts | null> {
    const user = this.users.find((u) => u.id === userId);
    if (!user) return null;
    return { user, devices: [...this.devices.values()].filter((d) => d.userId === userId) };
  }
}

export class InMemoryNotificationRepository implements NotificationRepository {
  rows: (Notification & { publishedAt: Date | null; sentAt?: Date; lastError?: string })[] = [];

  async insertPending(rows: NewNotification[]): Promise<Notification[]> {
    const created = rows.map((r, i) => ({
      ...r,
      id: `n-${this.rows.length + i + 1}`,
      status: "PENDING",
      createdAt: new Date(),
      publishedAt: null,
    }));
    this.rows.push(...created);
    return created;
  }

  async markPublished(ids: string[]): Promise<void> {
    for (const r of this.rows) if (ids.includes(r.id)) r.publishedAt = new Date();
  }

  async findById(id: string): Promise<Notification | null> {
    return this.rows.find((r) => r.id === id) ?? null;
  }

  async markSent(id: string): Promise<void> {
    const r = this.rows.find((x) => x.id === id)!;
    Object.assign(r, { status: "SENT", sentAt: new Date(), lastError: undefined });
  }

  async markFailed(id: string, error: string): Promise<void> {
    Object.assign(this.rows.find((x) => x.id === id)!, { status: "FAILED", lastError: error });
  }

  // The fake ignores the age threshold: tests decide what is "old enough" by calling it.
  async findUnpublished(_olderThanMs: number, limit: number): Promise<Notification[]> {
    return this.rows.filter((r) => r.publishedAt === null).slice(0, limit);
  }
}

// A broker that records what it was given and can be switched off to simulate an outage.
export class FakePublisher implements MessagePublisher {
  published: { queue: string; message: object }[] = [];
  down = false;

  async publish(queue: string, message: object): Promise<void> {
    if (this.down) throw new Error("broker down");
    this.published.push({ queue, message });
  }
}

// The whole app wired with fakes; tests grab the pieces they want to inspect.
export function buildTestApp(healthChecks: HealthCheck[] = []) {
  const users = new InMemoryUserRepository();
  const notificationRows = new InMemoryNotificationRepository();
  const publisher = new FakePublisher();
  const notifications = new NotificationService(users, notificationRows, publisher, silentLogger);
  const app = buildServer({ logger: silentLogger, healthChecks, users, notifications });
  return { app, users, notificationRows, publisher, notifications };
}
