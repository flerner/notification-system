-- The earliest moment a notification may be sent. For an ordinary notification it is the moment it
-- was stored (both default to the transaction's now(), so they are equal). A scheduled one has a
-- later send_at, and is not published to the queue until that time has come.
ALTER TABLE notifications ADD COLUMN send_at timestamptz NOT NULL DEFAULT now();

-- The relay looks for unpublished notifications that are due, oldest first.
DROP INDEX notifications_unpublished_idx;
CREATE INDEX notifications_unpublished_idx ON notifications (send_at) WHERE published_at IS NULL;
