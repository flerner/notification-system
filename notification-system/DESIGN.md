# Design

A notification system for push, SMS and email, from Chapter 10 of _System Design Interview_ (Alex Xu). This document
explains what it does, how it is built, why, and what it does not do. To run it, see the [README](README.md). For a tour
of the code, see [docs/WALKTHROUGH.md](docs/WALKTHROUGH.md); for every decision in full, [docs/DECISIONS.md](docs/DECISIONS.md)
(referred to below as D-nn); for sequence diagrams, [docs/FLOWS.md](docs/FLOWS.md).

## 1. What it has to do

Requirements (Book: Ch. 10, Step 1): send push (iOS, Android, web), SMS and email; soft real-time (a short delay under load
is fine); triggered by client applications **and** scheduled on the server; users can opt out; about 10 million push,
1 million SMS and 5 million emails a day.

That is about 16 million a day, **about 185 per second on average**, and I sized for roughly ten times that at the peak
(about 2,000 per second). Push is 62% of it, email 31%, SMS 6%, which is a reason to have one queue per channel and to be
able to scale each channel's workers on its own. The one absolute requirement is: _notifications can be
delayed or reordered, but never lost._ (Book: Ch. 10, "Reliability".) Most of the design follows from it.

Out of scope, on purpose: real provider accounts (the providers are mocks behind an interface), a login for end users,
analytics on opens and clicks. Section 9 lists what is missing.

## 2. Architecture

```
Services ──(appKey + secret)──> API (stateless, any number) ──> Postgres   every notification, the source of truth
                                  │            ▲                 Redis      template cache, rate-limit counters
                                  │ publish    │ relay: queues what was stored but not queued, and what is due
                                  ▼            │
                          RabbitMQ: push.ios · push.android · push.web · sms · email
                                    (+ retry queues, + dead-letter queue)
                                  │
                                  ▼
                          Workers (stateless, any number) ──> providers (APNS, FCM, SMS, email: mocks)

                          Prometheus ──> Grafana (dashboard, alert rules)
```

Book: Figure 10-14. Same parts: notification servers, a database and cache moved out of them, message
queues per notification type, workers, third-party services, and the additions (authentication, rate limiting, retries,
templates, monitoring).

**What a notification goes through** (the code for each step is in the [walkthrough](docs/WALKTHROUGH.md)):

1. A client calls `POST /v1/notifications`. The API checks its credentials and the request.
2. It looks up the user's destinations for the channel, fills in the template if there is one, and stores one row per
   destination in Postgres, in one transaction together with the request's idempotency key.
3. It publishes `{notificationId}` to the channel's queue, waits for RabbitMQ to confirm, and answers **202**. A scheduled
   notification is stored and not queued yet.
4. A worker receives the message and **claims** the notification with one atomic update. Then it checks the user's
   opt-out and rate limit, and calls the provider.
5. Success: `SENT`. A temporary failure: the notification waits in a retry queue and comes back after a delay. A permanent
   failure, or no attempts left: `FAILED`, recorded and announced on the dead-letter queue.

Two processes, one code base and one image: the API and the worker. They share the core (`src/notifications`), which
depends only on small interfaces, so the tests run it with no infrastructure.

## 3. The main problem: never lose, never duplicate

**What is guaranteed.** Once the API answers 202, the notification is in Postgres, and nothing short of losing the
database loses it. It is delivered **at least once**. Delivering _exactly_ once is impossible in a distributed system
(a worker that crashes after the provider accepted a message cannot tell it from one that crashed before), so I aimed
for at-least-once delivery with idempotent processing, and I accept a rare duplicate rather than a loss.

**Idempotency, at the three places a duplicate can come from** (D-11, D-12, D-13):

