-- Adds the mail box that backs each Steam account, plus a private note field.
--
-- These columns are deliberately NOT part of what a renter can ever read:
--   * email / email_password_enc give permanent control of the account (a renter
--     holding them could change the Steam password and keep it), so they exist
--     for shop administration only.
--   * internal_note holds our own bookkeeping ("day 2", "1 tuan", "mua"), which
--     is not customer-facing text. The renter-visible message stays in `note`.
--
-- Apply with:
--   npx wrangler d1 execute fungaming-rentals --local  --file=./migrations/0002_account_email.sql
--   npx wrangler d1 execute fungaming-rentals --remote --file=./migrations/0002_account_email.sql
--
-- Run once per database. SQLite has no ADD COLUMN IF NOT EXISTS, so re-running
-- this fails with "duplicate column name: email" — that error means it is
-- already applied and is safe to ignore.

ALTER TABLE steam_accounts ADD COLUMN email TEXT;
ALTER TABLE steam_accounts ADD COLUMN email_password_enc TEXT;
ALTER TABLE steam_accounts ADD COLUMN internal_note TEXT;
