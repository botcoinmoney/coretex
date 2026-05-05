#!/usr/bin/env node
// Phase 8 latch/unlatch rehearsal.
// Per §9 Phase 8: stop cortex-server mid-flight ≥2 times; verify SWCP claim
// parity preserved; queue resumes without duplicate submissions.
//
// This script is procedural — it shows exactly what to do and verifies a
// few invariants programmatically. Operator runs the actual systemctl steps.

import { exit, env } from 'node:process';
import { spawnSync } from 'node:child_process';

const COORD_BASE = env.COORDINATOR_BASE ?? 'http://127.0.0.1:8081';
const SWCP_BASE  = env.SWCP_COORDINATOR_BASE ?? 'http://127.0.0.1:8080';
const CORTEX_DB_PATH = env.CORTEX_DB_PATH ?? 'data/cortex/queue.db';

console.log('[latch-unlatch] testing baseline state');

// 1. Confirm cortex-server is up.
const h1 = await fetch(`${COORD_BASE}/healthz`).then((r) => r.json()).catch(() => null);
if (!h1?.ok) { console.error('cortex-server not running at ' + COORD_BASE); exit(1); }
console.log('  cortex-server: UP');

// 2. Confirm SWCP coordinator is up (the parent-process /healthz).
const h2 = await fetch(`${SWCP_BASE}/healthz`).then((r) => r.json()).catch(() => null);
if (!h2) console.warn('  SWCP coordinator probe failed (may not expose /healthz at this URL)');
else console.log('  SWCP coordinator: UP');

// 3. Record cortex queue size + a SWCP receipt count baseline.
const queueBeforeBytes = await import('node:fs').then((fs) => {
  try { return fs.statSync(CORTEX_DB_PATH).size; } catch { return 0; }
});
console.log(`  cortex queue size: ${queueBeforeBytes} bytes`);

console.log('\n[latch-unlatch] OPERATOR ACTION 1:');
console.log('  sudo systemctl stop cortex-server');
console.log('  Press Enter when cortex-server is stopped...');
// Wait for user — in CI we can't read stdin; the operator runs the script
// step-by-step. For a fully-automated run, set OPERATOR_AUTO=1.
if (env.OPERATOR_AUTO !== '1') {
  await new Promise((res) => process.stdin.once('data', res));
}

// 4. Verify cortex-server is DOWN.
const h3 = await fetch(`${COORD_BASE}/healthz`).then((r) => r.json()).catch(() => null);
if (h3) { console.error('cortex-server still up — operator action incomplete'); exit(2); }
console.log('  cortex-server: DOWN (correct)');

// 5. Verify SWCP coordinator UNAFFECTED.
const h4 = await fetch(`${SWCP_BASE}/healthz`).then((r) => r.json()).catch(() => null);
if (h4 && h2 && JSON.stringify(h4).slice(0, 50) !== JSON.stringify(h2).slice(0, 50)) {
  console.warn('SWCP coordinator state changed; further investigation needed');
} else if (h4) {
  console.log('  SWCP coordinator: STILL UP — SWCP unaffected (correct)');
}

console.log('\n[latch-unlatch] OPERATOR ACTION 2:');
console.log('  sudo systemctl start cortex-server');
console.log('  Press Enter when cortex-server is up again...');
if (env.OPERATOR_AUTO !== '1') {
  await new Promise((res) => process.stdin.once('data', res));
}

// 6. Verify cortex-server is back UP.
const h5 = await fetch(`${COORD_BASE}/healthz`).then((r) => r.json()).catch(() => null);
if (!h5?.ok) { console.error('cortex-server failed to restart'); exit(3); }
console.log('  cortex-server: UP (correct)');

// 7. Verify queue resumes without duplicate submissions — operator runs
//    feed-synthetic-traffic.mjs and confirms no duplicate patchHash on
//    chain. We just verify the DB file size is sane (didn't get truncated).
const queueAfterBytes = await import('node:fs').then((fs) => {
  try { return fs.statSync(CORTEX_DB_PATH).size; } catch { return 0; }
});
console.log(`  cortex queue size after: ${queueAfterBytes} bytes (was ${queueBeforeBytes})`);
if (queueAfterBytes < queueBeforeBytes - 1024) {
  console.error('cortex queue shrunk significantly — possible data loss');
  exit(4);
}

console.log('\n[latch-unlatch] iteration 1 OK. Per §9 Phase 8, run twice.');
console.log('[latch-unlatch] re-run this script for iteration 2.');