| Where a duplicate comes from                                                                               | What stops it                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The caller retries a request                                                                               | An optional `Idempotency-Key`, stored in the same transaction as the notifications. The same key and request returns the original answer; a different request with the same key is refused. Keys belong to a client, so no client can read another's request. |
| The same queue message is delivered twice (a crash before the acknowledgement, the relay publishing twice) | A **claim**: one atomic `UPDATE` moves the notification to `SENDING`. Of any number of workers holding a copy, exactly one wins. The claim carries a **lease**, so if the winner dies another worker takes over after it expires.                             |
| The worker dies after the provider accepted, before it recorded the result                                 | The notification id is sent to the provider as its idempotency key. A provider that honours it drops the repeat. One that does not will receive a duplicate: this is the window that cannot be closed, and it is the accepted cost.                           |

**What happens when something fails** (the chaos demo, section 8, checks these):

| What fails                                                    | What happens                                                                                                                                                                |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The API crashes between storing and publishing                | The row is stored but unpublished; the relay queues it.                                                                                                                     |
| RabbitMQ is down                                              | The API still stores and answers 202; the relay queues the rows once the broker is back. Workers exit and Docker restarts them.                                             |
| A worker dies mid-send                                        | Its message goes back to the queue; after the lease expires another worker claims the notification again.                                                                   |
| A provider fails now and then                                 | The notification waits in a retry queue (5 s, 30 s, 2 min by default) and is tried again, up to four attempts.                                                              |
| A provider is down                                            | Its circuit breaker opens. New notifications are not even claimed, so they keep their attempts, and wait. After a cooldown one trial call decides whether it has recovered. |
| A provider refuses a notification for good (an invalid token) | `FAILED` at once, with no retries, and a message on the dead-letter queue.                                                                                                  |
| A provider is slow                                            | Every call has a timeout; a timeout counts as a temporary failure.                                                                                                          |
| Redis is down                                                 | Templates are read from Postgres. The rate limiter lets notifications through and counts the failure.                                                                       |
| Postgres is down                                              | **Not handled gracefully**: the API cannot store anything and answers with an error.                                                                                        |

## 4. The decisions that matter, and what they cost

Book references for each are in section 5.

