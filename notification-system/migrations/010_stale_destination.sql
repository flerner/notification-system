-- A device token can move to another user (the same phone logs in to a different account). A
-- notification already stored for the old owner is then skipped instead of being sent to the new one.
ALTER TABLE notifications DROP CONSTRAINT notifications_status_check;
ALTER TABLE notifications
  ADD CONSTRAINT notifications_status_check
  CHECK (status IN ('PENDING', 'SENDING', 'RETRYING', 'SENT', 'FAILED', 'SKIPPED_OPT_OUT', 'SKIPPED_RATE_LIMITED', 'SKIPPED_STALE_DESTINATION'));

-- Finds the waiting notifications of a push token without scanning the whole table.
CREATE INDEX notifications_waiting_push_destination_idx ON notifications (destination)
  WHERE channel = 'push' AND status IN ('PENDING', 'RETRYING');
