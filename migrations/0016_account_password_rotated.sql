-- When each account's Steam password was last rotated.
--
-- scripts/steam_change_password.py already recorded rotations in its own result
-- file, but that file lives next to whichever copy of the script ran — one on the
-- Mac, one on the server — so neither knows what the other did. The consequence was
-- real: an account rotated on the server in the morning could be rotated again from
-- the laptop that afternoon, and each rotation costs a Steam Guard email and
-- invalidates the password the previous run recorded.
--
-- The database is the one thing both copies share, so the timestamp belongs here.
-- It is also what makes "not twice in one day" enforceable rather than advisory.
--
-- Epoch seconds, to match every other timestamp in this schema.
--
-- Apply with:
--   npx wrangler d1 execute fungaming-rentals --local  --file=./migrations/0016_account_password_rotated.sql
--   npx wrangler d1 execute fungaming-rentals --remote --file=./migrations/0016_account_password_rotated.sql

ALTER TABLE steam_accounts ADD COLUMN password_changed_at INTEGER;

-- The rotation sweep asks "which of these was already done today", so the column is
-- read for every candidate on every run.
CREATE INDEX IF NOT EXISTS idx_accounts_rotated ON steam_accounts (password_changed_at);