| Decision                                                                     | Why                                                                                                                                                                                                                                         | What it costs                                                                                                                                         |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **RabbitMQ, not Kafka** (D-02)                                               | The workload is a task queue: send once, retry on failure, route by channel. RabbitMQ gives per-message acknowledgement, retry through dead-letter queues, backpressure, and queue depths for monitoring, with little to operate.           | No replay of old messages and a lower throughput ceiling. At about 2,000 a second that does not matter; with a need to replay events Kafka would win. |
| **Postgres is the source of truth** (D-03)                                   | Unique constraints and atomic updates are what make idempotency work; the notification log is durable.                                                                                                                                      | The table grows by about 16 million rows a day: it would need partitioning and archiving.                                                             |
| **Store first, publish second, with a relay** (D-05)                         | A database write and a queue publish cannot be one atomic step. Storing first means a crash can leave a stored notification unqueued, never a queued one that was not stored. The relay queues what is missing.                             | A message may be published twice; the claim makes that harmless.                                                                                      |
| **202 Accepted, one row per destination, only the id in the message** (D-08) | The API stays fast whatever the providers do. Each device has its own status, retries and outcome. The database stays the single source of truth.                                                                                           | A caller learns the outcome only by looking it up.                                                                                                    |
| **Retries through RabbitMQ retry queues** (D-15)                             | A queue with a time limit hands the message back to the main queue after the delay: no timers or scheduler in our code, and it survives restarts.                                                                                           | One queue per delay and channel, and a fixed delay per queue, so no random jitter.                                                                    |
| **Dead-letter queue as a signal, the `FAILED` row as the truth** (D-16)      | Failing to announce a failure must never make a worker send again.                                                                                                                                                                          | The announcement is best effort.                                                                                                                      |
| **Circuit breaker checked before the claim** (D-17)                          | A provider outage must not spend the attempts of notifications that were never tried.                                                                                                                                                       | The state is per process. The few notifications in flight when it opens do spend an attempt.                                                          |
| **Opt-out checked in the worker, at the last moment** (D-18)                 | A notification may wait in a queue for a while; the user may opt out meanwhile.                                                                                                                                                             | A notification for an opted-out user is still stored and queued first.                                                                                |
| **Rate limit: a fixed-window counter in Redis, one Lua script** (D-21, D-22) | One atomic step per notification, correct under concurrent workers, no counter can be left without an expiry. Counted by the worker so it matches what the user receives.                                                                   | Up to twice the limit around a window boundary. It **fails open**: if Redis is down the cap is not enforced.                                          |
| **Templates rendered in the API; only templates cached** (D-19, D-20)        | The stored text is final, so editing a template never changes a queued notification, and mistakes reach the caller at once. Consent and device data are not cached: a stale entry could message someone who opted out, or the wrong person. | Variation: user and device info are not cached (section 5).                                                                                           |
| **Credentials: key and secret, only a hash stored** (D-23)                   | A leak of the database leaks no working credentials. Every failure gets the same 401, comparisons take constant time, and secrets never reach the logs.                                                                                     | One level of permission for every client, and Basic auth needs HTTPS in front.                                                                        |
| **Scheduled notifications reuse the relay** (D-28)                           | A stored notification with a send time is the same thing as one the relay has not queued yet. Opt-out and the rate limit are checked at send time, which is exactly right for next week.                                                    | Precision of one relay tick (5 s); the relay runs in the API.                                                                                         |
| **Metrics on an internal port, low-cardinality labels** (D-24, D-25)         | Metrics are for operators and need no credentials. A label that can take many values would overload Prometheus.                                                                                                                             | Alerts fire but nothing delivers them.                                                                                                                |
| **TypeScript and Express; repository interfaces** (D-01)                     | A framework I know, so I can explain every line of the HTTP layer. The core never imports Express or the broker client.                                                                                                                     | One more file per area for the interfaces.                                                                                                            |

## 5. Book references

Chapter 10 of _System Design Interview_. [docs/DECISIONS.md](docs/DECISIONS.md) has a `Book:` line under each decision that relates to it, and a "Book" column in its index.

| Book                                                                                                                                                  | Here                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Ch. 10, Step 1: the requirements (push, SMS, email; client-triggered **and** scheduled; opt-out; the volumes)                                         | The scope of the system (section 1). Scheduling: D-28                                                                                    |
| Ch. 2: back-of-the-envelope estimation                                                                                                                | The sizing in section 1                                                                                                                  |
| Ch. 3: a framework for approaching a design problem (understand the scope, propose a design, go deeper, wrap up)                                      | How the work was ordered                                                                                                                 |
| Ch. 1: a stateless web tier; a message queue as a buffer; logging and metrics                                                                         | Stateless API and workers (D-09); queues (D-02); metrics (D-24)                                                                          |
| Ch. 10, Step 2: one message queue per notification type (Fig. 10-10)                                                                                  | Five queues, one per channel and platform (D-02)                                                                                         |
| Ch. 10, Step 2: move the database and the cache out of the notification server; the notification log (Fig. 10-11)                                     | Postgres and Redis (D-03); persist before queueing (D-05)                                                                                |
| Ch. 10, Step 2: third-party services must be easy to plug and unplug                                                                                  | The `ChannelProvider` interface (D-04)                                                                                                   |
| Ch. 10: the contact info gathering flow; the notification servers validate and put the data on the queues                                             | Users and devices (D-06), validation (D-07), one row per destination (D-08)                                                              |
| Ch. 10: exactly-once delivery is impossible, so dedupe by event ID                                                                                    | Idempotency (D-11, D-12)                                                                                                                 |
| Ch. 10: the retry mechanism, "if the problem persists, an alert will be sent out to developers"; Ch. 4: "add sufficient back off time to retry logic" | Retries (D-15); the dead-letter queue and the alerts (D-16, D-27)                                                                        |
| Ch. 10: notification template; notification setting; rate limiting                                                                                    | Templates (D-19), opt-out (D-18), the per-user cap (D-21). The algorithm, and a Lua script for the race condition, are from Ch. 4 (D-22) |
| Ch. 10: security in push notifications, an appKey and appSecret                                                                                       | Authentication (D-23)                                                                                                                    |
| Ch. 10: monitor queued notifications, the key metric                                                                                                  | The dashboard's first panel, and its alerts (D-25, D-26, D-27)                                                                           |

