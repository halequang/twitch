-- "Please rent this game too" — customer demand for games the shop does not carry.
--
-- A table rather than a Telegram ping, for the same reason account_reports is one:
-- a chat message nobody happened to read is lost, whereas a row can be counted. And
-- counting is the whole point — the useful question is not "who asked for something"
-- but "which game do most customers want next", which needs the asks to survive and
-- to be deduplicated.
--
-- game_key is the counting key: game_name as typed, lower-cased with everything but
-- letters and digits removed, so "PoE 2", "poe2" and "Poe-2" are one game rather
-- than three. Both are stored — the raw text is what a human reads, the key is what
-- SQL groups by.
--
-- One row per (customer, game): the unique index makes a second submission an
-- update, so the tally is a count of people who want a game and not a count of how
-- often the keenest one pressed the button.
--
-- Apply with:
--   npx wrangler d1 execute fungaming-rentals --local  --file=./migrations/0017_game_requests.sql
--   npx wrangler d1 execute fungaming-rentals --remote --file=./migrations/0017_game_requests.sql

CREATE TABLE IF NOT EXISTS game_requests (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  -- provider:sub, the same identity orders are attributed by.
  user_key     TEXT    NOT NULL,
  user_email   TEXT,
  game_name    TEXT    NOT NULL,
  game_key     TEXT    NOT NULL,
  note         TEXT,
  -- open → planned → added, or declined. Set by the shop, shown back to the
  -- customer so an ask does not disappear into nothing.
  status       TEXT    NOT NULL DEFAULT 'open',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  -- What the shop replied, if anything. Shown to everyone who asked for that game.
  reply        TEXT,
  replied_at   INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_game_requests_one_per_user
  ON game_requests (user_key, game_key);

-- The tally: "which game, how many people, what state".
CREATE INDEX IF NOT EXISTS idx_game_requests_tally ON game_requests (game_key, status);
