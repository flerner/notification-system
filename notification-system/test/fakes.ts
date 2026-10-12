import request from "supertest";
import { pino } from "pino";
import { hashSecret } from "../src/clients/credentials.js";
import type { ClientRecord, ClientRepository } from "../src/clients/repository.js";
import type { Cache } from "../src/infra/cache.js";
import { buildServer } from "../src/api/server.js";
import type { MessagePublisher } from "../src/infra/rabbit.js";
import {
  DuplicateKeyError,
  type ClaimResult,
  type IdempotencyRecord,
  type NewNotification,
  type Notification,
  type NotificationRepository,
  type SkippedStatus,
} from "../src/notifications/repository.js";
import { isTerminal, predecessors } from "../src/notifications/state.js";
import { NotificationService } from "../src/notifications/service.js";
import type { Channel } from "../src/notifications/queues.js";
import type { RateLimit, RateLimiter } from "../src/notifications/rate-limit.js";
import type { SettingsRepository } from "../src/notifications/settings.js";
import type { Template, TemplateRepository } from "../src/notifications/templates.js";
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

// Mirrors PgNotificationRepository's rules (idempotency keys, claims with leases, legal status
// changes from state.ts). The Postgres tests check the real thing; this keeps the other tests fast.
export class InMemoryNotificationRepository implements NotificationRepository {
  rows: (Notification & { publishedAt: Date | null; sentAt?: Date; lastError?: string; leaseExpiresAt?: number })[] = [];
  keys = new Map<string, { requestId: string; requestHash: string }>(); // keyed by "clientId:key"
  // Tests move time by replacing this, so lease expiry needs no sleeping.
  now = () => Date.now();

  async insertPending(rows: NewNotification[], idempotency?: { key: string; hash: string }): Promise<Notification[]> {
    if (idempotency) {
      const scoped = `${rows[0]!.clientId}:${idempotency.key}`;
      if (this.keys.has(scoped)) throw new DuplicateKeyError(idempotency.key);
      this.keys.set(scoped, { requestId: rows[0]!.requestId, requestHash: idempotency.hash });
    }
    const created = rows.map((r, i) => ({
      ...r,
      id: `n-${this.rows.length + i + 1}`,
      status: "PENDING" as const,
      attempts: 0,
      createdAt: new Date(),
      publishedAt: null,
    }));
    this.rows.push(...created);
    return created;
  }

  async findByKey(clientId: string, key: string): Promise<IdempotencyRecord | null> {
    const k = this.keys.get(`${clientId}:${key}`);
    if (!k) return null;
    return { ...k, notifications: this.rows.filter((r) => r.requestId === k.requestId) };
  }

  async markPublished(ids: string[]): Promise<void> {
    for (const r of this.rows) if (ids.includes(r.id)) r.publishedAt = new Date();
  }

  // The fake ignores the age threshold: tests decide what is "old enough" by calling it.
  async findUnpublished(_olderThanMs: number, limit: number): Promise<Notification[]> {
    return this.rows.filter((r) => r.publishedAt === null).slice(0, limit);
  }

  async claim(id: string, leaseMs: number): Promise<ClaimResult> {
    const row = this.rows.find((r) => r.id === id);
    if (!row) return { outcome: "missing" };
    const claimable =
      predecessors("SENDING").includes(row.status) && (row.status !== "SENDING" || row.leaseExpiresAt! < this.now());
    if (!claimable) return { outcome: isTerminal(row.status) ? "done" : "busy" };
    Object.assign(row, { status: "SENDING", attempts: row.attempts + 1, leaseExpiresAt: this.now() + leaseMs });
    return { outcome: "claimed", notification: { ...row } };
  }

  async markSent(id: string): Promise<boolean> {
    const row = this.rows.find((r) => r.id === id)!;
    if (!predecessors("SENT").includes(row.status)) return false;
    Object.assign(row, { status: "SENT", sentAt: new Date(), lastError: undefined });
    return true;
  }

  async markSkipped(id: string, status: SkippedStatus, detail: string): Promise<boolean> {
    const row = this.rows.find((r) => r.id === id)!;
    if (!predecessors(status).includes(row.status)) return false;
    Object.assign(row, { status, lastError: detail, leaseExpiresAt: undefined });
    return true;
  }

  async markRetrying(id: string, error: string): Promise<boolean> {
    const row = this.rows.find((r) => r.id === id)!;
    if (!predecessors("RETRYING").includes(row.status)) return false;
    Object.assign(row, { status: "RETRYING", lastError: error, leaseExpiresAt: undefined });
    return true;
  }

  async markFailed(id: string, error: string): Promise<boolean> {
    const row = this.rows.find((r) => r.id === id)!;
    if (!predecessors("FAILED").includes(row.status)) return false;
    Object.assign(row, { status: "FAILED", lastError: error });
    return true;
  }
}

