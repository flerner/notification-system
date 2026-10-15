// It EMPTIES the notifications table, the rate-limit counters and the queues, and it recreates the api
// and worker containers (with short retry delays and high rate limits so the demo is visible). When it
// finishes, or is interrupted, it puts the stack back as `docker compose up` would start it.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pg from "pg";

const exec = promisify(execFile);

const API = "http://localhost:3000";
const AUTH = `Basic ${Buffer.from("demo-key:demo-secret").toString("base64")}`;
const DB_URL = process.env.DATABASE_URL ?? "postgres://notif:notif@localhost:5432/notifications";

const scaleArg = process.argv.indexOf("--scale");
const SCALE = scaleArg >= 0 ? Number(process.argv[scaleArg + 1]) : 1;
if (!(SCALE > 0 && SCALE <= 5)) throw new Error("--scale must be a number between 0 and 5");
const workersArg = process.argv.indexOf("--workers");
const WORKERS = workersArg >= 0 ? Number(process.argv[workersArg + 1]) : 1;
if (!Number.isInteger(WORKERS) || WORKERS < 1 || WORKERS > 8) throw new Error("--workers must be a whole number from 1 to 8");
const seconds = (s: number) => Math.max(3, Math.round(s * SCALE)) * 1000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const started = Date.now();
const say = (msg: string) => console.log(`[${String(Math.round((Date.now() - started) / 1000)).padStart(3)}s] ${msg}`);
const banner = (title: string, watch: string) => {
  console.log(`\n=== ${title}`);
  console.log(`    watch: ${watch}`);
};

async function compose(args: string[], env: Record<string, string> = {}): Promise<string> {
  const { stdout } = await exec("docker", ["compose", ...args], { env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

const DEMO_ENV = {
  RETRY_DELAYS_MS: "2000,5000",
  RATE_LIMIT_PUSH: "100000/60",
  RATE_LIMIT_SMS: "100000/60",
  RATE_LIMIT_EMAIL: "100000/60",
};
const archivedWorkerLogs: string[] = [];
async function recreateWorker(extra: Record<string, string> = {}, archiveFirst = true) {
  if (archiveFirst) archivedWorkerLogs.push(await compose(["logs", "--no-log-prefix", "worker"]).catch(() => ""));
  return compose(["up", "-d", "--force-recreate", "--no-deps", "--scale", `worker=${WORKERS}`, "worker"], { ...DEMO_ENV, ...extra });
}

async function waitHealthy(timeoutMs = 90_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      if ((await fetch(`${API}/health`, { signal: AbortSignal.timeout(2000) })).ok) return;
    } catch {
    }
    await sleep(1000);
  }
  throw new Error("the api did not become healthy");
}

type Tally = {
  logicalRequests: number;
  accepted: number;
  neverAccepted: number;
  notificationsReported: number;
  repeatsRecognised: number;
  http5xx: number;
  networkErrors: number;
  retriesByCaller: number;
};

const TARGETS: [userId: string, channel: string][] = [
  ["1", "email"], ["2", "email"], ["1", "sms"], ["3", "sms"], ["1", "push"], ["2", "push"],
];

class Load {
  readonly tally: Tally = {
    logicalRequests: 0, accepted: 0, neverAccepted: 0, notificationsReported: 0,
    repeatsRecognised: 0, http5xx: 0, networkErrors: 0, retriesByCaller: 0,
  };
  private rate = 0;
  private carry = 0;
  private seq = 0;
  private timer?: NodeJS.Timeout;
  private readonly inflight = new Set<Promise<void>>();
  private readonly runId = Date.now().toString(36);

  setRate(perSecond: number) {
    this.rate = perSecond;
  }

  start() {
    this.timer = setInterval(() => {
      this.carry += this.rate / 10;
      const n = Math.floor(this.carry);
      this.carry -= n;
      for (let i = 0; i < n; i++) {
        const p = this.sendOne().finally(() => this.inflight.delete(p));
        this.inflight.add(p);
      }
    }, 100);
  }

  async stop() {
    clearInterval(this.timer);
    await Promise.allSettled([...this.inflight]);
  }

  private body(): string {
    const [userId, channel] = TARGETS[Math.floor(Math.random() * TARGETS.length)]!;
    const n = ++this.seq;
    return JSON.stringify(
      Math.random() < 0.5
        ? { userId, channel, template: "order-shipped", params: { name: `User${userId}`, order_id: n, eta: "Friday" } }
        : { userId, channel, body: `demo message ${n}` },
    );
  }

  private post(body: string, key: string) {
    return fetch(`${API}/v1/notifications`, {
      method: "POST",
      headers: { authorization: AUTH, "content-type": "application/json", "idempotency-key": key },
      body,
      signal: AbortSignal.timeout(8000),
    });
  }

  private async sendOne(): Promise<void> {
    const t = this.tally;
    t.logicalRequests++;
    const body = this.body();
    const key = `chaos-${this.runId}-${this.seq}`;

    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const res = await this.post(body, key);
        if (res.status === 202) {
          const json = (await res.json()) as { notifications: unknown[] };
          t.accepted++;
          t.notificationsReported += json.notifications.length;
          if (Math.random() < 0.1) {
            const again = await this.post(body, key).catch(() => undefined);
            if (again?.status === 202 && again.headers.get("idempotent-replayed") === "true") t.repeatsRecognised++;
          }
          return;
        }
        if (res.status >= 500) t.http5xx++;
        else return void t.neverAccepted++;
      } catch {
        t.networkErrors++;
      }
      t.retriesByCaller++;
      await sleep(500 * attempt);
    }
    t.neverAccepted++;
  }
}

