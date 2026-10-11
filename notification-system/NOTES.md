# Notification System: working notes

Private study and planning notes for the challenge. They are **not** the deliverable.
The deliverable is `DESIGN.md` (in this folder), which we write at the end from the decision log below.

Source: *System Design Interview Vol. 1*, Chapter 10 (PDF pages 151-168), plus the challenge brief.

---

## 0. Rules of the challenge (re-read before every milestone)

| Rule | What it means for us |
|---|---|
| Must build and pass tests | Never commit a red build. CI-style check (`npm test && npm run build`) before every commit. |
| Comprehensive tests for core logic | Core = idempotency, retry/backoff, opt-in check, rate limiter, worker state machine. Not getters. |
| Elegant design (APOSD) | Deep modules, small interfaces, hide complexity. Few, meaningful abstractions. |
| Correct error handling | Distinguish *retryable* (5xx, timeout) from *permanent* (invalid token, 4xx). Never swallow errors. |
| Concurrency only if needed | Worker concurrency = RabbitMQ `prefetch`. No hand-rolled thread pools. |
| Avoid overengineering | No microservice-per-channel, no service mesh, no Kubernetes. One codebase, two processes (api, worker). |
| Avoid AI slop | No comment on every function. No boilerplate abstractions. Delete unused code. Comments explain *why*. |
| **Any undocumented code is assumed understood by me** | If I don't understand something the AI wrote, add a `// NOTE(not fully understood): ...` comment or rewrite it simpler. |
| Nice to have | Logging, metrics, easy deployment, timeouts, right-sized pools, circuit breakers. |
| Submission | Folder named after the problem (`/notification-system`), with `DESIGN.md` inside covering **choices, trade-offs, and how AI was used**. |

**Extra requirements from the interviewers (verbal):**
- **Idempotency is very important.**
- Use **RabbitMQ or Kafka**: we pick **RabbitMQ** (see D-02).
- **Dockerize everything** (`docker compose up` runs the whole system).
- **Observability in Grafana.**

> Keep a running "How I used AI" log (section 9). It is a required part of `DESIGN.md`.

---

## 1. Exercise scope (Chapter 10, Step 1)

Requirements from the book's interviewer Q&A:

| Question | Answer in the book | Implication |
|---|---|---|
| Notification types | Push, SMS, email | 3 channel types |
| Real-time? | **Soft** real-time. A slight delay under load is OK | Queues as buffers are acceptable |
| Devices | iOS, Android, laptop/desktop | Push splits into iOS / Android (/ web). The book has separate queues for iOS and Android |
| Triggers | Client apps **and** scheduled server-side | Need a send API **and** a scheduler (`scheduled_at`) |
| Opt-out | Yes. Opted-out users receive nothing | Check settings before every send |
| Volume | 10M push + 1M SMS + 5M email per day | ~16M/day, about **185/s average**, so plan for roughly 10x peaks (about 2k/s) |

Back-of-the-envelope (Chapter 2 style), to put in `DESIGN.md`:
- 16M/day / 86,400 s = about 185 notifications/s average. Peak at 10x = about 1.9k/s.
- Push is about 62% of the traffic, email about 31%, SMS about 6%. This is a reason for **per-channel queues and per-channel worker scaling**.
- Queue payload about 1 KB, so a 1M backlog is about 1 GB. Fine for RabbitMQ.
- Notification log at about 16M rows/day: partition by day, or archive (a trade-off to mention, not to build).

**Out of scope** (say so explicitly in `DESIGN.md`): real FCM/APNS/Twilio/SendGrid accounts (we mock providers behind an interface), analytics UI, multi-region.

---

## 2. Book concepts to apply and where

This is the checklist of "important concepts of the book". Every row must end up as a decision in the log (section 3) and as a section in `DESIGN.md`.

