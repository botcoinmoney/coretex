// Baseline A — Empty Cortex.
// All-zero state with only the header magic populated. Floor / control.
// Heuristic miner: does nothing useful (always returns null).

import { WORD_COUNT, RANGES, PATCH_TYPE, buildHeaderWord0, makePatch } from '../types.mjs';

export const BASELINE_ID = 'A';
export const BASELINE_NAME = 'empty';

export function genesisState() {
  const words = new Array(WORD_COUNT).fill(0n);
  words[0] = buildHeaderWord0(1); // magic + genesis flag
  // Header word 8: SNAPSHOT_INTERVAL (191:128) = 100
  words[8] = (100n << 128n);
  return { words };
}

export function mineCandidatePatch(_state, _shardDescriptor) {
  // Empty baseline can't usefully patch — return null (no submission).
  return null;
}
