-- Steam account rentals (The Isle) — inventory + orders.
--
-- Apply with:
--   npx wrangler d1 execute fungaming-rentals --local  --file=./migrations/0001_rentals.sql
--   npx wrangler d1 execute fungaming-rentals --remote --file=./migrations/0001_rentals.sql

-- The rentable Steam accounts. Passwords are stored encrypted (AES-GCM) using
-- ACCOUNT_ENC_KEY, so a database dump alone does not leak Steam credentials.
CREATE TABLE IF NOT EXISTS steam_accounts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  game         TEXT    NOT NULL DEFAULT 'the-isle',
  login        TEXT    NOT NULL,
  password_enc TEXT    NOT NULL,
  note         TEXT,
  -- available | rented | disabled
  status       TEXT    NOT NULL DEFAULT 'available',
  created_at   INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_login ON steam_accounts (game, login);
CREATE INDEX IF NOT EXISTS idx_accounts_pool ON steam_accounts (game, status, id);

-- One row per checkout attempt. order_code is the PayOS orderCode (integer).
CREATE TABLE IF NOT EXISTS orders (
  order_code      INTEGER PRIMARY KEY,
  -- "<provider>:<sub>" from the session cookie — the same person across visits.
  user_key        TEXT    NOT NULL,
  user_email      TEXT,
  game            TEXT    NOT NULL,
  plan_id         TEXT    NOT NULL,
  hours           INTEGER NOT NULL,
  amount          INTEGER NOT NULL,
  -- pending | active | expired | cancelled | awaiting_stock
  status          TEXT    NOT NULL DEFAULT 'pending',
  payment_link_id TEXT,
  checkout_url    TEXT,
  account_id      INTEGER REFERENCES steam_accounts (id),
  created_at      INTEGER NOT NULL,
  paid_at         INTEGER,
  expires_at      INTEGER
);

CREATE INDEX IF NOT EXISTS idx_orders_user ON orders (user_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders (status, expires_at);
