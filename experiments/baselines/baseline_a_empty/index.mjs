// Baseline A — Empty Cortex.
// All-zero state with only the header magic populated. Floor / control.
// Corpus-aware miner: when given a corpus, encodes the next uncovered
// long-horizon event into a memory_index slot. Without a corpus, returns
// null — the empty baseline has nothing else useful to write.

import { WORD_COUNT, RANGES, PATCH_TYPE, buildHeaderWord0, makePatch, setField } from '../types.mjs';
import { eventIdToMem128 } from '../../harness/cortex-bench-eval.mjs';

export const BASELINE_ID = 'A';
export const BASELINE_NAME = 'empty';

export function genesisState() {
  const words = new Array(WORD_COUNT).fill(0n);
  words[0] = buildHeaderWord0(1); // magic + genesis flag
  // Header word 8: SNAPSHOT_INTERVAL (191:128) = 100
  words[8] = (100n << 128n);
  return { words };
}

export function mineCandidatePatch(state, shardDescriptor, opts = {}) {
  const corpus = opts.corpus;
  if (!corpus) return null;
  const events = corpus.events.long_horizon;
  if (events.length === 0) return null;

  const occupied = new Set();
  const freeSlots = [];
  for (let s = 0; s < 44; s++) {
    const w0 = state.words[RANGES.MEMORY_INDEX_START + s * 8] ?? 0n;
    if (w0 === 0n) freeSlots.push(s);
    else occupied.add((w0 >> 128n) & ((1n << 128n) - 1n));
  }
  if (freeSlots.length === 0) return null;

  const indices = [];
  const newWords = [];
  let probe = Number(BigInt(shardDescriptor?.solveIndex ?? 0) % BigInt(events.length));
  let probesUsed = 0;
  while (indices.length < 4 && indices.length < freeSlots.length && probesUsed < events.length) {
    const ev = events[probe];
    probe = (probe + 1) % events.length;
    probesUsed++;
    const eid = eventIdToMem128(ev.id);
    if (occupied.has(eid)) continue;
    occupied.add(eid);
    const slot = freeSlots[indices.length];
    let w0 = 0n;
    w0 = setField(w0, 255, 128, eid);
    w0 = setField(w0, 127, 96,  1n);
    w0 = setField(w0, 95, 80,   1n);
    w0 = setField(w0, 79, 64,   1n);
    indices.push(RANGES.MEMORY_INDEX_START + slot * 8);
    newWords.push(w0);
  }
  if (indices.length === 0) return null;

  return makePatch(
    PATCH_TYPE.SLOT_REPLACE,
    indices,
    newWords,
    250n,
    new Uint8Array(32),
  );
}
