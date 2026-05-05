#!/usr/bin/env node
// Phase 8 sparse mid-history replay.
// Per §9 Phase 8: reproduce ≥3 finalized epoch roots starting from a snapshot
// at epoch e_k, not from genesis. Validates the snapshot path under realistic
// gap sizes.
//
// Synthetic — no RPC. Uses an in-memory chain with explicit snapshots every
// SNAPSHOT_EPOCH_INTERVAL=10 (smaller than V0's 100 to keep the test fast).

import { strict as assert } from 'node:assert';

let mod;
try {
  mod = await import('../../../packages/cortex/dist/state/index.js');
} catch (e) {
  console.error('[sparse-replay] dist not built; run `npm run build` first');
  process.exit(2);
}
const { pack, unpack, merkleizeState, encodePatch, decodePatch, applyPatch, RANGES, PATCH_TYPE, bytesToHex, keccak256 } = mod;

const SNAPSHOT_INTERVAL = 10;
const TOTAL_EPOCHS = 35; // covers 3 snapshots: at 10, 20, 30
const TARGET_EPOCHS = [25, 31, 33]; // each replayed from the latest prior snapshot

// In-memory chain
const chain = { events: [], emit(n, a) { this.events.push({ name: n, args: a }); }, filter(n) { return this.events.filter(e => e.name === n); } };

function makeGenesis() {
  const words = new Array(RANGES.WORD_COUNT).fill(0n);
  words[0] = (0xC07En << 240n) | (1024n << 208n);
  return { words };
}

function makePatchAt(state, idxOffset, scoreDelta) {
  const idx = 400 + (idxOffset % 100);
  return {
    patchType: PATCH_TYPE.KEY_UPDATE,
    wordCount: 1,
    scoreDelta: BigInt(scoreDelta),
    parentStateRoot: merkleizeState(state),
    indices: [idx],
    newWords: [(state.words[idx] ?? 0n) ^ (1n << BigInt(idxOffset % 200))],
  };
}

function hexToBytes(hex) {
  const s = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i*2, i*2+2), 16);
  return out;
}

// Build the chain: 35 epochs; one patch per epoch; snapshot every 10.
let state = makeGenesis();
const finalizedRoots = {};
for (let e = 1; e <= TOTAL_EPOCHS; e++) {
  const patch = makePatchAt(state, e, e * 10);
  const wire = encodePatch(patch);
  const r = applyPatch(state, patch);
  assert(r.ok, `epoch ${e}: ${r.ok ? '' : r.code}`);
  state = r.state;
  const root = merkleizeState(state);

  chain.emit('CortexPatchAccepted', {
    epoch: e, compactPatchBytes: '0x' + bytesToHex(wire),
  });
  chain.emit('CortexEpochFinalized', {
    epoch: e, newStateRoot: '0x' + bytesToHex(root),
  });
  finalizedRoots[e] = '0x' + bytesToHex(root);

  if (e % SNAPSHOT_INTERVAL === 0) {
    chain.emit('CortexStateSnapshot', {
      epoch: e, stateRoot: '0x' + bytesToHex(root), fullStateBytes: '0x' + bytesToHex(pack(state)),
    });
  }
}

console.log(`[sparse-replay] built ${TOTAL_EPOCHS} epochs, ${chain.filter('CortexStateSnapshot').length} snapshots`);

// Replay each target epoch starting from the latest prior snapshot, NOT genesis.
for (const target of TARGET_EPOCHS) {
  const snapshots = chain.filter('CortexStateSnapshot').filter((s) => s.args.epoch < target);
  const startSnap = snapshots[snapshots.length - 1];
  assert(startSnap, `no snapshot before epoch ${target}`);
  const startEpoch = startSnap.args.epoch;
  let st = unpack(hexToBytes(startSnap.args.fullStateBytes));
  // Replay (startEpoch, target] from chain.
  for (let e = startEpoch + 1; e <= target; e++) {
    const accepted = chain.filter('CortexPatchAccepted').filter((ev) => ev.args.epoch === e);
    for (const a of accepted) {
      const patch = decodePatch(hexToBytes(a.args.compactPatchBytes));
      const r = applyPatch(st, patch);
      assert(r.ok, `replay failed at epoch ${e}: ${r.ok ? '' : r.code}`);
      st = r.state;
    }
  }
  const reproducedRoot = '0x' + bytesToHex(merkleizeState(st));
  assert.equal(reproducedRoot, finalizedRoots[target],
    `sparse replay diverged at target epoch ${target} (started from snapshot at epoch ${startEpoch})`);
  console.log(`[sparse-replay] target=${target} from snapshot=${startEpoch}: OK`);
}

console.log(`[sparse-replay] ${TARGET_EPOCHS.length} mid-history replays reproduced byte-identically from snapshots`);
