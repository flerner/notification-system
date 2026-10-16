// A load test for one machine: sends notifications at a fixed rate for a while, then measures how fast the
// system takes them in, how big the backlog gets, and how long it takes to deliver everything.
//
//   npm run load-test                                 200 requests per second for 30 seconds, 3 workers
//   npm run load-test -- --rate 800 --seconds 20      a heavier run
//   npm run load-test -- --workers 6                  more workers
//
// It EMPTIES the notifications table and recreates the api and worker containers (with very high rate limits,
// and mock providers that never fail), then puts the stack back as `docker compose up` would start it.
// The numbers describe this machine with mock providers (50 ms each): they say where the system saturates
// here, not what a deployment would do.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pg from "pg";

const exec = promisify(execFile);

const API = "http://localhost:3000";
const AUTH = `Basic ${Buffer.from("demo-key:demo-secret").toString("base64")}`;
const DB_URL = process.env.DATABASE_URL ?? "postgres://notif:notif@localhost:5432/notifications";

function intArg(name: string, fallback: number, min: number, max: number): number {
  const i = process.argv.indexOf(`--${name}`);
  const value = i >= 0 ? Number(process.argv[i + 1]) : fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`--${name} must be a whole number from ${min} to ${max}`);
  return value;
}
const RATE = intArg("rate", 200, 1, 5000);
const SECONDS = intArg("seconds", 30, 3, 600);
const WORKERS = intArg("workers", 3, 1, 12);
const MAX_IN_FLIGHT = intArg("max-in-flight", 500, 10, 5000);