async function purgeQueues() {
  const names = (await compose(["exec", "-T", "rabbitmq", "rabbitmqctl", "list_queues", "name", "--quiet"]))
    .split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("name") && !l.startsWith("Timeout") && !l.startsWith("Listing"));
  for (const q of names) await compose(["exec", "-T", "rabbitmq", "rabbitmqctl", "purge_queue", q]).catch(() => "");
}

// Read with rabbitmqctl, which is exact. The management API's message counts are only refreshed every
// few seconds, so reading them at the end of a run can miss the last ones.
async function deadLetterDepth(): Promise<number | undefined> {
  try {
    const out = await compose(["exec", "-T", "rabbitmq", "rabbitmqctl", "list_queues", "name", "messages", "--quiet"]);
    const line = out.split("\n").map((l) => l.trim().split(/\s+/)).find((cols) => cols[0] === "dead-letter");
    return line ? Number(line[1]) : undefined;
  } catch {
    return undefined;
  }
}

async function peakBacklog(runSeconds: number): Promise<number | undefined> {
  try {
    const q = `max_over_time((sum(rabbitmq_queue_messages_ready{queue!~".*retry.*|dead-letter"}))[${runSeconds}s:5s])`;
    const res = await fetch(`http://localhost:9090/api/v1/query?query=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(3000) });
    const r = ((await res.json()) as { data: { result: { value: [number, string] }[] } }).data.result;
    return r[0] ? Math.round(Number(r[0].value[1])) : undefined;
  } catch {
    return undefined;
  }
}

async function runLogLines(since: Date): Promise<{ level?: number; msg?: string; notificationId?: string; hostname?: string }[]> {
  const current = await compose(["logs", "--no-log-prefix", "--since", since.toISOString(), "api", "worker"]).catch(() => "");
  const lines: { level?: number; msg?: string; notificationId?: string; hostname?: string }[] = [];
  for (const line of [...archivedWorkerLogs, current].join("\n").split("\n")) {
    try {
      lines.push(JSON.parse(line));
    } catch {
    }
  }
  return lines;
}

function errorLogs(lines: { level?: number; msg?: string }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const j of lines) {
    if ((j.level ?? 0) >= 50) counts[j.msg ?? "(no message)"] = (counts[j.msg ?? "(no message)"] ?? 0) + 1;
  }
  return counts;
}

// A notification that was handed to the provider more than once. Found from the "notification sent" log
// line, which names the notification. Two cases:
//  - attempts = 1: it was never claimed again, so two workers processed the same notification at the
//    same time. The claim exists to make that impossible, so this would be a bug.
//  - attempts > 1: it was claimed again, after a worker died or lost its lease. The design accepts a
//    repeat send there (a duplicate instead of a loss), so it is reported but is not a failure.
async function repeatedSends(db: pg.Pool, lines: { msg?: string; notificationId?: string }[]) {
  const sends = new Map<string, number>();
  for (const j of lines) {
    if (j.msg === "notification sent" && j.notificationId) sends.set(j.notificationId, (sends.get(j.notificationId) ?? 0) + 1);
  }
  const repeated = [...sends].filter(([, n]) => n > 1).map(([id]) => id);
  if (repeated.length === 0) return { racing: 0, afterCrash: 0 };
  const rows = (await db.query("SELECT id, attempts FROM notifications WHERE id = ANY($1::uuid[])", [repeated])).rows as { id: string; attempts: number }[];
  const racing = rows.filter((r) => r.attempts === 1).length;
  return { racing, afterCrash: rows.length - racing };
}

async function workShare(): Promise<string> {
  const out = await compose(["logs", "--no-log-prefix", "worker"]).catch(() => "");
  const counts: Record<string, number> = {};
  for (const line of out.split("\n")) {
    try {
      const j = JSON.parse(line) as { msg?: string; hostname?: string };
      if (j.msg === "notification sent" && j.hostname) counts[j.hostname.slice(0, 6)] = (counts[j.hostname.slice(0, 6)] ?? 0) + 1;
    } catch {
    }
  }
  return Object.entries(counts).map(([worker, n]) => `${worker}: ${n}`).join(", ") || "(none yet)";
}

const mark = (ok: boolean) => (ok ? "PASS" : "FAIL");

async function restoreStack() {
  say("putting the stack back to its normal settings");
  await compose(["start", "rabbitmq", "redis"]).catch(() => "");
  await compose(["up", "-d", "--force-recreate", "api", "worker"]).catch((e) => console.error(String(e)));
}

async function main() {
  console.log("Load and chaos demo. Open the dashboard now: http://localhost:3001");
  console.log("This empties the notifications table, rate-limit counters and queues, and recreates api and worker.");
  console.log("Starting in 5 seconds (Ctrl+C to cancel)...");
  await sleep(5000);

  const db = new pg.Pool({ connectionString: DB_URL, max: 2 });
  let restored = false;
  const cleanup = async () => {
    if (restored) return;
    restored = true;
    await restoreStack();
  };
  process.once("SIGINT", async () => {
    await cleanup();
    process.exit(130);
  });

  const load = new Load();
  try {
    say("preparing: clean state, demo settings, seed data");
    await compose(["up", "-d", "--force-recreate", "--no-deps", "api"], DEMO_ENV);
    await recreateWorker({}, false);
    await waitHealthy();
    await exec("npx", ["tsx", "scripts/seed.ts"]);
    await db.query("TRUNCATE notifications, idempotency_keys");
    await compose(["exec", "-T", "redis", "redis-cli", "eval", "for _,k in ipairs(redis.call('keys','ratelimit:*')) do redis.call('del',k) end", "0"]);
    await purgeQueues();
    await fetch(`${API}/users/2/devices`, {
      method: "POST",
      headers: { authorization: AUTH, "content-type": "application/json" },
      body: JSON.stringify({ platform: "ios", token: "invalid-token-chaos" }),
    });
    const runStart = new Date();
    load.start();

    banner("1. Steady load (4 requests per second)", "Accepted vs sent follow each other; Waiting in queues stays near 0; p95 stays low");
    load.setRate(4);
    await sleep(seconds(30));

    banner("2. A spike (15 requests per second)", "Accepted jumps; Waiting for a worker may rise for a moment, then falls as the worker keeps up");
    load.setRate(15);
    await sleep(seconds(30));
    load.setRate(4);
    if (WORKERS > 1) say(`sends shared between the ${WORKERS} workers so far: ${await workShare()}`);

    if (WORKERS === 1) {
      banner("3. The only worker dies (and comes back)", "Workers listening turns red (0); Waiting in queues climbs; after the restart it drains to 0");
      await sleep(seconds(8));
      say("stopping the worker");
      await compose(["stop", "worker"]);
      await sleep(seconds(20));
      say("starting the worker again");
      await compose(["start", "worker"]);
      await sleep(seconds(18));
    } else {
      banner(
        `3. One of ${WORKERS} workers is killed (and comes back)`,
        `Workers listening drops by one and does NOT reach 0; the others carry the load; what the dead worker held is claimed again once its lease runs out`,
      );
      await sleep(seconds(8));
      const ids = (await compose(["ps", "-q", "worker"])).split("\n").filter(Boolean);
      say("killing one worker with SIGKILL, like a crash: it gets no chance to finish what it is doing");
      await exec("docker", ["kill", ids[0]!]);
      await sleep(seconds(20));
      say("bringing the missing worker back");
      await compose(["up", "-d", "--scale", `worker=${WORKERS}`, "--no-recreate", "--no-deps", "worker"], DEMO_ENV);
      await sleep(seconds(18));
    }

    banner("4. RabbitMQ goes down", "the API still answers 202 (stored, not queued yet); Workers listening drops; after the restart the relay queues what was stored");
    say("stopping RabbitMQ");
    await compose(["stop", "rabbitmq"]);
    await sleep(seconds(15));
    say("starting RabbitMQ again");
    await compose(["start", "rabbitmq"]);
    await sleep(seconds(25));

    banner("5. Redis goes down", "nothing visible should change: templates come from Postgres and the rate limiter lets notifications through");
    say("stopping Redis");
    await compose(["stop", "redis"]);
    await sleep(seconds(15));
    say("starting Redis again");
    await compose(["start", "redis"]);
    await sleep(seconds(10));

    banner("6. A flaky provider (half of the sends fail)", "retries appear in What becomes of notifications; p95 rises; some notifications fail for good and reach the dead-letter queue");
    await recreateWorker({ MOCK_FAILURE_RATE: "0.5" });
    await sleep(seconds(30));
    say("the provider recovers");
    await recreateWorker();
    await sleep(seconds(15));

    banner("7. The provider is completely down", "Provider circuit breakers turns red; notifications wait without using their attempts; after recovery they flow");
    await recreateWorker({ MOCK_FAILURE_RATE: "1", BREAKER_FAILURE_THRESHOLD: "3", BREAKER_COOLDOWN_MS: "15000" });
    await sleep(seconds(20));
    say("the provider recovers");
    await recreateWorker();
    await sleep(seconds(10));

    banner("8. Load stops; waiting for everything to finish", "Waiting in queues returns to 0; retrying notifications reach a final state");
    load.setRate(0);
    await load.stop();
    const unfinished = () =>
      db.query("SELECT count(*)::int AS n FROM notifications WHERE status IN ('PENDING','SENDING','RETRYING')").then((r) => r.rows[0].n as number);
    const end = Date.now() + 120_000;
    let left = await unfinished();
    while (left > 0 && Date.now() < end) {
      say(`${left} notifications not finished yet`);
      await sleep(5000);
      left = await unfinished();
    }

    const t = load.tally;
    const rows = (await db.query("SELECT count(*)::int AS n FROM notifications")).rows[0].n as number;
    const byStatus = (await db.query("SELECT status, count(*)::int AS n FROM notifications GROUP BY 1 ORDER BY 1")).rows as { status: string; n: number }[];
    const attempts = (await db.query("SELECT max(attempts)::int AS max FROM notifications")).rows[0].max as number;
    const dlq = await deadLetterDepth();
    const failedRows = byStatus.find((r) => r.status === "FAILED")?.n ?? 0;
    const backlog = await peakBacklog(Math.ceil((Date.now() - runStart.getTime()) / 1000));
    const logLines = await runLogLines(runStart);
    const errors = errorLogs(logLines);
    const repeats = await repeatedSends(db, logLines);

    console.log("\n================ RESULT ================");
    console.log(`caller:   ${t.logicalRequests} requests, ${t.accepted} accepted (202), ${t.neverAccepted} never accepted`);
    console.log(`          ${t.retriesByCaller} retries by the caller (${t.networkErrors} network errors, ${t.http5xx} server errors), ${t.repeatsRecognised} repeats recognised as replays`);
    console.log(`stored:   ${rows} notifications in Postgres (the API reported ${t.notificationsReported})`);
    console.log(`outcome:  ${byStatus.map((r) => `${r.status} ${r.n}`).join(", ")}`);
    console.log(`          most attempts used by one notification: ${attempts}`);
    console.log(`queues:   peak backlog ${backlog ?? "?"} messages, dead-letter queue holds ${dlq ?? "?"} (FAILED rows: ${failedRows})`);
    const errs = Object.entries(errors).sort((a, b) => b[1] - a[1]);
    console.log(`workers:  ${WORKERS}${WORKERS > 1 ? `; sent twice by workers racing: ${repeats.racing}; sent again after a worker died: ${repeats.afterCrash} (allowed: a duplicate instead of a loss)` : ""}`);
    console.log(`logs:     error-level lines by message ${errs.length ? "" : "(none)"}`);
    for (const [msg, n] of errs) console.log(`            ${String(n).padStart(5)}  ${msg}`);

    console.log("\nchecks:");
    const checks: [boolean, string][] = [
      [t.neverAccepted === 0, "every request was accepted in the end (the caller's retries with the same key were enough)"],
      [rows === t.notificationsReported, "no notification lost or duplicated between the API's answer and the database"],
      [left === 0, "every notification reached a final status (none stuck in PENDING, SENDING or RETRYING)"],
      [t.http5xx === 0, "the API never answered with a server error, even with RabbitMQ, Redis or a worker down"],
      [repeats.racing === 0, "no notification was sent twice by workers racing for it (the claim let exactly one win)"],
    ];
    for (const [ok, text] of checks) console.log(`  ${mark(ok)}  ${text}`);
    const allOk = checks.every(([ok]) => ok);
    console.log(allOk ? "\nNothing was lost." : "\nSomething did not hold: see the FAIL lines above.");
    process.exitCode = allOk ? 0 : 1;
  } finally {
    await load.stop().catch(() => undefined);
    await db.end().catch(() => undefined);
    await cleanup();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
