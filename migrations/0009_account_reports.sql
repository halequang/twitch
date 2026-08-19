-- Problem reports raised by renters about the account they are holding.
--
-- The reason this exists as a table rather than a Telegram message: "someone else
-- logged into my account" is the one report that means the previous renter still
-- knows the password, and that needs to survive being missed. A chat notification
-- that nobody reads is gone; a row stays until somebody resolves it.
--
-- account_id is copied in rather than read through the order every time, so group
-- scoping works with one join and a report still points at the right login after
-- the rental ends.
--
-- Apply with:
--   npx wrangler d1 execute fungaming-rentals --local  --file=./migrations/0009_account_reports.sql
--   npx wrangler d1 execute fungaming-rentals --remote --file=./migrations/0009_account_reports.sql

CREATE TABLE IF NOT EXISTS account_reports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  order_code  INTEGER NOT NULL REFERENCES orders (order_code),
  account_id  INTEGER REFERENCES steam_accounts (id),
  -- "<provider>:<sub>" from the session, so a report is attributable even when
  -- the provider gave us no email (Apple private relay).
  user_key    TEXT    NOT NULL,
  user_email  TEXT,
  -- intruder | cannot_login | banned | guard_code | wrong_password | other
  -- Free text on purpose: adding a reason must not need a migration, and the
  -- renter-facing labels live in src/lib/reports.js.
  reason      TEXT    NOT NULL,
  message     TEXT,
  -- open | resolved
  status      TEXT    NOT NULL DEFAULT 'open',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  resolved_at INTEGER,
  resolved_by TEXT,
  resolution  TEXT
);

CREATE INDEX IF NOT EXISTS idx_reports_open ON account_reports (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_account ON account_reports (account_id, status);

-- One open report per order: a renter hitting the button twice must update their
-- existing report, not queue a second one for the owner to read.
CREATE UNIQUE INDEX IF NOT EXISTS idx_reports_one_open
  ON account_reports (order_code) WHERE status = 'open';
