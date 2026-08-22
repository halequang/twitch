-- Lets a customer move a rental they already hold onto a higher plan: 1 ngày to
-- either week, and the plain week to the VOIP week.
--
-- Modelled like an extension — its own order row, so every payment stays one row
-- for accounting — but fulfilment does something different: instead of adding
-- hours to the parent, the child BECOMES the rental (carrying the new plan_id) and
-- the parent closes as 'upgraded'. The plan has to move with the row because
-- plan_id is what the page, the perks box and the admin panel all read; leaving it
-- on the parent would show a customer paying for VOIP a rental still labelled
-- "1 ngày".
--
-- Why a second column rather than reusing extends_order: an upgrade points at its
-- parent through BOTH. extends_order keeps every guard already written for
-- extensions working (the parent lookup, the ownership check, the one-unpaid-
-- checkout slot), and upgrades_order is what tells fulfilment to replace the plan
-- rather than top up the hours. Distinguishing them by plan or amount is not
-- possible: extending a 1-day rental by a week is a legitimate extension whose
-- plan differs from its parent's, so the two would be indistinguishable.
--
-- Apply with:
--   npx wrangler d1 execute fungaming-rentals --local  --file=./migrations/0013_order_upgrade.sql
--   npx wrangler d1 execute fungaming-rentals --remote --file=./migrations/0013_order_upgrade.sql
--
-- Run once per database. SQLite has no ADD COLUMN IF NOT EXISTS, so re-running
-- fails with "duplicate column name: upgrades_order" — that means it is already
-- applied and is safe to ignore.

ALTER TABLE orders ADD COLUMN upgrades_order INTEGER REFERENCES orders (order_code);

-- Fulfilment asks "is this row an upgrade"; the pending-checkout dedupe asks "is
-- there already an unpaid upgrade for this rental", which is what keeps a 30k
-- upgrade link from being handed back for an 80k extension of the same rental.
CREATE INDEX IF NOT EXISTS idx_orders_upgrades ON orders (upgrades_order);
