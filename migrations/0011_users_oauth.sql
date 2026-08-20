-- Records Google / Apple sign-ins in the same `users` table as email+password
-- accounts, rather than a second one.
--
-- One table keyed on email means a customer who signs in with Google and later sets
-- a password is one row, not two people. That matters for orders: user_email is how
-- a rental is attributed, so splitting identities would split their history.
--
-- password_hash stays NOT NULL. An OAuth row stores the sentinel 'oauth-only'
-- instead, which is safe by construction rather than by convention:
-- verifyPassword() requires exactly `pbkdf2$sha256$<iter>$<salt>$<hash>` — five
-- $-separated parts with those literal prefixes — and rejects anything else before
-- doing any comparison. A value containing no '$' can never authenticate. This
-- avoids rebuilding a live table to relax the constraint.
--
-- Apply with:
--   npx wrangler d1 execute fungaming-rentals --local  --file=./migrations/0011_users_oauth.sql
--   npx wrangler d1 execute fungaming-rentals --remote --file=./migrations/0011_users_oauth.sql

-- Which provider was last used, and its stable subject id. Kept for support
-- ("which button did this customer press?") and so an account can be traced back to
-- an identity that is not the email, since Google lets people change theirs.
ALTER TABLE users ADD COLUMN provider TEXT;
ALTER TABLE users ADD COLUMN provider_sub TEXT;
ALTER TABLE users ADD COLUMN picture TEXT;
ALTER TABLE users ADD COLUMN login_count INTEGER NOT NULL DEFAULT 0;

-- Existing rows all arrived through email+password.
UPDATE users SET provider = 'email' WHERE provider IS NULL;

-- Rows already here have logged in at least once; leaving the count at 0 would read
-- as "never used" for every existing customer.
UPDATE users SET login_count = 1 WHERE login_count = 0 AND last_login_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_users_provider ON users (provider, provider_sub);