**Variations:**

- **The opt-out and the rate limit are applied by the worker**, not by the notification servers (Book: Step 2, Fig. 10-14).
  A notification can wait in a queue while the user opts out, and a backlog must not be delivered in one burst, so both are applied at the
  last moment before sending (D-18, D-21).
- **Only templates are cached**, not user and device info (Book: Step 2, cache). A stale device entry could send one person's notification to
  another, and a stale opt-in could message someone who opted out (D-20).
- **Event tracking** (opens and clicks, through an analytics service; Book: Fig. 10-14) is not built (section 9).

**Own additions:**

- how the idempotency is enforced: the atomic claim with a lease, the state machine, and the three layers (D-10, D-12, D-13);
- timeouts and the circuit breaker, and telling permanent failures from temporary ones (D-14, D-17);
- retry queues with time limits, and the dead-letter queue (D-15, D-16);
- the relay that keeps the database and the queue consistent (D-05);
- the 202 contract and hashed secrets (D-08, D-23);
- the metrics, the dashboard and the chaos demo (D-24 to D-27);
- RabbitMQ rather than Kafka, TypeScript and Express (D-02, D-01).

## 6. Respecting the user

Users choose what to receive per channel, and a notification is skipped if they opted out (`SKIPPED_OPT_OUT`).
A frequency cap limits how many a user receives per channel per hour, so people do not switch notifications off
altogether (`SKIPPED_RATE_LIMITED`). Templates keep messages consistent, with a strict rule: a missing parameter is an
error, never a half-filled message. A skipped notification is not an error: it is recorded and counted separately.

## 7. Observability

Every notification has a status in Postgres, so the question "where is it?" is a query. Each process counts events
(accepted, sent, failed by reason, skipped by reason, retries, duplicates recognised, provider and end-to-end times) and
serves them on an internal port; Prometheus collects them and RabbitMQ's own queue depths, and Grafana shows a dashboard
of nine panels built around four questions: is it keeping up, is anything being given up on, is it fast enough, what is
the traffic doing ([screenshot](docs/grafana-dashboard.png)). The first version had 23 panels; most of them answered
questions nobody had asked, so I removed them (the metrics are still collected). Alert rules cover a non-empty
dead-letter queue, a growing backlog, an open circuit, a high failure rate, Redis failing and a service down.

## 8. How it was tested

- **Unit and API tests (238)** run the whole core against in-memory versions of every interface: the state machine, retries
  and backoff, the circuit breaker, idempotency, templates, opt-out, rate limit, authentication, metrics.
- **Integration tests (66 more, 304 in all)** use real Postgres, RabbitMQ and Redis for what only they can prove: eight
  workers racing for one claim and exactly one winning, six simultaneous requests with one idempotency key storing one
  notification, a message really coming back from a retry queue after its delay, a rate-limit counter that counts exactly under
  50 concurrent callers. They are skipped unless the services are available.
- **A chaos demo** (`npm run demo:chaos -- --workers 3`) drives load and a spike, then kills a worker, takes down RabbitMQ and Redis,
  and makes the provider flaky and then dead, and finishes with a verdict. One run: 735 requests, all accepted;
  996 notifications stored, exactly the 996 the API reported; 864 sent and 132 failed on purpose (an invalid device token and
  a failing provider); none stuck; no server error; none sent twice by racing workers. The load generator retries every
  unanswered request with the same idempotency key, as a good caller would.

