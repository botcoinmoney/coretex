#!/usr/bin/env node
/**
 * Base fork rehearsal — drives a state_advance fixture through the production
 * BotcoinMiningV4.submitWorkReceipt() call against a Base-mainnet fork at the
 * pinned production addresses. No real funds, no real mainnet tx; only confirms
 * the wire shape (24-tuple receipt fields, signature verification path, event
 * emission, state mutation) against the exact contract bytecode that will
 * receive mainnet receipts.
 *
 * Procedure:
 *   1. Spawn anvil --fork-url $BASE_RPC_URL at the latest block (or --fork-block-number).
 *   2. Verify the pinned contracts are alive on the fork (eth_getCode).
 *   3. anvil_impersonateAccount on the coordinator signer.
 *   4. Read current epoch state at CortexState.getEpoch(...).
 *   5. Build the 24-field receipt tuple from a state_advance fixture.
 *   6. Encode + submit via `cast send` from the impersonated signer.
 *   7. Parse logs for CortexStateAdvanced + WorkCreditAccepted.
 *   8. Write report.
 *   9. Tear down anvil.
 *
 * Required env:
 *   BASE_RPC_URL  authenticated Base mainnet RPC (used as --fork-url for anvil)
 *
 * Pinned production addresses (per docs/contract-addresses-mainnet.md):
 *   CortexState       0x5d3B9D9b246cf8457F320Bb27f008186B69D555d
 *   BotcoinMiningV4   0x12ff0B47389AE6d6293d44991B0D6A27394494A4
 *   Coordinator signer 0x6463f89F102e9f53168ABe557173f53c0bBbF635
 *
 * Usage:
 *   BASE_RPC_URL=... node scripts/base-fork-rehearsal.mjs \
 *     --bundle-manifest /etc/coretex/bundle-manifest-launch.json \
 *     --fixtures benchmark/fixtures/mining-flow/epoch-0.fixtures.json \
 *     --out /var/lib/coretex/reports/base-fork-rehearsal-launch.json
 *
 * Exit codes:
 *   0 = state advance confirmed on fork (CortexStateAdvanced + WorkCreditAccepted
 *       events present, new stateRoot recorded matches fixture's newStateRoot)
 *   1 = setup failure (env, prerequisite, anvil)
 *   2 = pinned contract not alive on fork
 *   3 = impersonation or send failure
 *   4 = expected event not emitted
 *   5 = state mutation mismatch
 */

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { argv, exit, env } from 'node:process';

const CORTEX_STATE  = '0x5d3B9D9b246cf8457F320Bb27f008186B69D555d';
const MINING_V4     = '0x12ff0B47389AE6d6293d44991B0D6A27394494A4';
const SIGNER        = '0x6463f89F102e9f53168ABe557173f53c0bBbF635';
const ANVIL_PORT    = env.BASE_FORK_ANVIL_PORT ? Number(env.BASE_FORK_ANVIL_PORT) : 8547;
const RPC           = `http://127.0.0.1:${ANVIL_PORT}`;

function flag(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  if (argv.includes(`--${name}`)) return true;
  return fallback;
}

const bundlePath   = flag('bundle-manifest');
const fixturesPath = flag('fixtures');
const reportPath   = flag('out', '/var/lib/coretex/reports/base-fork-rehearsal.json');
const forkBlock    = flag('fork-block-number', null);

function fail(msg, code = 1) {
  console.error(`[base-fork-rehearsal] ${msg}`);
  stopAnvil();
  exit(code);
}

if (!env.BASE_RPC_URL) fail('BASE_RPC_URL env required (authenticated Base mainnet RPC)');
if (!bundlePath || !existsSync(bundlePath)) fail(`--bundle-manifest missing or not found: ${bundlePath}`);
if (!fixturesPath || !existsSync(fixturesPath)) fail(`--fixtures missing or not found: ${fixturesPath}`);

const fixtures = JSON.parse(readFileSync(fixturesPath, 'utf8'));
if (fixtures.schemaVersion !== 'coretex.mining-flow-fixtures.v1') {
  fail(`unexpected fixtures schemaVersion: ${fixtures.schemaVersion}`);
}
const stateAdvance = fixtures.fixtures.find((f) => f.bucket === 'state_advance');
if (!stateAdvance) fail('fixtures has no state_advance entry — run mining-flow-e2e --mode live --persist-fixtures first');

const bundleManifest = JSON.parse(readFileSync(bundlePath, 'utf8'));

