CREATE TABLE IF NOT EXISTS accounts (
  email             TEXT PRIMARY KEY,
  password          TEXT,
  refresh_token     TEXT NOT NULL,
  client_id         TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  last_refresh_time INTEGER NOT NULL
);
