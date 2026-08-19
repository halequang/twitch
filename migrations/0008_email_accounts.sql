-- Email + password sign-up, alongside the existing Google/Apple sign-in.
--
-- Until now there were no user rows at all: an OIDC id token was verified and the
-- signed cookie WAS the session. Email sign-up needs somewhere to keep a password,
-- so these are the first users the shop actually stores.
--
-- Apply with:
--   npx wrangler d1 execute fungaming-rentals --local  --file=./migrations/0008_email_accounts.sql
--   npx wrangler d1 execute fungaming-rentals --remote --file=./migrations/0008_email_accounts.sql

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  -- As typed, for display and for addressing mail.
  email         TEXT    NOT NULL,
  -- Lower-cased for lookup: addresses are matched case-insensitively, so
  -- "Ha@x.com" must not be able to register a second account over "ha@x.com".
  email_lower   TEXT    NOT NULL,
  -- pbkdf2$sha256$<iterations>$<salt>$<hash>, all base64url. The iteration count
  -- travels with the hash so it can be raised later without stranding old rows.
  password_hash TEXT    NOT NULL,
  name          TEXT,
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users (email_lower);

-- One in-flight verification per address. A fresh request overwrites the previous
-- row, so the table cannot grow with abandoned sign-ups and an old code stops
-- working the moment a new one is sent.
CREATE TABLE IF NOT EXISTS email_codes (
  email_lower TEXT    PRIMARY KEY,
  email       TEXT    NOT NULL,
  -- SHA-256 of the code. The code itself is never stored: a database dump must
  -- not let anyone finish someone else's sign-up.
  code_hash   TEXT    NOT NULL,
  purpose     TEXT    NOT NULL DEFAULT 'register',
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  -- Drives the resend cooldown, so the endpoint cannot be used to flood an inbox.
  sent_at     INTEGER NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_email_codes_expiry ON email_codes (expires_at);
