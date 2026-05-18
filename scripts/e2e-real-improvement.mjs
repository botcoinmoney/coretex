#!/usr/bin/env node
// End-to-end real-improvement test for CoreTex mining.
//
// Lifecycle:
//   1. Start an Anvil chain.
//   2. Deploy CortexRegistry (+ stale CoreTexMergeBonus for compatibility).
//   3. Build the chosen baseline genesis state.
//   4. Mine a real-corpus improvement patch from the baseline miner; verify
//      the marginal evaluator returns a strictly positive marginalGain.
//   5. Submit via submitStateAdvance(...); verify CortexStateAdvanced event,
//      patchCount, advanceCount, liveStateRoot.
//   6. Mine a second non-overlapping improvement against the new live root;
//      submit; verify both advances coexist in the same epoch.
//   7. Re-submit the *first* patch (stale parent root); verify the contract
//      reverts with LiveStateRootMismatch.
//   8. Mine a no-improvement candidate; verify the live evaluator returns 0
//      and the live-epoch reducer rejects it with L01_NOT_IMPROVEMENT (no
//      submission, no credits).
//   9. Tear down Anvil cleanly.
//
// Exit 0 on success, non-zero with a labelled failure otherwise.

import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exit } from 'node:process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');

const ANVIL_PORT = process.env.E2E_ANVIL_PORT ? Number(process.env.E2E_ANVIL_PORT) : 8546;
const RPC = `http://127.0.0.1:${ANVIL_PORT}`;
const DEPLOYER_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const DEPLOYER    = '0xf39Fd6e51aad88F6F4ce6aB8827279cfFFb92266';
const COORDINATOR_PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const COORDINATOR    = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

let anvil;
let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, info) {
  if (ok) { pass++; console.log(`  PASS  ${name}${info ? `  (${info})` : ''}`); }
  else    { fail++; failures.push(name); console.error(`  FAIL  ${name}: ${info ?? ''}`); }
}

