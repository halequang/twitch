-- Renting several accounts in one payment.
--
-- Modelled as N sibling orders behind one payOS payment, NOT as one order holding
-- N accounts. orders.account_id is assumed to be a single account in seventeen
-- places across six files — the expiry sweep, extensions, buy-outs, credential
-- release, the admin panel, the notifier and two scripts. Making it a set would
-- mean changing all of them, and the failure mode of getting one wrong is an
-- account left 'rented' with nobody holding it, which this shop has already had to
-- clean up by hand.
--
-- So each order keeps exactly one account and every one of those paths is
-- untouched. Only checkout and fulfilment know about batches: the lead order
-- carries the payment link, the siblings point at it, and paying the lead fulfils
-- all of them.
--
-- batch_of is the lead's order_code, and NULL on the lead itself — so "a lead" is
-- `batch_of IS NULL`, which is every order that existed before this migration.
--
-- Apply with:
--   npx wrangler d1 execute fungaming-rentals --local  --file=./migrations/0011_order_batches.sql
--   npx wrangler d1 execute fungaming-rentals --remote --file=./migrations/0011_order_batches.sql

ALTER TABLE orders ADD COLUMN batch_of INTEGER;

-- Fulfilment asks "which orders belong to this lead"; the pending-checkout dedupe
-- asks "is there an unpaid lead for this user".
CREATE INDEX IF NOT EXISTS idx_orders_batch ON orders (batch_of);