| # | Concept (book) | Where it applies | Milestone |
|---|---|---|---|
| C1 | **Decouple with message queues**: queues remove dependencies between components and act as buffers during spikes | API to queue to worker | M3 |
| C2 | **One queue per notification type**: an outage in one third party does not affect the others | Queues: `push.ios`, `push.android`, `sms`, `email` | M3 |
| C3 | **Remove SPOF and scale horizontally**: stateless API servers, move DB and cache out of the server | Stateless `api` and `worker` containers; Postgres and Redis separate | M1, M3 |
| C4 | **Scale workers independently** (bottleneck: calling third parties is slow) | `docker compose up --scale worker=N`; `prefetch` | M4 |
| C5 | **Third-party extensibility**: easy to plug and unplug a provider (FCM unavailable in China, etc.) | `ChannelProvider` interface plus registry; mock providers | M4 |
| C6 | **Contact-info gathering flow** (users and devices tables, a user has many devices) | `POST /users`, `POST /users/:id/devices` | M2 |
| C7 | **Don't lose data**: persist to a notification log DB and retry. "Notifications can be delayed or reordered, but never lost" | `notifications` table written **before** publishing (outbox) | M2, M3 |
| C8 | **Exactly-once is impossible**: aim for at-least-once delivery plus **dedupe by event ID** | Idempotency (section 4), the core of the project | M5 |
| C9 | **Retry mechanism**: on failure put it back in the queue a predefined number of times, then alert | Retry with backoff, DLQ, alert metric | M6 |
| C10 | **Notification templates**: consistent format, fewer mistakes | `templates` table plus a tiny renderer (`{{var}}`) | M7 |
| C11 | **Notification settings / opt-in** (`user_id, channel, opt_in`) checked before sending | `notification_settings` table | M7 |
| C12 | **Rate limiting per user** (frequency capping) | Redis-based limiter (token bucket or fixed window, see Ch. 4) | M8 |
| C13 | **Security**: only authenticated clients can call the API (appKey/appSecret) | API key plus secret check on the send API | M9 |
| C14 | **Monitor queued notifications**: queue depth is the key metric, because a large number means the workers are too slow | RabbitMQ metrics in Grafana, plus our own metrics | M10 |
| C15 | **Event tracking** (sent / failed / delivered / ...) | Status transitions persisted plus counters | M5, M10 |
| C16 | **Cache** user info, device info, templates | Redis cache-aside | M7 |
| C17 | **Scheduled triggers** (server-side) | `scheduled_at` plus scheduler loop | M11 (optional) |
| C18 | Validation (emails, phone numbers) in the notification server | Zod schemas at the API edge | M2 |

---

## 3. Decision log (becomes `DESIGN.md`)

Format: **Decision / Why / Trade-off / Book ref.** Add an entry every time we decide something.

### D-01: TypeScript on Node.js (Express 5)
- **Why:** Express is the framework I use daily, so I can explain and defend every line of the HTTP layer (the brief penalises code I do not understand). Express 5 forwards async errors to the error middleware. Fastify was the first choice and was swapped out in M2; the HTTP layer was only three files, and everything else is framework-independent. Strong typing helps model the notification state machine.
- **Trade-off:** single-threaded, which is fine because the work is I/O-bound (network calls to providers).

### D-02: RabbitMQ over Kafka
- **Why:** the workload is a **task queue** (do this send once, retry on failure, route per channel). RabbitMQ gives us per-queue retry via **dead-letter exchanges with TTL**, per-message ack/nack, `prefetch` for backpressure, simple routing, and built-in Prometheus metrics (queue depth). Easier to learn and operate.
- **Trade-off:** no replay of old messages and lower raw throughput ceiling than Kafka. At about 2k/s peak this is a non-issue. If we needed replay or event sourcing, Kafka would win. Mention this in the interview.
- **Book ref:** Fig. 10-10: one queue per notification type.

### D-03: PostgreSQL as source of truth, Redis for cache and rate limiting
- **Why:** the notification log must be durable (C7). Postgres gives **unique constraints** for idempotency and transactions for the outbox. Redis gives fast atomic counters for rate limiting and cache-aside.
- **Trade-off:** two stores to operate. Redis loss must degrade gracefully (cache miss and fail-open rate limit, to be decided).

### D-04: Mock providers behind a `ChannelProvider` interface
- **Why:** no real credentials needed. Interface keeps providers swappable (C5). Mocks can inject latency and failures (chaos) so retry, circuit breaker, and dashboards can be demonstrated.

### D-05: Transactional outbox (DB write and publish are not atomic otherwise)
- **Why:** if we write to the DB and then publish, a crash in between loses the notification (violates C7). If we publish first, we can send something we never recorded. The outbox row is written in the same transaction as the notification, and a relay publishes it.
- **Trade-off:** extra table plus relay loop. **Simpler alternative:** the API writes the notification as `PENDING`, publishes, and a *reconciler* re-publishes stale `PENDING` rows. Decide in M3 (leaning toward the reconciler as the simpler option, with the same guarantee).

