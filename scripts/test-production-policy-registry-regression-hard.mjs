#!/usr/bin/env node
/**
 * Production plumbing regression test — HARD case (auditor item 9 follow-up).
 *
 * The "easy" regression at scripts/test-production-policy-registry-regression.mjs
 * confirms the production path (scoringOptionsFromProfile, no manual registry
 * injection) admits the conflict atom and produces the same composite delta as
 * the harness path. That test passes — but it does not by itself prove WHY.
 * Two distinct mechanisms could explain a pass:
 *
 *   (i)  The derive-from-corpus fallback in `evaluateRetrievalBenchmarkState`
 *        (`packages/cortex/src/eval/retrieval-benchmark.ts:2456-2465`) populates
 *        `policyEntityRegistry` from `corpus.entities` when admission requires
 *        one and none was injected. This is the CORRECT mechanism.
 *
 *   (ii) The `policyFires` final-reorder gate at line ~1764 falls back to
 *        `eventsInStage1` when `policyQueryConditionedAdmission` is FALSE — but
 *        even with QCA=true, if the anchored conflict doc happens to be in
 *        every query's stage-1 top-K, atom firing observation would be the
 *        same regardless of whether the registry is correctly plumbed.
 *
 * This hard test discriminates the two. Four scoring runs over the same
 * canonical conflict_lifecycle patch on the launch-reduced bundle:
 *
 *   A. NO_REGISTRY:        scoringOptionsFromProfile(profile) ONLY.
 *                          Expected: derive-from-corpus fires → atom fires.
 *   B. EMPTY_REGISTRY:     scoringOptionsFromProfile + explicit `[]` override.
 *                          Expected: derive-from-corpus is suppressed (opts present
 *                          → not derived) → selectorMatchedAnchorEvents stays empty
 *                          → atom does NOT fire.
 *   C. EMPTY_REGISTRY+QCAoff: same as B but `policyQueryConditionedAdmission=false`,
 *                          forcing the `eventsInStage1` fallback. Diagnostic: tells
 *                          us whether the anchor is in stage-1 top-K. Used to detect
 *                          "easy" cases where (ii) could mask a (i) failure.
 *   D. MANUAL_REGISTRY:    scoringOptionsFromProfile + manually injected registry,
 *                          QCA=true. Reference baseline matching the harness path.
 *
 * Pass criteria:
 *   - A.atomFired === D.atomFired === true
 *   - |A.compositeDeltaPpm - D.compositeDeltaPpm| < 100   (numerical agreement)
 *   - B.atomFired === false                                (test is HARD: without a
 *                                                          registry, the QCA path
 *                                                          legitimately fails)
 *
 * Fail mode: A.atomFired=true but B.atomFired=true means the eventsInStage1
 * fallback (or some other unintended path) was firing the atom regardless of
 * the registry. The test cannot then claim production plumbing is correct.
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
const OUT = flag('out', 'release/calibration/2026-05-21-memory-corpus-v2/test-production-policy-registry-regression-hard-2d953b71.json');

const C = await import(distIndex);
const {
  scoringOptionsFromProfile, deriveQueryPack, evaluateRetrievalBenchmarkState,
  applyPatch, createDeterministicReranker, biEncoderModelIdHash,
  PATCH_TYPE, merkleizeState,
} = C;

const profile = JSON.parse(readFileSync(resolve(repoRoot, PROFILE_PATH), 'utf8'));
console.log('[reg-hard] loading materialized base corpus ...');
const baseBundle = loadMaterializedCorpus(BUNDLE_PATH, { sourceCorpusPath: CORPUS_PATH, sourceEmbPath: EMB_PATH });
const currentProd = baseBundle.corpus;
const { BE, LAYOUT } = baseBundle;
const rawCorpus = JSON.parse(readFileSync(resolve(repoRoot, CORPUS_PATH), 'utf8'));
const logicalQById = new Map(rawCorpus.queries.map((q) => [q.id, q]));
const eventByDocId = new Map();
for (const ev of currentProd.events) eventByDocId.set(ev.id, ev);

const reranker = await createDeterministicReranker();
const biEncoderHash = biEncoderModelIdHash(BE.modelId, BE.revision, 'dense');
const rt = () => ({ biEncoder: inertBiEncoder(BE, LAYOUT), reranker, biEncoderHash, retrievalKeyLayout: LAYOUT });

const policyEntityRegistry = (rawCorpus.entities ?? []).map((e) => ({
  id: e.id,
  names: [e.canonicalName, ...(e.aliases ?? [])].filter(Boolean).map((n) => String(n).toLowerCase()),
}));

const frontierSeed = profile.epochFrontier?.seed ?? 'coretex-launch-frontier';
const evalSeedHex = '0x' + createHash('sha256').update(frontierSeed).digest('hex');
const pack = deriveQueryPack(0, evalSeedHex, currentProd, { ...(profile.hiddenPack ?? {}), packSize: 64 });
console.log(`[reg-hard] pack: ${pack.events.length} events`);

const genesisState = { words: new Array(1024).fill(0n) };
const u = conflictUnits({ pack, logicalQById, eventByDocId, conflictSlot: 0, action: 'boost' });
if (!u.indices?.length) {
  console.error(`[reg-hard] conflictUnits returned no units: ${u.reason}`);
  process.exit(1);
}

// Build a HARD PACK that strips `subjectEntityId` from queries so production
// scoring must walk the registry/text-fallback path (the path the auditor cares
// about). dgen1 v15 pre-resolves every query's `subjectEntityId`, which makes
// `resolveQuerySubjects` return the right entity without ever consulting the
// registry. That mask the entire registry-plumbing question on this corpus.
// The hard pack reproduces what a future / legacy corpus shape looks like
// (query carries no subjectEntityId): the only path to selector match is
// `policyEntityRegistry`.
function stripSubjectEntityId(p) {
  return {
    ...p,
    events: p.events.map((ev) => {
      const { subjectEntityId: _drop, ...rest } = ev;
      return rest;
    }),
  };
}
const packHard = stripSubjectEntityId(pack);
const sampleBefore = pack.events[0]?.subjectEntityId ?? null;
const sampleAfter = packHard.events[0]?.subjectEntityId ?? null;
const sampleCount = pack.events.filter((e) => e.subjectEntityId).length;
console.log(`[reg-hard] subjectEntityId: pack.events with subjectEntityId=${sampleCount}/${pack.events.length}, sample before=${sampleBefore} after-strip=${sampleAfter}`);
const patch = {
  patchType: PATCH_TYPE.MIXED, wordCount: u.indices.length, scoreDelta: 0,
  parentStateRoot: merkleizeState(genesisState), indices: u.indices, newWords: u.newWords,
};
const applied = applyPatch(genesisState, patch, true);
if (!applied.ok) { console.error('apply failed:', applied.code, applied.message); process.exit(1); }

async function score(label, opts, scoringPack = packHard) {
  const before = await evaluateRetrievalBenchmarkState(genesisState, currentProd, scoringPack, opts);
  const after = await evaluateRetrievalBenchmarkState(applied.state, currentProd, scoringPack, opts);
  const conflictFired = (after.perQuery ?? []).some((q) => (q.policyTraces ?? []).some((t) => t.atomFamily === 'conflict_lifecycle'));
  const dPpm = Math.round(((after.composite ?? 0) - (before.composite ?? 0)) * 1_000_000);
  console.log(`[reg-hard] ${label}: composite ${before.composite?.toFixed(6)} → ${after.composite?.toFixed(6)}  Δppm=${dPpm}  conflictAtomFired=${conflictFired}`);
  return { label, compositeDeltaPpm: dPpm, conflictAtomFired: conflictFired };
}

const baseOpts = () => ({ ...scoringOptionsFromProfile(profile, rt()), exposeFullRanking: true, policyEmitTraces: true });

// A. NO_REGISTRY — production path; tests derive-from-corpus.
console.log('[reg-hard] A. NO_REGISTRY (production path, derive-from-corpus expected) ...');
const A = await score('A_NO_REGISTRY', baseOpts());

// B. EMPTY_REGISTRY — explicit empty override; suppresses derive-from-corpus.
console.log('[reg-hard] B. EMPTY_REGISTRY (suppresses derive-from-corpus) ...');
const B = await score('B_EMPTY_REGISTRY', { ...baseOpts(), policyEntityRegistry: [], policyGenericEntityIds: [] });

// C. EMPTY_REGISTRY + QCA off — diagnostic for the eventsInStage1 fallback.
console.log('[reg-hard] C. EMPTY_REGISTRY + QCA=false (diagnostic: eventsInStage1 fallback?) ...');
const C_diag = await score('C_EMPTY_REGISTRY_QCAOFF', { ...baseOpts(), policyEntityRegistry: [], policyGenericEntityIds: [], policyQueryConditionedAdmission: false });

// D. MANUAL_REGISTRY — reference baseline matching the harness.
console.log('[reg-hard] D. MANUAL_REGISTRY (harness path baseline) ...');
const D = await score('D_MANUAL_REGISTRY', { ...baseOpts(), policyEntityRegistry, policyGenericEntityIds: ['e_universe'] });

const verdict = {
  derive_from_corpus_works:
    A.conflictAtomFired === true && D.conflictAtomFired === true &&
    Math.abs(A.compositeDeltaPpm - D.compositeDeltaPpm) < 100,
  test_is_hard_no_top1_fallback_masking: B.conflictAtomFired === false,
  top1_fallback_diagnostic_C_atom_fired: C_diag.conflictAtomFired,
  pass:
    A.conflictAtomFired === true && D.conflictAtomFired === true &&
    Math.abs(A.compositeDeltaPpm - D.compositeDeltaPpm) < 100 &&
    B.conflictAtomFired === false,
  A, B, C: C_diag, D,
};
console.log('[reg-hard] verdict:', JSON.stringify(verdict, null, 2));

const report = {
  schema: 'coretex.production-policy-registry-regression-hard.v1',
  bundleHash: baseBundle.manifest.bundleHash, corpusRoot: baseBundle.manifest.corpusRoot,
  profile: PROFILE_PATH, anchoredDocId: u.minedDocId,
  cases: { A, B, C: C_diag, D }, verdict,
  recommendation: verdict.pass
    ? 'PRODUCTION PATH OK: derive-from-corpus fallback in evaluateRetrievalBenchmarkState plumbs the registry. The HARD test confirms this is not masked by the eventsInStage1 top-K fallback — case B (empty registry, QCA=true) does NOT fire, proving the selector path is what carries production scoring.'
    : verdict.derive_from_corpus_works && !verdict.test_is_hard_no_top1_fallback_masking
      ? 'INCONCLUSIVE: derive-from-corpus works, but case B (empty registry, QCA=true) also fires — likely the anchor doc lands in stage-1 top-K so the top-K reorder gate carries it independently. Need a query whose anchor is NOT in stage-1 top-K to make the test discriminate.'
      : 'PRODUCTION PATH BROKEN: A or D failed to fire the conflict atom. Add the missing derive-from-corpus plumbing in scoringOptionsFromProfile, OR ensure the corpus has a populated `entities` table.',
};
const outAbs = resolve(repoRoot, OUT);
mkdirSync(dirname(outAbs), { recursive: true });
writeFileSync(outAbs, JSON.stringify(report, null, 2));
console.log(`[reg-hard] wrote ${outAbs}`);
process.exit(verdict.pass ? 0 : 2);
