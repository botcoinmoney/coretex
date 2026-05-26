#!/usr/bin/env node
/**
 * Phase-2 hardening probe: the Memory-IR renderer must read RESOLVED MemoryState, not static corpus labels.
 *
 * resolved MemoryState = corpus primitives + baseline substrate + miner STATE_ADVANCE patch.
 * The miner patch compiles temporal records (stale slot revoked + current slot + temporal record); the
 * scorer resolves lifecycle from decoded.temporal (temporalBoost/Suppress sets); the renderer emits
 * lifecycle from THAT (rerankerMemoryIRSource='resolved'), so the F2 lift is EARNED by the patch.
 *
 * Proves two things:
 *  (1) CONSISTENCY  — with the miner temporal patch compiled, resolved-state lifecycle == corpus lifecycle
 *                     for the compiled docs (the renderer reading resolved state == reading corpus, but earned).
 *  (2) EARNED       — with an EMPTY substrate, resolved-source F2 renders NO lifecycle headers (all 'none')
 *                     → no free lift from corpus; corpus-source F2 on empty substrate DOES (the convenience path).
 * Then GPU arms: A empty/off · B empty/F2-corpus · C compiled/F2-resolved (+ C_sub compiled/off = modulation only).
 *
 * Usage: node scripts/probe-resolved-state-f2.mjs [--reranker gpu] [--pack-size 64] [--out ..]
 */
import { distIndex, repoRoot } from './_repo-root.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildV2ProductionCorpus, inertBiEncoder } from './lib/build-v2-production-corpus.mjs';
import { makeStreamReranker } from './lib/stream-reranker.mjs';
import { temporalUnits } from './lib/v2-patch-families.mjs';

const C = await import(distIndex);
const { scoringOptionsFromProfile, deriveQueryPack, evaluateRetrievalBenchmarkState, createDeterministicReranker } = C;
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const base = 'release/calibration/2026-05-21-memory-corpus-v2';
const rerankerArg = flag('reranker', 'deterministic');
const packSize = Number(flag('pack-size', '64'));
const out = flag('out', `${base}/resolved-state-f2.json`);

const r5 = JSON.parse(readFileSync(resolve(repoRoot, 'release/bundle/evaluator-profile-v2-dgen1-policy-r5.json'), 'utf8'));
const { corpus, logical, LAYOUT, BE, RR, biEncoderHash } = buildV2ProductionCorpus({ corpusPath: `${base}/dgen1-r5-synth-corpus.json`, embPath: `${base}/dgen1-r5-synth-embeddings.json` });
const logicalQById = new Map(logical.queries.map((q) => [q.id, q]));
const reranker = rerankerArg === 'gpu'
  ? makeStreamReranker({ model: RR.modelId, revision: RR.revision, python: process.env.CORETEX_RERANKER_PYTHON ?? '/usr/bin/python3', allowCuda: true })
  : await createDeterministicReranker();
const rt = { biEncoder: inertBiEncoder(BE, LAYOUT), reranker, biEncoderHash, retrievalKeyLayout: LAYOUT };
const baseOpts = scoringOptionsFromProfile(r5, rt);
const seedHex = '0x' + 'e7'.repeat(32);
const pack = deriveQueryPack(1, seedHex, corpus, { ...r5.hiddenPack, packSize, quotas: [] });

// ── miner STATE_ADVANCE patch: compile temporal records for the pack's temporal queries (resolves lifecycle).
const empty = () => ({ words: new Array(1024).fill(0n) });
const compiled = empty();
const minedCurrentDocs = new Set();
let recordSlot = 0;
for (let i = 0; i < 96; i++) {
  const u = temporalUnits({ pack, logicalQById, recordSlot, skipDocIds: minedCurrentDocs });
  if (!u || u.recordsCompiled === 0) break;
  for (let k = 0; k < u.indices.length; k++) compiled.words[u.indices[k]] = u.newWords[k];
  if (u.minedDocId) minedCurrentDocs.add(u.minedDocId);
  recordSlot++;
}
console.error(`[resolved-f2] compiled ${recordSlot} temporal records (miner patch) for pack temporal queries`);

const F2 = (substrate, source) => ({ ...baseOpts, exposeFullRanking: true, rerankerMemoryIRFormat: 'F2', rerankerMemoryIRSource: source });
const famOf = new Map(logical.queries.map((q) => [q.id, q.family]));
const tmean = (sc) => { const v = sc.perQuery.filter((q) => famOf.get(q.recordId) === 'temporal_update').map((q) => q.nDCG10); return v.length ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(4) : 0; };

// CONSISTENCY + EARNED checks need the rendered docs; we infer lifecycle coverage via temporal-slice nDCG
// deltas (the renderer's effect). Direct render-string capture is covered by preflight-f2-golden-render.mjs.
const arms = {};
const run = async (label, substrate, opts) => { const r = await evaluateRetrievalBenchmarkState(substrate, corpus, pack, opts); arms[label] = { overall: +r.nDCG10.toFixed(4), temporal: tmean(r) }; console.error(`[resolved-f2] ${label}: overall=${arms[label].overall} temporal=${arms[label].temporal}`); };

await run('A_empty_off', empty(), { ...baseOpts });
await run('B_empty_F2corpus', empty(), F2(empty(), 'corpus'));
await run('B2_empty_F2resolved_EARNEDcheck', empty(), F2(empty(), 'resolved'));  // must ≈ A (no headers; lift not free)
await run('Csub_compiled_off', compiled, { ...baseOpts });                        // substrate temporal modulation only
await run('C_compiled_F2resolved', compiled, F2(compiled, 'resolved'));           // EARNED format lift from resolved state

const report = {
  probe: 'resolved-state-f2 (Phase 2: renderer reads RESOLVED state, not corpus labels)',
  generatedAt: new Date().toISOString(), reranker: rerankerArg === 'gpu' ? `Qwen3-Reranker-0.6B (gpu)` : 'deterministic', packSize: pack.events.length, compiledRecords: recordSlot,
  arms,
  interpretation: {
    formatLift_corpus_B_minus_A: +(arms.B_empty_F2corpus.temporal - arms.A_empty_off.temporal).toFixed(4),
    EARNED_check_B2_minus_A: +(arms.B2_empty_F2resolved_EARNEDcheck.temporal - arms.A_empty_off.temporal).toFixed(4),
    substrateModulation_Csub_minus_A: +(arms.Csub_compiled_off.temporal - arms.A_empty_off.temporal).toFixed(4),
    resolvedFormatLift_C_minus_Csub: +(arms.C_compiled_F2resolved.temporal - arms.Csub_compiled_off.temporal).toFixed(4),
    note: 'EARNED_check must be ≈0 (resolved F2 on EMPTY substrate renders no headers → no free lift). resolvedFormatLift (C−Csub) is the format lift EARNED by the miner patch resolving lifecycle. Target: C−Csub ≈ B−A (resolved renderer earns the same lift corpus-labels gave for free).',
  },
};
writeFileSync(resolve(repoRoot, out), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (typeof reranker.close === 'function') reranker.close();