### D-06: Plain SQL migrations with a tiny runner (no migration library)
- **Why:** one table-creating file per change, applied in order, tracked in `schema_migrations`, one transaction per file. A Postgres advisory lock makes concurrent api replicas take turns. About 40 lines, nothing to learn.
- **Trade-off:** no down-migrations and no tooling. Migrations run on api startup, which delays boot; a separate migrate job would be the next step in production.

### D-07: Repository interface for data access
- **Why:** the HTTP layer depends on `UserRepository`, not on Postgres. API validation tests use an in-memory fake; SQL behavior (constraints, upsert) is tested against real Postgres.
- **Trade-off:** one extra file and a fake to keep in sync. The Postgres test guards against the fake drifting.

### D-08: Device registration is an idempotent upsert keyed by token
- **Why:** APNS/FCM tokens are unique per app install, so `UNIQUE(token)` plus `ON CONFLICT DO UPDATE` makes clients' retries safe, and a token that moves to another account (logout/login) follows the new user instead of failing. This is the first application of the idempotency principle (section 4).
- **Trade-off:** a token can silently change owner; acceptable because the latest registration is the truth.

### D-09: Validation at the edge with Zod; ids are strings
- E.164 phones, lowercased emails, at least one contact. Bigint ids are strings in JSON to avoid precision loss. 409 for duplicates, 404 for unknown users, 400 for validation.
- `notification_settings` moved from M2 to M7 (nothing uses it before).

### D-05 (resolved in M3): the notifications table is its own outbox
- **Decision:** the API writes the rows first (`published_at = NULL`), publishes to RabbitMQ with publisher confirms, then sets `published_at`. A relay loop in the api republishes rows still NULL after `RELAY_MIN_AGE_MS`. No separate outbox table.
- **Why not "republish old PENDING rows":** under load rows legitimately wait in a queue for a long time, so that would republish the whole backlog. `published_at` separates "the broker has it" from "it has been sent".
- **Trade-off:** a message can be published twice (publish succeeded, marking failed, or two relays overlap). Accepted: consumers are idempotent (M5). Verified by hand: broker stopped, `POST` still answers 202 and stores the row, broker restarted, relay publishes it.

### D-10: 202 Accepted, one row per destination, queue message carries only the id
- 202 means "stored and queued", not delivered. A push to a user with 2 devices is 2 rows (own queue, own retries, own status). Destination is copied from the user's contacts at send time. The worker loads the row by id, so the database stays the single source of truth and M5 can claim rows atomically.
- 422 when the user has no destination on that channel, 404 for an unknown user.

### D-11: one long-lived confirm channel, reconnect lazily, timeouts everywhere
- `RabbitPublisher` keeps one connection and channel, drops them on any error and reopens on next use. Publishes time out after 5 s so a stalled broker cannot hang API requests. The health check reuses it.

### D-12: workers are a second process from the same image; backpressure through `prefetch`
- `src/worker/` is a second entry point of the same codebase and image (compose `command` differs). Scale with `docker compose up -d --scale worker=N`; `WORKER_QUEUES` lets a process serve only some queues (e.g. only `sms`) so channels scale independently (book: scale workers, one queue per type).
- `prefetch` caps unacknowledged messages per queue, so a slow provider cannot flood a worker. Ack happens only after the outcome is stored.
- If the broker connection drops, the worker exits and Docker restarts it (`restart: unless-stopped`), instead of hand-written reconnect logic for consumers.
- Providers sit behind `ChannelProvider`; the mocks have configurable latency and failure rate (`MOCK_LATENCY_MS`, `MOCK_FAILURE_RATE`).

### D-13: M4 deliberately had no atomic claim (added in M5, together with the lease, see D-15)
- A claim (`PENDING -> SENDING`) without a lease timeout is WORSE than none: a worker that crashes after claiming leaves the row in SENDING, the redelivered message finds it claimed and is dropped, and the notification is lost. So claim and lease expiry ship together in M5. Until then a redelivered message is sent twice (at-least-once, documented in `processor.ts`). Provider failure = FAILED, final, until M6 adds retries.

