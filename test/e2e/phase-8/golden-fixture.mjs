#!/usr/bin/env node
// Phase 8 golden e2e fixture — CI MERGE GATE per §9 Phase 8.
//
// End-to-end without any external deps:
//   genesis state → challenge → patch → Core eval → screener receipt
//                → reducer → finalized root → clean-machine verify-epoch
//
// All in-process. No testnet RPC. No anvil. No external signer.
// The "chain" is an in-memory event log; verify-epoch reads only that log.

import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';

let mod;
try {
  mod = await import('../../../packages/cortex/dist/state/index.js');
} catch (e) {
  console.error('[golden-fixture] dist not built — run `npm run build --workspace @botcoin/cortex` first');
  console.error(e.message);
  process.exit(2);
}
const { pack, unpack, merkleizeState, encodePatch, applyPatch, RANGES, PATCH_TYPE, bytesToHex } = mod;

// ─── Synthetic chain ──────────────────────────────────────────────────────────

const chain = {
  events: [],
  emit(name, args) { this.events.push({ name, args, blockNumber: this.events.length + 1 }); },
  filter(name) { return this.events.filter((e) => e.name === name); },
};

// ─── Genesis state ────────────────────────────────────────────────────────────

function makeGenesisState() {
  const words = new Array(RANGES.WORD_COUNT).fill(0n);
  // Header word 0: MAGIC (255:240) + WORD_COUNT (223:208).
  words[0] = (0xC07En << 240n) | (1024n << 208n);
  // Some retrieval-key slot data so a patch can do something.
  words[400] = 1n;
  words[408] = 2n;
  return { words };
}

// ─── Mining ───────────────────────────────────────────────────────────────────

function mineSimplePatch(state) {
  const root = merkleizeState(state);
  const idx = 412; // RetrievalKeys range, not yet populated
  return {
    patchType: PATCH_TYPE.KEY_UPDATE,
    wordCount: 1,
    scoreDelta: 100n,
    parentStateRoot: root,
    indices: [idx],
    newWords: [(state.words[idx] ?? 0n) | (1n << 100n)],
  };
}

// ─── Coordinator (in-process) ────────────────────────────────────────────────

function runEpoch(epoch, state) {
  const parentRoot = merkleizeState(state);

  // Single miner submits a patch.
  const patch = mineSimplePatch(state);
  const compactBytes = encodePatch(patch);

  // Screener: applyPatch must succeed.
  const result = applyPatch(state, patch);
  if (!result.ok) {
    throw new Error(`screener rejected: ${result.code}`);
  }

  // Emit accepted event with full compactPatchBytes.
  const patchHash = '0x' + bytesToHex(keccak(compactBytes));
  const evalReportHash = '0x' + bytesToHex(keccak(new TextEncoder().encode(JSON.stringify({
    epoch, parentRoot: '0x' + bytesToHex(parentRoot), accepted: true,
  }))));
  chain.emit('CortexPatchAccepted', {
    epoch, miner: '0x' + 'a'.repeat(40),
    parentStateRoot: '0x' + bytesToHex(parentRoot),
    patchHash, evalReportHash,
    compactPatchBytes: '0x' + bytesToHex(compactBytes),
  });

  // Reducer: trivial (1 patch, no conflicts).
  const newState = result.state;
  const newRoot  = merkleizeState(newState);
  const patchSetRoot = keccak(keccak(compactBytes));

  chain.emit('CortexEpochFinalized', {
    epoch,
    parentStateRoot: '0x' + bytesToHex(parentRoot),
    patchSetRoot:    '0x' + bytesToHex(patchSetRoot),
    newStateRoot:    '0x' + bytesToHex(newRoot),
    coreVersionHash: '0x' + 'c'.repeat(64),
    experienceCorpusRoot: '0x' + 'e'.repeat(64),
  });

  return { newState, newRoot, patchSetRoot };
}

// ─── verify-epoch (chain only) ───────────────────────────────────────────────

function verifyEpoch(epoch, genesisState) {
  // Replay from genesis using only chain events.
  let state = genesisState;
  for (let e = 1; e <= epoch; e++) {
    const accepted = chain.filter('CortexPatchAccepted').filter((ev) => ev.args.epoch === e);
    for (const a of accepted) {
      const { decodePatch } = mod;
      const wireBytes = hexToBytes(a.args.compactPatchBytes);
      const patch = decodePatch(wireBytes);
      const r = applyPatch(state, patch);
      assert(r.ok, `replay applyPatch failed at epoch ${e}: ${r.ok ? '' : r.code}`);
      state = r.state;
    }
  }
  return { state, root: '0x' + bytesToHex(merkleizeState(state)) };
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function keccak(data) {
  // We can't use NIST sha3 here — we need the canonical Keccak that the rest
  // of the system uses. Use the workspace's keccak via the same dist.
  const k = mod.keccak256;
  return k(data);
}

function hexToBytes(hex) {
  const s = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i*2, i*2+2), 16);
  return out;
}

// ─── Run ──────────────────────────────────────────────────────────────────────

console.log('[golden-fixture] genesis → challenge → submit → screener → reducer → finalize → verify');

const genesis = makeGenesisState();
const genesisRoot = merkleizeState(genesis);

const e1 = runEpoch(1, genesis);
const finalized1 = chain.filter('CortexEpochFinalized')[0];
assert.equal(finalized1.args.newStateRoot, '0x' + bytesToHex(e1.newRoot), 'epoch 1 finalized root mismatch');

const e2 = runEpoch(2, e1.newState);
const finalized2 = chain.filter('CortexEpochFinalized')[1];
assert.equal(finalized2.args.newStateRoot, '0x' + bytesToHex(e2.newRoot), 'epoch 2 finalized root mismatch');

console.log(`[golden-fixture]   genesis root:      0x${bytesToHex(genesisRoot).slice(0,16)}...`);
console.log(`[golden-fixture]   epoch 1 newRoot:   ${finalized1.args.newStateRoot.slice(0,18)}...`);
console.log(`[golden-fixture]   epoch 2 newRoot:   ${finalized2.args.newStateRoot.slice(0,18)}...`);

// Clean-machine verify: replay from genesis using only chain events.
const v1 = verifyEpoch(1, genesis);
assert.equal(v1.root, finalized1.args.newStateRoot, 'verify-epoch 1 diverged from on-chain finalized');
const v2 = verifyEpoch(2, genesis);
assert.equal(v2.root, finalized2.args.newStateRoot, 'verify-epoch 2 diverged from on-chain finalized');

console.log('[golden-fixture] verify-epoch reproduces both finalized roots from chain alone');
console.log('[golden-fixture] OK');
