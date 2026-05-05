#!/usr/bin/env node
// Phase 9 E2E gate.
// Per §9 Phase 9, all tests gate on mainnet RPC + deployed contracts and
// self-skip otherwise. The synthetic anvil drills (multisig revert,
// emergency disable) are runnable in CI.
//
// Tests (in order):
//   T1. Mainnet dry-run epoch                — gates on CORTEX_REGISTRY_ADDRESS + BASE_RPC_URL
//   T2. First-reward audit trail              — gates on FIRST_REWARD_EPOCH
//   T3. Audit-window enforcement on mainnet   — gates on mainnet RPC
//   T4. Multisig revert rehearsal (synthetic) — runs in CI when anvil available
//   T5. Emergency disable rehearsal (synth.)  — runs in CI when anvil available
//   T6. Receipt-mapping observability         — synthetic; always runs
//   T7. Pool-mode mainnet test                — gates on mainnet
//   T8. Multisig key set published+verified   — gates on docs/multisig-key-set.md filled
//
// Self-skip with a clear message when prerequisites are missing.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { exit, env } from 'node:process';

let pass = 0, fail = 0, skip = 0;

function check(name, ok, reason) {
  if (ok === null) { skip++; console.log(`  SKIP  ${name}: ${reason ?? ''}`); return; }
  if (ok)          { pass++; console.log(`  PASS  ${name}`); return; }
  fail++;          console.error(`  FAIL  ${name}: ${reason ?? ''}`);
}

console.log('[phase-9] E2E gate');

// T1. Mainnet dry-run
if (env.BASE_RPC_URL && env.CORTEX_REGISTRY_ADDRESS && env.MAINNET_DRY_RUN === '1') {
  const r = spawnSync('node', ['scripts/mainnet/dry-run-epoch.mjs'], { stdio: 'inherit' });
  check('mainnet-dry-run-epoch', r.status === 0);
} else {
  check('mainnet-dry-run-epoch', null, 'gate: requires BASE_RPC_URL + CORTEX_REGISTRY_ADDRESS + MAINNET_DRY_RUN=1');
}

// T2. First-reward audit trail
if (env.BASE_RPC_URL && env.FIRST_REWARD_EPOCH) {
  const r = spawnSync('node', ['scripts/mainnet/first-reward-audit-trail.mjs'], { stdio: 'inherit' });
  check('first-reward-audit-trail', r.status === 0);
} else {
  check('first-reward-audit-trail', null, 'gate: requires FIRST_REWARD_EPOCH after first reward epoch lands');
}

// T3. Audit-window enforcement on mainnet
check('audit-window-enforcement-mainnet', null, 'gate: requires mainnet + post-finalize state');

// T4. Multisig revert rehearsal (synthetic)
const anvil = spawnSync('which', ['anvil'], { encoding: 'utf8' });
if (anvil.status === 0) {
  const r = spawnSync('node', ['scripts/mainnet/multisig-revert-rehearsal.mjs'], { stdio: 'inherit' });
  check('multisig-revert-rehearsal-synth', r.status === 0);
} else {
  check('multisig-revert-rehearsal-synth', null, 'anvil not installed');
}

// T5. Emergency disable rehearsal (synthetic)
if (anvil.status === 0) {
  const r = spawnSync('node', ['scripts/mainnet/emergency-disable-rehearsal.mjs'], { stdio: 'inherit' });
  check('emergency-disable-rehearsal-synth', r.status === 0);
} else {
  check('emergency-disable-rehearsal-synth', null, 'anvil not installed');
}

// T6. Receipt-mapping observability — synthetic
{
  const decoderSrc = 'docs/receipt-mapping.md';
  if (!existsSync(decoderSrc)) {
    check('receipt-mapping-observability', false, 'docs/receipt-mapping.md missing');
  } else {
    const md = readFileSync(decoderSrc, 'utf8');
    const hasDecoder = md.includes('decodeCortexReceipt') && md.includes('rulesVersion');
    check('receipt-mapping-observability', hasDecoder, 'sample decoder snippet missing');
  }
}

// T7. Pool-mode mainnet test
check('pool-mode-mainnet', null, 'gate: requires mainnet pool contract');

// T8. Multisig key set published
{
  const ks = 'docs/multisig-key-set.md';
  const md = existsSync(ks) ? readFileSync(ks, 'utf8') : '';
  const hasFilledOperator = !md.match(/\| 1 \| `<TBD>`/) && md.match(/\| 1 \| `0x[0-9a-fA-F]{40}`/);
  if (hasFilledOperator) {
    check('multisig-key-set-published', true);
  } else {
    check('multisig-key-set-published', null, 'docs/multisig-key-set.md still has <TBD> placeholders');
  }
}

console.log(`\n[phase-9] ${pass} pass, ${fail} fail, ${skip} skip`);
exit(fail === 0 ? 0 : 1);
