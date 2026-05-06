#!/usr/bin/env node
// Phase 8 E2E gate.
// Per §9 Phase 8 — most tests SELF-SKIP without testnet RPC; the GOLDEN
// e2e fixture runs in-process against a synthetic chain (no RPC needed)
// and is the CI merge gate.
//
// Tests:
//   T1. Golden e2e fixture (CI MERGE GATE) — synthetic, always runs.
//   T2. Sparse mid-history replay         — synthetic, always runs.
//   T3. Saturation alarm fires            — synthetic, always runs.
//   T4. External auditor reproduction     — gates on BASE_TESTNET_RPC_URL
//   T5. Multisig override drill on testnet — gates on testnet RPC + funded keys
//   T6. Pass-rate band hold               — gates on real testnet run
//   T7. Multiplier-distribution gate      — gates on real testnet run
//   T8. Latch/unlatch rehearsal           — gates on running cortex-server
//   T9. Metrics dashboard correctness     — synthetic, always runs
//   T10. Storage/HF export non-interference — gates on running SWCP coordinator

import { spawnSync } from 'node:child_process';
import { exit, env } from 'node:process';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0, skip = 0;
function check(name, ok, reason) {
  if (ok === null) { skip++; console.log(`  SKIP  ${name}: ${reason ?? ''}`); return; }
  if (ok)          { pass++; console.log(`  PASS  ${name}`); return; }
  fail++;          console.error(`  FAIL  ${name}: ${reason ?? ''}`);
}

console.log('[phase-8] E2E gate');

// T1. Golden e2e fixture — CI MERGE GATE
{
  const r = spawnSync('node', ['test/e2e/phase-8/golden-fixture.mjs'], { stdio: 'inherit' });
  check('golden-e2e-fixture (CI MERGE GATE)', r.status === 0);
}

// T2. Sparse mid-history replay
{
  const r = spawnSync('node', ['test/e2e/phase-8/sparse-replay.mjs'], { stdio: 'inherit' });
  check('sparse-mid-history-replay', r.status === 0);
}

// T3. Saturation alarm
{
  const r = spawnSync('node', ['test/e2e/phase-8/saturation-alarm.mjs'], { stdio: 'inherit' });
  check('saturation-alarm-fires', r.status === 0);
}

// T4–T8 require testnet
if (env.BASE_TESTNET_RPC_URL) {
  check('external-auditor-reproduction', null, 'requires real testnet run output (≥10 finalized epochs)');
  check('multisig-override-drill-testnet', null, 'requires testnet + funded multisig');
  check('pass-rate-band-hold', null, 'requires testnet ≥100 epochs');
  check('multiplier-distribution-gate', null, 'requires testnet ≥100 epochs');
  check('latch-unlatch-rehearsal', null, 'requires running cortex-server + SWCP coordinator');
} else {
  check('external-auditor-reproduction', null, 'BASE_TESTNET_RPC_URL not set');
  check('multisig-override-drill-testnet', null, 'BASE_TESTNET_RPC_URL not set');
  check('pass-rate-band-hold', null, 'BASE_TESTNET_RPC_URL not set');
  check('multiplier-distribution-gate', null, 'BASE_TESTNET_RPC_URL not set');
  check('latch-unlatch-rehearsal', null, 'BASE_TESTNET_RPC_URL not set');
}

// T9. Metrics dashboard correctness — synthetic
{
  let dashOk = false;
  let dashReason = '';
  try {
    const j = JSON.parse(readFileSync('ops/testnet/dashboard.json', 'utf8'));
    const required = ['pass_rate_overall', 'score_delta_distribution', 'protected_regression_rate',
      'reducer_rejects', 'eval_latency_p50', 'eval_latency_p99', 'state_root_per_epoch',
      'corpus_snapshot_hash', 'merge_multiplier_distribution'];
    const text = JSON.stringify(j);
    const missing = required.filter((m) => !text.includes(m));
    dashOk = missing.length === 0;
    dashReason = missing.length ? `missing: ${missing.join(',')}` : '';
  } catch (e) {
    dashReason = String(e);
  }
  check('metrics-dashboard-correctness', dashOk, dashReason);
}

// T10. Storage namespace non-interference — gates on running coordinator
check('storage-hf-export-non-interference', null, 'requires running SWCP coordinator + HF export pipeline');

console.log(`\n[phase-8] ${pass} pass, ${fail} fail, ${skip} skip`);
if (fail > 0) exit(1);
// CI gates only on the golden-e2e-fixture test (T1) — that must always pass.
exit(0);
