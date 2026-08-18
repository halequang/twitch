-- Tracks that the shop owner has been told a rental ended.
--
-- Needed because the notifier runs on a cron: without a marker every run would
-- re-announce the same expiry. NULL means "not yet announced".
--
-- Apply with:
--   npx wrangler d1 execute fungaming-rentals --local  --file=./migrations/0004_expiry_notice.sql
--   npx wrangler d1 execute fungaming-rentals --remote --file=./migrations/0004_expiry_notice.sql
--
-- Run once per database. SQLite has no ADD COLUMN IF NOT EXISTS, so re-running
-- fails with "duplicate column name: notified_at" — that means it is already
-- applied and is safe to ignore.

ALTER TABLE orders ADD COLUMN notified_at INTEGER;

-- Backfill rentals that ended BEFORE this feature existed, so switching it on
-- does not fire a burst of notifications about ancient history.
UPDATE orders SET notified_at = COALESCE(expires_at, created_at)
 WHERE status = 'expired' AND notified_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_orders_unnotified
  ON orders (status, notified_at);
