# Walkthrough of the code

A guided tour of the whole project: what runs, how a user and a client get into the system, and what happens to a
notification from the moment it is requested to the moment it is delivered, with a link into the code for each step.
Read it with the code open. For the reasons behind the design, see [DESIGN.md](../DESIGN.md) and
[DECISIONS.md](DECISIONS.md); for pictures of the same flows, see [FLOWS.md](FLOWS.md).

## 0. Words used in this document

| Word | Meaning here |
|---|---|
| **client** | A service that calls our API (billing, shop...). It has an `appKey` and a secret. |
| **user** | The person who receives notifications. A user has an email, a phone number, and devices. |
| **device** | A phone or browser of a user: iOS, Android or web, identified by a push token. |
| **channel** | `push`, `sms` or `email`. |
| **destination** | The actual address: an email address, a phone number, or one device token. |
| **notification** | One message to one destination. A push to a user with two devices is two notifications. |
| **queue** | A RabbitMQ queue. There is one per channel (and per platform for push). |
| **provider** | The third-party service that delivers (APNS, FCM, an SMS gateway, an email service). Mocks here. |

## 1. The map

Two programs share one code base and one Docker image:

- the **API**, entry point [main.ts:20](../src/api/main.ts#L20): accepts requests and stores notifications;
- the **worker**, entry point [main.ts:18](../src/worker/main.ts#L18): takes notifications off the queues and delivers them.

| Folder | What is in it |
|---|---|
| `src/api/` | The HTTP layer: the app and its middleware ([server.ts](../src/api/server.ts)), one file of routes per area ([notifications.ts](../src/api/notifications.ts), [users.ts](../src/api/users.ts), [settings.ts](../src/api/settings.ts), [templates.ts](../src/api/templates.ts)), authentication ([auth.ts](../src/api/auth.ts)), request metrics ([http-metrics.ts](../src/api/http-metrics.ts)). No SQL and no business rules here. |
| `src/notifications/` | The core. [service.ts](../src/notifications/service.ts) accepts a request; [processor.ts](../src/notifications/processor.ts) delivers one notification; [repository.ts](../src/notifications/repository.ts) is all the SQL for notifications; [state.ts](../src/notifications/state.ts) is the state machine; [relay.ts](../src/notifications/relay.ts), [queues.ts](../src/notifications/queues.ts), [retry.ts](../src/notifications/retry.ts), [rate-limit.ts](../src/notifications/rate-limit.ts), [settings.ts](../src/notifications/settings.ts), [templates.ts](../src/notifications/templates.ts) and [metrics.ts](../src/notifications/metrics.ts) each do one job. |
| `src/worker/` | [consumer.ts](../src/worker/consumer.ts) talks to RabbitMQ (receive, acknowledge, put back); [metrics.ts](../src/worker/metrics.ts) publishes the circuit state. |
| `src/providers/` | The provider interface ([provider.ts](../src/providers/provider.ts)), the mocks ([mock.ts](../src/providers/mock.ts)), and what wraps every call: timeout and circuit breaker ([guarded.ts](../src/providers/guarded.ts), [circuit-breaker.ts](../src/providers/circuit-breaker.ts)). |
| `src/users/` | Users and devices: [repository.ts](../src/users/repository.ts). |
| `src/clients/` | Who may call the API: [credentials.ts](../src/clients/credentials.ts), [repository.ts](../src/clients/repository.ts). |
| `src/infra/` | Plumbing with no business rules: [config.ts](../src/infra/config.ts), [rabbit.ts](../src/infra/rabbit.ts), [cache.ts](../src/infra/cache.ts), [migrate.ts](../src/infra/migrate.ts), [health.ts](../src/infra/health.ts), [timeout.ts](../src/infra/timeout.ts), [metrics.ts](../src/infra/metrics.ts). |
| `migrations/` | The database schema as numbered SQL files. |
| `observability/` | Prometheus, the alert rules, Grafana (all provisioned from files). |
| `scripts/` | Seed data, demos, the load generator, the dashboard generator. |
| `test/` | Tests. See section 9. |

The dependency rule: `api` and `worker` use `notifications`, `users`, `clients` and `providers`; those use `infra`; nothing
uses `api` or `worker`. The core never imports Express or the RabbitMQ client directly: it depends on small interfaces
(`UserRepository`, `NotificationRepository`, `MessagePublisher`, `ChannelProvider`...), and the entry points plug in the
real implementations. That is what lets the tests run the whole core without any infrastructure.

## 2. What runs

Everything is defined in [docker-compose.yml:1](../docker-compose.yml#L1).

| Service | Role |
|---|---|
| [docker-compose.yml:2](../docker-compose.yml#L2) | The API. Applies the database migrations when it starts. |
| [docker-compose.yml:21](../docker-compose.yml#L21) | The worker. Can be scaled (`--scale worker=3`). Restarts itself if it exits. |
| [docker-compose.yml:47](../docker-compose.yml#L47) | The source of truth: users, devices, clients, templates, settings and **every notification**. |
| [docker-compose.yml:73](../docker-compose.yml#L73) | The queues. |
| [docker-compose.yml:63](../docker-compose.yml#L63) | The template cache and the rate-limit counters. Nothing important is only in Redis. |
| [docker-compose.yml:90](../docker-compose.yml#L90) | Collects metrics and evaluates the alert rules. |
| [docker-compose.yml:101](../docker-compose.yml#L101) | The dashboard. |

## 3. How each program starts

**The API** ([main.ts:20](../src/api/main.ts#L20)):

1. Reads and validates the configuration ([config.ts](../src/infra/config.ts): [config.ts:12](../src/infra/config.ts#L12)). A bad value stops it at once.
2. Opens the Postgres pool (bounded, [main.ts:25](../src/api/main.ts#L25)), the Redis client (fails fast when Redis is down), and the RabbitMQ publisher.
3. Applies the migrations: [main.ts:29](../src/api/main.ts#L29), using [migrate.ts:7](../src/infra/migrate.ts#L7).
4. Builds the pieces and plugs them together: [main.ts:38](../src/api/main.ts#L38), then [main.ts:40](../src/api/main.ts#L40).
5. Starts the relay ([main.ts:57](../src/api/main.ts#L57)), the metrics server ([main.ts:55](../src/api/main.ts#L55)) and listens ([main.ts:75](../src/api/main.ts#L75)).
6. On SIGTERM it stops the relay, finishes the requests in progress, closes the connections.

**The worker** ([main.ts:18](../src/worker/main.ts#L18)): the same configuration step, then it decides which queues to serve
([main.ts:23](../src/worker/main.ts#L23)), checks that the lease is longer than the provider timeout, builds the providers
([main.ts:45](../src/worker/main.ts#L45)), the processor ([main.ts:55](../src/worker/main.ts#L55))
and starts consuming ([main.ts:67](../src/worker/main.ts#L67)). If it loses the RabbitMQ connection it exits
([main.ts:76](../src/worker/main.ts#L76)) and Docker restarts it.

## 4. The life of a user

### 4.1 A user is created

`POST /users` with an email and/or a phone.

1. The route [users.ts:26](../src/api/users.ts#L26) validates the body with Zod: a well-formed email (lower-cased, so `A@x.com` and `a@x.com` are the same person), a phone in international format ([users.ts:5](../src/api/users.ts#L5)), and at least one of the two.
2. [repository.ts:57](../src/users/repository.ts#L57) inserts the row. The database enforces that email and phone are unique and that at least one exists ([001_users_and_devices.sql:3](../migrations/001_users_and_devices.sql#L3)).
3. A unique violation becomes `DuplicateContactError` and the route answers 409.

### 4.2 A device is registered

`POST /users/:id/devices` with a platform and a push token ([users.ts:31](../src/api/users.ts#L31)).

[repository.ts:72](../src/users/repository.ts#L72) is an **upsert on the token** ([repository.ts:81](../src/users/repository.ts#L81)). Registering the same token twice changes nothing; registering a token that belongs to another user moves it to this user, which is what happens when someone logs out and another person logs in on the same phone. An unknown user is a foreign-key failure, reported as 404.

### 4.3 A user chooses what to receive

`PUT /users/:id/settings/:channel` with `{"optIn": false}` ([settings.ts:12](../src/api/settings.ts#L12)).

It stores one row per user and channel ([settings.ts:24](../src/notifications/settings.ts#L24)). It does **not** touch any notification already stored. The worker reads the setting at the last moment before sending (section 5.9). No row means opted in. The setting is read from Postgres each time and is never cached, because it is consent.

### 4.4 Templates (written by an operator)

`PUT /v1/templates/:name/:channel` ([templates.ts:18](../src/api/templates.ts#L18)) stores text with `{{placeholders}}`. Rendering is [templates.ts:23](../src/notifications/templates.ts#L23): every placeholder must have a value (otherwise `TemplateParamError`), values are inserted as plain text in one pass, so a value that itself contains `{{x}}` is not expanded. Reads go through a Redis cache ([templates.ts:80](../src/notifications/templates.ts#L80)): on a miss it reads Postgres and fills the cache, an update deletes the cached copy, and if Redis fails ([cache.ts:13](../src/infra/cache.ts#L13)) every failure is treated as a miss, so a Redis outage only makes things slower.

## 5. The life of a client

A client is a service allowed to use the API.

- **Creating one:** `npm run create-client -- billing` runs [scripts/create-client.ts](../scripts/create-client.ts): it generates credentials ([credentials.ts:16](../src/clients/credentials.ts#L16)), stores the key and **only a SHA-256 hash of the secret** ([credentials.ts:12](../src/clients/credentials.ts#L12)), and prints the secret once. We never keep it, so a database leak does not leak working credentials.
- **Using it:** every request except `/live` and `/health` carries `Authorization: Basic base64(appKey:secret)`. The middleware [auth.ts:19](../src/api/auth.ts#L19) is registered once in [server.ts:54](../src/api/server.ts#L54), before the body is parsed, so every route added later is protected by default.
- **Checking it:** [credentials.ts:27](../src/clients/credentials.ts#L27) looks the key up, hashes the secret that was sent and compares the hashes in constant time ([credentials.ts:31](../src/clients/credentials.ts#L31)). An unknown key goes through the same comparison, so timing does not reveal which keys exist. A missing, malformed, unknown, wrong or revoked credential all get the same 401 ([auth.ts:24](../src/api/auth.ts#L24)).
- **What it is used for afterwards:** the client id is put on `res.locals.client`, written on every notification it creates (`client_id`), used to scope idempotency keys, and added to the request log line. The `Authorization` header itself is never logged ([server.ts:36](../src/api/server.ts#L36) logs only id, method and URL).

## 6. The life of a notification

This is the heart of the system. The numbers are the order in which things happen.

### 6.1 The request arrives (API)

1. **The route** [notifications.ts:48](../src/api/notifications.ts#L48) checks the body with [notifications.ts:21](../src/api/notifications.ts#L21): either `body` (with an optional `subject`) or a `template` with `params`, never both; an optional `sendAt` ([notifications.ts:29](../src/api/notifications.ts#L29)) up to 30 days ahead. It reads the optional `Idempotency-Key` header and the client from the middleware, and calls the service.
2. **The service** [service.ts:55](../src/notifications/service.ts#L55) does the rest of the acceptance.
3. **Is this a retry?** If there is an `Idempotency-Key`, the service looks it up for this client first ([service.ts:58](../src/notifications/service.ts#L58)). If it finds one, it compares a hash of the request ([service.ts:211](../src/notifications/service.ts#L211)) with the stored one: the same request replays the original answer, a different one is refused ([service.ts:135](../src/notifications/service.ts#L135)). Nothing new is created.
4. **Who is the user and where do they receive it?** [repository.ts:44](../src/users/repository.ts#L44) loads the user and their devices, and [service.ts:187](../src/notifications/service.ts#L187) picks the destinations for the channel: the email address, the phone number, or every device token. No destination is a 422.
5. **What does it say?** [service.ts:74](../src/notifications/service.ts#L74) turns the content into final text, rendering the template if there is one. A missing template or parameter is a 422 now, not a surprise later in a worker. The stored text is final, so editing a template cannot change a notification that is already waiting.
6. **Now or later?** [service.ts:78](../src/notifications/service.ts#L78): a `sendAt` more than a second ahead is scheduled; anything else is sent now.
7. **Store it.** [service.ts:99](../src/notifications/service.ts#L99), implemented by [repository.ts:78](../src/notifications/repository.ts#L78), writes in **one transaction**: the idempotency key ([repository.ts:88](../src/notifications/repository.ts#L88)) and one `PENDING` row per destination. If a concurrent request with the same key won the race, the insert fails with `DuplicateKeyError` and the service replays the winner's result ([service.ts:104](../src/notifications/service.ts#L104)). The key and the rows exist together or not at all.
8. **Queue it, unless it is scheduled.** [service.ts:114](../src/notifications/service.ts#L114). [service.ts:163](../src/notifications/service.ts#L163) sends `{notificationId}` to each notification's queue and waits for RabbitMQ to confirm it, and only then marks the row published. A failed publish is only logged: the row is already stored, and the relay will queue it.
9. **Answer.** The route returns **202 Accepted** with the request id and each notification's id and status. 202 means "stored", not "delivered".

The queue for a notification is chosen in [queues.ts:16](../src/notifications/queues.ts#L16): `push.ios`, `push.android`, `push.web`, `sms` or `email`. The publisher ([rabbit.ts:12](../src/infra/rabbit.ts#L12)) keeps one long-lived connection with publisher confirms, declares every queue when it opens ([rabbit.ts:48](../src/infra/rabbit.ts#L48)) and gives up on a publish after 5 seconds, so a stalled broker cannot hang a request.

Errors from all of this are turned into HTTP answers in one place, [server.ts:64](../src/api/server.ts#L64). The routes do not catch: the table of domain errors and their statuses (404 unknown user, 409 duplicate contact, 422 for the refused cases) is [errors.ts:15](../src/api/errors.ts#L15), and the same handler answers validation 400, malformed JSON 400, and anything unexpected with a logged 500 with no details.

### 6.2 The safety net: the relay (API)

A notification can be stored and not queued: the process crashed between the two steps, RabbitMQ was down, or it is scheduled for later. The relay finds those and queues them. [relay.ts:24](../src/notifications/relay.ts#L24) runs every 5 seconds and calls [relay.ts:9](../src/notifications/relay.ts#L9), which asks for the unpublished notifications that are due ([repository.ts:55](../src/notifications/repository.ts#L55)) in batches of 100 until a batch is not full. "Due" is a stored notification that is unpublished and whose `send_at` has passed: a scheduled one is queued as soon as it is due, an ordinary one only if it is old enough not to be a publish still in flight. It may publish a message twice; that is safe because the worker is idempotent.

### 6.3 The worker receives the message

[consumer.ts:24](../src/worker/consumer.ts#L24) connects, limits how many unacknowledged messages it holds per queue (`prefetch`, which is the backpressure) and subscribes to each queue ([consumer.ts:44](../src/worker/consumer.ts#L44)). RabbitMQ pushes each message to one of the subscribed workers. For each message [consumer.ts:54](../src/worker/consumer.ts#L54) runs:

1. It reads the message as `{notificationId}` ([consumer.ts:57](../src/worker/consumer.ts#L57)). A message that is not valid goes to the dead-letter queue and is then acknowledged, so it is kept and not retried for ever.
2. It calls the processor ([consumer.ts:70](../src/worker/consumer.ts#L70)) and acts on the answer:
   - `done`: acknowledge ([consumer.ts:83](../src/worker/consumer.ts#L83)); the message is finished.
   - `busy` or `circuit_open`, or an error thrown: **do not acknowledge**; wait, then put it back on the queue ([consumer.ts:90](../src/worker/consumer.ts#L90)).

The acknowledgement comes only after the outcome is stored. If the worker dies before that, RabbitMQ gives the message to another worker.

### 6.4 The processor delivers one notification (worker)

[processor.ts:38](../src/notifications/processor.ts#L38) is the whole delivery logic, in this order:

1. **Is the provider down?** [processor.ts:43](../src/notifications/processor.ts#L43): if its circuit breaker is open, return `circuit_open` **without claiming**, so the notification keeps all its attempts.
2. **Claim it.** [processor.ts:48](../src/notifications/processor.ts#L48). The SQL in [repository.ts:169](../src/notifications/repository.ts#L169) is one atomic `UPDATE`: it moves the row to `SENDING`, adds 1 to `attempts` and sets a lease (60 s). Of any number of workers holding a copy of the message, exactly one gets the row. The others learn why: `done` (already finished: acknowledge and drop the message), `missing`, or `busy` (someone holds a live lease: the message is put back, because if that worker died, this message is what will notice when the lease expires).
3. **Did the user opt out?** [processor.ts:69](../src/notifications/processor.ts#L69), read now and not when the request was accepted, because the notification may have waited. If so: `SKIPPED_OPT_OUT`, final.
4. **Has the user reached the limit?** [processor.ts:79](../src/notifications/processor.ts#L79), on the **first attempt only** (a retry is the same notification and must not take a second slot). If over the limit: `SKIPPED_RATE_LIMITED`, final.
5. **Send.** [processor.ts:91](../src/notifications/processor.ts#L91) goes through the guard ([guarded.ts:5](../src/providers/guarded.ts#L5)): a timeout ([guarded.ts:30](../src/providers/guarded.ts#L30)), the circuit breaker recording each success and failure, and every error turned into a `ProviderError` that says whether it is retryable. The notification id goes along as the provider's idempotency key.
6. **Success:** [processor.ts:112](../src/notifications/processor.ts#L112): `SENT`, final.
7. **Failure:** [processor.ts:162](../src/notifications/processor.ts#L162) (next section).

### 6.5 When delivery fails

| The provider says | What happens | Where |
|---|---|---|
| a permanent error (an invalid token) | `FAILED` at once, a message to the dead-letter queue | [processor.ts:196](../src/notifications/processor.ts#L196) |
| a temporary error, attempts left | `RETRYING`, and a message to a retry queue | [processor.ts:172](../src/notifications/processor.ts#L172) |
| a temporary error, no attempts left | `FAILED` ("exhausted"), a message to the dead-letter queue | [processor.ts:196](../src/notifications/processor.ts#L196) |

How a retry works: the delay comes from the number of attempts so far ([retry.ts:8](../src/notifications/retry.ts#L8): 5 s, then 30 s, then 2 min by default). The processor publishes the notification id to a queue named after that delay, for example `email.retry.5000` ([queues.ts:25](../src/notifications/queues.ts#L25)). That queue has a time limit and a rule (declared in [queues.ts:29](../src/notifications/queues.ts#L29)): when a message has waited that long, RabbitMQ moves it back to the main queue by itself. No timer in our code. A worker then receives it again like a new message and claims it from `RETRYING`.

The row is written before the retry message is published. If the publish fails, the error goes up, the original message is put back, and a worker claims the notification again a bit sooner than the backoff: acceptable. When it gives up, the row is written first and the dead-letter publish is best effort: the `FAILED` row is the truth, the dead-letter queue is a signal for operators.

### 6.6 A provider that is down: the circuit breaker

[circuit-breaker.ts:10](../src/providers/circuit-breaker.ts#L10) counts consecutive temporary failures ([circuit-breaker.ts:37](../src/providers/circuit-breaker.ts#L37)). After 5 it opens for 30 seconds: while open, step 1 of the processor returns early and the consumer puts the message back after 5 seconds. After the cooldown the next call is a trial: a success closes the circuit, a failure opens it again. There is one breaker per provider, built in [index.ts:14](../src/providers/index.ts#L14), so one provider being down does not hold back the others. A permanent error does not count against the breaker: the provider answered.

### 6.7 Every status, and who sets it

The legal changes are in one table, [state.ts:11](../src/notifications/state.ts#L11). The repository builds its SQL guards from [state.ts:26](../src/notifications/state.ts#L26), so an illegal change matches no row and nothing happens; the database also refuses unknown values with a `CHECK`.

| Status | Meaning | Set by |
|---|---|---|
| `PENDING` | stored, waiting for a worker (or for its time) | [repository.ts:78](../src/notifications/repository.ts#L78) |
| `SENDING` | a worker has claimed it and is sending | [repository.ts:169](../src/notifications/repository.ts#L169) |
| `RETRYING` | a send failed, waiting in a retry queue | [repository.ts:212](../src/notifications/repository.ts#L212) |
| `SENT` | the provider accepted it. Final | [repository.ts:190](../src/notifications/repository.ts#L190) |
| `FAILED` | given up. Final | [repository.ts:220](../src/notifications/repository.ts#L220) |
| `SKIPPED_OPT_OUT`, `SKIPPED_RATE_LIMITED`, `SKIPPED_STALE_DESTINATION` | deliberately not sent. Final | [repository.ts:199](../src/notifications/repository.ts#L199), [users/repository.ts:90](../src/users/repository.ts#L90) |

### 6.8 Special paths

| Situation | What happens |
|---|---|
| **The caller repeats a request** (same `Idempotency-Key`) | Step 3 of 6.1 returns the original answer, marked `Idempotent-Replayed: true`. Nothing is created. |
| **The same queue message arrives twice** | One worker wins the claim; the other gets `busy` (put back) or `done` (acknowledged and dropped). |
| **A worker dies while sending** | Its message goes back to the queue; the row stays `SENDING` until the lease expires, then another worker claims it again (`attempts` goes up). This may send twice if the first send had gone out; that is accepted over losing it. |
| **A scheduled notification** | Stored with a future `send_at` and not published (6.1, step 8). The relay publishes it when due; the worker then checks opt-out and rate limit at that moment. |
| **RabbitMQ is down** | The API still stores and answers 202. The relay queues the rows when the broker is back. |
| **Redis is down** | Templates come from Postgres; the rate limiter lets notifications through and counts the failure. |

### 6.9 The rate limit

[rate-limit.ts:31](../src/notifications/rate-limit.ts#L31) keeps one counter in Redis per user and channel, in a single Lua script ([rate-limit.ts:23](../src/notifications/rate-limit.ts#L23)) that adds 1 and sets the expiry in one atomic step: concurrent workers get distinct counts, and a counter can never be left without an expiry. [rate-limit.ts:43](../src/notifications/rate-limit.ts#L43) returns whether the new count is within the limit. If Redis fails it allows the notification and counts the failure.

## 7. The data

| Table | Holds | Created in |
|---|---|---|
| `users`, `devices` | contacts; a device's token is unique | [001_users_and_devices.sql:3](../migrations/001_users_and_devices.sql#L3) |
| `notifications` | **every notification**: destination, queue, final text, status, attempts, lease, send time, client | [002_notifications.sql:4](../migrations/002_notifications.sql#L4), and later migrations 003, 004, 005, 006, 007, 008 and 009 add columns and statuses |
| `idempotency_keys` | a client's key and the request it belongs to | [004_idempotency_and_claims.sql:3](../migrations/004_idempotency_and_claims.sql#L3), re-keyed by client in 008 |
| `templates`, `notification_settings` | text with placeholders; opt-ins | [006_templates_and_settings.sql:3](../migrations/006_templates_and_settings.sql#L3) |
| `clients` | appKey and the hash of the secret | [008_clients.sql:3](../migrations/008_clients.sql#L3) |

## 8. Watching the system

- **Logs:** one JSON line per request and per notable event (pino). The request line has the client id and never the credentials.
- **Metrics:** each process counts events and serves them on its own internal port ([metrics.ts:10](../src/infra/metrics.ts#L10)). The events are defined in [metrics.ts:3](../src/notifications/metrics.ts#L3) (accepted, sent, failed by reason, skipped by reason, retries, duplicates recognised, provider call time, accepted-to-sent time...) and the request metrics in [http-metrics.ts:6](../src/api/http-metrics.ts#L6). Labels are few and fixed: never an id or a URL.
- **Prometheus** scrapes the API, the workers (found by DNS, so `--scale` just works) and RabbitMQ ([prometheus.yml:9](../observability/prometheus/prometheus.yml#L9)), and evaluates the alert rules ([alerts.yml:8](../observability/prometheus/alerts.yml#L8)).
- **Grafana** loads its datasource and dashboard from files. The dashboard is generated from [build-dashboard.ts:61](../scripts/build-dashboard.ts#L61).

## 9. The tests

Run `npm test` for those that need nothing; set the `TEST_*` variables (see the README) to include the ones that use real Postgres, RabbitMQ and Redis.

| Area | Files |
|---|---|
| Sending, idempotency, scheduling, templates | [notifications.service.test.ts](../test/notifications.service.test.ts), [notifications.api.test.ts](../test/notifications.api.test.ts), [notifications.pg.test.ts](../test/notifications.pg.test.ts) (real database: claims, races, due times) |
| Delivery, retries, circuit breaker, rate limit | [processor.test.ts](../test/processor.test.ts), [retry.test.ts](../test/retry.test.ts), [circuit-breaker.test.ts](../test/circuit-breaker.test.ts), [guarded-provider.test.ts](../test/guarded-provider.test.ts), [rate-limit.test.ts](../test/rate-limit.test.ts) |
| RabbitMQ | [consumer.test.ts](../test/consumer.test.ts), [rabbit.test.ts](../test/rabbit.test.ts) (real broker: acknowledgement, redelivery, retry queues) |
| Users, preferences, templates, cache | [users.api.test.ts](../test/users.api.test.ts), [users.pg.test.ts](../test/users.pg.test.ts), [preferences.api.test.ts](../test/preferences.api.test.ts), [preferences.pg.test.ts](../test/preferences.pg.test.ts), [templates.test.ts](../test/templates.test.ts), [cache.test.ts](../test/cache.test.ts) |
| Authentication | [auth.api.test.ts](../test/auth.api.test.ts), [credentials.test.ts](../test/credentials.test.ts), [clients.pg.test.ts](../test/clients.pg.test.ts) |
| Metrics, health, state machine, relay | [metrics.test.ts](../test/metrics.test.ts), [health.test.ts](../test/health.test.ts), [state.test.ts](../test/state.test.ts), [relay.test.ts](../test/relay.test.ts) |

[test/fakes.ts](../test/fakes.ts) has in-memory versions of every interface (repositories, publisher, cache, rate limiter) and `buildTestApp`, which wires the whole core without infrastructure. The Postgres tests exist because the guarantees live in SQL (constraints, atomic updates), and a fake cannot prove those. The end-to-end check is the chaos demo ([scripts/chaos-demo.ts](../scripts/chaos-demo.ts)): it drives load, breaks things, and checks that nothing accepted was lost.

## 10. The scripts

| Script | What it does |
|---|---|
| `npm run seed` ([seed.ts](../scripts/seed.ts)) | Demo client, three users with devices, templates. Safe to run again. |
| `npm run create-client -- <name>` ([create-client.ts](../scripts/create-client.ts)) | A new client; prints the secret once. |
| `./scripts/watch-db.sh` | Live view of notifications, queues and Redis. |
| `./scripts/traffic.sh [seconds] [per second]` | Load, with some repeated requests. |
| `npm run demo:chaos [-- --workers 3] [-- --scale 0.4]` ([chaos-demo.ts](../scripts/chaos-demo.ts)) | Load plus failures, with a verdict. |
| `./scripts/inject-duplicate.sh` | Puts extra copies of a queue message on a queue, to watch the claim handle them. |
| `./scripts/demo.sh` | A short tour of the main cases. |
| `npm run build-dashboard` ([build-dashboard.ts](../scripts/build-dashboard.ts)) | Regenerates the Grafana dashboard JSON. |

## 11. Where is...?

| Question | Look at |
|---|---|
| Where does a request become a stored notification? | [service.ts:55](../src/notifications/service.ts#L55) and [repository.ts:78](../src/notifications/repository.ts#L78) |
| Where is a message put on a queue? | [service.ts:163](../src/notifications/service.ts#L163) and [rabbit.ts:23](../src/infra/rabbit.ts#L23) |
| What decides who wins when two workers get the same message? | [repository.ts:169](../src/notifications/repository.ts#L169) |
| Where is a retry scheduled? | [processor.ts:162](../src/notifications/processor.ts#L162) |
| Where is the wait before a retry? | [queues.ts:29](../src/notifications/queues.ts#L29) (a queue with a time limit) |
| Where does a notification become `FAILED`? | [processor.ts:196](../src/notifications/processor.ts#L196) |
| Where is an opt-out applied? | [processor.ts:69](../src/notifications/processor.ts#L69) |
| Where is the rate limit applied? | [processor.ts:79](../src/notifications/processor.ts#L79) and [rate-limit.ts:23](../src/notifications/rate-limit.ts#L23) |
| Where are credentials checked? | [credentials.ts:27](../src/clients/credentials.ts#L27) |
| Where are the legal status changes? | [state.ts:11](../src/notifications/state.ts#L11) |
| Where is the delay between retries configured? | [config.ts:34](../src/infra/config.ts#L34) |
| Where are scheduled notifications published? | [relay.ts:9](../src/notifications/relay.ts#L9) |
| Where are all configuration values? | [config.ts:12](../src/infra/config.ts#L12) |