### D-14: Idempotency layer 1 (API): optional `Idempotency-Key`, key stored in the same transaction
- `idempotency_keys(key PK, request_hash, request_id)`. The key row and the notification rows are inserted in ONE transaction, so a key never exists without its notifications. Same key + same request: the original result is returned (202, `Idempotent-Replayed: true`) and nothing new is created or queued. Same key + different request (hash differs): 422.
- Race: two simultaneous requests with the same new key: the second `INSERT ... ON CONFLICT DO NOTHING` blocks until the first transaction finishes, then does nothing; the loser looks the winner up and replays it. Verified with 10 parallel curls (1 notification) and a Postgres test.
- The key is checked BEFORE resolving the user's contacts, so a replay still works if the user changed in the meantime.
- **Trade-off:** the header is optional, so a caller that sends none gets no protection (documented). Keys are kept forever here; production would expire them after ~24h. No per-client scoping until auth (M9).

### D-15: Idempotency layer 2 (worker): atomic claim with a lease, plus `busy` requeue
- `claim()` is one `UPDATE ... WHERE status = ANY(predecessors) AND (status <> 'SENDING' OR lease_expires_at < now())`. Of N concurrent workers exactly one wins (tested with 8 parallel claims). The lease (`CLAIM_LEASE_MS`, default 60 s, must exceed the slowest provider call) lets another worker take over a row whose worker died; killing a worker mid-send and restarting it was verified end to end (attempt 2, SENT, nothing lost).
- A failed claim has three meanings: `done` (SENT/FAILED, ack and drop the message), `missing` (drop), `busy` (someone holds a live lease). `busy` is NOT acked: it is put back after a delay, because if the holder crashed this message is what makes us notice when the lease expires. Dropping it would lose the notification.
- **Trade-off:** a `busy` message is re-checked every `requeueDelayMs` (1 s) until the lease resolves: wasteful but simple and correct. M6's delayed retry queues can replace the polling.
- **Accepted duplicate:** re-claiming after lease expiry can send twice if the first attempt had actually gone out. We prefer a possible duplicate to a certain loss (book: never lose).

### D-16: State machine in one module, constraint in the database; provider dedupe key (layer 3)
- `state.ts` holds the transition table; the repository builds its SQL guards from `predecessors()`, so an illegal change matches no row (`markSent` on an unclaimed row returns false). The DB also has a `CHECK` on the status values.
- Layer 3: `DeliveryRequest.idempotencyKey` = notification id, stable across attempts. The mock provider delivers a key once. Honest limits: the mock's memory is per process (a restarted worker has an empty memory), and providers without such a key will get a duplicate in the crash-after-send window. Both are covered by tests that document the behaviour.

### D-17: Error classification: `ProviderError.retryable`, unknown means retryable
- Providers throw `ProviderError(message, retryable)`. Permanent (invalid token): FAILED immediately, no retry can help. Retryable (timeout, 5xx, network): retried with backoff. Anything that is not a `ProviderError` is wrapped as retryable, so an unexpected bug cannot cause an infinite loop: the attempt limit bounds it.

### D-18: Retries use RabbitMQ retry queues (TTL + dead-letter), not timers in our code
- `email.retry.5000` etc.: a message waits there for its TTL, then the broker dead-letters it to the default exchange with the main queue as routing key. One queue per delay (all messages in a queue share one TTL, because RabbitMQ only expires at the head of a queue). Delays `RETRY_DELAYS_MS` (default 5 s, 30 s, 2 min) give N+1 attempts; the attempt number picks the queue.
- Order in the worker: mark the row RETRYING, publish to the retry queue, then ack. If the publish fails the error propagates, the original message returns to the queue and a worker claims the row again from RETRYING (sooner than the backoff: acceptable).
- **Trade-offs:** no random jitter (fixed TTLs); 5 main queues x N delays means many small queues (declared by code, idempotent); changing a delay creates new queue names, the old ones stay behind. A DB-driven retry (`next_attempt_at` plus the relay) would allow jitter but ties retries to the api process.

### D-19: Dead-letter queue is an operator signal; the FAILED row is the truth
- Permanent failures, exhausted attempts and malformed messages are published to `dead-letter` with the reason. For a FAILED notification the row is written first and the DLQ publish is best effort: failing to announce must not make a worker send again. Malformed messages are acknowledged only after they reached the DLQ (otherwise they stay on the queue).
- M10: alert on DLQ depth > 0 and on the `notification_failed` log events.

