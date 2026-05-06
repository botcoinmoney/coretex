// Baseline D — Late-interaction (multi-vector) Cortex.
// Header populated; RetrievalKeys populated with multi-slot vectors per
// WARP-style late-interaction (one slot per "token", many slots per record).
// Corpus-aware miner: rewrites the lead slot of a record so its KEY_ID maps
// to the next uncovered near-collision corpus event. The 4 slots of a
// record share KEY_ID, so updating the lead slot is sufficient to register
// retrieval coverage.

import { WORD_COUNT, RANGES, PATCH_TYPE, buildHeaderWord0, makePatch, randBigInt256, xorShift32, setField } from '../types.mjs';
import { eventIdToKey128 } from '../../harness/cortex-bench-eval.mjs';

export const BASELINE_ID = 'D';
export const BASELINE_NAME = 'late-interaction';

export function genesisState() {
  const words = new Array(WORD_COUNT).fill(0n);
  words[0] = buildHeaderWord0(1);
  words[8] = (100n << 128n);

  const rng = xorShift32(0xD17);
  for (let record = 0; record < 9; record++) {
    const recordKeyId = randBigInt256(rng) >> 128n;
    for (let v = 0; v < 4; v++) {
      const slot = record * 4 + v;
      const base = RANGES.RETRIEVAL_KEYS_START + slot * 8;
      const meta = ((recordKeyId & ((1n << 128n) - 1n)) << 128n)
                 | (0x0002n << 112n)
                 | (256n    << 96n)
                 | (0x0001n << 80n);
      words[base] = meta;
      for (let w = 1; w < 8; w++) words[base + w] = randBigInt256(rng);
    }
  }
  return { words };
}

export function mineCandidatePatch(state, shardDescriptor, opts = {}) {
  const corpus = opts.corpus;
  if (!corpus) {
    const slot = 2 * 4 + 1;
    const idx = RANGES.RETRIEVAL_KEYS_START + slot * 8 + 3;
    const current = state.words[idx] ?? 0n;
    const seed = BigInt(shardDescriptor?.solveIndex ?? 0);
    const newWord = current ^ ((1n << ((seed % 256n))) | (1n << (((seed * 31n) % 256n))));
    if (newWord === current) return null;
    return makePatch(PATCH_TYPE.KEY_UPDATE, [idx], [newWord], 200n, new Uint8Array(32));
  }

  const events = corpus.events.near_collision;
  if (events.length === 0) return null;

  // Multi-vector layout: 9 records × 4 slots-per-record. Updating the lead
  // slot of a record changes the KEY_ID for all 4 slots (they share id).
  // We update up to 4 record-leads per patch.
  const recordIds = [];
  const presentIds = new Set();
  for (let r = 0; r < 9; r++) {
    const lead = state.words[RANGES.RETRIEVAL_KEYS_START + r * 4 * 8] ?? 0n;
    const id = (lead >> 128n) & ((1n << 128n) - 1n);
    recordIds.push(id);
    presentIds.add(id);
  }

  const indices = [];
  const newWords = [];
  let probe = Number(BigInt(shardDescriptor?.solveIndex ?? 0) % BigInt(events.length));
  let recordProbe = Number(BigInt(shardDescriptor?.solveIndex ?? 0) % 9n);
  let probesUsed = 0;
  let recordsUsed = 0;
  while (indices.length < 4 && probesUsed < events.length && recordsUsed < 9) {
    const ev = events[probe];
    probe = (probe + 1) % events.length;
    probesUsed++;
    const kid = eventIdToKey128(ev.id);
    if (presentIds.has(kid)) continue;

    let recordIdx = -1;
    for (let i = 0; i < 9; i++) {
      const cand = (recordProbe + i) % 9;
      const ix = RANGES.RETRIEVAL_KEYS_START + cand * 4 * 8;
      if (!indices.includes(ix)) { recordIdx = cand; break; }
    }
    if (recordIdx < 0) break;
    recordProbe = (recordIdx + 1) % 9;
    recordsUsed++;

    presentIds.delete(recordIds[recordIdx]);
    recordIds[recordIdx] = kid;
    presentIds.add(kid);

    let meta = 0n;
    meta = setField(meta, 255, 128, kid);
    meta = setField(meta, 127, 112, 0x0002n);
    meta = setField(meta, 111, 96,  256n);
    meta = setField(meta, 95, 80,   0x0001n);
    indices.push(RANGES.RETRIEVAL_KEYS_START + recordIdx * 4 * 8);
    newWords.push(meta);
  }
  if (indices.length === 0) return null;

  return makePatch(
    PATCH_TYPE.KEY_UPDATE,
    indices,
    newWords,
    200n,
    new Uint8Array(32),
  );
}
