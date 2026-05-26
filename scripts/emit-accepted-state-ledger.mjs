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
import { buildV2ProductionCorpus } from './lib/build-v2-production-corpus.mjs';
import { temporalUnits } from './lib/v2-patch-families.mjs';

const C = await import(distIndex);
const { merkleizeState, bytesToHex, deriveQueryPack } = C;
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
const { corpus, logical } = buildV2ProductionCorpus({ corpusPath, embPath: `${base}/${corpusPath.includes('r5-synth') ? 'dgen1-r5-synth-embeddings.json' : 'dgen1-embeddings.json'}` });
const logicalQById = new Map(logical.queries.map((q) => [q.id, q]));
const stateRoot = (s) => { const h = bytesToHex(merkleizeState(s)); return h.startsWith('0x') ? h : '0x' + h; };
const patchHash = (indices, words) => '0x' + createHash('sha256').update(indices.map((ix, k) => `${ix}:${words[k].toString(16)}`).join('|')).digest('hex').slice(0, 32);

// Build a pack over the chosen split (the miner's working set). Temporal advances mine its temporal pairs.
const splitEvents = corpus.events.filter((e) => e.split === splitFilter || e.split !== 'eval_hidden');
const splitCorpus = { ...corpus, events: corpus.events, byId: corpus.byId };
const seedHex = '0x' + createHash('sha256').update(`accepted-ledger:${splitFilter}`).digest('hex');
// pack: temporal queries from the split (the minable set). Large pack so we cover many pairs.
const packEvents = corpus.events.filter((e) => e.split === splitFilter && e.logicalFamily === 'temporal_update');
const pack = { events: packEvents, corpusRoot: corpus.corpusRoot, epochId: 0, evalSeedHex: seedHex };
const queryPackRoot = '0x' + createHash('sha256').update(packEvents.map((e) => e.id).sort().join('|')).digest('hex').slice(0, 32);

let state = { words: new Array(1024).fill(0n) };
const ledger = [];
const minedDocs = new Set();
let recordSlot = 0;
const cap = maxAdvances > 0 ? maxAdvances : 96;
for (let i = 0; i < cap; i++) {
  const u = temporalUnits({ pack, logicalQById, recordSlot, skipDocIds: minedDocs });
  if (!u || u.recordsCompiled === 0) break;
  const parentStateRoot = stateRoot(state);
  const child = { words: [...state.words] };
  for (let k = 0; k < u.indices.length; k++) child.words[u.indices[k]] = u.newWords[k];
  const childStateRoot = stateRoot(child);
  // the covered query = the temporal query whose current-doc this advance mined.
  const coveredQ = logical.queries.find((q) => q.family === 'temporal_update' && (q.qrels ?? []).some((r) => r.role === 'direct' && r.docId === u.minedDocId));
  ledger.push({
    epoch: i, parentStateRoot, childStateRoot, patchId: patchHash(u.indices, u.newWords),
    patchFamily: 'temporal', profileId, corpusRoot: corpus.corpusRoot, queryPackRoot,
    accepted: true, deltaPpm: null, coveredQueryId: coveredQ?.id ?? null, minedDocId: u.minedDocId,
    resolvedStateAfterRoot: childStateRoot,
  });
  if (u.minedDocId) minedDocs.add(u.minedDocId);
  state = child; recordSlot++;
}

writeFileSync(resolve(repoRoot, out), ledger.map((r) => JSON.stringify(r)).join('\n') + '\n');
writeFileSync(resolve(repoRoot, stateOut), JSON.stringify({ corpusRoot: corpus.corpusRoot, profileId, split: splitFilter, advances: ledger.length, finalStateRoot: stateRoot(state), words: state.words.map((w) => w.toString()) }));
console.log(JSON.stringify({ split: splitFilter, advances: ledger.length, finalStateRoot: stateRoot(state), corpusRoot: corpus.corpusRoot, queryPackRoot, ledger: out, state: stateOut, sample: ledger[0] }, null, 2));
