#!/usr/bin/env node
/**
 * Step-5 FULL-benchmark reranker arm (nDCG, not pairwise). One arm per invocation so the FORMAT lift
 * and the TUNING lift are cleanly separated (auditor):
 *   E0-raw  : base reranker,    --mir off   (no Memory-IR render)
 *   E0+F2   : base reranker,    --mir F2    (scorer renders the lifecycle header)
 *   E1+F2   : adapter reranker, --mir F2    (set CORETEX_RERANKER_ADAPTER_DIR; E1 LoRA)
 * Run each × substrate ON (r5 profile temporal modulation) vs OFF (--substrate-off) for the residual.
 * Reports overall + temporal-slice nDCG@10. Same pack/seed across arms → directly comparable.
 *
 * Usage: node scripts/probe-reranker-fullbench.mjs --mir off|F2 [--substrate-off] --reranker gpu --out <json>
 */
import { distIndex, repoRoot } from './_repo-root.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildV2ProductionCorpus, inertBiEncoder } from './lib/build-v2-production-corpus.mjs';
import { makeStreamReranker } from './lib/stream-reranker.mjs';

const C = await import(distIndex);
const { scoringOptionsFromProfile, deriveQueryPack, evaluateRetrievalBenchmarkState, createDeterministicReranker } = C;
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const has = (n) => argv.includes(`--${n}`);
const base = 'release/calibration/2026-05-21-memory-corpus-v2';
const mir = flag('mir', 'off');
const substrateOff = has('substrate-off');
const rerankerArg = flag('reranker', 'deterministic');
const packSize = Number(flag('pack-size', '64'));
const out = flag('out', `/tmp/fullbench-${mir}${substrateOff ? '-subOFF' : ''}.json`);

const r5 = JSON.parse(readFileSync(resolve(repoRoot, 'release/bundle/evaluator-profile-v2-dgen1-policy-r5.json'), 'utf8'));
const { corpus, logical, LAYOUT, BE, RR, biEncoderHash } = buildV2ProductionCorpus({ corpusPath: `${base}/dgen1-r5-synth-corpus.json`, embPath: `${base}/dgen1-r5-synth-embeddings.json` });
const reranker = rerankerArg === 'gpu'
  ? makeStreamReranker({ model: RR.modelId, revision: RR.revision, python: process.env.CORETEX_RERANKER_PYTHON ?? '/usr/bin/python3', allowCuda: true })
  : await createDeterministicReranker();
const irSource = flag('ir-source', 'corpus');         // corpus | resolved (resolved needs --substrate)
const substratePath = flag('substrate', null);         // resolved-state sidecar (ledger .state.json)
const rt = { biEncoder: inertBiEncoder(BE, LAYOUT), reranker, biEncoderHash, retrievalKeyLayout: LAYOUT };
const opts = { ...scoringOptionsFromProfile(r5, rt), exposeFullRanking: true };
opts.rerankerMemoryIRFormat = mir === 'F2' ? 'F2' : 'off';
opts.rerankerMemoryIRSource = irSource === 'resolved' ? 'resolved' : 'corpus';
if (substrateOff) {  // substrate OFF: kill the temporal modulation channel (isolate the residual)
  opts.temporalCurrentBoost = 0; opts.temporalStaleSuppression = 0; opts.temporalStaleContrast = false;
}
const famOf = new Map(logical.queries.map((q) => [q.id, q.family]));
const seedHex = '0x' + 'd5'.repeat(32);
const pack = deriveQueryPack(1, seedHex, corpus, { ...r5.hiddenPack, packSize, quotas: [] });
// substrate = the ledger's resolved state (so resolved-IR + temporal modulation are EARNED) or empty.
const substrate = substratePath
  ? { words: JSON.parse(readFileSync(resolve(repoRoot, substratePath), 'utf8')).words.map((w) => BigInt(w)) }
  : { words: new Array(1024).fill(0n) };
const R = await evaluateRetrievalBenchmarkState(substrate, corpus, pack, opts);

const fam = {};
for (const q of R.perQuery) { const f = famOf.get(q.recordId) ?? q.family; (fam[f] ??= []).push(q.nDCG10); }
const mean = (a) => (a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(4) : 0);
const report = {
  arm: `${mir === 'F2' ? (process.env.CORETEX_RERANKER_ADAPTER_DIR ? 'E1+F2' : 'E0+F2') : 'E0-raw'}${substrateOff ? ' (substrate OFF)' : ''}`,
  mir, substrateOff, adapter: process.env.CORETEX_RERANKER_ADAPTER_DIR ?? null,
  reranker: rerankerArg === 'gpu' ? `Qwen3-Reranker-0.6B@${RR.revision} (gpu)` : 'deterministic',
  packSize: pack.events.length, overall_nDCG10: +R.nDCG10.toFixed(4),
  temporal_nDCG10: mean(fam.temporal_update ?? []), byFamily: Object.fromEntries(Object.entries(fam).map(([k, v]) => [k, { n: v.length, nDCG10: mean(v) }])),
};
writeFileSync(resolve(out.startsWith('/') ? out : resolve(repoRoot, out)), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (typeof reranker.close === 'function') reranker.close();
