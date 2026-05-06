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
  // Payload words inside RetrievalKeys slots — these positions accept
  // arbitrary 256-bit values (no reserved-bit constraints, unlike each
  // slot's word-0 which has a reserved tail in bits 79:0).
  // slot k (0..35), payload word offset 1..7 → idx = 384 + 8k + off.
  words[385] = 1n;  // slot 0, word 1
  words[393] = 2n;  // slot 1, word 1
  return { words };
}

// ─── Mining ───────────────────────────────────────────────────────────────────

function mineSimplePatch(state, epoch) {
  const root = merkleizeState(state);
  // Pick a payload word inside a different RetrievalKeys slot per epoch so
  // back-to-back epochs never produce no-op patches (E05). slot k word 3,
  // k = epoch (mod 32), idx = 384 + 8*k + 3.
  const slot = epoch % 32;
  const idx = 384 + 8 * slot + 3;
  return {
    patchType: PATCH_TYPE.KEY_UPDATE,
    wordCount: 1,
    scoreDelta: 100n,
    parentStateRoot: root,
    indices: [idx],
    newWords: [(state.words[idx] ?? 0n) ^ (1n << BigInt(50 + (epoch % 100)))],
  };
}

// ─── Coordinator (in-process) ────────────────────────────────────────────────

function runEpoch(epoch, state) {
  const parentRoot = merkleizeState(state);

  // Single miner submits a patch (epoch-indexed slot so consecutive epochs
  // never produce identical no-op patches against the same word).
  const patch = mineSimplePatch(state, epoch);
  const compactBytes = encodePatch(patch);

  // Screener: applyPatch must succeed.
  const result = applyPatch(state, patch);
  if (!result.ok) {
    throw new Error(`screener rejected: ${result.code}`);
  }

  // Emit accepted event with full compactPatchBytes.
  const patchHash = bytesToHex(keccak(compactBytes));
  const evalReportHash = bytesToHex(keccak(new TextEncoder().encode(JSON.stringify({
    epoch, parentRoot: bytesToHex(parentRoot), accepted: true,
  }))));
  chain.emit('CortexPatchAccepted', {
    epoch, miner: '0x' + 'a'.repeat(40),
    parentStateRoot: bytesToHex(parentRoot),
    patchHash, evalReportHash,
    compactPatchBytes: bytesToHex(compactBytes),
  });

  // Reducer: trivial (1 patch, no conflicts).
  const newState = result.state;
  const newRoot  = merkleizeState(newState);
  const patchSetRoot = keccak(keccak(compactBytes));

  chain.emit('CortexEpochFinalized', {
    epoch,
    parentStateRoot: bytesToHex(parentRoot),
    patchSetRoot:    bytesToHex(patchSetRoot),
    newStateRoot:    bytesToHex(newRoot),
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
  return { state, root: bytesToHex(merkleizeState(state)) };
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
assert.equal(finalized1.args.newStateRoot, bytesToHex(e1.newRoot), 'epoch 1 finalized root mismatch');

const e2 = runEpoch(2, e1.newState);
const finalized2 = chain.filter('CortexEpochFinalized')[1];
assert.equal(finalized2.args.newStateRoot, bytesToHex(e2.newRoot), 'epoch 2 finalized root mismatch');

console.log(`[golden-fixture]   genesis root:      ${bytesToHex(genesisRoot).slice(0,18)}...`);
console.log(`[golden-fixture]   epoch 1 newRoot:   ${finalized1.args.newStateRoot.slice(0,18)}...`);
console.log(`[golden-fixture]   epoch 2 newRoot:   ${finalized2.args.newStateRoot.slice(0,18)}...`);

// Clean-machine verify: replay from genesis using only chain events.
const v1 = verifyEpoch(1, genesis);
assert.equal(v1.root, finalized1.args.newStateRoot, 'verify-epoch 1 diverged from on-chain finalized');
const v2 = verifyEpoch(2, genesis);
assert.equal(v2.root, finalized2.args.newStateRoot, 'verify-epoch 2 diverged from on-chain finalized');

console.log('[golden-fixture] verify-epoch reproduces both finalized roots from chain alone');
console.log('[golden-fixture] OK');
