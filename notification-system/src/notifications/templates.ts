import type pg from "pg";
import type { Cache } from "../infra/cache.js";
import { NotificationMetrics } from "./metrics.js";
import type { Channel } from "./queues.js";

export interface Template {
  name: string;
  channel: Channel;
  subject?: string;
  body: string;
}

export type Params = Record<string, string | number | boolean>;

export class TemplateNotFoundError extends Error {}
export class TemplateParamError extends Error {}

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

// Fills a template's placeholders. A missing parameter is an error (a half-filled message such as
// "Hi , your order is on its way" must never be sent); extra parameters are ignored. The text is
// scanned once, so a parameter whose value contains "{{x}}" is inserted as it is, not expanded.
export function render(text: string, params: Params): string {
  const missing = new Set<string>();
  const out = text.replace(PLACEHOLDER, (_match, name: string) => {
    if (!Object.hasOwn(params, name)) {
      missing.add(name);
      return "";
    }
    return String(params[name]);
  });
  if (missing.size > 0)
    throw new TemplateParamError(
      `missing template parameters: ${[...missing].join(", ")}`,
    );
  return out;
}

export interface TemplateRepository {
  find(name: string, channel: Channel): Promise<Template | null>;
  upsert(template: Template): Promise<Template>;
}

export class PgTemplateRepository implements TemplateRepository {
  constructor(private readonly db: pg.Pool) {}

  async find(name: string, channel: Channel): Promise<Template | null> {
    const { rows } = await this.db.query(
      "SELECT name, channel, subject, body FROM templates WHERE name = $1 AND channel = $2",
      [name, channel],
    );
    return rows.length === 0 ? null : toTemplate(rows[0]);
  }

  async upsert(t: Template): Promise<Template> {
    const { rows } = await this.db.query(
      `INSERT INTO templates (name, channel, subject, body) VALUES ($1, $2, $3, $4)
       ON CONFLICT (name, channel) DO UPDATE SET subject = EXCLUDED.subject, body = EXCLUDED.body, updated_at = now()
       RETURNING name, channel, subject, body`,
      [t.name, t.channel, t.subject ?? null, t.body],
    );
    return toTemplate(rows[0]);
  }
}

function toTemplate(row: {
  name: string;
  channel: Channel;
  subject: string | null;
  body: string;
}): Template {
  return {
    name: row.name,
    channel: row.channel,
    subject: row.subject ?? undefined,
    body: row.body,
  };
}

export class CachedTemplateRepository implements TemplateRepository {
  constructor(
    private readonly inner: TemplateRepository,
    private readonly cache: Cache,
    private readonly ttlSeconds: number,
    private readonly metrics: NotificationMetrics = new NotificationMetrics(),
  ) {}

  async find(name: string, channel: Channel): Promise<Template | null> {
    const key = cacheKey(name, channel);
    const cached = await this.cache.get(key);
    if (cached !== null) {
      try {
        const template = JSON.parse(cached) as Template;
        this.metrics.templateCache("hit");
        return template;
      } catch {
      }
    }
    this.metrics.templateCache("miss");
    const found = await this.inner.find(name, channel);
    if (found)
      await this.cache.set(key, JSON.stringify(found), this.ttlSeconds);
    return found;
  }

  async upsert(t: Template): Promise<Template> {
    const saved = await this.inner.upsert(t);
    await this.cache.del(cacheKey(t.name, t.channel));
    return saved;
  }
}

const cacheKey = (name: string, channel: Channel) =>
  `template:${name}:${channel}`;
