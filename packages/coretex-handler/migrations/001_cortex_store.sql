-- Cortex store schema — applied by scripts/apply-migrations.mjs
-- Idempotent: all statements use IF NOT EXISTS / ON CONFLICT.
-- Node >=22.5 node:sqlite required.
--
-- Tables:
--   outstanding_challenges   cross-lane challenge guard (SWCP + Cortex)
--   merge_bonus_funding      per-epoch merge-bonus funding receipts
--   multiplier_claims        multiplier-claim ledger

PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS outstanding_challenges (
  miner                 TEXT PRIMARY KEY,
  lane                  TEXT NOT NULL CHECK(lane IN ('swcp','cortex')),
  expires_at            INTEGER NOT NULL,
  shard_or_challenge_id TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_oc_expires_at
  ON outstanding_challenges(expires_at);

CREATE TABLE IF NOT EXISTS merge_bonus_funding (
  epoch_id         INTEGER NOT NULL,
  miner            TEXT    NOT NULL,
  bonus_amount_raw TEXT    NOT NULL,
  funded_at        INTEGER NOT NULL DEFAULT (unixepoch('now')),
  claimed          INTEGER NOT NULL DEFAULT 0,
  claimed_at       INTEGER,
  PRIMARY KEY (epoch_id, miner)
);

CREATE INDEX IF NOT EXISTS idx_mbf_miner_unclaimed
  ON merge_bonus_funding(miner, claimed);

CREATE TABLE IF NOT EXISTS multiplier_claims (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  miner          TEXT    NOT NULL,
  epoch_id       INTEGER NOT NULL,
  claim_tx_hash  TEXT,
  status         TEXT    NOT NULL DEFAULT 'pending'
                         CHECK(status IN ('pending','funded','claimed','failed')),
  created_at     INTEGER NOT NULL DEFAULT (unixepoch('now')),
  updated_at     INTEGER NOT NULL DEFAULT (unixepoch('now')),
  UNIQUE(miner, epoch_id)
);

CREATE INDEX IF NOT EXISTS idx_mc_miner
  ON multiplier_claims(miner);

-- Migration metadata table (tracks applied migrations for future incremental runs)
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT    NOT NULL,
  applied_at INTEGER NOT NULL DEFAULT (unixepoch('now'))
);

INSERT OR IGNORE INTO schema_migrations (version, name)
  VALUES (1, '001_cortex_store');
