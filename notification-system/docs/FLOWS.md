# Flows

Sequence diagrams of how a notification moves through the system, written in Mermaid (GitHub
renders them on this page). Participants: **Caller** (another service), **API**, **DB**
(Postgres), **MQ** (RabbitMQ), **Worker**, **Provider** (APNS, FCM, SMS or email service; mocks
in this project).

## 1. Accepting a request (API)

The API only accepts and queues. Nothing is delivered here. Idempotency layer 1: the
`Idempotency-Key` makes a retried request safe.

```mermaid
sequenceDiagram
    autonumber
    participant C as Caller
    participant A as API
    participant DB as Postgres
    participant MQ as RabbitMQ

    C->>A: POST /v1/notifications (Idempotency-Key: K)
    A->>DB: look up key K
    alt K already stored (the caller is retrying)
        DB-->>A: original request and its notifications
        A-->>C: 202 same requestId, Idempotent-Replayed: true
    else new request
        A->>DB: load the user's email, phone and devices
        A->>DB: one transaction: store key K + one PENDING row per destination
        Note over A,DB: the key and the rows exist together or not at all
        A->>MQ: publish {notificationId} to the channel's queue, wait for confirm
        alt broker confirmed
            A->>DB: set published_at
        else broker unreachable
            Note over A,MQ: rows stay unpublished, the relay publishes them later (diagram 2)
        end
        A-->>C: 202 Accepted (stored, queued, not delivered yet)
    end
```

## 2. The relay: nothing stored is left unqueued

Runs every few seconds inside the API. Covers a crash between the database write and the publish,
and a broker outage. It may publish a message twice; that is safe because workers are idempotent.

```mermaid
sequenceDiagram
    participant R as Relay (in the API)
    participant DB as Postgres
    participant MQ as RabbitMQ

    loop every RELAY_INTERVAL_MS
        R->>DB: rows with published_at NULL and old enough
        DB-->>R: stuck rows
        R->>MQ: publish {notificationId} for each, wait for confirm
        R->>DB: set published_at for the confirmed ones
    end
```

## 3. Delivering a notification (happy path)

Idempotency layer 2: the claim. Of any number of workers holding a copy of the message, exactly
one wins it.

```mermaid
sequenceDiagram
    autonumber
    participant MQ as RabbitMQ
    participant W as Worker
    participant DB as Postgres
    participant P as Provider

    MQ->>W: push {notificationId} (at most prefetch unacknowledged)
    W->>W: is this provider's circuit open? no
    W->>DB: claim: PENDING to SENDING, attempts + 1, lease (one atomic UPDATE)
    DB-->>W: the row (claimed)
    W->>P: send, idempotency key = notification id, 10 s timeout
    P-->>W: accepted
    W->>DB: SENDING to SENT
    W->>MQ: ack (only now)
```

## 4. A retryable failure, then success

The wait happens inside RabbitMQ: the retry queue has a TTL and hands the message back to the main
queue when it expires. No timer in our code.

```mermaid
sequenceDiagram
    autonumber
    participant MQ as RabbitMQ
    participant W as Worker
    participant DB as Postgres
    participant P as Provider

    MQ->>W: push {notificationId}
    W->>DB: claim (attempt 1)
    W->>P: send
    P-->>W: 503 (retryable)
    W->>DB: SENDING to RETRYING, keep the error
    W->>MQ: publish to email.retry.5000
    W->>MQ: ack the original message
    Note over MQ: waits 5 s in the retry queue
    MQ->>MQ: TTL expires, dead-letters the message to the email queue
    MQ->>W: push {notificationId} again
    W->>DB: claim: RETRYING to SENDING (attempt 2)
    W->>P: send, same idempotency key
    P-->>W: accepted
    W->>DB: SENDING to SENT
    W->>MQ: ack
```

The delay depends on the attempt: after attempt 1 the 5 s queue, after attempt 2 the 30 s queue,
after attempt 3 the 2 min queue (`RETRY_DELAYS_MS`). Four attempts at most.

