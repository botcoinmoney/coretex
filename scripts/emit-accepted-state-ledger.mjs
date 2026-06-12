#!/usr/bin/env node
/**
 * Phase-1 canonical StateAdvanceTrace ledger emitter.
 *
 * Compiles REAL accepted miner state advances (the validated temporal lever: temporalUnits → 1 temporal
 * record + stale/current MemoryIndex slots per pair) into a cumulative substrate, recording per advance:
 *   { epoch, parentStateRoot, childStateRoot, patchId, patchFamily, profileId, corpusRoot, queryPackRoot,
 *     accepted, coveredQueryId, resolvedStateAfterRoot }
 * and writing the FINAL resolved substrate (the resolved MemoryState the renderer reads) as a sidecar.
 *
 * INVARIANT (deterministic): same corpus + same parent + same patch + same profile ⇒ same childStateRoot ⇒
 * same resolvedStateAfterRoot. No hidden qrels / answer-ids enter the ledger (only public roots + ids in
 * provenance). The ledger is the bridge mining→training; the exporter renders IR from resolvedStateAfter.
 *
 * Usage: node scripts/emit-accepted-state-ledger.mjs --corpus <c> --profile <p> [--split train_visible]
 *        [--max-advances 0] --out <ledger.jsonl>
 */
import { distIndex, repoRoot } from './_repo-root.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
const C = await import(distIndex);
const { merkleizeState, bytesToHex, encodeMemoryIndexSlot, encodeTemporalRecord, stableRecordIdFor } = C;
const { RANGES } = await import(resolve(repoRoot, 'packages/coretex/dist/state/types.js'));
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const base = 'release/calibration/2026-05-21-memory-corpus-v2';
const corpusPath = flag('corpus', `${base}/dgen1-r5-synth-corpus.json`);
const profilePath = flag('profile', 'release/bundle/evaluator-profile-v2-dgen1-policy-r5.json');
const splitFilter = flag('split', 'train_visible');
const maxAdvances = Number(flag('max-advances', '0')); // 0 = all (cap 96 temporal pairs)
const out = flag('out', `${base}/accepted-state-ledger.jsonl`);
const stateOut = out.replace(/\.jsonl$/, '') + '.state.json';

const profile = JSON.parse(readFileSync(resolve(repoRoot, profilePath), 'utf8'));
const profileId = profile.name ?? 'profile';
// RAW corpus only (embeddings-free): the ledger needs query/qrel structure for temporalUnits, not vectors.
const raw = JSON.parse(readFileSync(resolve(repoRoot, corpusPath), 'utf8'));
const logicalQById = new Map(raw.queries.map((q) => [q.id, q]));
const corpusRoot = '0x' + createHash('sha256').update(raw.docs.map((d) => d.id).sort().join('|')).digest('hex').slice(0, 32);  // deterministic corpus hash (provenance)
const stateRoot = (s) => { const h = bytesToHex(merkleizeState(s)); return h.startsWith('0x') ? h : '0x' + h; };
const patchHash = (indices, words) => '0x' + createHash('sha256').update(indices.map((ix, k) => `${ix}:${words[k].toString(16)}`).join('|')).digest('hex').slice(0, 32);

// pack: temporal queries from the split (the minable set). temporalUnits reads ev.id → logicalQById.
const packEvents = raw.queries.filter((q) => (q.split ?? 'eval_hidden') === splitFilter && q.family === 'temporal_update').map((q) => ({ id: q.id }));
const pack = { events: packEvents, corpusRoot, epochId: 0 };
const queryPackRoot = '0x' + createHash('sha256').update(packEvents.map((e) => e.id).sort().join('|')).digest('hex').slice(0, 32);

// minable temporal queries from the pack (each has a direct=current + stale qrel docs).
const minable = packEvents.map((e) => logicalQById.get(e.id)).filter((q) => q && (q.qrels ?? []).some((r) => r.role === 'direct') && (q.qrels ?? []).some((r) => r.role === 'stale'));
// --shuffle-seed: rotate the mined COHORT (a churn frontier mines a different slice than the static one).
const shuffleSeed = flag('shuffle-seed', null);
if (shuffleSeed !== null) { let s = (Number(shuffleSeed) * 2654435761) >>> 0; const rnd = () => { s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 1) >>> 0; return s / 4294967296; }; for (let i = minable.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [minable[i], minable[j]] = [minable[j], minable[i]]; } }
let state = { words: new Array(1024).fill(0n) };
const ledger = [];
const cap = maxAdvances > 0 ? maxAdvances : 96;
for (let recordSlot = 0; recordSlot < Math.min(cap, 96, minable.length); recordSlot++) {
  const q = minable[recordSlot];
  const curDoc = (q.qrels ?? []).find((r) => r.role === 'direct').docId;
  const staleQ = (q.qrels ?? []).filter((r) => r.role === 'stale').map((r) => r.docId);
  if (!staleQ.length) continue;
  const staleDoc = staleQ[0];
  // compile ONE accepted temporal advance: stale slot (revoked) + current slot + temporal record.
  // policyAnchor=true → the slots RESOLVE lifecycle (decoded.temporal) + drive temporal modulation,
  // but are EXCLUDED from anchor-mandatory routing (no candidate-pool flood on unrelated queries).
  const staleSlot = recordSlot * 2, curSlot = recordSlot * 2 + 1;
  const sw = encodeMemoryIndexSlot({ slotIndex: staleSlot, recordId: stableRecordIdFor(`mem_${staleDoc}`), family: 'temporal', domainBits: 1n, valid: true, revoked: true, protected: false, policyAnchor: true, retrievalSlot: 0, expiryEpoch: 0n })[0];
  const cw = encodeMemoryIndexSlot({ slotIndex: curSlot, recordId: stableRecordIdFor(`mem_${curDoc}`), family: 'temporal', domainBits: 1n, valid: true, revoked: false, protected: false, policyAnchor: true, retrievalSlot: 0, expiryEpoch: 0n })[0];
  const tw = encodeTemporalRecord({ recordIndex: recordSlot, memorySlot: staleSlot, supersededBy: curSlot, validFromEpoch: 1n, validUntilEpoch: (2n ** 40n - 1n), currentStaleFlag: true });
  const indices = [RANGES.MEMORY_INDEX_START + staleSlot, RANGES.MEMORY_INDEX_START + curSlot, RANGES.TEMPORAL_START + recordSlot];
  const newWords = [sw, cw, tw[0]];
  const parentStateRoot = stateRoot(state);
  const child = { words: [...state.words] };
  for (let k = 0; k < indices.length; k++) child.words[indices[k]] = newWords[k];
  const childStateRoot = stateRoot(child);
  ledger.push({
    epoch: recordSlot, parentStateRoot, childStateRoot, patchId: patchHash(indices, newWords),
    patchFamily: 'temporal', profileId, corpusRoot, queryPackRoot,
    accepted: true, deltaPpm: null, coveredQueryId: q.id, minedDocId: curDoc,
    resolvedStateAfterRoot: childStateRoot,
  });
  state = child;
}

writeFileSync(resolve(repoRoot, out), ledger.map((r) => JSON.stringify(r)).join('\n') + '\n');
writeFileSync(resolve(repoRoot, stateOut), JSON.stringify({ corpusRoot, profileId, split: splitFilter, advances: ledger.length, finalStateRoot: stateRoot(state), words: state.words.map((w) => w.toString()) }));
console.log(JSON.stringify({ split: splitFilter, advances: ledger.length, finalStateRoot: stateRoot(state), corpusRoot, queryPackRoot, ledger: out, state: stateOut, sample: ledger[0] }, null, 2));