export class InMemoryTemplateRepository implements TemplateRepository {
  items = new Map<string, Template>();
  finds = 0; // how many times the "database" was read, to show what the cache saves

  async find(name: string, channel: Channel): Promise<Template | null> {
    this.finds++;
    return this.items.get(`${name}:${channel}`) ?? null;
  }

  async upsert(t: Template): Promise<Template> {
    this.items.set(`${t.name}:${t.channel}`, t);
    return t;
  }
}

// Opted in unless told otherwise, like the real table. `optedOut` holds "userId:channel".
export class InMemorySettingsRepository implements SettingsRepository {
  optedOut = new Set<string>();
  constructor(private readonly users?: InMemoryUserRepository) {}

  async isOptedIn(userId: string, channel: Channel): Promise<boolean> {
    return !this.optedOut.has(`${userId}:${channel}`);
  }

  async setOptIn(userId: string, channel: Channel, optIn: boolean): Promise<void> {
    if (this.users && !(await this.users.findContacts(userId))) throw new UserNotFoundError(`user ${userId} not found`);
    if (optIn) this.optedOut.delete(`${userId}:${channel}`);
    else this.optedOut.add(`${userId}:${channel}`);
  }

  async list(userId: string): Promise<Record<Channel, boolean> | null> {
    if (this.users && !(await this.users.findContacts(userId))) return null;
    const has = (c: Channel) => !this.optedOut.has(`${userId}:${c}`);
    return { push: has("push"), sms: has("sms"), email: has("email") };
  }
}

// Counts per user and channel like the real limiter, without time: the window never ends.
export class InMemoryRateLimiter implements RateLimiter {
  counts = new Map<string, number>();
  calls: { userId: string; channel: Channel }[] = [];
  constructor(private readonly limit: RateLimit = { max: 1_000_000, windowSeconds: 3600 }) {}

  async allow(userId: string, channel: Channel): Promise<boolean> {
    this.calls.push({ userId, channel });
    const key = `${channel}:${userId}`;
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);
    return count <= this.limit.max;
  }

  limitFor(): RateLimit {
    return this.limit;
  }
}

export class InMemoryClientRepository implements ClientRepository {
  clients = new Map<string, ClientRecord>();

  async findByKey(appKey: string): Promise<ClientRecord | null> {
    return this.clients.get(appKey) ?? null;
  }

  async create(c: { appKey: string; name: string; secretHash: string }): Promise<void> {
    this.clients.set(c.appKey, { ...c, revokedAt: null });
  }

  revoke(appKey: string): void {
    this.clients.get(appKey)!.revokedAt = new Date();
  }
}

// The client every test authenticates as, unless it says otherwise.
export const TEST_KEY = "test-client";
export const TEST_SECRET = "test-secret";

// supertest with the test client's credentials already attached.
export const authed = (app: Parameters<typeof request>[0], key = TEST_KEY, secret = TEST_SECRET) => ({
  get: (url: string) => request(app).get(url).auth(key, secret),
  post: (url: string) => request(app).post(url).auth(key, secret),
  put: (url: string) => request(app).put(url).auth(key, secret),
});

export class InMemoryCache implements Cache {
  entries = new Map<string, { value: string; ttlSeconds: number }>();
  async get(key: string) {
    return this.entries.get(key)?.value ?? null;
  }
  async set(key: string, value: string, ttlSeconds: number) {
    this.entries.set(key, { value, ttlSeconds });
  }
  async del(key: string) {
    this.entries.delete(key);
  }
}

// A broker that records what it was given and can be switched off to simulate an outage.
export class FakePublisher implements MessagePublisher {
  published: { queue: string; message: object }[] = [];
  down = false;
  // Publishing to these queues fails while the rest works, e.g. to test a failing dead-letter queue.
  failQueues = new Set<string>();

  async publish(queue: string, message: object): Promise<void> {
    if (this.down || this.failQueues.has(queue)) throw new Error("broker down");
    this.published.push({ queue, message });
  }
}

// The whole app wired with fakes; tests grab the pieces they want to inspect.
export function buildTestApp(healthChecks: HealthCheck[] = [], logger = silentLogger) {
  const users = new InMemoryUserRepository();
  const notificationRows = new InMemoryNotificationRepository();
  const templates = new InMemoryTemplateRepository();
  const settings = new InMemorySettingsRepository(users);
  const publisher = new FakePublisher();
  const clients = new InMemoryClientRepository();
  void clients.create({ appKey: TEST_KEY, name: "tests", secretHash: hashSecret(TEST_SECRET) });
  const notifications = new NotificationService(users, notificationRows, templates, publisher, silentLogger);
  const app = buildServer({ logger, healthChecks, users, notifications, settings, templates, clients });
  return { app, users, notificationRows, templates, settings, publisher, notifications, clients };
}
