-- Every attempt scripts/steam_change_password.py makes at an account, kept.
--
-- The script already wrote one line per account to scripts/rental_rotate_results.txt,
-- but that file lives next to whichever copy of the script ran — one on the Mac, one
-- on the server — so neither machine can see the other's history, and neither is
-- visible from the admin panel at all. The database is the one thing they share, and
-- it is what the panel reads, so the log belongs here.
--
-- Every OUTCOME, not just the successes: a SKIPPED row is the answer to "why has this
-- account not been rotated", a LOGIN_FAILED row is the first sign of an account going
-- bad, and both are invisible if only the wins are recorded.
--
-- NO PASSWORDS. The result file carries the old and new password in plaintext because
-- it is the operator's own recovery copy of a rotation that may have half-failed; this
-- table is read by the panel over the network, and the live password already has a
-- home in steam_accounts.password_enc. What is worth keeping here is what happened.
--
-- account_id is ON DELETE SET NULL, and login is stored beside it rather than only
-- joined: deleting an account must not erase the record that its password was once
-- changed, and the log has to still say which login that was.
--
-- Apply with:
--   npx wrangler d1 execute fungaming-rentals --local  --file=./migrations/0018_password_rotation_log.sql
--   npx wrangler d1 execute fungaming-rentals --remote --file=./migrations/0018_password_rotation_log.sql

CREATE TABLE IF NOT EXISTS password_rotations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER REFERENCES steam_accounts (id) ON DELETE SET NULL,
  -- The login as it was at the time, kept even if the account row goes away.
  login      TEXT    NOT NULL,
  -- 'password' or 'email' — the script's two modes. An email change is a different
  -- event with the same shape, and splitting the table would double every query.
  mode       TEXT    NOT NULL DEFAULT 'password',
  -- OK, OK_STILL_RENTED, SKIPPED_TOO_RECENT, LOGIN_FAILED, CODE_REJECTED, ERROR, …
  -- Free text on purpose: the script grows new outcomes, and a CHECK constraint that
  -- has to be migrated before a new one can be logged would just stop the logging.
  status     TEXT    NOT NULL,
  -- The human sentence behind the status: which skip rule fired, what Steam said.
  detail     TEXT,
  -- Which machine ran it, so two copies of the script can be told apart.
  host       TEXT,
  created_at INTEGER NOT NULL
);

-- The panel asks for the newest rows, and for one account's history.
CREATE INDEX IF NOT EXISTS idx_rotations_time ON password_rotations (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rotations_account ON password_rotations (account_id, created_at DESC);
