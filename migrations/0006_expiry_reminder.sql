-- Tracks that a renter has been emailed that their rental is about to end.
--
-- Deliberately NOT notified_at: that column records the shop owner being told a
-- rental already ended. One marker for two different messages would mean sending
-- either one silences the other.
--
-- NULL means "not yet reminded". The reminder script is built to run on a
-- schedule, so without a marker every run would email the same people again.
--
-- Apply with:
--   npx wrangler d1 execute fungaming-rentals --local  --file=./migrations/0006_expiry_reminder.sql
--   npx wrangler d1 execute fungaming-rentals --remote --file=./migrations/0006_expiry_reminder.sql
--
-- Run once per database. SQLite has no ADD COLUMN IF NOT EXISTS, so re-running
-- fails with "duplicate column name: reminder_sent_at" — that means it is
-- already applied and is safe to ignore.

ALTER TABLE orders ADD COLUMN reminder_sent_at INTEGER;

-- Backfill everything that is not a live rental with a future expiry, so
-- switching this on cannot email people about rentals that are already over.
UPDATE orders SET reminder_sent_at = COALESCE(expires_at, created_at)
 WHERE reminder_sent_at IS NULL
   AND (status <> 'active' OR expires_at IS NULL OR expires_at <= strftime('%s', 'now'));

CREATE INDEX IF NOT EXISTS idx_orders_reminder
  ON orders (status, reminder_sent_at, expires_at);
