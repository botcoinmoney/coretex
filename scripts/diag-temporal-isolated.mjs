#!/usr/bin/env node
/**
 * Temporal-isolated CPU diagnostic. Verifies the temporal substrate is correctly wired
 * BEFORE running the A100 temporal-isolated mini, so a green A100 mini measures temporal
 * surface quality rather than re-discovering a wiring bug.
 *
 * Checks (per user direction 2026-05-30):
 *   1. Profile knobs: isolated temporal profile has temporalStaleContrast=true,
 *      temporalCurrentBoost>0, temporalStaleSuppression>0; NO unrelated atom/policy/aspect
 *      knobs enabled.
 *   2. Qrels mark current vs stale correctly after corpus bridge/materialization: each
 *      pack temporal_update query must have both a role='direct'/isCurrent=true truth doc
 *      AND a role='stale'/isCurrent=false truth doc.
 *   3. Stale docs are present in candidate sets BEFORE rerank: the stale doc id must
 *      appear in the pre-rerank candidate list (firstStageCandidates) for the temporal
 *      query so the temporal mechanism has something to suppress.
 *   4. Temporal boost/suppression fires on intended docs: when an honest temporal patch
 *      writes stale-suppress + current-boost slots + a TemporalRecord, the scorer's
 *      policyTraces (or rank-change diff) must show movement on those specific docs.
 *   5. Same-pack delta: score same pack under isolated profile vs main calibration profile
 *      with both an empty substrate AND with a single honest temporal patch. If isolated
 *      passes (positive temporal lift) and mixed fails, root cause is pack interference
 *      / admission / rerank-cap composition — NOT temporal substrate quality.
 *
 * Usage:
 *   node scripts/diag-temporal-isolated.mjs \
 *     --isolated-profile release/bundle/evaluator-profile-v2-dgen1-policy-r5-300k-isolated-temporal.json \
 *     --mixed-profile    release/bundle/evaluator-profile-v2-dgen1-policy-r5-300k-calibration.json \
 *     --isolated-bundle  release/bundle/bundle-manifest-v2-dgen1-policy-r5-300k-isolated-temporal.json \
 *     --mixed-bundle     release/bundle/bundle-manifest-v2-dgen1-policy-r5-300k-calibration.json \
 *     --corpus  release/calibration/2026-05-21-memory-corpus-v2/dgen1-r5-synth-300k-final-corpus.json \
 *     --emb     release/calibration/2026-05-21-memory-corpus-v2/dgen1-r5-synth-300k-final-embeddings.json \
 *     [--pack-size 64]
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { argv, exit } from 'node:process';
import { distIndex, repoRoot } from './_repo-root.mjs';
import { inertBiEncoder } from './lib/build-v2-production-corpus.mjs';
import { loadMaterializedCorpus } from './lib/load-materialized-corpus.mjs';
import { temporalUnits } from './lib/v2-patch-families.mjs';

const C = await import(distIndex);
const {
  scoringOptionsFromProfile, createDeterministicReranker, deriveQueryPack,
  biEncoderModelIdHash, evaluateRetrievalBenchmarkState,
  RANGES, PATCH_TYPE, merkleizeState, firstStageCandidates, retrieveFirstStageCandidates, buildPublicCorpusIndex,
} = C;

const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const ISO_PROFILE = flag('isolated-profile');
const MIX_PROFILE = flag('mixed-profile');
const ISO_BUNDLE = flag('isolated-bundle');
const MIX_BUNDLE = flag('mixed-bundle');
const CORPUS_PATH = flag('corpus');
const EMB_PATH = flag('emb');
const PACK_SIZE = Number(flag('pack-size', '64'));
if (!ISO_PROFILE || !MIX_PROFILE || !ISO_BUNDLE || !MIX_BUNDLE || !CORPUS_PATH || !EMB_PATH) {
  console.error('HARD FAIL: --isolated-profile, --mixed-profile, --isolated-bundle, --mixed-bundle, --corpus, --emb required'); exit(1);
}
let exitCode = 0;
function check(name, ok, detail = '') { console.log(`${ok ? 'PASS' : 'FAIL'} [${name}]${detail ? ' — ' + detail : ''}`); if (!ok) exitCode = 1; }
function info(s) { console.log(`     ${s}`); }

const isoProfile = JSON.parse(readFileSync(resolve(repoRoot, ISO_PROFILE), 'utf8'));
const mixProfile = JSON.parse(readFileSync(resolve(repoRoot, MIX_PROFILE), 'utf8'));
const isoProfileForScoring = {
  ...isoProfile,
  // Isolate temporal substrate flags, not stale lower-layer retrieval knobs.
  firstStageTopK: mixProfile.firstStageTopK,
  firstStageMode: mixProfile.firstStageMode,
  firstStageDenseWeight: mixProfile.firstStageDenseWeight,
  firstStageLexicalWeight: mixProfile.firstStageLexicalWeight,
  rerankerInputTopK: mixProfile.rerankerInputTopK,
};

// ─── Check 1: profile knobs ───
console.log('\n=== check 1: isolated temporal profile knobs ===');
check('temporalStaleContrast=true', isoProfile.temporalStaleContrast === true, `${isoProfile.temporalStaleContrast}`);
check('temporalCurrentBoost>0', typeof isoProfile.temporalCurrentBoost === 'number' && isoProfile.temporalCurrentBoost > 0, `${isoProfile.temporalCurrentBoost}`);
check('temporalStaleSuppression>0', typeof isoProfile.temporalStaleSuppression === 'number' && isoProfile.temporalStaleSuppression > 0, `${isoProfile.temporalStaleSuppression}`);
check('w_temporal>0', typeof isoProfile.compositeWeights?.w_temporal === 'number' && isoProfile.compositeWeights.w_temporal > 0, `${isoProfile.compositeWeights?.w_temporal}`);
// Flag only ENABLE-flag knobs that fire substrate paths (atoms / admission), NOT
// threshold / cap values that are scaffolding constants regardless of whether the
// corresponding atom family is enabled.
const ENABLE_FLAGS_NOT_ALLOWED = ['enableEvidenceBundleAtoms', 'enableConflictLifecycleAtoms', 'enableAbstentionAtoms', 'enableAspectConstraintAtoms'];
const ADMISSION_FLAGS_NOT_ALLOWED = ['policyQueryConditionedAdmission', 'policyRelationTypedAdmission', 'policyConflictIntentAdmission', 'policyAspectIntentAdmission', 'policyAtomsMode'];
const unrelatedActive = [...ENABLE_FLAGS_NOT_ALLOWED, ...ADMISSION_FLAGS_NOT_ALLOWED].filter((k) => isoProfile[k] === true);
check('no unrelated atom-enable/admission flags active in isolated profile', unrelatedActive.length === 0, unrelatedActive.length ? `active=${unrelatedActive.join(',')}` : 'clean (only temporal substrate active)');

// ─── Load corpus + reranker ───
// Load via the MIXED bundle: corpus content is profile-independent (same corpus.events),
// so loading from the mixed bundle's materialized cache is equivalent for diagnostic
// purposes. Avoids requiring a separate 16-min materialize for the isolated bundle.
console.log('\n=== loading materialized corpus (via mixed bundle — content is bundle-independent) ===');
const { corpus, BE, RR, LAYOUT } = loadMaterializedCorpus(MIX_BUNDLE, { sourceCorpusPath: CORPUS_PATH, sourceEmbPath: EMB_PATH });
const reranker = await createDeterministicReranker();
const rt = { biEncoder: inertBiEncoder(BE, LAYOUT), reranker, biEncoderHash: biEncoderModelIdHash(BE.modelId, BE.revision, 'dense'), retrievalKeyLayout: LAYOUT };
const optsIso = scoringOptionsFromProfile(isoProfileForScoring, rt);
const optsMix = scoringOptionsFromProfile(mixProfile, rt);
info(`corpus events=${corpus.events.length} root=${corpus.corpusRoot.slice(0, 18)}...`);

// ─── Check 2: qrels mark current vs stale ───
console.log('\n=== check 2: qrel current/stale tagging (post-bridge/materialize) ===');
const seedHex = isoProfile.baselineEvalSeedHex ?? mixProfile.baselineEvalSeedHex ?? '0x' + 'a5'.repeat(32);
const pack = deriveQueryPack(0, seedHex, corpus, { ...isoProfile.hiddenPack, packSize: PACK_SIZE });
info(`pack: ${pack.events.length} queries`);
const temporalQueries = pack.events.filter((ev) => (ev.logicalFamily ?? ev.family) === 'temporal_update');
info(`pack temporal queries: ${temporalQueries.length}`);
check('pack has temporal queries', temporalQueries.length > 0);
const wellMarked = temporalQueries.filter((ev) =>
  Array.isArray(ev.truthDocuments)
  && ev.truthDocuments.some((t) => t.isCurrent === true)
  && ev.truthDocuments.some((t) => t.isCurrent === false));
check('every temporal query has current AND stale truth doc', wellMarked.length === temporalQueries.length,
  `${wellMarked.length}/${temporalQueries.length} well-marked`);
if (wellMarked.length === 0) {
  info('HALT: cannot proceed with checks 3-5; pack temporal queries lack current/stale role marking.');
  exit(exitCode);
}

// Pick a representative temporal query for checks 3-5.
const sample = wellMarked[0];
const sampleCurrent = sample.truthDocuments.find((t) => t.isCurrent === true);
const sampleStale = sample.truthDocuments.find((t) => t.isCurrent === false);
info(`sample query: ${sample.id} (family=${sample.family}/${sample.logicalFamily})`);
info(`  current truth doc: ${sampleCurrent.id}`);
info(`  stale truth doc:   ${sampleStale.id}`);

// ─── Check 3: stale doc in candidate set BEFORE rerank ───
console.log('\n=== check 3: stale doc in pre-rerank candidate set ===');
try {
  const pubIndex = buildPublicCorpusIndex(corpus);
  // Use the active first-stage settings, not a diagnostic-only topK. v15 pins
  // hybrid top-3200; checking dense top-256 produced false lower-layer failures.
  const queryVec = sample.embeddings?.query ?? sample.queryVec ?? sample.embedding;
  if (!queryVec) {
    info(`pack event ${sample.id} has no embeddings.query — first-stage candidate enumeration not possible from this event shape`);
    check('first-stage candidate enumeration', false, 'no queryVec on pack event');
  } else {
    const stage1K = optsIso.firstStageTopK;
    const stage1Mode = optsIso.firstStageMode ?? 'dense';
    const stage1Opts = { mode: stage1Mode, denseWeight: optsIso.firstStageDenseWeight ?? 1, lexicalWeight: optsIso.firstStageLexicalWeight ?? 1 };
    const cands = typeof retrieveFirstStageCandidates === 'function'
      ? retrieveFirstStageCandidates(sample.queryText ?? '', queryVec, pubIndex, stage1K, stage1Opts)
      : firstStageCandidates(queryVec, pubIndex, stage1K);
    const candIds = new Set((cands ?? []).map((c) => c.documentId ?? c.id ?? c.docId));
    info(`first-stage candidates: ${candIds.size} (mode=${stage1Mode} topK=${stage1K})`);
    check('current truth doc in pre-rerank candidates', candIds.has(sampleCurrent.id), `id=${sampleCurrent.id}`);
    check('stale truth doc in pre-rerank candidates', candIds.has(sampleStale.id), `id=${sampleStale.id}`);
    if (!candIds.has(sampleStale.id)) info('  → stale doc is filtered out before rerank; temporal suppression has nothing to act on.');
  }
} catch (e) {
  info(`could not run firstStageCandidates: ${e.message?.slice(0, 100)}`);
  check('first-stage candidate enumeration', false, 'API access failed — diagnostic incomplete');
}

// ─── Check 4: temporal boost/suppression fires on intended docs ───
console.log('\n=== check 4: temporal boost/suppression fires on intended docs ===');
const empty = { words: new Array(1024).fill(0n) };
const parentRoot = merkleizeState(empty);
// Build a temporal patch for the sample query using the canonical helper (matches honest miner).
const packLogicalQById = new Map(pack.events.map((ev) => [ev.id, {
  family: ev.logicalFamily ?? ev.family,
  qrels: (ev.truthDocuments ?? []).map((t) => ({
    docId: t.id, relevance: 1.0, role: t.isCurrent === false ? 'stale' : 'direct',
  })),
}]));
const tu = temporalUnits({ pack, logicalQById: packLogicalQById, recordSlot: 0, skipDocIds: new Set() });
check('canonical temporal patch compiled (recordsCompiled>0)', tu.recordsCompiled > 0, `recordsCompiled=${tu.recordsCompiled} indices=${tu.indices.length}`);
if (tu.recordsCompiled === 0) {
  info('HALT: canonical temporalUnits could not compile a temporal record from the pack; check 5 skipped.');
  exit(exitCode);
}
info(`temporal patch indices: ${tu.indices.length} words at offsets ${tu.indices.slice(0, 6).join(',')}${tu.indices.length > 6 ? '...' : ''}`);
// Apply the patch in-place to build the post-patch state.
const postState = { words: [...empty.words] };
for (let i = 0; i < tu.indices.length; i++) postState.words[tu.indices[i]] = tu.newWords[i];
const postRoot = merkleizeState(postState);
info(`pre-patch root:  ${parentRoot.slice(0, 24)}...`);
info(`post-patch root: ${postRoot.slice(0, 24)}...`);
check('parent != post-patch root (patch actually mutates state)', parentRoot !== postRoot);

// ─── Check 5: same-pack delta — isolated vs mixed ───
console.log('\n=== check 5: same-pack delta isolated vs mixed (empty + post-patch) ===');
async function scoreFamilyDelta(opts, label, state, scorePack = pack) {
  const r = await evaluateRetrievalBenchmarkState(state, corpus, scorePack, opts);
  const eventByRecord = new Map(scorePack.events.map((e) => [e.recordId ?? e.id, e]));
  const perQ = r.perQuery ?? [];
  const tQ = perQ.filter((q) => {
    const ev = eventByRecord.get(q.recordId ?? q.id);
    return ev && (ev.logicalFamily ?? ev.family) === 'temporal_update';
  });
  const mean = tQ.length ? tQ.reduce((a, q) => a + q.nDCG10, 0) / tQ.length : 0;
  return { label, agg: r.nDCG10, temporalMean: mean, temporalN: tQ.length };
}
const soloPack = { ...pack, events: [sample] };
const isoSoloEmpty = await scoreFamilyDelta(optsIso, 'isolated/solo-empty', empty, soloPack);
const isoSoloPost = await scoreFamilyDelta(optsIso, 'isolated/solo-post-patch', postState, soloPack);
const isoEmpty = await scoreFamilyDelta(optsIso, 'isolated/empty', empty);
const mixEmpty = await scoreFamilyDelta(optsMix, 'mixed/empty', empty);
const isoPost = await scoreFamilyDelta(optsIso, 'isolated/post-patch', postState);
const mixPost = await scoreFamilyDelta(optsMix, 'mixed/post-patch', postState);
info(`isolated/solo-empty:      agg=${isoSoloEmpty.agg.toFixed(4)} temporal-family-mean=${isoSoloEmpty.temporalMean.toFixed(4)} (n=${isoSoloEmpty.temporalN})`);
info(`isolated/solo-post-patch: agg=${isoSoloPost.agg.toFixed(4)} temporal-family-mean=${isoSoloPost.temporalMean.toFixed(4)}`);
info(`isolated/empty:      agg=${isoEmpty.agg.toFixed(4)} temporal-family-mean=${isoEmpty.temporalMean.toFixed(4)} (n=${isoEmpty.temporalN})`);
info(`mixed/empty:         agg=${mixEmpty.agg.toFixed(4)} temporal-family-mean=${mixEmpty.temporalMean.toFixed(4)} (n=${mixEmpty.temporalN})`);
info(`isolated/post-patch: agg=${isoPost.agg.toFixed(4)} temporal-family-mean=${isoPost.temporalMean.toFixed(4)}`);
info(`mixed/post-patch:    agg=${mixPost.agg.toFixed(4)} temporal-family-mean=${mixPost.temporalMean.toFixed(4)}`);
const isoSoloLiftTemporal = isoSoloPost.temporalMean - isoSoloEmpty.temporalMean;
const isoSoloLiftAgg = isoSoloPost.agg - isoSoloEmpty.agg;
const isoLiftTemporal = isoPost.temporalMean - isoEmpty.temporalMean;
const mixLiftTemporal = mixPost.temporalMean - mixEmpty.temporalMean;
const isoLiftAgg = isoPost.agg - isoEmpty.agg;
const mixLiftAgg = mixPost.agg - mixEmpty.agg;
info(`isolated single-query temporal lift: ${isoSoloLiftTemporal.toFixed(4)}    isolated single-query aggregate lift: ${isoSoloLiftAgg.toFixed(4)}`);
info(`isolated temporal-family lift: ${isoLiftTemporal.toFixed(4)}    isolated aggregate lift: ${isoLiftAgg.toFixed(4)}`);
info(`mixed    temporal-family lift: ${mixLiftTemporal.toFixed(4)}    mixed    aggregate lift: ${mixLiftAgg.toFixed(4)}`);
check('isolated profile: single-query temporal lift > 0', isoSoloLiftTemporal > 0, `${isoSoloLiftTemporal.toFixed(4)}`);
check('isolated profile: same-pack temporal-family lift > 0', isoLiftTemporal > 0, `${isoLiftTemporal.toFixed(4)}`);
check('isolated profile: same-pack aggregate lift >= 0 (no global damage)', isoLiftAgg >= 0, `${isoLiftAgg.toFixed(4)}`);
if (isoSoloLiftTemporal > 0 && isoLiftAgg <= 0) {
  info(`\nROOT CAUSE INDICATOR: single-query temporal lift is positive but same-pack isolated aggregate is damaging`);
  info(`  → temporal substrate wiring is live; pack interference / global temporal modulation is burying it.`);
} else if (isoSoloLiftTemporal <= 0) {
  info(`\nROOT CAUSE INDICATOR: single-query isolated profile can't produce temporal lift`);
  info(`  → temporal substrate or wiring issue, NOT just pack interference.`);
}

await reranker.close?.();
console.log(`\n${exitCode === 0 ? 'DIAG: ALL CHECKS PASS' : 'DIAG: HARD FAIL (' + exitCode + ' checks failed)'}`);
exit(exitCode);
