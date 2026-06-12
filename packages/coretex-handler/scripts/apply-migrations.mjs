#!/usr/bin/env node
/**
 * Apply Cortex store migrations idempotently.
 *
 * Usage:
 *   node packages/coretex-handler/scripts/apply-migrations.mjs
 *
 * Reads CORTEX_STORE_DB_PATH env (default: data/coordinator/coretex-store.db).
 * Applies all SQL files in packages/coretex-handler/migrations/ in version order.
 * Safe to run multiple times — already-applied migrations are skipped.
 *
 * Referenced in instructions.md §5.
 */

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');
const DEFAULT_DB = 'data/coordinator/coretex-store.db';

const dbPath = process.env.CORTEX_STORE_DB_PATH ?? DEFAULT_DB;

console.log(`[apply-migrations] target: ${dbPath}`);
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode=WAL');
db.exec('PRAGMA foreign_keys=ON');

// Bootstrap the migrations table so we can check what's applied
db.exec(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    name       TEXT    NOT NULL,
    applied_at INTEGER NOT NULL DEFAULT (unixepoch('now'))
  );
`);

const appliedRows = db.prepare('SELECT version FROM schema_migrations').all();
const applied = new Set(appliedRows.map((r) => r.version));

// Read migration files sorted by version prefix
const files = fs
  .readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();

let appliedCount = 0;
for (const file of files) {
  const match = file.match(/^(\d+)_/);
  if (!match) {
    console.warn(`[apply-migrations] skipping non-versioned file: ${file}`);
    continue;
  }
  const version = Number(match[1]);
  if (applied.has(version)) {
    console.log(`[apply-migrations] skip v${version} ${file} (already applied)`);
    continue;
  }

  const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
  console.log(`[apply-migrations] applying v${version} ${file}...`);

  db.exec(sql);
  // Record application (idempotent due to INSERT OR IGNORE in the SQL itself)
  db.prepare('INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (?, ?)')
    .run(version, file.replace('.sql', ''));

  appliedCount++;
  console.log(`[apply-migrations] v${version} applied`);
}

db.close();
console.log(`[apply-migrations] done. Applied ${appliedCount} new migration(s).`);
