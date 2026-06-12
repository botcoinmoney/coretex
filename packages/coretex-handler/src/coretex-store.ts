/**
 * coretex-store.ts — cross-lane bookkeeping on the SWCP coordinator side.
 *
 * Tracks:
 *   1. Outstanding-challenge state across lanes (SWCP + Cortex).
 *   2. Per-epoch merge-bonus funding receipts.
 *   3. Multiplier-claim ledger.
 *
 * Uses the SWCP coordinator's existing SQLite (or a separate file at
 * CORTEX_STORE_DB_PATH). The schema is applied idempotently via
 * migrations/001_cortex_store.sql (run by scripts/apply-migrations.mjs).
 *
 * §13.4 plug-and-play guarantee: this file is imported only by coretex-handler.
 * No changes to existing SWCP routes are required.
 */

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_STORE_PATH = 'data/coordinator/coretex-store.db';

export type ChallengeOutstandingLane = 'swcp' | 'cortex';

export interface OutstandingChallengeRecord {
  miner: string;
  lane: ChallengeOutstandingLane;
  expiresAt: number;
  shardOrChallengeId: string;
}

export interface MergeBonusFundingRecord {
  epochId: number;
  miner: string;
  bonusAmountRaw: string; // uint256 as decimal string
  fundedAt: number;
  claimed: boolean;
  claimedAt: number | null;
}

export interface MultiplierClaimRecord {
  id: number;
  miner: string;
  epochId: number;
  claimTxHash: string | null;
  status: 'pending' | 'funded' | 'claimed' | 'failed';
  createdAt: number;
  updatedAt: number;
}

export interface CortexStore {
  // Outstanding challenge (cross-lane)
  getOutstanding(miner: string): OutstandingChallengeRecord | undefined;
  setOutstanding(miner: string, lane: ChallengeOutstandingLane, expiresAt: number, shardOrChallengeId: string): void;
  clearOutstanding(miner: string): void;
  clearExpired(): void;

  // Merge bonus funding
  recordMergeBonusFunding(epochId: number, miner: string, bonusAmountRaw: string): void;
  getUnclaimedMergeBonuses(miner: string): MergeBonusFundingRecord[];
  markClaimed(epochId: number, miner: string): void;

  // Multiplier claim ledger
  upsertMultiplierClaim(miner: string, epochId: number, status: MultiplierClaimRecord['status'], claimTxHash?: string): void;
  getMultiplierClaims(miner: string): MultiplierClaimRecord[];

  close(): void;
}