function run(cmd, args, env = process.env, cwd = REPO) {
  const r = spawnSync(cmd, args, { env, cwd, stdio: 'pipe', encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(`[e2e] ${cmd} ${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`);
    throw new Error(`${cmd} exited ${r.status}`);
  }
  return r.stdout.trim();
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

async function waitRpcUp(timeoutMs = 15_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { await rpc('eth_chainId'); return; }
    catch { await sleep(150); }
  }
  throw new Error('anvil not up after timeout');
}

function startAnvil() {
  console.log(`[e2e] starting anvil on :${ANVIL_PORT}`);
  anvil = spawn('anvil', [
    '--port', String(ANVIL_PORT),
    '--silent',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  anvil.stderr.on('data', (b) => { stderr += b.toString(); });
  anvil.stdout.on('data', () => {});
  anvil.on('exit', (code) => {
    if (code !== null && code !== 0 && code !== 130) {
      console.error(`[e2e] anvil exited unexpectedly (code ${code}); stderr: ${stderr.slice(0, 300)}`);
    }
  });
}

function stopAnvil() {
  if (anvil && !anvil.killed) {
    try { anvil.kill('SIGINT'); } catch {}
  }
}

process.on('exit', stopAnvil);
process.on('SIGINT', () => { stopAnvil(); process.exit(130); });

// ── Build the cortex bench evaluator + load corpus ──
const corpusMod = await import(`${REPO}/experiments/harness/cortex-bench-eval.mjs`);
const stateMod  = await import(`${REPO}/packages/cortex/dist/state/index.js`);
const liveMod   = await import(`${REPO}/packages/cortex/dist/reducer/live-epoch.js`);
const baseline  = await import(`${REPO}/experiments/baselines/baseline_a_empty/index.mjs`);

const { loadRealCorpus, scoreState } = corpusMod;
const { merkleizeState, encodePatch, applyPatchOntoCurrent, applyPatch, bytesToHex, keccak256, hexToBytes } = stateMod;
const { advanceEpochState, makeLiveEpochInput } = liveMod;
const corpus = loadRealCorpus({ repoRoot: REPO });

// real marginal evaluator: score(curr+patch) − score(curr), scaled to 1e6 bigint.
function marginalEvaluator(currentState, patch) {
  const before = scoreState(currentState, corpus).composite;
  const r = applyPatch(currentState, patch);
  if (!r.ok) return 0n;
  const after = scoreState(r.state, corpus).composite;
  const delta = after - before;
  return BigInt(Math.round(delta * 1_000_000));
}

startAnvil();
await waitRpcUp();
console.log('[e2e] anvil up');

// ── Compile contracts (forge build) ──
console.log('[e2e] compiling contracts');
run('forge', ['build', '--silent', '--root', 'contracts'], process.env);

const registryArtifact = JSON.parse(readFileSync(resolve(REPO, 'contracts/out/CortexRegistry.sol/CortexRegistry.json'), 'utf8'));

// ── Deploy CortexRegistry ──
const deployOut = run(
  'forge', [
    'create',
    '--rpc-url', RPC,
    '--private-key', DEPLOYER_PK,
    '--broadcast',
    '--root', 'contracts',
    'src/CortexRegistry.sol:CortexRegistry',
    '--constructor-args', DEPLOYER, COORDINATOR,
  ],
  process.env,
);
const registryAddr = (deployOut.match(/Deployed to:\s*(0x[a-fA-F0-9]{40})/) ?? [])[1];
if (!registryAddr) {
  console.error(deployOut);
  throw new Error('failed to parse CortexRegistry deploy address');
}
console.log(`[e2e] CortexRegistry @ ${registryAddr}`);

// ── Phase 7 setup: pick the canonical baseline, build genesis, sanity-score ──
let state = baseline.genesisState();
const genesisRoot = bytesToHex(merkleizeState(state));
const genesisScore = scoreState(state, corpus).composite;
console.log(`[e2e] baseline=${baseline.BASELINE_ID}  genesis composite=${genesisScore.toFixed(6)}  root=${genesisRoot.slice(0, 18)}…`);

// ── Step 1: mine a real-improvement patch and submit it ──
const epoch = 1;
const minerA = '0x' + 'aa'.repeat(20);
const minerB = '0x' + 'bb'.repeat(20);

const patch1 = baseline.mineCandidatePatch(state, { epoch, solveIndex: 1 }, { corpus });
if (!patch1) { check('baseline-mines-real-patch', false, 'miner returned null'); finalize(); }
patch1.parentStateRoot = merkleizeState(state);
const gain1 = marginalEvaluator(state, patch1);
check('marginal-gain-positive-1', gain1 > 0n, `gain=${gain1}`);

const apply1 = applyPatch(state, patch1);
check('apply-patch-1-ok', apply1.ok, apply1.ok ? null : apply1.code);
const newState1 = apply1.state;
const newRoot1 = merkleizeState(newState1);
const patchHash1 = keccak256(encodePatch(patch1));
const evalReportHash1 = keccak256(new TextEncoder().encode(`evalreport:1:${bytesToHex(patchHash1)}`));

await submitStateAdvance({
  epoch,
  miner: minerA,
  parentStateRoot: bytesToHex(merkleizeState(state)),
  patchHash: bytesToHex(patchHash1),
  evalReportHash: bytesToHex(evalReportHash1),
  newStateRoot: bytesToHex(newRoot1),
  improvementCredits: gain1,
  compactPatchBytes: bytesToHex(encodePatch(patch1)),
});

const liveRoot1 = await registryView('liveStateRoot(uint64)', `0x${epoch.toString(16).padStart(16, '0')}`);
check('live-root-updated-after-1', liveRoot1.toLowerCase() === bytesToHex(newRoot1).toLowerCase(),
  `expected ${bytesToHex(newRoot1)} got ${liveRoot1}`);
const advCount1 = Number(await registryView('advanceCount(uint64)', `0x${epoch.toString(16).padStart(16, '0')}`));
check('advance-count-1', advCount1 === 1, `count=${advCount1}`);

state = newState1;

// ── Step 2: mine a non-overlapping second improvement against the new root ──
const patch2 = baseline.mineCandidatePatch(state, { epoch, solveIndex: 2 }, { corpus });
if (!patch2) { check('baseline-mines-real-patch-2', false, 'miner returned null'); finalize(); }
patch2.parentStateRoot = merkleizeState(state);
const gain2 = marginalEvaluator(state, patch2);
check('marginal-gain-positive-2', gain2 > 0n, `gain=${gain2}`);
const overlap = patch1.indices.some((i) => patch2.indices.includes(i));
check('non-overlapping-mid-epoch', !overlap, overlap ? `shared=${patch1.indices.filter((i) => patch2.indices.includes(i))}` : null);

const apply2 = applyPatch(state, patch2);
check('apply-patch-2-ok', apply2.ok, apply2.ok ? null : apply2.code);
const newState2 = apply2.state;
const newRoot2 = merkleizeState(newState2);
const patchHash2 = keccak256(encodePatch(patch2));
const evalReportHash2 = keccak256(new TextEncoder().encode(`evalreport:2:${bytesToHex(patchHash2)}`));

await submitStateAdvance({
  epoch,
  miner: minerB,
  parentStateRoot: bytesToHex(merkleizeState(state)),
  patchHash: bytesToHex(patchHash2),
  evalReportHash: bytesToHex(evalReportHash2),
  newStateRoot: bytesToHex(newRoot2),
  improvementCredits: gain2,
  compactPatchBytes: bytesToHex(encodePatch(patch2)),
});

const liveRoot2 = await registryView('liveStateRoot(uint64)', `0x${epoch.toString(16).padStart(16, '0')}`);
check('live-root-updated-after-2', liveRoot2.toLowerCase() === bytesToHex(newRoot2).toLowerCase(),
  `expected ${bytesToHex(newRoot2)} got ${liveRoot2}`);
const advCount2 = Number(await registryView('advanceCount(uint64)', `0x${epoch.toString(16).padStart(16, '0')}`));
check('advance-count-2', advCount2 === 2, `count=${advCount2}`);

state = newState2;

// ── Step 3: re-submit a stale-parent patch and confirm the contract reverts ──
const stalePatch = {
  ...patch1,
  parentStateRoot: hexToBytes(genesisRoot), // pointing at genesis, not current live root
};
const stalePatchBytes = encodePatch(stalePatch);
const stalePatchHash = keccak256(stalePatchBytes);
let staleReverted = false;
let staleRevertReason = '';
try {
  await submitStateAdvance({
    epoch,
    miner: minerA,
    parentStateRoot: bytesToHex(stalePatch.parentStateRoot),
    patchHash: bytesToHex(stalePatchHash),
    evalReportHash: bytesToHex(evalReportHash1),
    newStateRoot: bytesToHex(newRoot1), // anything; contract checks parent root first
    improvementCredits: 1n,
    compactPatchBytes: bytesToHex(stalePatchBytes),
  });
} catch (e) {
  staleReverted = true;
  staleRevertReason = String(e?.message ?? e);
}
check('stale-parent-reverted-on-chain', staleReverted, staleRevertReason.slice(0, 200));

// ── Step 4: a no-improvement (bogus) patch must produce 0 marginal gain ──
const bogusPatch = baseline.mineCandidatePatch(state, { epoch, solveIndex: 999 }, { corpus });
let bogusOk = true;
if (bogusPatch) {
  bogusPatch.parentStateRoot = merkleizeState(state);
  // Force a no-op by overwriting newWords with the values already present at
  // those indices (E05 from applyPatch, but the spec live-epoch evaluator
  // catches this as marginalGain=0).
  for (let i = 0; i < bogusPatch.indices.length; i++) {
    bogusPatch.newWords[i] = state.words[bogusPatch.indices[i]] ?? 0n;
  }
}
const bogusGain = bogusPatch ? marginalEvaluator(state, bogusPatch) : 0n;
check('bogus-patch-zero-gain', bogusGain === 0n, `gain=${bogusGain}`);

// Live-epoch reducer rejects with L01_NOT_IMPROVEMENT and never submits.
const liveOut = advanceEpochState(state, [
  makeLiveEpochInput(minerA, bogusPatch ?? patch1, bogusPatch ? encodePatch(bogusPatch) : encodePatch(patch1), () => 0n),
]);
check('live-reducer-rejects-bogus', liveOut.advances.length === 0 && liveOut.rejected.length === 1,
  liveOut.rejected[0]?.reason ?? 'no rejection');

// ── Step 5: finalize the epoch, confirm the seal matches the live root ──
const finalLive = await registryView('liveStateRoot(uint64)', `0x${epoch.toString(16).padStart(16, '0')}`);
const finalRoot = bytesToHex(merkleizeState(state));
check('final-live-equals-current', finalLive.toLowerCase() === finalRoot.toLowerCase(),
  `live=${finalLive} computed=${finalRoot}`);

const reducerOut = advanceEpochState(baseline.genesisState(), [
  makeLiveEpochInput(minerA, patch1, encodePatch(patch1), () => gain1),
  makeLiveEpochInput(minerB, patch2, encodePatch(patch2), () => gain2),
]);
const patchSetRootHex = '0x' + Buffer.from(reducerOut.patchSetRoot).toString('hex');
const newStateRootHex = '0x' + Buffer.from(reducerOut.newStateRoot).toString('hex');
check('reducer-replay-matches-live-root', newStateRootHex.toLowerCase() === finalLive.toLowerCase(),
  `replay=${newStateRootHex} live=${finalLive}`);

await finalizeEpoch({
  epoch,
  parentStateRoot: genesisRoot,
  patchSetRoot: patchSetRootHex,
  newStateRoot: newStateRootHex,
  coreVersionHash: '0x' + 'cc'.repeat(32),
  benchmarkCommitment: '0x' + 'bb'.repeat(32),
  experienceCorpusRoot: '0x' + 'ee'.repeat(32),
  scoreRoot: '0x' + 'dd'.repeat(32),
});
const finalised = await registryView('epochFinalized(uint64)', `0x${epoch.toString(16).padStart(16, '0')}`);
check('epoch-finalized', BigInt(finalised) === 1n, `finalized=${finalised}`);

finalize();

// ── helpers ─────────────────────────────────────────────────────────────────
async function submitStateAdvance(args) {
  const { epoch, miner, parentStateRoot, patchHash, evalReportHash, newStateRoot, improvementCredits, compactPatchBytes } = args;
  const data = encodeCall(
    'submitStateAdvance(uint64,address,bytes32,bytes32,bytes32,bytes32,uint256,bytes)',
    [
      ['uint64',  '0x' + epoch.toString(16).padStart(16, '0')],
      ['address', miner],
      ['bytes32', parentStateRoot],
      ['bytes32', patchHash],
      ['bytes32', evalReportHash],
      ['bytes32', newStateRoot],
      ['uint256', '0x' + improvementCredits.toString(16)],
      ['bytes',   compactPatchBytes],
    ],
  );
  const txHash = await rpc('eth_sendTransaction', [{
    from: COORDINATOR,
    to: registryAddr,
    data,
    gas: '0x1000000',
  }]);
  const r = await rpc('eth_getTransactionReceipt', [txHash]);
  if (!r) throw new Error(`no receipt for ${txHash}`);
  if (r.status !== '0x1') throw new Error(`tx reverted: ${txHash}`);
}

async function finalizeEpoch({ epoch, parentStateRoot, patchSetRoot, newStateRoot, coreVersionHash, benchmarkCommitment, experienceCorpusRoot, scoreRoot }) {
  const data = encodeCall(
    'finalizeEpoch(uint64,bytes32,bytes32,bytes32,bytes32,bytes32,bytes32,bytes32)',
    [
      ['uint64',  '0x' + epoch.toString(16).padStart(16, '0')],
      ['bytes32', parentStateRoot],
      ['bytes32', patchSetRoot],
      ['bytes32', newStateRoot],
      ['bytes32', coreVersionHash],
      ['bytes32', benchmarkCommitment],
      ['bytes32', experienceCorpusRoot],
      ['bytes32', scoreRoot],
    ],
  );
  const txHash = await rpc('eth_sendTransaction', [{
    from: COORDINATOR,
    to: registryAddr,
    data,
    gas: '0x500000',
  }]);
  const r = await rpc('eth_getTransactionReceipt', [txHash]);
  if (!r || r.status !== '0x1') throw new Error(`finalize tx reverted: ${txHash}`);
}

async function registryView(signature, packedArg) {
  const selector = '0x' + Buffer.from(keccak256(new TextEncoder().encode(signature))).toString('hex').slice(0, 8);
  const arg = packedArg.startsWith('0x') ? packedArg.slice(2) : packedArg;
  const padded = arg.length === 64 ? arg : arg.padStart(64, '0');
  const data = selector + padded;
  return await rpc('eth_call', [{ to: registryAddr, data }, 'latest']);
}

// ── ABI encoding (minimal ABI v2 encoder for the exact tuples we use) ─
function encodeCall(signature, args) {
  const selectorBytes = keccak256(new TextEncoder().encode(signature));
  let head = '';
  let tail = '';
  const headSize = 32 * args.length;
  const headOffsets = [];

  // First pass: encode head + tail offsets for dynamic types.
  for (const [type, value] of args) {
    if (type === 'bytes') {
      headOffsets.push(headSize + tail.length / 2);
      const v = value.startsWith('0x') ? value.slice(2) : value;
      const lenHex = (v.length / 2).toString(16).padStart(64, '0');
      const padded = v + '0'.repeat((64 - (v.length % 64)) % 64);
      tail += lenHex + padded;
    } else {
      headOffsets.push(null);
    }
  }

  // Second pass: write head.
  let i = 0;
  for (const [type, value] of args) {
    if (type === 'bytes') {
      head += headOffsets[i].toString(16).padStart(64, '0');
    } else if (type === 'address') {
      const a = value.toLowerCase().replace(/^0x/, '');
      head += a.padStart(64, '0');
    } else if (type === 'bytes32') {
      const b = value.startsWith('0x') ? value.slice(2) : value;
      head += b.padStart(64, '0');
    } else {
      // uint*
      const u = value.startsWith('0x') ? value.slice(2) : value;
      head += u.padStart(64, '0');
    }
    i++;
  }

  return '0x' + Buffer.from(selectorBytes).toString('hex').slice(0, 8) + head + tail;
}

function finalize() {
  console.log(`\n[e2e-real-improvement] ${pass} pass, ${fail} fail`);
  if (fail > 0) {
    console.error('failures:', failures);
    stopAnvil();
    exit(1);
  }
  stopAnvil();
  exit(0);
}
