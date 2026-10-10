-- What happened when a worker tried to deliver the notification.
ALTER TABLE notifications
  ADD COLUMN sent_at    timestamptz,
  ADD COLUMN last_error text;
