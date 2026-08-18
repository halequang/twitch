-- Lets a customer pay to add time to a rental they already hold.
--
-- An extension is its own order row (so every payment stays one row for
-- accounting) that points at the rental it tops up. Fulfilling it adds hours to
-- the parent's expires_at instead of claiming another account from the pool.
--
-- Apply with:
--   npx wrangler d1 execute fungaming-rentals --local  --file=./migrations/0003_extend_rental.sql
--   npx wrangler d1 execute fungaming-rentals --remote --file=./migrations/0003_extend_rental.sql
--
-- Run once per database. SQLite has no ADD COLUMN IF NOT EXISTS, so re-running
-- fails with "duplicate column name: extends_order" — that means it is already
-- applied and is safe to ignore.

ALTER TABLE orders ADD COLUMN extends_order INTEGER REFERENCES orders (order_code);

CREATE INDEX IF NOT EXISTS idx_orders_extends ON orders (extends_order);