### D-20: Timeouts and a circuit breaker per provider, checked BEFORE the claim
- `PROVIDER_TIMEOUT_MS` (10 s) turns a hung call into a retryable failure; the worker refuses to start unless `CLAIM_LEASE_MS` is greater, otherwise a healthy worker loses its claim and a second one sends a duplicate.
- `CircuitBreaker` (closed / open / half-open): after `BREAKER_FAILURE_THRESHOLD` consecutive transient failures it opens for `BREAKER_COOLDOWN_MS`. While open the worker does not claim, so notifications do not burn attempts against a provider that is down; the message goes back to the queue with a 5 s pause. Permanent errors do not count (the provider answered). Half-open lets calls through; one success closes, one failure re-opens. One breaker per provider so one outage does not stop the others.
- Seen in a real run: with a 60% failing mock, five failures in a row opened the circuit and the remaining notifications waited with `tries=0`; after the cooldown all of them resolved (6 SENT, 2 FAILED after 3 attempts).
- **Trade-offs:** breaker state is per worker process (not shared); messages for an open circuit are re-checked every 5 s; a requeued message holds a prefetch slot while it waits, so a malformed message behind them is dead-lettered a little later.

*(add more as we go: retry policy, rate-limit algorithm, circuit breaker params, pool sizes, etc.)*

---

## 4. Idempotency (the focus topic)

Definition: performing the same operation more than once has the same effect as performing it once.
Book position: **exactly-once delivery is impossible** (a crash after the provider call but before the ack/DB write cannot be distinguished from a crash before it). So we build **at-least-once delivery + idempotent processing = effectively once**, and we are honest about the residual window.

Idempotency has to be handled at **three layers**:

### Layer 1: Ingress (API): "the caller retried the request"
- Caller sends `Idempotency-Key` header (or `request_id` in the body).
- `notifications` has `UNIQUE (client_id, idempotency_key)`.
- `INSERT ... ON CONFLICT DO NOTHING`. On conflict, return the **existing** notification (same `id`, `200`/`202`), not a new one and not an error.
- Same key with a **different payload**: return `422` (hash the payload and compare).
- Tests: same key twice gives one row and one message. Concurrent requests with the same key give exactly one row (race).

### Layer 2: Queue consumer: "RabbitMQ delivered the message twice"
At-least-once means redelivery will happen (worker crash before ack, network blip, requeue on nack).
- Worker claims the notification with an **atomic state transition**:
  `UPDATE notifications SET status='SENDING', attempts=attempts+1 WHERE id=$1 AND status IN ('PENDING','RETRYING') RETURNING *`