const LOAD_ENV = {
  RATE_LIMIT_PUSH: "10000000/60",
  RATE_LIMIT_SMS: "10000000/60",
  RATE_LIMIT_EMAIL: "10000000/60",
  MOCK_FAILURE_RATE: "0",
  ...(process.env.LOG_LEVEL ? { LOG_LEVEL: process.env.LOG_LEVEL } : {}),
  ...(process.env.RELAY_INTERVAL_MS ? { RELAY_INTERVAL_MS: process.env.RELAY_INTERVAL_MS } : {}),
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const say = (msg: string) => console.log(`[${String(Math.round((Date.now() - t0) / 1000)).padStart(3)}s] ${msg}`);

async function compose(args: string[], env: Record<string, string> = {}): Promise<string> {
  const { stdout } = await exec("docker", ["compose", ...args], { env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

async function waitHealthy(): Promise<void> {
  const end = Date.now() + 90_000;
  while (Date.now() < end) {
    try {
      if ((await fetch(`${API}/health`, { signal: AbortSignal.timeout(2000) })).ok) return;
    } catch {
      // not up yet
    }
    await sleep(1000);
  }
  throw new Error("the api did not become healthy");
}

const percentile = (sorted: number[], p: number) => (sorted.length === 0 ? NaN : sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!);
const fmt = (n: number, digits = 0) => (Number.isFinite(n) ? n.toFixed(digits) : "n/a");

const db = new pg.Pool({ connectionString: DB_URL, max: 2 });

async function statusCounts(): Promise<Record<string, number>> {
  const { rows } = await db.query("SELECT status, count(*)::int AS n FROM notifications GROUP BY status");
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}
const waiting = (c: Record<string, number>) => (c.PENDING ?? 0) + (c.SENDING ?? 0) + (c.RETRYING ?? 0);

async function idOf(column: "email" | "phone", value: string): Promise<string> {
  const { rows } = await db.query(`SELECT id FROM users WHERE ${column} = $1`, [value]);
  if (rows.length === 0) throw new Error("the demo users are missing: run `npm run seed` first");
  return String(rows[0].id);
}

async function restoreStack() {
  say("putting the stack back to its normal settings");
  await compose(["up", "-d", "--force-recreate", "api", "worker"]).catch((e) => console.error(String(e)));
}

async function main() {
  console.log(`Load test: ${RATE} requests per second for ${SECONDS} s (${RATE * SECONDS} requests), ${WORKERS} workers.`);
  console.log("This empties the notifications table and recreates the api and worker containers. Open Grafana now: http://localhost:3001");
  console.log("Starting in 5 seconds (Ctrl+C to cancel)...");
  await sleep(5000);

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

  try {
    say("preparing: clean state, high rate limits, workers");
    await compose(["up", "-d", "--force-recreate", "--no-deps", "api"], LOAD_ENV);
    await compose(["up", "-d", "--force-recreate", "--no-deps", "--scale", `worker=${WORKERS}`, "worker"], LOAD_ENV);
    await waitHealthy();
    await exec("npx", ["tsx", "scripts/seed.ts"]);
    await db.query("TRUNCATE notifications, idempotency_keys");

    const ana = await idOf("email", "ana@example.com");
    const bob = await idOf("email", "bob@example.com");
    const third = await idOf("phone", "+14155550103");
    const targets: [string, string][] = [[ana, "email"], [bob, "email"], [ana, "sms"], [third, "sms"]];

    const runId = Date.now().toString(36);
    const latencies: number[] = [];
    const statuses = new Map<string, number>();
    let seq = 0;
    let inFlight = 0;
    let skippedByClient = 0;
    let peakInFlight = 0;

    async function sendOne(n: number) {
      const [userId, channel] = targets[n % targets.length]!;
      const started = performance.now();
      inFlight++;
      peakInFlight = Math.max(peakInFlight, inFlight);
      let outcome: string;
      try {
        const res = await fetch(`${API}/v1/notifications`, {
          method: "POST",
          headers: { authorization: AUTH, "content-type": "application/json", "idempotency-key": `load-${runId}-${n}` },
          body: JSON.stringify({ userId, channel, body: `load test message ${n}` }),
          signal: AbortSignal.timeout(10_000),
        });
        await res.arrayBuffer();
        outcome = String(res.status);
        if (res.status === 202) latencies.push(performance.now() - started);
      } catch {
        outcome = "error";
      } finally {
        inFlight--;
      }
      statuses.set(outcome, (statuses.get(outcome) ?? 0) + 1);
    }

    let peakBacklog = 0;
    const sampler = setInterval(async () => {
      try {
        peakBacklog = Math.max(peakBacklog, waiting(await statusCounts()));
      } catch {
        // a sample is optional
      }
    }, 1000);

    say(`sending ${RATE} requests per second for ${SECONDS} s`);
    const loadStart = Date.now();
    let due = 0;
    let lastReport = 0;
    const timer = setInterval(() => {
      const expected = Math.floor(((Date.now() - loadStart) / 1000) * RATE);
      for (; due < expected; due++) {
        if (inFlight >= MAX_IN_FLIGHT) skippedByClient++;
        else void sendOne(seq++);
      }
      const elapsed = Math.floor((Date.now() - loadStart) / 1000);
      if (elapsed >= lastReport + 5) {
        lastReport = elapsed;
        say(`${seq} sent so far, ${inFlight} waiting for an answer, ${latencies.length} accepted`);
      }
    }, 10);
    await sleep(SECONDS * 1000);
    clearInterval(timer);
    while (inFlight > 0 && Date.now() - loadStart < (SECONDS + 30) * 1000) await sleep(50);
    const loadSeconds = (Date.now() - loadStart) / 1000;
    const loadEnd = Date.now();

    const atLoadEnd = await statusCounts();
    say(`load ended: ${waiting(atLoadEnd)} notifications still waiting; waiting for the workers to deliver them`);
    let counts = atLoadEnd;
    const drainDeadline = Date.now() + 180_000;
    while (waiting(counts) > 0 && Date.now() < drainDeadline) {
      await sleep(1000);
      counts = await statusCounts();
    }
    clearInterval(sampler);
    const drainSeconds = (Date.now() - loadEnd) / 1000;

    const { rows } = await db.query("SELECT min(created_at) AS first, max(sent_at) AS last FROM notifications");
    const stored = Object.values(counts).reduce((a, b) => a + b, 0);
    const sent = counts.SENT ?? 0;
    const deliverySeconds = rows[0].first && rows[0].last ? (new Date(rows[0].last).getTime() - new Date(rows[0].first).getTime()) / 1000 : NaN;
    const accepted = latencies.length;
    latencies.sort((a, b) => a - b);

    console.log("\n================ RESULT ================");
    console.log(`asked:      ${RATE}/s for ${SECONDS} s = ${RATE * SECONDS} requests; sent ${seq}${skippedByClient ? `, ${skippedByClient} NOT sent because ${MAX_IN_FLIGHT} were already waiting (the client could not keep up)` : ""}`);
    console.log(`accepted:   ${accepted} (202) = ${fmt(accepted / loadSeconds, 1)}/s    other answers: ${[...statuses].filter(([s]) => s !== "202").map(([s, n]) => `${s} x${n}`).join(", ") || "none"}`);
    console.log(`api time:   p50 ${fmt(percentile(latencies, 50))} ms   p95 ${fmt(percentile(latencies, 95))} ms   p99 ${fmt(percentile(latencies, 99))} ms   max ${fmt(latencies[latencies.length - 1] ?? NaN)} ms   (peak ${peakInFlight} requests in flight)`);
    console.log(`backlog:    peak ${peakBacklog} notifications waiting, ${waiting(atLoadEnd)} when the load stopped, drained ${fmt(drainSeconds, 1)} s later`);
    console.log(`delivered:  ${sent} of ${stored} stored; ${fmt(sent / deliverySeconds, 1)}/s from the first accepted to the last sent    final states: ${JSON.stringify(counts)}`);
    console.log("\nchecks:");
    const ok = (pass: boolean, text: string) => console.log(`  ${pass ? "PASS" : "FAIL"}  ${text}`);
    ok(stored === accepted, `every accepted request was stored once (${accepted} accepted, ${stored} stored)`);
    ok(waiting(counts) === 0, "everything reached a final status");
    ok(sent === stored, "everything was sent (the providers never fail in this test)");
    ok(!statuses.has("error") && ![...statuses.keys()].some((s) => s.startsWith("5")), "no server errors or timeouts");
    const kept = skippedByClient === 0 && drainSeconds <= 5;
    console.log(`\n${kept ? "It kept up at this rate: the backlog was gone within 5 s of the load stopping." : "It did NOT keep up at this rate: look at the lines above to see whether the api, the workers or the client was the limit."}`);
  } finally {
    await cleanup();
    await db.end();
  }
}

await main();
