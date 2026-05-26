CREATE TABLE IF NOT EXISTS accounts (
  email         TEXT PRIMARY KEY,
  password      TEXT,
  refresh_token TEXT NOT NULL,
  client_id     TEXT NOT NULL,
  updated_at    INTEGER NOT NULL
);
