-- Audit trail for Steam Guard codes handed to renters, and the basis for rate
-- limiting them.
--
-- Whoever can read an account's mailbox can take the account over, so handing codes
-- out needs a record of who asked and when. If an account is later stolen, this is
-- the only way to tell whether a code was served and to whom.
--
-- Every attempt is recorded, including refused ones: a renter repeatedly hitting a
-- refusal is exactly the pattern worth seeing.
--
-- Apply with:
--   npx wrangler d1 execute fungaming-rentals --local  --file=./migrations/0012_steam_code_requests.sql
--   npx wrangler d1 execute fungaming-rentals --remote --file=./migrations/0012_steam_code_requests.sql

CREATE TABLE IF NOT EXISTS steam_code_requests (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  order_code  INTEGER NOT NULL,
  account_id  INTEGER REFERENCES steam_accounts (id),
  user_key    TEXT    NOT NULL,
  user_email  TEXT,
  -- served | no_code | refused_purpose | rate_limited | unreadable_mailbox | error
  -- refused_purpose is the important one: a code was present but its email said it
  -- changes login credentials, so it was withheld.
  outcome     TEXT    NOT NULL,
  -- The code itself is NOT stored. It is short-lived and single-use, and keeping it
  -- would turn this audit table into a way to take the account over.
  requested_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_code_requests_order
  ON steam_code_requests (order_code, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_code_requests_recent
  ON steam_code_requests (requested_at DESC);
