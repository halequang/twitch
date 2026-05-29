-- Migration: split `updated_at` into `created_at` + `last_refresh_time`.
--
-- Run once per environment:
--   wrangler d1 execute twitch-mail --file=./migrations/2026-05-add-timestamps.sql           # remote
--   wrangler d1 execute twitch-mail --local --file=./migrations/2026-05-add-timestamps.sql   # local
--
-- New columns are added nullable (D1/SQLite requires that for ADD COLUMN on
-- a non-empty table), then backfilled from the legacy `updated_at` so that
-- age-based filters work on day one. Fresh installs via schema.sql get the
-- NOT NULL constraint.

ALTER TABLE accounts ADD COLUMN created_at        INTEGER;
ALTER TABLE accounts ADD COLUMN last_refresh_time INTEGER;

UPDATE accounts SET created_at        = updated_at WHERE created_at        IS NULL;
UPDATE accounts SET last_refresh_time = updated_at WHERE last_refresh_time IS NULL;

ALTER TABLE accounts DROP COLUMN updated_at;
