-- Notification templates (book: consistent format, fewer mistakes). One per name and channel, so
-- "order-shipped" can read differently as an email, an SMS and a push.
CREATE TABLE templates (
  name        text NOT NULL,
  channel     text NOT NULL CHECK (channel IN ('push', 'sms', 'email')),
  subject     text,
  body        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (name, channel)
);

-- Notification settings (book): has the user opted in to this channel? No row means opted in.
CREATE TABLE notification_settings (
  user_id     bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel     text NOT NULL CHECK (channel IN ('push', 'sms', 'email')),
  opt_in      boolean NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, channel)
);

-- A notification skipped because the user opted out is recorded, not silently dropped.
ALTER TABLE notifications DROP CONSTRAINT notifications_status_check;
ALTER TABLE notifications
  ADD CONSTRAINT notifications_status_check
  CHECK (status IN ('PENDING', 'SENDING', 'RETRYING', 'SENT', 'FAILED', 'SKIPPED_OPT_OUT'));
