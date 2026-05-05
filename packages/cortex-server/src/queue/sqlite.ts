/**
 * SQLite queue for cortex-server.
 *
 * Uses node:sqlite (Node >=22.5) with a WAL journal for crash safety.
 * Path is controlled by CORTEX_DB_PATH env (default: data/cortex/queue.db).
 *
 * All writes go through idempotent upserts keyed on (miner, solveIndex).
 * A crash between INSERT and COMMIT leaves a partial row; the reconcile()
 * function replays in-flight rows against chain state on restart.
 *
 * IMPORTANT: Cortex NEVER writes to data/v2/swcp/* — the SWCP HF export
 * pipeline is untouched. Dataset writes go to dataset/v2/cortex/epoch/{N}/.
 */

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_DB_PATH = 'data/cortex/queue.db';

export type SubmissionStatus =
  | 'pending'
  | 'evaluating'
  | 'screener_pass'
  | 'screener_fail'
  | 'signed'
  | 'submitted_on_chain'
  | 'duplicate';

export interface QueueRow {
  id: number;
  miner: string;
  epoch: number;
  solveIndex: number;
  patchHex: string;
  parentStateRoot: string;
  shardId: string;
  status: SubmissionStatus;
  receiptJson: string | null;
  rejectCode: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface CortexDb {
  upsertSubmission(row: Omit<QueueRow, 'id' | 'createdAt' | 'updatedAt'>): number;
  updateStatus(id: number, status: SubmissionStatus, extra?: { receiptJson?: string; rejectCode?: string }): void;
  getSubmission(id: number): QueueRow | undefined;
  getPendingSubmissions(): QueueRow[];
  getSubmissionByMinerEpoch(miner: string, epoch: number, solveIndex: number): QueueRow | undefined;
  getOutstandingChallenge(miner: string): { epoch: number; shardId: string; expiresAt: number } | undefined;
  setOutstandingChallenge(miner: string, epoch: number, shardId: string, expiresAt: number): void;
  clearOutstandingChallenge(miner: string): void;
  close(): void;
}

export function openDatabase(dbPath?: string): CortexDb {
  const resolvedPath = dbPath ?? process.env['CORTEX_DB_PATH'] ?? DEFAULT_DB_PATH;

  // Ensure directory exists
  const dir = path.dirname(resolvedPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new DatabaseSync(resolvedPath);

  // WAL mode for crash safety — concurrent readers don't block writers
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('PRAGMA synchronous=NORMAL');
  db.exec('PRAGMA foreign_keys=ON');

  // Schema bootstrap (idempotent)
  db.exec(`
    CREATE TABLE IF NOT EXISTS submissions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      miner         TEXT    NOT NULL,
      epoch         INTEGER NOT NULL,
      solve_index   INTEGER NOT NULL,
      patch_hex     TEXT    NOT NULL,
      parent_state_root TEXT NOT NULL,
      shard_id      TEXT    NOT NULL,
      status        TEXT    NOT NULL DEFAULT 'pending',
      receipt_json  TEXT,
      reject_code   TEXT,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL,
      UNIQUE(miner, epoch, solve_index)
    );

    CREATE INDEX IF NOT EXISTS idx_submissions_status   ON submissions(status);
    CREATE INDEX IF NOT EXISTS idx_submissions_miner    ON submissions(miner, epoch);

    CREATE TABLE IF NOT EXISTS outstanding_challenges (
      miner       TEXT    PRIMARY KEY,
      epoch       INTEGER NOT NULL,
      shard_id    TEXT    NOT NULL,
      expires_at  INTEGER NOT NULL
    );
  `);

  const insertStmt = db.prepare(`
    INSERT INTO submissions
      (miner, epoch, solve_index, patch_hex, parent_state_root, shard_id, status, receipt_json, reject_code, created_at, updated_at)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch('now'), unixepoch('now'))
    ON CONFLICT(miner, epoch, solve_index) DO UPDATE SET
      patch_hex        = excluded.patch_hex,
      parent_state_root = excluded.parent_state_root,
      shard_id         = excluded.shard_id,
      status           = excluded.status,
      receipt_json     = excluded.receipt_json,
      reject_code      = excluded.reject_code,
      updated_at       = unixepoch('now')
    RETURNING id
  `);

  const updateStatusStmt = db.prepare(`
    UPDATE submissions
    SET status = ?, receipt_json = ?, reject_code = ?, updated_at = unixepoch('now')
    WHERE id = ?
  `);

  const getByIdStmt = db.prepare(`SELECT * FROM submissions WHERE id = ?`);
  const getPendingStmt = db.prepare(`SELECT * FROM submissions WHERE status IN ('pending', 'evaluating') ORDER BY created_at ASC`);
  const getByMinerEpochStmt = db.prepare(`SELECT * FROM submissions WHERE miner = ? AND epoch = ? AND solve_index = ?`);

  const getOutstandingStmt = db.prepare(`SELECT * FROM outstanding_challenges WHERE miner = ?`);
  const setOutstandingStmt = db.prepare(`
    INSERT INTO outstanding_challenges (miner, epoch, shard_id, expires_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(miner) DO UPDATE SET
      epoch = excluded.epoch,
      shard_id = excluded.shard_id,
      expires_at = excluded.expires_at
  `);
  const clearOutstandingStmt = db.prepare(`DELETE FROM outstanding_challenges WHERE miner = ?`);

  function rowToQueueRow(r: Record<string, unknown>): QueueRow {
    return {
      id:              r['id'] as number,
      miner:           r['miner'] as string,
      epoch:           r['epoch'] as number,
      solveIndex:      r['solve_index'] as number,
      patchHex:        r['patch_hex'] as string,
      parentStateRoot: r['parent_state_root'] as string,
      shardId:         r['shard_id'] as string,
      status:          r['status'] as SubmissionStatus,
      receiptJson:     r['receipt_json'] as string | null,
      rejectCode:      r['reject_code'] as string | null,
      createdAt:       r['created_at'] as number,
      updatedAt:       r['updated_at'] as number,
    };
  }

  return {
    upsertSubmission(row) {
      const result = insertStmt.get(
        row.miner, row.epoch, row.solveIndex,
        row.patchHex, row.parentStateRoot, row.shardId,
        row.status, row.receiptJson ?? null, row.rejectCode ?? null,
      ) as Record<string, unknown>;
      return result['id'] as number;
    },

    updateStatus(id, status, extra) {
      updateStatusStmt.run(status, extra?.receiptJson ?? null, extra?.rejectCode ?? null, id);
    },

    getSubmission(id) {
      const r = getByIdStmt.get(id) as Record<string, unknown> | undefined;
      return r ? rowToQueueRow(r) : undefined;
    },

    getPendingSubmissions() {
      return (getPendingStmt.all() as Record<string, unknown>[]).map(rowToQueueRow);
    },

    getSubmissionByMinerEpoch(miner, epoch, solveIndex) {
      const r = getByMinerEpochStmt.get(miner, epoch, solveIndex) as Record<string, unknown> | undefined;
      return r ? rowToQueueRow(r) : undefined;
    },

    getOutstandingChallenge(miner) {
      const r = getOutstandingStmt.get(miner) as Record<string, unknown> | undefined;
      if (!r) return undefined;
      const now = Math.floor(Date.now() / 1000);
      const expiresAt = r['expires_at'] as number;
      if (expiresAt < now) {
        // Expired — clean up lazily
        clearOutstandingStmt.run(miner);
        return undefined;
      }
      return { epoch: r['epoch'] as number, shardId: r['shard_id'] as string, expiresAt };
    },

    setOutstandingChallenge(miner, epoch, shardId, expiresAt) {
      setOutstandingStmt.run(miner, epoch, shardId, expiresAt);
    },

    clearOutstandingChallenge(miner) {
      clearOutstandingStmt.run(miner);
    },

    close() {
      db.close();
    },
  };
}
