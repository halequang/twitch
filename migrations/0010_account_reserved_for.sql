-- Holds an account aside for one customer.
--
-- When they rent again they get that same login back instead of whatever happens
-- to be free, and nobody else is ever given it — a reserved account is excluded
-- from other customers' allocations even while its status is 'available'.
--
-- Matched on the customer's email address, because that is what an admin knows and
-- what orders already record. A consequence worth knowing: Apple sign-in allows a
-- null email, so a customer who signed in that way cannot be reserved for.
--
-- Deliberately survives the rental ending. The reservation is the point: the
-- account returns to 'available' as usual, still earmarked for that person.
--
-- Apply with:
--   npx wrangler d1 execute fungaming-rentals --local  --file=./migrations/0010_account_reserved_for.sql
--   npx wrangler d1 execute fungaming-rentals --remote --file=./migrations/0010_account_reserved_for.sql
--
-- Run once per database. SQLite has no ADD COLUMN IF NOT EXISTS, so re-running
-- fails with "duplicate column name: reserved_for" — that means it is already
-- applied and is safe to ignore.

ALTER TABLE steam_accounts ADD COLUMN reserved_for TEXT;

-- Allocation asks two questions of this column on every checkout: "is one reserved
-- for this customer?" and "which are reserved for nobody?".
CREATE INDEX IF NOT EXISTS idx_accounts_reserved
  ON steam_accounts (game, status, reserved_for);