What the tests did not show me: behaviour under real network conditions, and anything involving a real provider.

## 9. What is not done, and what I would do next

Left out on purpose, because it would add code without adding a design idea:

- **Real providers.** The mocks sit behind `ChannelProvider`; adding one is a class and its credentials.
- **High availability and edge**: one RabbitMQ, one Postgres, one Redis; no load balancer, no replication, no HTTPS (needed in front,
  since Basic auth sends the secret on every request), no per-client permissions, no Alertmanager.
- **Opens and clicks** (Book: event tracking): we record delivery outcomes, not what users do afterwards.
- **User and device caching** (Book: Step 2, cache). Not done, because a device token can move between users and a
  stale entry could send one person's notification to another. A short TTL with invalidation on both owners would be the way.

Known limits of what is built:

- **Not load-tested.** The sizing in section 1 is arithmetic, not a measurement. The chaos demo proves nothing is lost under failure, at a
  few requests per second on one machine with mock providers. Postgres writes are where I would expect the first limit (section 9, scaling).
- A `FAILED` notification is final, and there is **no replay tool**. A notification that failed because the _provider_ was
  unhealthy (all attempts used) is a good candidate to resend; one the provider refused is not. The reason is recorded.
- There is **no expiry**: a notification waiting behind a provider outage is delivered whenever it recovers, even hours late.
- A long provider outage can still exhaust the notifications that were in flight before the circuit opened.
- Scheduled notifications cannot be cancelled, their contacts are resolved when they are accepted, and they wait if every API
  instance is down (the relay lives in the API).
- Idempotency keys are kept for ever; production would expire them after a day or so.
- The rate limiter is a fixed window; a sliding window would remove the boundary effect.
- Postgres is a single point of failure, and the `notifications` table needs partitioning and archiving at this volume.

## 10. How AI was used

AI (Claude Code) was used as a collaborative implementation tool, not as an autonomous author.

**Design and planning first.** The scope and the plan were worked out before any code was written: the requirements and
volumes of Chapter 10, RabbitMQ over Kafka, Postgres as the source of truth, the three idempotency layers, and a plan of
small milestones (a Docker skeleton, users and devices, the send path and queues, workers, idempotency, retries, templates and
opt-out, rate limiting, authentication, Grafana, scheduling, a chaos demo). Claude was used to present trade-offs and surface edge
cases, for example that a database write and a queue publish cannot be one atomic step, which led to the relay. The design
choices were made together.

**Decided, run and verified, milestone by milestone.** Each part was worked out side by side: the options were weighed together and the
reasons went into the decision log as we went. The paths where a wrong result would be silent (the atomic claim and lease, the
idempotency key stored in the same transaction, the retry queues, the rate-limit script) were reviewed most closely, and
[docs/WALKTHROUGH.md](docs/WALKTHROUGH.md) documents how they work. Every milestone was also run against the real stack, not only the
tests: the broker stopped, workers killed, Redis stopped, a dashboard looked at in a browser.

**AI output was changed when it did not fit.** There were many such changes along the way. Examples: the providers were moved to a
top-level folder, the cache was kept to templates only instead of also caching user and device data, and the dashboard was cut from
23 panels to 9. The decision log ([docs/DECISIONS.md](docs/DECISIONS.md)) was kept as the system was built, so the reasons are recorded
when the decisions were made.

**Where the AI output was wrong, and what caught it.** Examples, among others found by running the system and by tests: a limiter
metric that existed and was never incremented, a flaky test caused by clock differences between the host and the database container,
a dead-letter count that disagreed with the failed rows (stale statistics in RabbitMQ's management API), and a dashboard with
fractional counts and "No data" on healthy panels. Each was fixed and, where possible, covered by a test.
