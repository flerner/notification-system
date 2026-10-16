# Design decisions

Why the system is built the way it is: for each choice, the reason, the trade-off, and the alternative where there was one.
[DESIGN.md](../DESIGN.md) summarises the important ones; this is the full log, numbered in the order the decisions were made.

Decisions that relate to Chapter 10 (or the chapters it builds on) carry a `Book:` line and a reference in the index. *Variation* marks where the design differs, *Own* what was added. Only decisions that relate to the book, and the large ones that do not, are listed.

| # | Decision | Book |
|---|---|---|
| [D-01](#d-01) | TypeScript on Node.js (Express 5) |  |
| [D-02](#d-02) | RabbitMQ over Kafka | Ch. 10 queues per type; Ch. 1 message queue |
| [D-03](#d-03) | PostgreSQL as source of truth, Redis for cache and rate limiting | Ch. 10 improved design; Fig. 10-11 |
| [D-04](#d-04) | Mock providers behind a `ChannelProvider` interface | Ch. 10 third-party services |
| [D-05](#d-05) | The notifications table is its own outbox | Ch. 10 reliability: no data loss |
| [D-06](#d-06) | Device registration is an idempotent upsert keyed by token | Ch. 10 contact info flow |
| [D-07](#d-07) | Validation at the edge with Zod; ids are strings | Ch. 10 notification servers |
| [D-08](#d-08) | 202 Accepted, one row per destination, queue message carries only the id | Ch. 10 notification servers; contact flow |
| [D-09](#d-09) | workers are a second process from the same image; backpressure through `prefetch` | Ch. 10 workers; monitor queued |
| [D-10](#d-10) | The claim and the lease ship together |  |
| [D-11](#d-11) | Idempotency layer 1 (API): optional `Idempotency-Key`, key stored in the same transaction | Ch. 10 exactly once: dedupe by event ID |
| [D-12](#d-12) | Idempotency layer 2 (worker): atomic claim with a lease, plus `busy` requeue | Ch. 10 exactly once: dedupe by event ID |
| [D-13](#d-13) | State machine in one module, constraint in the database; provider dedupe key (layer 3) |  |
| [D-14](#d-14) | Error classification: `ProviderError.retryable`, unknown means retryable |  |
| [D-15](#d-15) | Retries use RabbitMQ retry queues (TTL + dead-letter), not timers in our code | Ch. 10 retry mechanism; Ch. 4 back off |
| [D-16](#d-16) | Dead-letter queue is an operator signal; the FAILED row is the truth | Ch. 10 retry mechanism: alert |
| [D-17](#d-17) | Timeouts and a circuit breaker per provider, checked BEFORE the claim |  |
| [D-18](#d-18) | Opt-out is checked in the worker, at the last moment, and recorded as SKIPPED_OPT_OUT | Ch. 10 notification setting; variation: where |
| [D-19](#d-19) | Templates are rendered in the API, per (name, channel), strictly | Ch. 10 notification template |
| [D-20](#d-20) | Redis cache-aside for templates only; fail open | Ch. 10 cache; variation: templates only |
| [D-21](#d-21) | Frequency cap per user and channel, enforced by the worker, one slot per notification | Ch. 10 rate limiting; variation: where |
| [D-22](#d-22) | Fixed window counter in Redis, one Lua script | Ch. 4 fixed window counter; race condition |
| [D-23](#d-23) | Authentication with appKey / appSecret as HTTP Basic, secrets stored hashed | Ch. 10 security: appKey/appSecret |
| [D-24](#d-24) | Metrics on a separate internal port; Prometheus finds replicas by DNS | Ch. 1 logging, metrics; Ch. 10 monitoring |
| [D-25](#d-25) | Low-cardinality metrics that answer the questions we actually had | Ch. 10 monitor queued notifications |
| [D-26](#d-26) | Grafana is provisioned from files, the dashboard is generated from code | Ch. 10 monitor queued; Fig. 10-12 |
| [D-27](#d-27) | Alert rules as code in Prometheus, with nothing to deliver them | Ch. 10 retry: alert; monitor queued |
| [D-28](#d-28) | Scheduled notifications reuse the relay: `sendAt`, stored but not published until due | Ch. 10 Step 1: scheduled triggers |

## D-01

**TypeScript on Node.js (Express 5)**

- **Why:** Express is a framework I know well, so I can explain and maintain the whole HTTP layer myself. Express 5 forwards async errors to the error middleware. Fastify was the first choice and was replaced early on; the HTTP layer was only three files, and everything else is framework-independent. Strong typing helps model the notification state machine.
- **Trade-off:** single-threaded, which is fine because the work is I/O-bound (network calls to providers).

## D-02

**RabbitMQ over Kafka**

> **Book:** Ch. 10, Step 2, Fig. 10-10 (one queue per notification type); Ch. 1, "Message queue".

- **Why:** the workload is a **task queue** (do this send once, retry on failure, route per channel). RabbitMQ gives us per-queue retry via **dead-letter exchanges with TTL**, per-message ack/nack, `prefetch` for backpressure, simple routing, and built-in Prometheus metrics (queue depth). Easier to learn and operate.
- **Trade-off:** no replay of old messages and lower raw throughput ceiling than Kafka. At about 2k/s peak this is a non-issue. If we needed replay or event sourcing, Kafka would win.

## D-03

**PostgreSQL as source of truth, Redis for cache and rate limiting**

> **Book:** Ch. 10, Step 2, improved design (database and cache out of the notification server); Fig. 10-11 (notification log).

- **Why:** the notification log must be durable. Postgres gives **unique constraints** for idempotency and transactions for the outbox. Redis gives fast atomic counters for rate limiting and cache-aside.
- **Trade-off:** two stores to operate. Redis loss degrades gracefully: a cache miss, and a rate limiter that lets notifications through (D-20, D-22).

## D-04

**Mock providers behind a `ChannelProvider` interface**

> **Book:** Ch. 10, Step 2, "Third-party services" (easy to plug and unplug).

- **Why:** no real credentials needed. Interface keeps providers swappable. Mocks can inject latency and failures (chaos) so retry, circuit breaker, and dashboards can be demonstrated.

## D-05

**The notifications table is its own outbox**

> **Book:** Ch. 10, "Reliability" (never lose data; notification log). Own: the relay and the `published_at` marker.

- **Problem:** a database write and a queue publish cannot be one atomic step. If we write and crash before publishing, the notification is stuck; if we publish first, we can send something we never recorded.
- **Decision:** the API writes the rows first (`published_at = NULL`), publishes to RabbitMQ with publisher confirms, then sets `published_at`. A relay loop in the api republishes rows still NULL after `RELAY_MIN_AGE_MS`. No separate outbox table.
- **Why not "republish old PENDING rows":** under load rows legitimately wait in a queue for a long time, so that would republish the whole backlog. `published_at` separates "the broker has it" from "it has been sent".
- **Trade-off:** a message can be published twice (publish succeeded, marking failed, or two relays overlap). Accepted: consumers are idempotent (D-12). Verified by hand: broker stopped, `POST` still answers 202 and stores the row, broker restarted, relay publishes it.

## D-06

**Device registration is an idempotent upsert keyed by token**

> **Book:** Ch. 10, "Contact info gathering flow", Figs. 10-7 and 10-8. Own: the idempotent upsert on the token.

- **Why:** APNS/FCM tokens are unique per app install, so `UNIQUE(token)` plus `ON CONFLICT DO UPDATE` makes clients' retries safe, and a token that moves to another account (logout/login) follows the new user instead of failing. This is the first application of the idempotency principle (see D-11 to D-13).
- **Trade-off:** a token can silently change owner; acceptable because the latest registration is the truth. Notifications are stored with the token already copied in, so moving it also skips what is still waiting for the previous owner (`PENDING` or `RETRYING`, status `SKIPPED_STALE_DESTINATION`), in the same transaction as the move. One being sent at that moment is not touched, so a notification already claimed can still reach the new owner. A partial index on waiting push destinations keeps the lookup cheap.

## D-07

**Validation at the edge with Zod; ids are strings**

> **Book:** Ch. 10, Step 2 (notification servers validate emails and phone numbers).

- E.164 phones, lowercased emails, at least one contact. Bigint ids are strings in JSON to avoid precision loss. 409 for duplicates, 404 for unknown users, 400 for validation.

## D-08

**202 Accepted, one row per destination, queue message carries only the id**

> **Book:** Ch. 10, Step 2 (notification servers put data on queues; one push per device). Own: the 202 contract, the id-only message.

- 202 means "stored and queued", not delivered. A push to a user with 2 devices is 2 rows (own queue, own retries, own status). Destination is copied from the user's contacts at send time. The worker loads the row by id, so the database stays the single source of truth and workers can claim rows atomically (D-12).
- 422 when the user has no destination on that channel, 404 for an unknown user.

## D-09

**workers are a second process from the same image; backpressure through `prefetch`**

> **Book:** Ch. 10, Step 2 (workers pull from the queues); "Monitor queued notifications" (more workers when the queue grows). Own: `prefetch`, `WORKER_QUEUES`, restart on disconnect.

- `src/worker/` is a second entry point of the same codebase and image (compose `command` differs). Scale with `docker compose up -d --scale worker=N`; `WORKER_QUEUES` lets a process serve only some queues (e.g. only `sms`) so channels scale independently (one queue per type).
- `prefetch` caps unacknowledged messages per queue, so a slow provider cannot flood a worker. Ack happens only after the outcome is stored.
- If the broker connection drops, the worker exits and Docker restarts it (`restart: unless-stopped`), instead of hand-written reconnect logic for consumers.
- Providers sit behind `ChannelProvider`; the mocks have configurable latency and failure rate (`MOCK_LATENCY_MS`, `MOCK_FAILURE_RATE`).

## D-10

**The claim and the lease ship together**

- A claim (`PENDING -> SENDING`) without a lease timeout is WORSE than no claim: a worker that crashes after claiming leaves the row in `SENDING`, the redelivered message finds it claimed and is dropped, and the notification is lost. So the claim is only safe together with a lease that expires (D-12).
- A queue consumer that existed before the claim would send a redelivered message twice (plain at-least-once). That is the less harmful way to be wrong, which is why the claim was added only together with the lease.

## D-11

**Idempotency layer 1 (API): optional `Idempotency-Key`, key stored in the same transaction**

> **Book:** Ch. 10, "Will recipients receive a notification exactly once?" (the event ID). Own: the three layers.

- `idempotency_keys(key PK, request_hash, request_id)`. The key row and the notification rows are inserted in ONE transaction, so a key never exists without its notifications. Same key + same request: the original result is returned (202, `Idempotent-Replayed: true`) and nothing new is created or queued. Same key + different request (hash differs): 422.
- Race: two simultaneous requests with the same new key: the second `INSERT ... ON CONFLICT DO NOTHING` blocks until the first transaction finishes, then does nothing; the loser looks the winner up and replays it. Verified with 10 parallel curls (1 notification) and a Postgres test.
- The key is checked BEFORE resolving the user's contacts, so a replay still works if the user changed in the meantime.
- **Trade-off:** the header is optional, so a caller that sends none gets no protection (documented). Keys are kept forever here; production would expire them after ~24h.

## D-12

**Idempotency layer 2 (worker): atomic claim with a lease, plus `busy` requeue**

> **Book:** Ch. 10, same section (check the event ID at the consumer). Own: the claim with a lease, the `busy` requeue.

- `claim()` is one `UPDATE ... WHERE status = ANY(predecessors) AND (status <> 'SENDING' OR lease_expires_at < now())`. Of N concurrent workers exactly one wins (tested with 8 parallel claims). The lease (`CLAIM_LEASE_MS`, default 60 s, must exceed the slowest provider call) lets another worker take over a row whose worker died; killing a worker mid-send and restarting it was verified end to end (attempt 2, SENT, nothing lost).
- A failed claim has three meanings: `done` (SENT/FAILED, ack and drop the message), `missing` (drop), `busy` (someone holds a live lease). `busy` is NOT acked: it is put back after a delay, because if the holder crashed this message is what makes us notice when the lease expires. Dropping it would lose the notification.
- **Trade-off:** a `busy` message is re-checked every `requeueDelayMs` (1 s) until the lease resolves: wasteful but simple and correct. A delayed retry queue could replace the polling.
- **Fencing:** `claim()` returns the attempt number, and every later write (`markSent`, `markRetrying`, `markFailed`, `markSkipped`) must carry it. A worker whose lease ran out and whose notification was taken over cannot overwrite the new holder's result: its write is refused, logged as a lost claim, and discarded.
- **Accepted duplicate:** re-claiming after lease expiry can send twice if the first attempt had actually gone out. We prefer a possible duplicate to a certain loss (never lose).

## D-13

**State machine in one module, constraint in the database; provider dedupe key (layer 3)**

- `state.ts` holds the transition table; the repository builds its SQL guards from `predecessors()`, so an illegal change matches no row (`markSent` on an unclaimed row returns false). The DB also has a `CHECK` on the status values.
- Layer 3: `DeliveryRequest.idempotencyKey` = notification id, stable across attempts. The mock provider delivers a key once. Limits: the mock's memory is per process (a restarted worker has an empty memory), and providers without such a key will get a duplicate in the crash-after-send window. Both are covered by tests that document the behaviour.

## D-14

**Error classification: `ProviderError.retryable`, unknown means retryable**

- Providers throw `ProviderError(message, retryable)`. Permanent (invalid token): FAILED immediately, no retry can help. Retryable (timeout, 5xx, network): retried with backoff. Anything that is not a `ProviderError` is wrapped as retryable, so an unexpected bug cannot cause an infinite loop: the attempt limit bounds it.

## D-15

**Retries use RabbitMQ retry queues (TTL + dead-letter), not timers in our code**

> **Book:** Ch. 10, "Retry mechanism"; Ch. 4, summary (back-off). Own: retry queues with a time limit, the delays.

- `email.retry.5000` etc.: a message waits there for its TTL, then the broker dead-letters it to the default exchange with the main queue as routing key. One queue per delay (all messages in a queue share one TTL, because RabbitMQ only expires at the head of a queue). Delays `RETRY_DELAYS_MS` (default 5 s, 30 s, 2 min) give N+1 attempts; the attempt number picks the queue.
- Order in the worker: mark the row RETRYING, publish to the retry queue, then ack. If the publish fails the error propagates, the original message returns to the queue and a worker claims the row again from RETRYING (sooner than the backoff: acceptable).
- **Trade-offs:** no random jitter (fixed TTLs); 5 main queues x N delays means many small queues (declared by code, idempotent); changing a delay creates new queue names, the old ones stay behind. A DB-driven retry (`next_attempt_at` plus the relay) would allow jitter but ties retries to the api process.

## D-16

**Dead-letter queue is an operator signal; the FAILED row is the truth**

> **Book:** Ch. 10, "Retry mechanism" (alert developers when the problem persists). Own: the dead-letter queue and alert rules.

- Permanent failures, exhausted attempts and malformed messages are published to `dead-letter` with the reason. For a FAILED notification the row is written first and the DLQ publish is best effort: failing to announce must not make a worker send again. Malformed messages are acknowledged only after they reached the DLQ (otherwise they stay on the queue).
- The alert rules watch the dead-letter queue depth and the failure rate (D-27).

## D-17

**Timeouts and a circuit breaker per provider, checked BEFORE the claim**

- `PROVIDER_TIMEOUT_MS` (10 s) turns a hung call into a retryable failure; the worker refuses to start unless `CLAIM_LEASE_MS` is greater, otherwise a healthy worker loses its claim and a second one sends a duplicate.
- `CircuitBreaker` (closed / open / half-open): after `BREAKER_FAILURE_THRESHOLD` consecutive transient failures it opens for `BREAKER_COOLDOWN_MS`. While open the worker does not claim, so notifications do not burn attempts against a provider that is down; the message goes back to the queue with a 5 s pause. Permanent errors do not count (the provider answered). Half-open lets calls through; one success closes, one failure re-opens. One breaker per provider so one outage does not stop the others.
- Seen in a real run: with a 60% failing mock, five failures in a row opened the circuit and the remaining notifications waited with `tries=0`; after the cooldown all of them resolved (6 SENT, 2 FAILED after 3 attempts).
- **Trade-offs:** breaker state is per worker process (not shared); messages for an open circuit are re-checked every 5 s; a requeued message holds a prefetch slot while it waits, so a malformed message behind them is dead-lettered a little later.

## D-18

**Opt-out is checked in the worker, at the last moment, and recorded as SKIPPED_OPT_OUT**

> **Book:** Ch. 10, Step 1 (opt-out) and "Notification setting". Variation: checked by the worker, not the notification servers (Step 2, Fig. 10-14).

- `notification_settings(user_id, channel, opt_in)`, no row = opted in. The worker checks after the claim and before the provider call, on every attempt. A notification can wait in a queue (or in a retry queue) while the user opts out, so checking only when the request is accepted would still send to someone who just opted out. A skipped notification is final (`SKIPPED_OPT_OUT`, reason in `last_error`), counted as an attempt, never retried, never dead-lettered (it is not a failure).
- **Trade-off:** a notification for an opted-out user is still stored and queued first (a little wasted work), and the API answers 202 for it. Verified: queue a notification with the workers stopped, opt out, start the workers: it is skipped.

## D-19

**Templates are rendered in the API, per (name, channel), strictly**

> **Book:** Ch. 10, "Notification template"; Step 2.

- A caller sends `body` (+ `subject`) or `template` + `params`, never both. Rendering happens when the request is accepted, so the stored/queued payload is the final text: editing a template later cannot change a notification already waiting, and an unknown template or missing parameter is a 422 for the caller, not a failure inside a worker.
- A missing parameter is an error (never send "Hi , your order..."). Values are inserted literally in a single pass (a value containing `{{x}}` is not expanded). Placeholders are `{{name}}`. No HTML escaping: templates are plain text.
- The idempotency hash covers the request as sent (template name + sorted params), not the rendered text, so a retry still replays after the template was edited or deleted.

## D-20

**Redis cache-aside for templates only; fail open**

> **Book:** Ch. 10, Step 2 (cache). Variation: only templates are cached; user and device info are not.

- `CachedTemplateRepository`: read cache, on a miss read Postgres and fill (TTL 300 s); an update writes Postgres then deletes the key. Not cached: "not found" (a template created a moment later must be visible at once). If Redis is slow or down, `RedisCache` turns every failure into a miss and logs a warning; the Redis client fails fast (`enableOfflineQueue: false`, 500 ms command timeout) so a dead Redis never stalls a request. Verified: Redis stopped, a send and a template update still succeed.
- **Deliberately not cached (user and device info):** (1) opt-in settings: consent must be authoritative, and a stale entry would send to someone who opted out, while a primary-key read is cheap at ~185/s; (2) user contacts and devices: a device token moves between users (the upsert), so invalidation is easy to get wrong and a stale entry could send one person's notification to someone else.
- **Trade-off:** if Redis is up but the invalidation fails, an edited template can be served stale for up to the TTL.

## D-21

**Frequency cap per user and channel, enforced by the worker, one slot per notification**

> **Book:** Ch. 10, "Rate limiting"; Fig. 10-14. Variation: counted by the worker, not the notification servers.

- Config `RATE_LIMIT_PUSH|SMS|EMAIL` as `max/windowSeconds` (defaults 20/3600, 5/3600, 10/3600). The worker checks after the claim and the opt-out check, just before the provider call. Over the limit: `SKIPPED_RATE_LIMITED` (final, reason in `last_error`, no retry, no dead letter: nothing failed).
- **Why the worker and not the API:** the cap is about what the user *receives*. Counting at accept time would let a backlog accepted over an hour be delivered in one burst and still pass.
- **One slot per notification:** only the first attempt asks the limiter; a retry is the same notification and takes no second slot. An opted-out notification takes no slot. A slot taken by a notification that then fails permanently is not given back (conservative, simple).
- Verified: 5 emails at 3/60 gave 3 SENT and 2 skipped; 12 simultaneous emails across 3 workers gave exactly 3 SENT; after the window the counter vanished and sending resumed.

## D-22

**Fixed window counter in Redis, one Lua script**

> **Book:** Ch. 4, fixed window counter; "Race condition" (Lua script).

- `INCR` + `EXPIRE` in a single script: Redis runs it without interleaving, so concurrent workers get distinct counts (exactly `max` are allowed) and a counter can never be left without an expiry (which would block a user for good; the script also repairs a counter that lost its TTL). The window starts at the user's first notification and the counter disappears when it ends, so no clocks are compared between machines.
- **Trade-offs:** up to 2x the limit around a window boundary; refused attempts are counted too (the counter can read above `max`, harmless). A sliding window counter or a token bucket would smooth the boundary at the price of more state and a bigger script. For an hourly "do not annoy people" cap the simple one is enough.

## D-23

**Authentication with appKey / appSecret as HTTP Basic, secrets stored hashed**

> **Book:** Ch. 10, "Security in push notifications" and Step 2 (appKey and appSecret). Own: hashed secret, identical 401.

- Every endpoint except `/live` and `/health` needs `Authorization: Basic base64(appKey:appSecret)` (`curl -u key:secret`). Clients live in a `clients` table; `npm run create-client -- <name>` generates credentials and prints the secret once; `npm run seed` creates a development client (`demo-key` / `demo-secret`, well known, never for production).
- **Only a SHA-256 hash of the secret is stored.** A fast hash is right because our secrets are 256 random bits: there is nothing to guess, and slow hashing (bcrypt, argon2) exists for weak human-chosen passwords. The comparison is constant-time and an unknown key goes through the same comparison, so timing does not reveal which keys exist.
- Missing, malformed, unknown key, wrong secret and revoked client all return the same 401 body, so the response never says which part was wrong. Authentication runs before the body is parsed (a bad body with no credentials is a 401).
- **Trade-offs:** Basic auth sends the secret on every request, so the API must only be reachable over HTTPS (terminated at the load balancer: not in this project). No per-client permissions: every client may do everything (send, edit templates, change settings, register users). No brute-force protection (a limit per IP or per key would be the next step). The user and device endpoints would in reality be called by end-user apps with per-user auth; here trusted backend services call them.

## D-24

**Metrics on a separate internal port; Prometheus finds replicas by DNS**

> **Book:** Ch. 1, "Logging, metrics, automation"; Ch. 10, "Monitor queued notifications". Own: the internal port, discovery of replicas.

- Each process (api and worker) serves `/metrics` from `src/infra/metrics.ts` on `METRICS_PORT` (9464), a different port from the API's. The API port needs credentials and is the one callers use; metrics are for operators and the port is not published by Docker, only Prometheus reaches it. The worker has no HTTP server, so it needs the same small server anyway. Prometheus scrapes `api` and `worker` with DNS service discovery, so `--scale worker=3` is picked up with no change; RabbitMQ is scraped on its own Prometheus plugin (port 15692).
- RabbitMQ is configured with `prometheus.return_per_object_metrics = true` (`observability/rabbitmq/rabbitmq.conf`) so every queue is reported by name: main queues, the retry queues and the dead-letter queue. Fine for a handful of queues; expensive with thousands.

## D-25

**Low-cardinality metrics that answer the questions we actually had**

> **Book:** Ch. 10, "Monitor queued notifications" (queued notifications as the key metric).

- Counters: accepted, sent, failed by reason (permanent / exhausted), skipped by reason (opt_out / rate_limit), retries scheduled, duplicates recognised by layer (request / claim), held back by an open circuit, Redis errors absorbed by component, template cache hit/miss. Histograms: provider call duration (by provider and outcome), accepted-to-sent time, API request duration. Gauge: circuit state per provider, read at scrape time.
- **Labels are few and fixed.** Never a user id, notification id or URL (each distinct value is a new time series). HTTP metrics use the route PATTERN (`/users/:id/settings`); unmatched requests are labelled by why (`unauthenticated`, `unmatched`). A test sends requests with different ids and asserts no id appears in a label.
- The metrics object is injected into the service, processor, limiter and cache with an isolated default, so tests need no setup and nothing global is shared.

## D-26

**Grafana is provisioned from files, the dashboard is generated from code**

> **Book:** Ch. 10, "Monitor queued notifications", Fig. 10-12. Own: the generated, provisioned dashboard.

- `docker compose up` gives Grafana at http://localhost:3001 with the datasource, the dashboard (9 panels in 3 rows, built around four questions: is it keeping up, is anything being given up on, is it fast enough, what is the traffic doing) and anonymous viewing, with no clicking. The dashboard JSON is generated by `scripts/build-dashboard.ts` (`npm run build-dashboard`) and committed, so it can be reviewed and edited as code. `allowUiUpdates: false`: a change made in the browser is not kept. Every panel has a description that says how to read it.
- Screenshot of the running dashboard under load: `docs/grafana-dashboard.png`. Traffic for it: `scripts/traffic.sh`.
- **Limits:** anonymous access and `admin/admin` are for development only; Prometheus keeps 7 days with no persistent volume; the scrape interval is 5 s so the dashboard reacts while you watch (15-30 s in real life).

- **Why only nine:** a first version had 23 panels (provider times, API latency, memory, cache hit ratio, repeats recognised...). That was overengineering for this exercise: a reader had to scan all of them to learn whether the system was healthy. Those things are still measured (the metrics stay in the code, and the alert rules still use them), only the panels were removed; adding one back is a few lines in `scripts/build-dashboard.ts`.

## D-27

**Alert rules as code in Prometheus, with nothing to deliver them**

> **Book:** Ch. 10, "Retry mechanism" (alert) and "Monitor queued notifications". Own: the alert rules.

- `observability/prometheus/alerts.yml`: dead-letter queue not empty, queue backlog growing, a provider circuit open, more than 10% failing for good, Redis failing (the limiter lets notifications through unchecked), a service down. They show as firing at http://localhost:9090/alerts. **There is no Alertmanager, so nothing is sent anywhere**: connecting email, Slack or a pager is the next step for a real deployment. The first two follow the references above.

## D-28

**Scheduled notifications reuse the relay: `sendAt`, stored but not published until due**

> **Book:** Ch. 10, Step 1 (scheduled on the server side). Own: reusing the relay.

- `POST /v1/notifications` takes an optional `sendAt` (ISO 8601 with an offset). Missing, in the past, or within a second: sent now, exactly as before. Later than 30 days ahead: 400 (a typo in the year should be an error, not a row that waits for a century). The notification is stored with `send_at`; the API does not publish it. The relay, which already republished anything unpublished, now also publishes a scheduled notification once it is due. Nothing new in the worker: it claims, checks opt-out and rate limit AT SEND TIME (the right moment for a notification scheduled for next week; verified: Ana opted out while hers waited and it became SKIPPED_OPT_OUT), and sends.
- One query serves both jobs: unpublished and `send_at <= now()` and (scheduled, or old enough not to be a publish in flight). Scheduled rows need no minimum age because the API never publishes them. An ordinary row has `send_at = created_at` (both are the transaction's `now()`), so "scheduled" means `send_at > created_at`.
- `sendAt` is part of the idempotency hash: same key and time replays; same key and another time is a 422.
- The relay now drains in batches (`drainRelay`, stops at the first batch that is not full, with a safety limit of 50 batches per tick), so 120 notifications due at the same instant were all published within about a second.
- **Limits:** precision is one relay tick (5 s by default) after the due time; the relay runs inside the API, so scheduled notifications wait if every API instance is down (moving it to its own process or the worker is the fix); contacts are resolved when the request is accepted, not at send time, so a notification scheduled for next week goes to the devices the user has today; no way to cancel a scheduled notification; send times are compared with the database's clock, so a skew between machines shifts them by the same amount (a test that assumed the clocks agreed was flaky until it waited for the database to say "due" instead of sleeping).

