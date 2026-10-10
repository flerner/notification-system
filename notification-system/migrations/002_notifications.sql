-- The notification log (book Fig. 10-11): every notification is persisted BEFORE it is queued,
-- so a crash or a broker outage can never lose one. One row per destination: a push to a user
-- with two devices is two rows, each retried and tracked on its own.
CREATE TABLE notifications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Groups the rows created by one API call (the fan-out of a single request).
  request_id    uuid NOT NULL,
  user_id       bigint NOT NULL REFERENCES users(id),
  channel       text NOT NULL CHECK (channel IN ('push', 'sms', 'email')),
  platform      text CHECK (platform IN ('ios', 'android', 'web')),
  -- Copied from the user's contacts at send time, so what we send does not change under us.
  destination   text NOT NULL,
  -- RabbitMQ queue this row is routed to (one queue per channel/platform).
  queue         text NOT NULL,
  payload       jsonb NOT NULL,
  status        text NOT NULL DEFAULT 'PENDING',
  -- NULL until RabbitMQ has confirmed the message. Rows stuck at NULL are re-published by the
  -- relay: this table is its own outbox.
  published_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notifications_push_has_platform CHECK ((channel = 'push') = (platform IS NOT NULL))
);

-- Tiny index: only the rows the relay cares about.
CREATE INDEX notifications_unpublished_idx ON notifications (created_at) WHERE published_at IS NULL;
