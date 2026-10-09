-- Contact info (book Fig. 10-8): email/phone on the user, device tokens in their own table
-- because one user can have many devices.
CREATE TABLE users (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email       text UNIQUE,
  phone       text UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- A user nobody can reach is useless to a notification system.
  CONSTRAINT users_has_contact CHECK (email IS NOT NULL OR phone IS NOT NULL)
);

CREATE TABLE devices (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform    text NOT NULL CHECK (platform IN ('ios', 'android', 'web')),
  -- APNS/FCM tokens identify one app install, so they are globally unique. Making the
  -- token the unique key is what lets "register device" be an idempotent upsert.
  token       text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX devices_user_id_idx ON devices (user_id);
