-- Users table: stores player Bluesky DID -> encrypted Letta credentials
CREATE TABLE IF NOT EXISTS users (
  did TEXT PRIMARY KEY,
  handle TEXT NOT NULL,
  letta_base_url TEXT NOT NULL,
  letta_key_enc_b64 TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Deduplication table: prevents processing same post twice
CREATE TABLE IF NOT EXISTS processed_posts (
  uri TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

-- Optional: track DM turns for analytics
CREATE TABLE IF NOT EXISTS dm_turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger_uri TEXT NOT NULL,
  player_did TEXT NOT NULL,
  player_handle TEXT NOT NULL,
  state_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Index for faster lookups
CREATE INDEX IF NOT EXISTS idx_users_handle ON users(handle);
CREATE INDEX IF NOT EXISTS idx_dm_turns_player ON dm_turns(player_did);
