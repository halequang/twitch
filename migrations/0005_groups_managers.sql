-- Account groups + scoped managers.
--
-- A group owns Steam accounts ("Kho A", a supplier, a batch). A manager is
-- assigned one or more groups and may only see and touch accounts in them.
--
-- The shop OWNER is still whoever is listed in the ADMIN_EMAILS var, not a row
-- here. That is deliberate: if the owner lived in this table, deleting the wrong
-- row would lock everyone out of the panel with no way back in. The env var is
-- the recovery path.
--
-- Accounts with group_id NULL are "ungrouped" and visible to the owner only, so
-- existing stock does not silently become readable by the first manager added.
--
-- Apply with:
--   npx wrangler d1 execute fungaming-rentals --local  --file=./migrations/0005_groups_managers.sql
--   npx wrangler d1 execute fungaming-rentals --remote --file=./migrations/0005_groups_managers.sql

CREATE TABLE IF NOT EXISTS account_groups (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  note       TEXT,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_groups_name ON account_groups (name);

-- Managers are matched on identity: a lowercased email, or "provider:sub" for
-- accounts with no usable email (Apple private relay).
CREATE TABLE IF NOT EXISTS managers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  identity   TEXT    NOT NULL,
  label      TEXT,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_managers_identity ON managers (identity);

CREATE TABLE IF NOT EXISTS manager_groups (
  manager_id INTEGER NOT NULL REFERENCES managers (id) ON DELETE CASCADE,
  group_id   INTEGER NOT NULL REFERENCES account_groups (id) ON DELETE CASCADE,
  PRIMARY KEY (manager_id, group_id)
);

ALTER TABLE steam_accounts ADD COLUMN group_id INTEGER REFERENCES account_groups (id);

CREATE INDEX IF NOT EXISTS idx_accounts_group ON steam_accounts (group_id, status);