- If 0 rows come back, another worker is handling it, or it is already `SENT`, so **ack and discard** (this is the book's "seen before, so discard").
- Only one worker can win the claim, so there are no duplicate sends from concurrent consumers.
- Tests: deliver the same message twice (sequentially and concurrently), provider called once.

### Layer 3: Provider call: "we sent it but didn't record it"
- Residual window: provider call succeeded, then the worker crashed before writing `SENT`. On redelivery the state is `SENDING`, which is ambiguous.
- Mitigations (document the trade-off in `DESIGN.md`):
  1. Pass `notification.id` as the **provider-side idempotency key** where the provider supports it (Twilio/FCM-style). The mock provider will implement dedupe by key to demonstrate it.
  2. A `SENDING` row older than a timeout (lease expiry) can be re-claimed. This accepts a **possible duplicate** over a **guaranteed loss**. The book says never lose, so we choose duplicate over loss.
- Tests: the crash-after-send scenario with a mock provider that dedupes on key (one delivery) and one that does not (a documented duplicate).

### State machine
```
PENDING -> SENDING -> SENT
              |
              +-> RETRYING -> SENDING ... (up to MAX_ATTEMPTS)
              |
              +-> FAILED (permanent error or attempts exhausted, goes to DLQ)
         SKIPPED_OPT_OUT / SKIPPED_RATE_LIMITED (terminal, recorded for tracking)
```
Transitions are enforced in **one module** (deep module, APOSD). Nothing else mutates `status`.

---

## 5. Architecture (target, based on book Fig. 10-14)

```
Service 1..N --POST /v1/notifications (auth, rate-limit, validate, idempotency)--> API (stateless, xN)
                                    |  Postgres (users, devices, settings, templates, notifications log)
                                    |  Redis (cache, rate limit)
                                    v
                      RabbitMQ  [push.ios] [push.android] [sms] [email]   (+ retry queues + DLQ)
                                    |
                                    v
                            Workers (xN, per channel) --> Provider (mock APNS / FCM / SMS / Email)
                                    |
                            Prometheus <- /metrics (api, worker, rabbitmq)  ->  Grafana
```

Code layout: **by feature, not by technical layer** (no global `models/`, `services/`, `routes/`).
```
notification-system/
  DESIGN.md              <- the deliverable (written at the end)
  NOTES.md               <- this file (private; decide at the end whether to keep it)
  docker-compose.yml
  Dockerfile
  migrations/            <- plain SQL, applied in filename order at api startup
  src/
    api/                 <- entry point 1, HTTP only: main.ts, server.ts, one routes file per feature
    worker/              <- entry point 2, queue consumers (M4)
    users/               <- feature: contacts and devices (repository, domain errors)
    notifications/       <- feature: the core. State machine, repository, send flow,
                            idempotency, retry policy (M3-M6)
    providers/           <- top level: ChannelProvider interface, mocks, circuit breaker (M4, M6).
                            Not under notifications/ because workers and tests use it on its own.
    infra/               <- technical plumbing, no business logic: config, db, migrate,
                            health, later rabbit/redis/metrics
  test/                  <- mirrors src/
  observability/         <- prometheus.yml, grafana provisioning + dashboards JSON (M10)
```
Rules:
1. Dependencies point one way: `api`/`worker` -> feature folders -> `infra`. Features never import from `api` or `worker`.
2. Routes are thin: validate input, call a feature, map the result to a status code. No SQL or business rules in `api/`.
3. A folder is a module with a small interface (APOSD deep module). Callers depend on e.g. `UserRepository`, not on how it is stored.
4. No empty layers: a service class exists only where there is real logic to put in it (`notifications/` yes, `users/` no).
5. Two processes, one codebase: `api` and `worker` share the feature folders but have separate entry points and Docker commands.

---

## 6. Milestones (each is a small, learnable, committable step)

Each milestone has: **Goal / Concepts / Done when**. We do them one at a time, and I explain the concept first, then we code, then I should be able to explain the code (see Rules).

| # | Milestone | Concepts | Done when |
|---|---|---|---|
| **M0** | Repo and notes (this file) | rules | repo pushed, `NOTES.md` agreed |
| **M1** | **Skeleton in Docker**: TS project, Fastify `/health`, Dockerfile, compose with Postgres, Redis, RabbitMQ, config via env, structured logs (pino) | C3 | `docker compose up` gives a healthy API; `npm test` runs a first test |
| **M2** | **Data model and contact flow**: migrations, `users`, `devices`, `notification_settings`; `POST /users`, `POST /users/:id/devices`; validation | C6, C7, C18 | users/devices can be created; invalid email/phone rejected (tested) |
| **M3** | **Send API and queues**: `POST /v1/notifications` writes `PENDING` row and publishes to the per-channel queue (+ reconciler or outbox) | C1, C2, C7, D-05 | a request produces a row and a message in the right queue; crash-between-write-and-publish is recovered (tested) |
| **M4** | **Workers and providers**: consumer per channel, `ChannelProvider` interface, mock providers with configurable latency/failure, `prefetch` | C4, C5 | notification ends `SENT`; scale to N workers works |
| **M5** | **Idempotency (3 layers)** + state machine | C8, C15 | all section 4 tests pass (duplicates, races, redelivery, crash-after-send) |
| **M6** | **Retries and DLQ**: backoff via TTL/dead-letter queues, error classification (retryable vs permanent), max attempts, alert counter, **timeouts and circuit breaker** around providers | C9 | flaky provider eventually succeeds; poison message ends in DLQ and `FAILED`; breaker opens and closes (tested) |
| **M7** | **Templates, settings, cache**: template rendering, opt-in check before send, Redis cache-aside | C10, C11, C16 | opted-out user gets `SKIPPED_OPT_OUT`; template renders with params |
| **M8** | **Rate limiting** per user and channel | C12 | N+1th notification gets `SKIPPED_RATE_LIMITED` (tested incl. concurrency) |
| **M9** | **API authentication** (appKey/appSecret) | C13 | unauthenticated call gives 401 |
| **M10** | **Observability**: `prom-client` metrics in api/worker, Prometheus, Grafana provisioned dashboards (as code) | C14, C15 | dashboard (see section 7) shows live data after a load run, with no manual setup |
| **M11** | *(optional)* **Scheduled notifications** | C17 | `scheduled_at` in the future is sent at that time |
| **M12** | **Load/chaos demo script** plus pool/timeout tuning | defensive design | script that shows queue depth rising and draining in Grafana |
| **M13** | **Write `DESIGN.md`**, README quickstart, final cleanup (remove AI slop, check every file has meaningful comments) | all | a reviewer can run it in 2 commands and understand the choices |

Order note: M5 (idempotency) is deliberately early. It shapes the schema and the worker, so retrofitting is expensive.

---

## 7. Observability plan (Grafana)

Stack: `prom-client` in api and worker, RabbitMQ built-in Prometheus plugin, Prometheus, Grafana (datasource and dashboard **provisioned from files**, so `docker compose up` needs no clicks).

Metrics (name them consistently, with low-cardinality labels):
- `notifications_accepted_total{channel}`, `notifications_deduplicated_total{layer}` (**shows idempotency working**)
- `notifications_sent_total{channel}`, `notifications_failed_total{channel,reason}`, `notifications_skipped_total{reason}`
- `notification_send_duration_seconds{channel}` (histogram), `notification_end_to_end_seconds{channel}` (accepted to sent)
- `provider_circuit_state{channel}`, `notification_retries_total{channel}`
- `rabbitmq_queue_messages{queue}` (**the book's key metric: queued notifications**), DLQ depth
- API: request rate, latency, error rate

Dashboard rows: Throughput / Queue depth and DLQ / Latency / Errors and retries / Idempotency (duplicates caught) / Circuit breakers.
Alerts (document, optionally provision): DLQ depth > 0, queue depth growing for 5 min.

---

## 8. Testing strategy

- **Unit (most of the value):** state machine transitions, retry/backoff policy, error classification, template rendering, rate-limit logic, idempotency decision logic. Use in-memory fakes for ports (repository, publisher, provider).
- **Integration (few, high value):** real Postgres and RabbitMQ via Testcontainers or the compose services: the idempotency race, the redelivery case, the crash-between-write-and-publish case.
- **Not tested:** framework wiring, trivial mappers.
- Test names state the behavior ("does not send twice when the same message is redelivered").
- Tooling: Vitest.

---

## 9. "How I used AI" log (feeds `DESIGN.md`)

Be honest and specific. Keep appending.

- 2026-10-09: used Claude Code to read Ch. 10, extract concepts, and draft these notes and the milestone plan. I reviewed and chose the stack (TypeScript; RabbitMQ per Claude's recommendation).
- - 2026-10-09: M1 (Docker skeleton) and M2 (users/devices) generated with Claude Code. I asked for the `withTimeout` explanation and had a comment added; I reviewed the design choices D-06 to D-09.
- 2026-10-09: M3 (send API, queues, relay) generated with Claude Code; I chose the outbox variant after the explanation of the PENDING-reconciler pitfall.
- 2026-10-10: M5 (idempotency, claims, state machine) generated with Claude Code. I reviewed the design: three layers, why a claim without a lease loses notifications, why `busy` messages must not be acked.
- 2026-10-11: M6 (retries, DLQ, timeouts, circuit breaker) generated with Claude Code. I reviewed the trade-offs: RabbitMQ retry queues vs DB-driven retries, why the breaker is checked before the claim, why FAILED rows are the truth and the DLQ is a signal.
- *(add: what AI generated, what I changed, what I rejected, what I rewrote because I didn't understand it)*

---

## 10. Interview prep: questions I must be able to answer

- Why can't we have exactly-once delivery? What do we guarantee instead?
- Walk through what happens if a worker crashes (a) before the provider call, (b) after the call but before the ack.
- Why RabbitMQ and not Kafka? When would you switch?
- How do you avoid losing a notification between the DB write and the publish?
- How do retries work? What is retryable vs permanent? What stops a retry storm? (backoff, jitter, circuit breaker)
- How does the system behave when SMS provider is down? (isolated queue, breaker, backlog grows, other channels fine)
- How would you scale 10x? Where is the bottleneck? (workers, then the DB log, then RabbitMQ)
- Rate limiter algorithm and its failure mode if Redis is down?
- What would you do next with more time?
