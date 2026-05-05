#!/usr/bin/env node
// Phase 8 synthetic miner traffic.
// Runs N synthetic miners against /v1/cortex/{challenge,submit} to drive
// epochs forward. The §9 Phase 8 ≥1k-patch gate.

import { exit, env } from 'node:process';

const COORD = env.COORDINATOR_BASE ?? 'http://127.0.0.1:8081';
const N = parseInt(env.N_MINERS ?? '10', 10);
const TOTAL = parseInt(env.TOTAL_PATCHES ?? '1000', 10);

console.log(`[feed-traffic] base=${COORD} miners=${N} totalPatches=${TOTAL}`);

const miners = Array.from({ length: N }, (_, i) =>
  '0x' + i.toString(16).padStart(40, '0'));

let submitted = 0, accepted = 0, rejected = 0;

while (submitted < TOTAL) {
  const miner = miners[submitted % N];
  try {
    const challenge = await fetch(`${COORD}/v1/cortex/challenge`, {
      headers: { 'x-miner': miner },
    }).then((r) => r.ok ? r.json() : null);

    if (!challenge) { rejected++; submitted++; continue; }

    // Synthesize a tiny patch — deterministic per (miner, solveIndex).
    const patch = {
      parentStateRoot: challenge.parentStateRoot,
      targetIndices: [400 + (submitted % 250)],
      newWords: ['0x' + submitted.toString(16).padStart(64, '0')],
      patchType: 'KEY_UPDATE',
      scoreDelta: String(50 + (submitted % 100)),
    };

    const r = await fetch(`${COORD}/v1/cortex/submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-miner': miner },
      body: JSON.stringify({ challenge, patch }),
    });
    if (r.ok) accepted++; else rejected++;
  } catch (e) {
    rejected++;
  }

  submitted++;
  if (submitted % 100 === 0) {
    console.log(`[feed-traffic] ${submitted}/${TOTAL}  accepted=${accepted}  rejected=${rejected}`);
  }
}

console.log(`[feed-traffic] DONE  submitted=${submitted}  accepted=${accepted}  rejected=${rejected}`);
console.log(`[feed-traffic] pass-rate ≈ ${(100 * accepted / submitted).toFixed(1)}%`);
exit(0);