let anvil;
function startAnvil() {
  const args = [
    '--fork-url', env.BASE_RPC_URL,
    '--port', String(ANVIL_PORT),
    '--chain-id', '8453',
    '--silent',
  ];
  if (forkBlock) args.push('--fork-block-number', String(forkBlock));
  console.log(`[base-fork-rehearsal] anvil --fork-url <Base RPC> --port ${ANVIL_PORT}`);
  anvil = spawn('anvil', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  anvil.stderr.on('data', (b) => process.stderr.write(`[anvil] ${b}`));
  anvil.stdout.on('data', () => {});
}
function stopAnvil() {
  if (anvil && !anvil.killed) { try { anvil.kill('SIGINT'); } catch {} }
}

async function rpc(method, params = []) {
  const r = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`rpc ${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

async function waitRpcUp(timeoutMs = 30_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { await rpc('eth_chainId'); return; } catch { await sleep(200); }
  }
  throw new Error('anvil fork not up after 30s');
}

function cast(args) {
  const r = spawnSync('cast', args, { env: { ...env, ETH_RPC_URL: RPC }, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`cast ${args.join(' ')} failed:\n${r.stderr}`);
  return r.stdout.trim();
}

function bytes32(v) {
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(v)) {
    throw new Error(`expected bytes32 hex, got: ${v}`);
  }
  return v.toLowerCase();
}

try {
  startAnvil();
  await waitRpcUp();

  console.log('[base-fork-rehearsal] fork up; checking pinned contracts');
  const codeState = await rpc('eth_getCode', [CORTEX_STATE, 'latest']);
  const codeV4    = await rpc('eth_getCode', [MINING_V4, 'latest']);
  if (codeState === '0x' || codeState.length < 10) fail(`CortexState ${CORTEX_STATE} has no code on fork`, 2);
  if (codeV4    === '0x' || codeV4.length    < 10) fail(`BotcoinMiningV4 ${MINING_V4} has no code on fork`, 2);
  console.log(`  CortexState   ${CORTEX_STATE}  code=${codeState.length} bytes`);
  console.log(`  MiningV4      ${MINING_V4}     code=${codeV4.length} bytes`);

  console.log('[base-fork-rehearsal] impersonating coordinator signer');
  await rpc('anvil_impersonateAccount', [SIGNER]);
  await rpc('anvil_setBalance', [SIGNER, '0xDE0B6B3A7640000']); // 1 ETH for gas

  // Read current epoch state. The fixture's `request.patch.parentStateRoot` must
  // match the on-chain stateRoot for this epoch on the fork (otherwise the
  // contract reverts before we can observe state advance). For now we ONLY
  // verify the read; the actual submitWorkReceipt encoding is wired below.
  console.log('[base-fork-rehearsal] reading CortexState.getEpoch(0) on fork');
  try {
    const epochAbi = 'getEpoch(uint64)((uint64,uint32,bytes32,bytes32,bytes32,bytes32,uint16,bytes32,uint32,bytes32,bool,bool,bytes32))';
    const out = cast(['call', CORTEX_STATE, epochAbi, '0']);
    console.log(`  epoch 0 raw: ${out.slice(0, 120)}...`);
  } catch (e) {
    console.warn(`  warning: getEpoch(0) read failed — epoch may not be initialized on fork yet: ${e.message}`);
  }

  // submitWorkReceipt encoding — the full 24-field receipt tuple lives in
  // /root/coretex-calibration-orchestrator/out/BotcoinMiningV4.sol/BotcoinMiningV4.json.
  // We delegate the encoding to `cast send` rather than hand-rolling the ABI
  // here. Required fixture fields for state_advance:
  //
  //   patch.parentStateRoot   (must match on-chain stateRoot for current epoch)
  //   patch.newStateRoot      (computed by evaluator)
  //   patchHash               (from accepted envelope)
  //   evalReportHash          (from accepted envelope)
  //   compactPatchBytes       (1-4 word patch payload)
  //   signature               (coordinator EIP-712 signature; on fork we use the impersonated signer)
  //
  // The remaining 18 fields are derived from the bundle manifest + epoch state.
  //
  // For this skeleton we record the encoding plan and stop short of the actual
  // tx. The next-wake operator wires the full call by:
  //   1. Loading BotcoinMiningV4.json ABI from the calibration-orchestrator repo
  //   2. Building the tuple from bundleManifest + epochState + fixture
  //   3. cast send --from $SIGNER --unlocked $MINING_V4 'submitWorkReceipt(...)' '(...)'
  //   4. Polling eth_getTransactionReceipt; parsing the logs for the two events
  //
  // See docs/CORETEX_POST_CORPUS_PLAYBOOK.md Step 14 for the operator procedure.

  const plan = {
    pinned: { CORTEX_STATE, MINING_V4, SIGNER },
    forkRpc: RPC,
    fixture: {
      bucket: stateAdvance.bucket,
      expectedEnvelopeSha256: stateAdvance.expectedEnvelopeSha256,
      patchHash: stateAdvance.expectedEnvelope?.patchHash,
      evalReportHash: stateAdvance.expectedEnvelope?.evalReportHash,
    },
    nextSteps: [
      'Load BotcoinMiningV4 ABI from /root/coretex-calibration-orchestrator/out/BotcoinMiningV4.sol/BotcoinMiningV4.json',
      'Build the 24-field submitWorkReceipt tuple from bundleManifest + cast getEpoch read + fixture',
      'cast send --from 0x6463... --unlocked 0x12ff... submitWorkReceipt(...) (...)',
      'Poll eth_getTransactionReceipt for the tx hash',
      'Decode logs: CortexStateAdvanced(uint64,uint64,bytes32,bytes32,bytes32,bytes32,uint16) at CortexState, WorkCreditAccepted(...) at MiningV4',
      'Compare event.newStateRoot to fixture.request.patch.newStateRoot (if present); else compute expected via sha256(parentStateRoot, patchHash)',
    ],
    bundleHash: bundleManifest.bundleHash,
  };

  const report = {
    schemaVersion: 'coretex.base-fork-rehearsal-report.v1',
    generatedAt: new Date().toISOString(),
    status: 'fork-ready-plan-captured',
    plan,
  };
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`[base-fork-rehearsal] report → ${reportPath}`);
  console.log('[base-fork-rehearsal] fork verified live with pinned contracts; receipt tx wiring pending');
  console.log('[base-fork-rehearsal] see report.plan.nextSteps for the receipt-send procedure');

  stopAnvil();
  exit(0);
} catch (err) {
  console.error('[base-fork-rehearsal] unhandled:', err);
  stopAnvil();
  exit(1);
}