function openStore(storePath?: string): CortexStore {
  const p = storePath ?? process.env['CORTEX_STORE_DB_PATH'] ?? DEFAULT_STORE_PATH;
  fs.mkdirSync(path.dirname(p), { recursive: true });

  const db = new DatabaseSync(p);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA synchronous=NORMAL');
  db.exec('PRAGMA foreign_keys=ON');

  // Schema — matches migrations/001_cortex_store.sql (idempotent)
  db.exec(`
    CREATE TABLE IF NOT EXISTS outstanding_challenges (
      miner                TEXT PRIMARY KEY,
      lane                 TEXT NOT NULL,
      expires_at           INTEGER NOT NULL,
      shard_or_challenge_id TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS merge_bonus_funding (
      epoch_id        INTEGER NOT NULL,
      miner           TEXT    NOT NULL,
      bonus_amount_raw TEXT   NOT NULL,
      funded_at       INTEGER NOT NULL,
      claimed         INTEGER NOT NULL DEFAULT 0,
      claimed_at      INTEGER,
      PRIMARY KEY (epoch_id, miner)
    );

    CREATE TABLE IF NOT EXISTS multiplier_claims (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      miner        TEXT    NOT NULL,
      epoch_id     INTEGER NOT NULL,
      claim_tx_hash TEXT,
      status       TEXT    NOT NULL DEFAULT 'pending',
      created_at   INTEGER NOT NULL DEFAULT (unixepoch('now')),
      updated_at   INTEGER NOT NULL DEFAULT (unixepoch('now')),
      UNIQUE(miner, epoch_id)
    );

    CREATE INDEX IF NOT EXISTS idx_oc_expires_at ON outstanding_challenges(expires_at);
    CREATE INDEX IF NOT EXISTS idx_mbf_miner ON merge_bonus_funding(miner, claimed);
    CREATE INDEX IF NOT EXISTS idx_mc_miner ON multiplier_claims(miner);
  `);

  const getOcStmt = db.prepare(`SELECT * FROM outstanding_challenges WHERE miner = ?`);
  const setOcStmt = db.prepare(`
    INSERT INTO outstanding_challenges (miner, lane, expires_at, shard_or_challenge_id)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(miner) DO UPDATE SET
      lane = excluded.lane,
      expires_at = excluded.expires_at,
      shard_or_challenge_id = excluded.shard_or_challenge_id
  `);
  const clearOcStmt = db.prepare(`DELETE FROM outstanding_challenges WHERE miner = ?`);
  const clearExpiredStmt = db.prepare(`DELETE FROM outstanding_challenges WHERE expires_at < unixepoch('now')`);

  const recordFundingStmt = db.prepare(`
    INSERT INTO merge_bonus_funding (epoch_id, miner, bonus_amount_raw, funded_at)
    VALUES (?, ?, ?, unixepoch('now'))
    ON CONFLICT(epoch_id, miner) DO UPDATE SET
      bonus_amount_raw = excluded.bonus_amount_raw,
      funded_at = unixepoch('now')
  `);
  const getUnclaimedStmt = db.prepare(`
    SELECT * FROM merge_bonus_funding WHERE miner = ? AND claimed = 0
    ORDER BY epoch_id ASC
  `);
  const markClaimedStmt = db.prepare(`
    UPDATE merge_bonus_funding SET claimed = 1, claimed_at = unixepoch('now')
    WHERE epoch_id = ? AND miner = ?
  `);

  const upsertMcStmt = db.prepare(`
    INSERT INTO multiplier_claims (miner, epoch_id, claim_tx_hash, status)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(miner, epoch_id) DO UPDATE SET
      claim_tx_hash = excluded.claim_tx_hash,
      status = excluded.status,
      updated_at = unixepoch('now')
  `);
  const getMcStmt = db.prepare(`SELECT * FROM multiplier_claims WHERE miner = ? ORDER BY epoch_id DESC`);

  return {
    getOutstanding(miner) {
      const r = getOcStmt.get(miner) as Record<string, unknown> | undefined;
      if (!r) return undefined;
      const now = Math.floor(Date.now() / 1000);
      if ((r['expires_at'] as number) < now) {
        clearOcStmt.run(miner);
        return undefined;
      }
      return {
        miner,
        lane: r['lane'] as ChallengeOutstandingLane,
        expiresAt: r['expires_at'] as number,
        shardOrChallengeId: r['shard_or_challenge_id'] as string,
      };
    },

    setOutstanding(miner, lane, expiresAt, shardOrChallengeId) {
      setOcStmt.run(miner, lane, expiresAt, shardOrChallengeId);
    },

    clearOutstanding(miner) {
      clearOcStmt.run(miner);
    },

    clearExpired() {
      clearExpiredStmt.run();
    },

    recordMergeBonusFunding(epochId, miner, bonusAmountRaw) {
      recordFundingStmt.run(epochId, miner, bonusAmountRaw);
    },

    getUnclaimedMergeBonuses(miner) {
      const rows = getUnclaimedStmt.all(miner) as Record<string, unknown>[];
      return rows.map((r) => ({
        epochId:        r['epoch_id'] as number,
        miner:          r['miner'] as string,
        bonusAmountRaw: r['bonus_amount_raw'] as string,
        fundedAt:       r['funded_at'] as number,
        claimed:        Boolean(r['claimed']),
        claimedAt:      (r['claimed_at'] as number | null) ?? null,
      }));
    },

    markClaimed(epochId, miner) {
      markClaimedStmt.run(epochId, miner);
    },

    upsertMultiplierClaim(miner, epochId, status, claimTxHash) {
      upsertMcStmt.run(miner, epochId, claimTxHash ?? null, status);
    },

    getMultiplierClaims(miner) {
      const rows = getMcStmt.all(miner) as Record<string, unknown>[];
      return rows.map((r) => ({
        id:           r['id'] as number,
        miner:        r['miner'] as string,
        epochId:      r['epoch_id'] as number,
        claimTxHash:  (r['claim_tx_hash'] as string | null) ?? null,
        status:       r['status'] as MultiplierClaimRecord['status'],
        createdAt:    r['created_at'] as number,
        updatedAt:    r['updated_at'] as number,
      }));
    },

    close() {
      db.close();
    },
  };
}

// Lazy singleton for use inside mountCortexHandler
let _store: CortexStore | null = null;

export function getCortexStore(storePath?: string): CortexStore {
  if (!_store) {
    _store = openStore(storePath);
  }
  return _store;
}
