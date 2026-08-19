-- Caches each account's steamID64.
--
-- Without it a ban check is impossible without logging in: Steam's public ban API
-- (GetPlayerBans) is keyed by steamID64, and a Steam *login name* cannot be
-- resolved to one by any public endpoint. Storing it once turns every later check
-- into a free, login-free API call — which also makes it safe to check an account
-- while a customer is using it.
--
-- Apply with:
--   npx wrangler d1 execute fungaming-rentals --local  --file=./migrations/0007_account_steam_id.sql
--   npx wrangler d1 execute fungaming-rentals --remote --file=./migrations/0007_account_steam_id.sql
--
-- Run once per database. SQLite has no ADD COLUMN IF NOT EXISTS, so re-running
-- fails with "duplicate column name: steam_id" — that means it is already applied
-- and is safe to ignore.

ALTER TABLE steam_accounts ADD COLUMN steam_id TEXT;

-- Ban state as last observed, so the admin panel can show it without a Steam
-- round-trip and so a newly-appeared ban is distinguishable from one already known.
ALTER TABLE steam_accounts ADD COLUMN ban_state TEXT;
ALTER TABLE steam_accounts ADD COLUMN ban_checked_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_accounts_ban ON steam_accounts (ban_state, ban_checked_at);
