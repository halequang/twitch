-- One Steam account, several games.
--
-- A Steam account owns a library, not a single title, so the same login can serve
-- the The Isle pool and the PoE 2 pool. Until now `steam_accounts.game` was the
-- whole truth and every allocation query filtered on it, which meant one account
-- row per game and no way to say "this login owns both".
--
-- WHAT DOES NOT CHANGE: renting means handing over the login, so an account is only
-- ever out with ONE customer at a time however many games it owns. Membership here
-- decides which pools an account is ELIGIBLE for; claiming it for one game sets its
-- status to 'rented', which removes it from every other pool at the same moment.
-- The one case where two games genuinely coexist is the person already holding the
-- account renting a second game on it — see orders.addon_of below.
--
-- steam_accounts.game is kept as the account's home game: it is half of
-- idx_accounts_login (game, login), the unique index that stops the same login being
-- imported twice, and it is what the admin list shows. Membership is additive on top.
--
-- Apply with:
--   npx wrangler d1 execute fungaming-rentals --local  --file=./migrations/0014_account_games.sql
--   npx wrangler d1 execute fungaming-rentals --remote --file=./migrations/0014_account_games.sql

CREATE TABLE IF NOT EXISTS steam_account_games (
  account_id INTEGER NOT NULL REFERENCES steam_accounts (id) ON DELETE CASCADE,
  game       TEXT    NOT NULL,
  PRIMARY KEY (account_id, game)
);

-- "Which accounts are in this game's pool" is the question every allocation asks.
CREATE INDEX IF NOT EXISTS idx_account_games_game ON steam_account_games (game, account_id);

-- Every existing account keeps exactly the game it already had, so nothing changes
-- behaviour until an account is tagged with a second one.
INSERT OR IGNORE INTO steam_account_games (account_id, game)
SELECT id, game FROM steam_accounts WHERE game IS NOT NULL;

-- Renting a second game on a login the customer already holds. The child order
-- names its own game, plan and expiry, and points at the order whose account it
-- borrows — so it claims nothing from the pool, and each game's rental runs out on
-- its own schedule.
--
-- Distinct from extends_order (adds hours to the same rental) and upgrades_order
-- (replaces the plan on the same rental): this one adds a DIFFERENT game alongside.
ALTER TABLE orders ADD COLUMN addon_of INTEGER REFERENCES orders (order_code);

CREATE INDEX IF NOT EXISTS idx_orders_addon ON orders (addon_of);
