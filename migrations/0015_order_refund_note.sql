-- Refunded orders, and a note to say why.
--
-- 'refunded' is a real end state, not a flavour of 'cancelled': the money moved and
-- then moved back. It matters that the two are distinguishable — a cancelled order
-- was never paid, whereas a refunded one was, and telling them apart is the
-- difference between "this customer never bought" and "this customer bought and we
-- gave it back".
--
-- Two consequences, both enforced in code rather than here:
--   · the account is RELEASED, exactly as ending any order does. The customer is
--     not renting it any more, so it goes back to the pool — unless something else
--     is still live on that login (a second-game rental), which the release guard
--     already checks.
--   · it does NOT count towards revenue. Every revenue sum keys on `paid_at IS NOT
--     NULL`, and a refunded order keeps its paid_at — that is a fact about what
--     happened — so the sums exclude the status explicitly instead of clearing the
--     timestamp and losing the history.
--
-- orders.note is the shop's own note on an order: why it was refunded, what was
-- agreed, which conversation it came from. Admin-facing only, like
-- steam_accounts.internal_note — it is never sent to the customer, who has no field
-- of their own here.
--
-- Apply with:
--   npx wrangler d1 execute fungaming-rentals --local  --file=./migrations/0015_order_refund_note.sql
--   npx wrangler d1 execute fungaming-rentals --remote --file=./migrations/0015_order_refund_note.sql

ALTER TABLE orders ADD COLUMN note TEXT;

-- Refund reporting asks "which paid orders came back", so the status is worth an
-- index alongside paid_at rather than a scan per summary.
CREATE INDEX IF NOT EXISTS idx_orders_paid_status ON orders (paid_at, status);
