#!/usr/bin/env node
/**
 * Diagnose why conflict_lifecycle PolicyAtoms accept on the isolated probe but reject
 * `no_retrieval_improvement` under mixed endurance on 0x2d953b71.
 *
 * Replays the same active-pack derivation the live-evolve harness uses, builds ONE
 * conflict patch with scripts/lib/v2-patch-families.mjs:conflictUnits, applies it,
 * decodes the substrate, scores the pack with policyEmitTraces=true, and prints:
 *   - decoded conflict atom count
 *   - per pack-query: conflict intent? entity match? policy traces? rank deltas
 *   - which queries the atom fires on and which it does not
 *
 * No A100 — deterministic scoring is enough to expose whether the atom is firing at all.
 *
 * Usage:
 *   node scripts/diag-conflict-mixed-root-cause.mjs \
 *     --bundle release/bundle/bundle-manifest-v2-dgen1-policy-r5-300k-launch-reduced.json \
 *     --profile release/bundle/evaluator-profile-v2-dgen1-policy-r5-300k-launch-reduced.json \
 *     --corpus release/calibration/2026-05-21-memory-corpus-v2/dgen1-r5-synth-300k-v15-corpus.json \
 *     --emb release/calibration/2026-05-21-memory-corpus-v2/dgen1-r5-synth-300k-v15-embeddings.json \
 *     --pack-size 64 \
 *     --out release/calibration/2026-05-21-memory-corpus-v2/conflict-mixed-root-cause-diag-2d953b71.json
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import process from 'node:process';
import { distIndex, repoRoot } from './_repo-root.mjs';
import { inertBiEncoder } from './lib/build-v2-production-corpus.mjs';
import { loadMaterializedCorpus } from './lib/load-materialized-corpus.mjs';
import { conflictUnits } from './lib/v2-patch-families.mjs';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };

const BUNDLE_PATH = flag('bundle', 'release/bundle/bundle-manifest-v2-dgen1-policy-r5-300k-launch-reduced.json');
const PROFILE_PATH = flag('profile', 'release/bundle/evaluator-profile-v2-dgen1-policy-r5-300k-launch-reduced.json');
const CORPUS_PATH = flag('corpus', 'release/calibration/2026-05-21-memory-corpus-v2/dgen1-r5-synth-300k-v15-corpus.json');
const EMB_PATH = flag('emb', 'release/calibration/2026-05-21-memory-corpus-v2/dgen1-r5-synth-300k-v15-embeddings.json');
const PACK_SIZE = Number(flag('pack-size', '64'));
const OUT = flag('out', 'release/calibration/2026-05-21-memory-corpus-v2/conflict-mixed-root-cause-diag-2d953b71.json');

const C = await import(distIndex);
const {
  scoringOptionsFromProfile, deriveQueryPack,
  evaluateRetrievalBenchmarkState, applyPatch, decodeSubstrate,
  parseQueryConflictIntent,
  createDeterministicReranker, biEncoderModelIdHash, makeLaunchFrontier,
  PATCH_TYPE, merkleizeState, RANGES,
} = C;

const profile = JSON.parse(readFileSync(resolve(repoRoot, PROFILE_PATH), 'utf8'));
console.log('[diag-conflict] loading materialized base corpus ...');
const baseBundle = loadMaterializedCorpus(BUNDLE_PATH, { sourceCorpusPath: CORPUS_PATH, sourceEmbPath: EMB_PATH });
const currentProd = baseBundle.corpus;
const { BE, RR, LAYOUT } = baseBundle;
const rawCorpus = JSON.parse(readFileSync(resolve(repoRoot, CORPUS_PATH), 'utf8'));
const logicalQById = new Map(rawCorpus.queries.map((q) => [q.id, q]));
const eventByDocId = new Map(); for (const ev of currentProd.events) eventByDocId.set(ev.id, ev);
const docById = new Map(rawCorpus.docs.map((d) => [d.id, d]));
console.log(`[diag-conflict] bundle ${baseBundle.manifest.bundleHash} corpus ${currentProd.events.length} events`);

const reranker = await createDeterministicReranker();
const biEncoderHash = biEncoderModelIdHash(BE.modelId, BE.revision, 'dense');
const rt = () => ({ biEncoder: inertBiEncoder(BE, LAYOUT), reranker, biEncoderHash, retrievalKeyLayout: LAYOUT });
// REPLICATE the harness exactly: scoringOptionsFromProfile + traces. No registry passed.
const baseOpts = () => ({ ...scoringOptionsFromProfile(profile, rt()), exposeFullRanking: true, policyEmitTraces: true });
// FIX hypothesis: the launch profile does NOT plumb policyEntityRegistry through
// scoringOptionsFromProfile, so resolvedQuerySubjects is empty for every query and
// the CONFLICT_SET_MEMBER selector admission never matches. The probe-conflict and
// probe-r5-relation-typed scripts pass policyEntityRegistry MANUALLY. Build the same
// registry here so MODE 3 can confirm the hypothesis.
const policyEntityRegistry = (rawCorpus.entities ?? []).map((e) => ({ id: e.id, names: [e.canonicalName, ...(e.aliases ?? [])].filter(Boolean).map((n) => String(n).toLowerCase()) }));
const fixedOpts = () => ({ ...scoringOptionsFromProfile(profile, rt()), exposeFullRanking: true, policyEmitTraces: true, policyEntityRegistry, policyGenericEntityIds: ['e_universe'] });

const frontierSeed = profile.epochFrontier?.seed ?? 'coretex-launch-frontier';
const evalSeedHex = '0x' + createHash('sha256').update(frontierSeed).digest('hex');
const fullPack = deriveQueryPack(0, evalSeedHex, currentProd, { ...(profile.hiddenPack ?? {}), packSize: PACK_SIZE });
console.log(`[diag-conflict] full pack: ${fullPack.events.length} queries`);
const frontier = makeLaunchFrontier(profile, currentProd);
const fr0 = frontier.stepEpoch(0, null, null);
const activePack = { ...fullPack, events: fullPack.events.filter((e) => fr0.activeIds.has(e.id)) };
console.log(`[diag-conflict] active pack: ${activePack.events.length} queries`);
// Diagnostic of every conflict_lifecycle query in the active pack and whether its resolved doc
// resolves to a valid corpus event id (the root cause hypothesis: evolved docs use a different
// event-id convention zz_e{N}_mem_*, not mem_*).
console.log('[diag-conflict] conflict pack queries + anchor-event resolution check:');
for (const ev of activePack.events) {
  const lq = logicalQById.get(ev.id);
  if (!lq) continue;
  const fam = lq.family ?? lq.logicalFamily;
  if (fam !== 'conflict_lifecycle') continue;
  const resolved = (lq.qrels ?? []).find((r) => r.role === 'direct');
  if (!resolved) continue;
  const memEvIdGuess = `mem_${resolved.docId}`;
  const evResolved = eventByDocId.get(memEvIdGuess) ?? null;
  console.log(`  q=${ev.id} resolvedDoc=${resolved.docId} memEventId=${memEvIdGuess} foundInCorpus=${!!evResolved}`);
}

const families = {};
const conflictQueries = [];
const entityRegistry = profile.policyEntityRegistry ?? [];
const entityNames = new Set((entityRegistry).flatMap((e) => e.names ?? []));
for (const ev of activePack.events) {
  const lq = logicalQById.get(ev.id);
  if (!lq) continue;
  const fam = lq.family ?? lq.logicalFamily ?? 'unknown';
  families[fam] = (families[fam] ?? 0) + 1;
  if (fam === 'conflict_lifecycle') conflictQueries.push({ ...lq, eventId: ev.id });
}
console.log('[diag-conflict] active pack families:', families);
console.log(`[diag-conflict] conflict queries in active pack: ${conflictQueries.length}`);

// Build the conflict patch the same way the harness does.
const cunits = conflictUnits({ pack: activePack, logicalQById, eventByDocId, conflictSlot: 0, action: 'boost' });
console.log(`[diag-conflict] conflict patch units: ${cunits.indices.length} words; minedDocId=${cunits.minedDocId}`);
if (!cunits.indices.length) {
  console.error('HARD FAIL: no conflict pack query available; cannot diagnose.'); process.exit(1);
}

const genesisState = { words: new Array(1024).fill(0n) };
const patch = {
  patchType: PATCH_TYPE.MIXED, wordCount: cunits.indices.length, scoreDelta: 0,
  parentStateRoot: merkleizeState(genesisState),
  indices: cunits.indices, newWords: cunits.newWords,
};
const applied = applyPatch(genesisState, patch);
if (!applied.ok) { console.error('HARD FAIL: applyPatch rejected:', applied.code, applied.message); process.exit(1); }
const decoded = decodeSubstrate(applied.state, { policyAtomsMode: true });
console.log(`[diag-conflict] decoded conflict atoms: ${decoded.conflictLifecycleAtoms.length} (failures: ${decoded.decodeFailures})`);
for (const a of decoded.conflictLifecycleAtoms) {
  console.log(`  conflict atom: slot=${a.atomIndex} selector=${a.selector} ef=${a.evidenceFeature} action=${a.action} scope=${a.scope} targetSlot=${a.targetSlot} budget=${a.budget}`);
}
console.log(`[diag-conflict] anchored doc=${cunits.minedDocId} subject(s)=`, (docById.get(cunits.minedDocId)?.entityIds ?? []).filter((e) => e !== 'e_universe'));

// Score genesis vs honest on the active pack.
console.log('[diag-conflict] scoring genesis (no atoms) on active pack ...');
const before = await evaluateRetrievalBenchmarkState(genesisState, currentProd, activePack, baseOpts());
console.log('[diag-conflict] scoring honest (with conflict atom) on active pack ...');
const after = await evaluateRetrievalBenchmarkState(applied.state, currentProd, activePack, baseOpts());

console.log(`[diag-conflict] composite: before=${before.composite?.toFixed(6)} after=${after.composite?.toFixed(6)} delta=${((after.composite - before.composite) * 1_000_000).toFixed(0)}ppm`);

const perQueryAfter = new Map((after.perQuery ?? []).map((q) => [q.recordId, q]));
const perQueryBefore = new Map((before.perQuery ?? []).map((q) => [q.recordId, q]));

// Per-conflict-query diagnostic.
const conflictDiag = [];
let anyFired = 0, anyMoved = 0;
for (const cq of conflictQueries) {
  const intent = parseQueryConflictIntent(cq.queryText ?? '', entityNames);
  const subj = cq.subjectEntityId;
  const anchorEv = eventByDocId.get(`mem_${cunits.minedDocId}`);
  const anchorSubjects = (anchorEv?.entityIds ?? []).filter((e) => e !== 'e_universe');
  const subjectMatch = anchorSubjects.includes(subj);
  const qb = perQueryBefore.get(cq.id);
  const qa = perQueryAfter.get(cq.id);
  const deltaNdcg = (qa?.nDCG10 ?? 0) - (qb?.nDCG10 ?? 0);
  const policyTraces = (qa?.policyTraces ?? []);
  const conflictTraces = policyTraces.filter((t) => t.atomFamily === 'conflict_lifecycle');
  const fired = conflictTraces.length > 0;
  if (fired) anyFired++;
  if (Math.abs(deltaNdcg) > 0.001) anyMoved++;
  conflictDiag.push({
    queryId: cq.id, queryText: cq.queryText, subject: subj,
    conflictIntent: intent, anchorSubjects, subjectMatch,
    nDCGBefore: qb?.nDCG10 ?? null, nDCGAfter: qa?.nDCG10 ?? null, deltaNdcg,
    conflictTracesEmitted: conflictTraces.length,
    conflictTracesSample: conflictTraces.slice(0, 2),
    rankedAfterTop5: (qa?.finalRankingTop20 ?? []).slice(0, 5).map((r) => ({ docId: r.docId, rank: r.rank, relevance: r.relevance, sources: r.sources })),
  });
}

console.log(`[diag-conflict] conflict queries: ${conflictQueries.length} | atom fired on ${anyFired} | rank moved on ${anyMoved}`);
for (const d of conflictDiag.slice(0, 6)) {
  console.log(`  q=${d.queryId} intent=${d.conflictIntent} subjectMatch=${d.subjectMatch} traces=${d.conflictTracesEmitted} delta=${d.deltaNdcg.toFixed(4)}`);
}

const report = {
  schema: 'coretex.conflict-mixed-root-cause-diag.v1',
  bundle: BUNDLE_PATH, profile: PROFILE_PATH, corpus: CORPUS_PATH,
  bundleHash: baseBundle.manifest.bundleHash, corpusRoot: baseBundle.manifest.corpusRoot,
  packSize: PACK_SIZE,
  activePackSize: activePack.events.length,
  activePackFamilies: families,
  conflictQueriesInPack: conflictQueries.length,
  anchoredDocId: cunits.minedDocId,
  anchoredSubjects: (docById.get(cunits.minedDocId)?.entityIds ?? []).filter((e) => e !== 'e_universe'),
  conflictAtomsDecoded: decoded.conflictLifecycleAtoms.length,
  decodeFailures: decoded.decodeFailures,
  conflictAtoms: decoded.conflictLifecycleAtoms.map((a) => ({
    atomIndex: a.atomIndex, selector: a.selector, evidenceFeature: a.evidenceFeature,
    action: a.action, scope: a.scope, targetSlot: a.targetSlot, budget: a.budget,
  })),
  composite: { before: before.composite, after: after.composite, deltaPpm: Math.round((after.composite - before.composite) * 1_000_000) },
  conflictQueryDiag: conflictDiag,
  anyFired, anyMoved,
  conclusion: {
    atomDecodes: decoded.conflictLifecycleAtoms.length > 0,
    atomFires: anyFired > 0,
    rankMoves: anyMoved > 0,
  },
};
const outAbs = resolve(repoRoot, OUT);
mkdirSync(dirname(outAbs), { recursive: true });
writeFileSync(outAbs, JSON.stringify(report, null, 2));
console.log(`[diag-conflict] wrote ${outAbs}`);

// ─── Mode 2: replicate harness epoch-1 conditions ───────────────────────────────
// Apply evolveCorpusDelta(epoch=1), build newProd via the live-delta bridge,
// step the frontier to epoch 1, derive the post-delta active pack, then re-run
// the same conflict patch path on THAT pack via evaluateRetrievalBenchmarkPatch.
import { evolveCorpusDelta } from './lib/evolve-corpus.mjs';
const { buildCorpusDelta, applyCorpusDelta, bridgeLogicalDeltaToProductionEvents, evaluateRetrievalBenchmarkPatch } = C;
function mockVec(seed = 0) {
  const v = new Float32Array(LAYOUT.dim);
  for (let i = 0; i < LAYOUT.dim; i++) v[i] = Math.sin(i + seed * 131 + 7);
  return v;
}
function int8Bytes(vec) {
  let m = 0; for (const v of vec) m = Math.max(m, Math.abs(v));
  const s = m > 0 ? m / 127 : 1;
  const o = new Uint8Array(4 + LAYOUT.dim);
  new DataView(o.buffer).setFloat32(0, s, false);
  for (let i = 0; i < LAYOUT.dim; i++) { let c = Math.round((vec[i] ?? 0) / s); c = Math.max(-127, Math.min(127, c)); o[4 + i] = c & 0xff; }
  return o;
}
console.log('\n[diag-conflict] === MODE 2: replicate harness epoch 1 ===');
const ld = evolveCorpusDelta({ baseLogical: rawCorpus, epoch: 1, seed: frontierSeed, churnFraction: 0.05 });
console.log(`[diag-conflict] evolveCorpusDelta epoch 1: +${ld.addedDocs.length}docs +${ld.addedQueries.length}queries +${ld.addedRelations.length}rels`);
const addedDocEmbeddings = new Map();
ld.addedDocs.forEach((d, i) => addedDocEmbeddings.set(d.id, int8Bytes(mockVec(1000 + i))));
const addedQueryEmbeddings = new Map();
ld.addedQueries.forEach((q, i) => addedQueryEmbeddings.set(q.id, int8Bytes(mockVec(2000 + i))));
const additions = bridgeLogicalDeltaToProductionEvents({
  previousCorpus: currentProd, logicalDelta: ld, addedDocEmbeddings, addedQueryEmbeddings,
  biEncoder: { modelId: BE.modelId, revision: BE.revision, layout: LAYOUT },
});
const labelingProvenance = { modelId: RR.modelId, revision: RR.revision, runtime: 'coretex-retrieval-v2-policy-r5', batchHash: '0x' + '00'.repeat(32) };
const delta = buildCorpusDelta({ previousCorpus: currentProd, additions, removals: [], epoch: 1, labelingProvenance });
const newProd = applyCorpusDelta(currentProd, delta);
console.log(`[diag-conflict] newProd events: ${newProd.events.length}`);
const fr1 = frontier.stepEpoch(1, 0, 0);
// inject the live eval ids
const newEvalIds = ld.addedQueries.filter((q) => q.split === undefined || q.split === 'eval_hidden').map((q) => q.id);
if (frontier.addReserveIds) frontier.addReserveIds(newEvalIds, (id) => 'conflict_lifecycle');
console.log(`[diag-conflict] frontier epoch 1 activeIds=${fr1.activeIds.size}`);
const fullPack1 = deriveQueryPack(0, evalSeedHex, newProd, { ...(profile.hiddenPack ?? {}), packSize: PACK_SIZE });
const activePack1 = { ...fullPack1, events: fullPack1.events.filter((e) => fr1.activeIds.has(e.id)) };
console.log(`[diag-conflict] epoch-1 active pack: ${activePack1.events.length} queries`);

// Refresh logicalQById + eventByDocId per the harness's epoch logic.
const logicalQById1 = new Map(rawCorpus.queries.map((q) => [q.id, q]));
const eventByDocId1 = new Map(); for (const ev of newProd.events) eventByDocId1.set(ev.id, ev);

// Replicate the harness honest path for conflict.
const cunits1 = conflictUnits({ pack: activePack1, logicalQById: logicalQById1, eventByDocId: eventByDocId1, conflictSlot: 0, action: 'boost' });
console.log(`[diag-conflict] epoch-1 conflict patch units: ${cunits1.indices.length} words; minedDocId=${cunits1.minedDocId}`);
if (cunits1.indices.length) {
  const patch1 = {
    patchType: PATCH_TYPE.MIXED, wordCount: cunits1.indices.length, scoreDelta: 0,
    parentStateRoot: merkleizeState(genesisState),
    indices: cunits1.indices, newWords: cunits1.newWords,
  };
  // Use canonical evaluateRetrievalBenchmarkPatch like the harness does.
  const r1 = await evaluateRetrievalBenchmarkPatch(genesisState, patch1, newProd, activePack1, baseOpts(), { ...profile.patchAcceptanceFloors, acceptanceThresholdPpm: profile.patchAcceptanceFloors?.minImprovementPpm ?? 2500 });
  console.log(`[diag-conflict] epoch-1 patch result: accepted=${r1.accepted} deltaPpm=${r1.deltaPpm} reason=${r1.reason ?? 'n/a'}`);
  const perAfter = new Map((r1.after?.perQuery ?? []).map((q) => [q.recordId, q]));
  const perBefore = new Map((r1.before?.perQuery ?? []).map((q) => [q.recordId, q]));
  let moved = 0, fired = 0;
  for (const ev of activePack1.events) {
    const lq = logicalQById1.get(ev.id); if (!lq) continue;
    const fam = lq.family ?? lq.logicalFamily;
    if (fam !== 'conflict_lifecycle') continue;
    const qb = perBefore.get(ev.id), qa = perAfter.get(ev.id);
    const d = (qa?.nDCG10 ?? 0) - (qb?.nDCG10 ?? 0);
    const traces = ((qa?.policyTraces ?? []).filter((t) => t.atomFamily === 'conflict_lifecycle'));
    if (Math.abs(d) > 0.001) moved++;
    if (traces.length) fired++;
    console.log(`  conflict q=${ev.id} subj=${lq.subjectEntityId} traces=${traces.length} delta=${d.toFixed(4)} before=${(qb?.nDCG10 ?? 0).toFixed(4)} after=${(qa?.nDCG10 ?? 0).toFixed(4)}`);
  }
  console.log(`[diag-conflict] epoch-1 conflict: fired=${fired} moved=${moved}`);
}

// ─── MODE 3: confirm fix — same epoch-1 patch with policyEntityRegistry passed ───
console.log('\n[diag-conflict] === MODE 3: epoch-1 + policyEntityRegistry (FIX TEST) ===');
{
  if (cunits1.indices.length) {
    const patch3 = { patchType: PATCH_TYPE.MIXED, wordCount: cunits1.indices.length, scoreDelta: 0, parentStateRoot: merkleizeState(genesisState), indices: cunits1.indices, newWords: cunits1.newWords };
    const r3 = await evaluateRetrievalBenchmarkPatch(genesisState, patch3, newProd, activePack1, fixedOpts(), { ...profile.patchAcceptanceFloors, acceptanceThresholdPpm: profile.patchAcceptanceFloors?.minImprovementPpm ?? 2500 });
    console.log(`[diag-conflict] MODE 3 patch result: accepted=${r3.accepted} deltaPpm=${r3.deltaPpm} reason=${r3.reason ?? 'n/a'}`);
    const perAfter3 = new Map((r3.after?.perQuery ?? []).map((q) => [q.recordId, q]));
    const perBefore3 = new Map((r3.before?.perQuery ?? []).map((q) => [q.recordId, q]));
    let moved3 = 0, fired3 = 0;
    for (const ev of activePack1.events) {
      const lq = logicalQById1.get(ev.id); if (!lq) continue;
      const fam = lq.family ?? lq.logicalFamily;
      if (fam !== 'conflict_lifecycle') continue;
      const qb = perBefore3.get(ev.id), qa = perAfter3.get(ev.id);
      const d = (qa?.nDCG10 ?? 0) - (qb?.nDCG10 ?? 0);
      const traces = ((qa?.policyTraces ?? []).filter((t) => t.atomFamily === 'conflict_lifecycle'));
      if (Math.abs(d) > 0.001) moved3++;
      if (traces.length) fired3++;
      console.log(`  MODE 3 q=${ev.id} subj=${lq.subjectEntityId} traces=${traces.length} delta=${d.toFixed(4)} before=${(qb?.nDCG10 ?? 0).toFixed(4)} after=${(qa?.nDCG10 ?? 0).toFixed(4)}`);
    }
    console.log(`[diag-conflict] MODE 3 conflict: fired=${fired3} moved=${moved3}`);
  }
}
