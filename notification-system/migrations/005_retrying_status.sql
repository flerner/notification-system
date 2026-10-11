-- A notification whose delivery failed with a retryable error waits as RETRYING until its retry
-- message comes back from the broker and a worker claims it again.
ALTER TABLE notifications DROP CONSTRAINT notifications_status_check;
ALTER TABLE notifications
  ADD CONSTRAINT notifications_status_check
  CHECK (status IN ('PENDING', 'SENDING', 'RETRYING', 'SENT', 'FAILED'));