## 5. Giving up: permanent failure or attempts used up

The database row is the truth. The dead-letter queue is a signal for operators, published after
the row is written and best effort.

```mermaid
sequenceDiagram
    autonumber
    participant MQ as RabbitMQ
    participant W as Worker
    participant DB as Postgres
    participant P as Provider

    MQ->>W: push {notificationId}
    W->>DB: claim
    W->>P: send
    alt permanent error (invalid token)
        P-->>W: refused, retrying cannot help
    else retryable error and no attempts left
        P-->>W: 503
        Note over W: attempt 4 of 4: nothing left to retry
    end
    W->>DB: SENDING to FAILED, keep the error
    W->>MQ: publish to dead-letter (reason, error, attempts)
    Note over W,MQ: if this publish fails the row still says FAILED, nothing is sent twice
    W->>MQ: ack
```

A message that is not valid JSON, or has no notification id, never reaches the processor: the consumer
publishes it to the dead-letter queue and acknowledges it only after that succeeds.

## 6. A provider is down: the circuit breaker

The breaker is checked **before** the claim, so notifications do not use up attempts against a
provider that is known to be down.

```mermaid
sequenceDiagram
    autonumber
    participant MQ as RabbitMQ
    participant W as Worker
    participant DB as Postgres
    participant P as Provider

    Note over W,P: 5 transient failures in a row: the circuit opens for 30 s
    loop while the circuit is open
        MQ->>W: push {notificationId}
        W->>W: circuit open: do not claim, do not call the provider
        W->>MQ: nack with requeue, after a 5 s pause
    end
    Note over W,P: cooldown over: half open, calls are allowed as a trial
    MQ->>W: push {notificationId}
    W->>DB: claim
    W->>P: send (the trial)
    alt trial succeeds
        P-->>W: accepted
        Note over W: circuit closes, the backlog drains
    else trial fails
        P-->>W: 503
        Note over W: circuit opens again for a full cooldown
    end
```

Permanent errors (invalid token) never open the circuit: the provider answered, so it is healthy.

## 7. A worker crashes in the middle of a send

Idempotency layers 2 and 3. A message that finds the notification claimed is **not** acknowledged:
if the worker holding it died, that message is what makes us notice when the lease expires.

```mermaid
sequenceDiagram
    autonumber
    participant MQ as RabbitMQ
    participant W1 as Worker 1
    participant W2 as Worker 2
    participant DB as Postgres
    participant P as Provider

    MQ->>W1: push {notificationId}
    W1->>DB: claim (attempt 1, lease 60 s)
    W1->>P: send
    Note over W1: crashes before recording SENT
    MQ->>MQ: connection closed: the unacknowledged message goes back to the queue
    loop until the lease expires
        MQ->>W2: push {notificationId}
        W2->>DB: claim
        DB-->>W2: busy (Worker 1's lease is still valid)
        W2->>MQ: nack with requeue after 1 s (not acknowledged, not dropped)
    end
    MQ->>W2: push {notificationId}
    W2->>DB: claim: the lease has expired, SENDING to SENDING (attempt 2)
    W2->>P: send, same idempotency key
    Note over W2,P: a provider that honours the key drops the repeat, otherwise a duplicate:<br/>accepted instead of a lost notification
    P-->>W2: accepted
    W2->>DB: SENDING to SENT
    W2->>MQ: ack
```

If Worker 1 had **not** crashed and was only slow, Worker 2 keeps getting `busy`. Once Worker 1
records `SENT`, the next claim answers `done` and the duplicate message is acknowledged and dropped.

## 8. Status of a notification

```mermaid
stateDiagram-v2
    [*] --> PENDING: stored by the API
    PENDING --> SENDING: claim
    RETRYING --> SENDING: claim, the retry message came back
    SENDING --> SENDING: claim after the lease expired
    SENDING --> SENT: provider accepted
    SENDING --> RETRYING: retryable failure, attempts left
    SENDING --> FAILED: permanent failure or attempts used up
    SENT --> [*]
    FAILED --> [*]
```
