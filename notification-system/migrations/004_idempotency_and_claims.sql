-- Layer 1 (API): one row per Idempotency-Key a caller has used. Inserted in the same transaction
-- as the notification rows, so a key never exists without its notifications.
CREATE TABLE idempotency_keys (
  key           text PRIMARY KEY,
  -- Hash of the request body: the same key with a different body is a client bug (422).
  request_hash  text NOT NULL,
  request_id    uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX notifications_request_id_idx ON notifications (request_id);

-- Layer 2 (worker): a worker claims a row (PENDING -> SENDING) before sending. The claim is a
-- lease: if the worker dies, lease_expires_at passes and another worker may claim it again.
ALTER TABLE notifications
  ADD COLUMN attempts         int NOT NULL DEFAULT 0,
  ADD COLUMN lease_expires_at timestamptz,
  ADD CONSTRAINT notifications_status_check CHECK (status IN ('PENDING', 'SENDING', 'SENT', 'FAILED'));
