-- Clients: the services allowed to call the API (Book: Ch. 10, "Security in push notifications"). The secret itself is
-- never stored, only its hash.
CREATE TABLE clients (
  app_key      text PRIMARY KEY,
  name         text NOT NULL,
  secret_hash  text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- A revoked client is refused at once, but its history stays.
  revoked_at   timestamptz
);

-- Who asked for each notification. Rows from before authentication belong to 'anonymous'.
ALTER TABLE notifications ADD COLUMN client_id text NOT NULL DEFAULT 'anonymous';
ALTER TABLE notifications ALTER COLUMN client_id DROP DEFAULT;

-- An Idempotency-Key now belongs to the client that sent it: two clients may use the same key, and
-- one can never replay (and so read) the other's request.
ALTER TABLE idempotency_keys ADD COLUMN client_id text NOT NULL DEFAULT 'anonymous';
ALTER TABLE idempotency_keys ALTER COLUMN client_id DROP DEFAULT;
ALTER TABLE idempotency_keys DROP CONSTRAINT idempotency_keys_pkey;
ALTER TABLE idempotency_keys ADD PRIMARY KEY (client_id, key);
