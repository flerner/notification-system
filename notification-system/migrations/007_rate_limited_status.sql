-- A notification skipped because the user already received their limit for that channel is
-- recorded, not silently dropped.
ALTER TABLE notifications DROP CONSTRAINT notifications_status_check;
ALTER TABLE notifications
  ADD CONSTRAINT notifications_status_check
  CHECK (status IN ('PENDING', 'SENDING', 'RETRYING', 'SENT', 'FAILED', 'SKIPPED_OPT_OUT', 'SKIPPED_RATE_LIMITED'));
