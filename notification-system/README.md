# Notification system

A notification system for push, SMS and email, built from Chapter 10 of *System Design Interview* (Alex Xu). Other
services call an authenticated HTTP API. The API stores each notification durably and puts it on a per-channel
RabbitMQ queue. Stateless workers take it off the queue and deliver it through provider adapters (mocks here).
Delivery is at-least-once, so everything on the path is idempotent. Failures are retried with backoff, and what
cannot be delivered ends up in a dead-letter queue.

TypeScript, Express 5, PostgreSQL, RabbitMQ, Redis, Prometheus and Grafana, all in Docker Compose.

- **[DESIGN.md](DESIGN.md)**: the architecture, the trade-offs, what is not done, and how AI was used.
- [docs/WALKTHROUGH.md](docs/WALKTHROUGH.md): a guided tour of the code, following a user and a notification.
- [docs/FLOWS.md](docs/FLOWS.md): sequence diagrams of every flow.
- [docs/DECISIONS.md](docs/DECISIONS.md): the full decision log.

## Run it

You need Docker with Compose v2. Node 20 or later is needed only for the helper scripts (seeding, tests, demos).

```bash
cd notification-system
docker compose up -d --build        # api, worker, postgres, rabbitmq, redis, prometheus, grafana
npm ci
npm run seed                        # a demo client, three users, their devices, some templates
```

Send a notification (the demo client is `demo-key` / `demo-secret`, for development only):

```bash
curl -u demo-key:demo-secret -XPOST localhost:3000/v1/notifications \
  -H 'content-type: application/json' \
  -d '{"userId":"2","channel":"email","body":"Hello Bob"}'
# 202 Accepted: stored and queued, not delivered yet. A moment later it is SENT:
docker compose exec postgres psql -U notif -d notifications -c "SELECT status, attempts, payload->>'body' AS body FROM notifications ORDER BY created_at DESC LIMIT 3;"
```

| What | Where |
|---|---|
| API | http://localhost:3000 |
| Grafana dashboard (no login) | http://localhost:3001 |
| Prometheus (targets, alerts) | http://localhost:9090 |
| RabbitMQ management (`notif` / `notif`) | http://localhost:15672 |
| Postgres | `localhost:5432`, database `notifications`, user `notif`, password `notif` |

## The API

Every route except `/live` and `/health` needs `Authorization: Basic base64(appKey:secret)`. Create more clients with
`npm run create-client -- <name>`, which prints the secret once; only a hash is stored.

| Route | What it does |
|---|---|
| `POST /v1/notifications` | Send a notification: `{userId, channel, body}` or `{userId, channel, template, params}`. Optional `subject`, and `sendAt` (ISO 8601 with an offset, up to 30 days ahead) to schedule it. Send an `Idempotency-Key` header and a retry of the same request is safe. |
| `PUT` / `GET /v1/templates/:name/:channel` | Create, update or read a template with `{{param}}` placeholders. |
| `POST /users`, `POST /users/:id/devices` | Register a user's email and phone, and their devices (iOS, Android, web). |
| `PUT /users/:id/settings/:channel`, `GET /users/:id/settings` | Opt a user in or out of a channel. |
| `GET /live`, `GET /health` | Liveness, and readiness (Postgres, Redis, RabbitMQ). |

A few examples:

```bash
J='content-type: application/json'; A='demo-key:demo-secret'

# a templated notification, safe to retry
curl -u $A -XPOST localhost:3000/v1/notifications -H "$J" -H 'Idempotency-Key: order-1001' \
  -d '{"userId":"2","channel":"email","template":"order-shipped","params":{"name":"Bob","order_id":1001,"eta":"Friday"}}'

# scheduled for later (use a time in the future)
curl -u $A -XPOST localhost:3000/v1/notifications -H "$J" \
  -d '{"userId":"2","channel":"email","body":"See you tomorrow","sendAt":"2030-01-01T09:00:00Z"}'

# opt Bob out of email: his next email is recorded as SKIPPED_OPT_OUT
curl -u $A -XPUT localhost:3000/users/2/settings/email -H "$J" -d '{"optIn":false}'
```

## See it handle failure

```bash
./scripts/watch-db.sh                      # live view: notifications, queues, Redis (leave it in one terminal)
./scripts/traffic.sh 40 4                  # 40 seconds of load, 4 requests per second
npm run demo:chaos -- --workers 3          # about 5 minutes: load, a spike, then a worker killed,
                                           # RabbitMQ down, Redis down, a flaky and a dead provider.
                                           # Ends with a verdict: nothing accepted was lost.
```

Open Grafana while the demo runs; each phase prints what to watch. Use `--scale 0.4` for a shorter run. The demo
empties the notifications table and recreates the api and worker containers, and restores them at the end.

## Tests

```bash
npm test                  # unit and API tests, no infrastructure needed
```

The tests that need real infrastructure are skipped unless you point them at it (with the stack up):

```bash
TEST_DATABASE_URL=postgres://notif:notif@localhost:5432/notifications \
TEST_RABBITMQ_URL=amqp://notif:notif@localhost:5672 \
TEST_REDIS_URL=redis://localhost:6379 npm test
```

These empty the notifications, users, templates and clients tables, so run `npm run seed` afterwards.

## Configuration

Everything comes from environment variables, validated at start-up ([src/infra/config.ts](src/infra/config.ts) lists
them all with comments). The ones below can be overridden from the shell when starting the containers, for example
`MOCK_FAILURE_RATE=0.4 docker compose up -d --force-recreate worker`. They are read when a container starts.

| Variable | Default | Meaning |
|---|---|---|
| `RETRY_DELAYS_MS` | `5000,30000,120000` | Wait before each retry; N delays mean N+1 attempts. Set it on api **and** worker. |
| `CLAIM_LEASE_MS` | `60000` | How long a worker owns a notification it is sending. Must exceed the provider timeout. |
| `PROVIDER_TIMEOUT_MS` | `10000` | A provider call longer than this counts as a retryable failure. |
| `BREAKER_FAILURE_THRESHOLD`, `BREAKER_COOLDOWN_MS` | `5`, `30000` | Circuit breaker per provider. |
| `RATE_LIMIT_PUSH`, `_SMS`, `_EMAIL` | `20/3600`, `5/3600`, `10/3600` | At most that many notifications per user and channel in that many seconds. |
| `MOCK_LATENCY_MS`, `MOCK_FAILURE_RATE` | `50`, `0` | How the mock providers behave. |

## If something does not start

- RabbitMQ shows `Exited` right after a fresh `up`: run `docker compose up -d` again (a permissions glitch of the image on
  Docker Desktop, on the first start of a new volume).
- After Docker Desktop restarts, Prometheus or Grafana fail with a "mount" error: `docker compose up -d --force-recreate prometheus grafana`.
- `Cannot connect to the Docker daemon`: Docker Desktop is not running.

## Layout

```
src/api/            HTTP: routes, authentication, request metrics        (entry point: main.ts)
src/worker/         the queue consumer                                    (entry point: main.ts)
src/notifications/  the core: sending, claiming, retries, rate limit, templates, settings, state machine
src/providers/      provider interface, the mocks, timeout, circuit breaker
src/users/          users and devices
src/clients/        the services allowed to call the API, and their credentials
src/infra/          configuration, RabbitMQ, cache, migrations, health, metrics
migrations/         plain SQL, applied in order when the api starts
observability/      Prometheus, alert rules, Grafana (provisioned from files)
scripts/            seed, demos, load generator, dashboard generator
test/               unit and integration tests
```

[docs/WALKTHROUGH.md](docs/WALKTHROUGH.md) explains which file does what, with links into the code.
