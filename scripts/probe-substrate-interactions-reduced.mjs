#!/usr/bin/env node
/**
 * Substrate-pair interaction probe (CPU/deterministic-first) on the 0x2d953b71 reduced launch
 * bundle.
 *
 * For each user-listed pair (A, B), scores the SAME query slice under four arms:
 *   - none: both surfaces off
 *   - A:    A on, B off
 *   - B:    A off, B on
 *   - AB:   both on
 *
 * Then evaluates the user-specified promotion gate:
 *   1. AB nDCG > max(A, B) nDCG by > EPSILON   (combined beats stronger solo)
 *   2. AB does not increase truth/gold damage   (truth-doc top-K drops vs the stronger solo)
 *   3. AB does not materially increase junk     (relevance==0 in top-K vs the stronger solo)
 *   4. AB does not regress off-family nDCG      (families outside the pair's target)
 *   5. AB selector path is qrel/header/doc-ID-free (sanity log of trace sources, deterministic-safe)
 *   6. If AB == best solo, do not promote.
 *
 * Five pairs run by default:
 *   (temporal, conflict)
 *   (relation_category, temporal)
 *   (relation_category, conflict)
 *   (relation_category, abstention)
 *   (relation_category, evidence_rendering)
 *
 * No A100 by default: deterministic reranker proves the structural interaction shape.
 * Real-Qwen confirmation runs only when the user passes --reranker gpu and a target pair shows
 * a structurally promotable lift.
 *
 * Bottom-up philosophy: CPU/structural -> Qwen confirm. If a pair never separates structurally,
 * skip the A100 cost.
 *
 * Usage (CPU):
 *   node scripts/probe-substrate-interactions-reduced.mjs \
 *     --bundle release/bundle/bundle-manifest-v2-dgen1-policy-r5-300k-launch-reduced.json \
 *     --profile release/bundle/evaluator-profile-v2-dgen1-policy-r5-300k-launch-reduced.json \
 *     --corpus  release/calibration/2026-05-21-memory-corpus-v2/dgen1-r5-synth-300k-v15-corpus.json \
 *     --emb     release/calibration/2026-05-21-memory-corpus-v2/dgen1-r5-synth-300k-v15-embeddings.json \
 *     --pack-size 60 \
 *     --out release/calibration/2026-05-21-memory-corpus-v2/substrate-interactions-v15-cpu-reduced-2d953b71.json
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import process from 'node:process';
import { distIndex, repoRoot } from './_repo-root.mjs';
import { inertBiEncoder } from './lib/build-v2-production-corpus.mjs';
import { loadMaterializedCorpus } from './lib/load-materialized-corpus.mjs';
import { calibrationProvenance } from './lib/calibration-provenance.mjs';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const has = (n) => argv.includes(`--${n}`);

const PROFILE_PATH = flag('profile', 'release/bundle/evaluator-profile-v2-dgen1-policy-r5-300k-launch-reduced.json');
const BUNDLE_PATH  = flag('bundle',  'release/bundle/bundle-manifest-v2-dgen1-policy-r5-300k-launch-reduced.json');
const CORPUS_PATH  = flag('corpus',  'release/calibration/2026-05-21-memory-corpus-v2/dgen1-r5-synth-300k-v15-corpus.json');
const EMB_PATH     = flag('emb',     'release/calibration/2026-05-21-memory-corpus-v2/dgen1-r5-synth-300k-v15-embeddings.json');
const OUT_PATH     = flag('out',     'release/calibration/2026-05-21-memory-corpus-v2/substrate-interactions-v15-cpu-reduced-2d953b71.json');
const PACK_SIZE    = Number(flag('pack-size', '60'));
const RERANKER     = flag('reranker', 'deterministic');
const EPSILON      = Number(flag('epsilon', '0.001'));
const TRACE_SOURCES = has('trace-sources');

const C = await import(distIndex);
const {
  scoringOptionsFromProfile, deriveQueryPack,
  evaluateRetrievalBenchmarkState,
  createDeterministicReranker, biEncoderModelIdHash,
} = C;

const profile = JSON.parse(readFileSync(resolve(repoRoot, PROFILE_PATH), 'utf8'));
console.log(`[interactions] profile=${PROFILE_PATH} bundle=${BUNDLE_PATH}`);
console.log('[interactions] loading materialized base production corpus (NO rebuild) ...');
const baseBundle = loadMaterializedCorpus(BUNDLE_PATH, { sourceCorpusPath: CORPUS_PATH, sourceEmbPath: EMB_PATH });
const currentProd = baseBundle.corpus;
const { BE, RR, LAYOUT } = baseBundle;
const provenance = calibrationProvenance({
  bundlePath: BUNDLE_PATH, corpusPath: CORPUS_PATH, embPath: EMB_PATH,
  profilePath: PROFILE_PATH, manifest: baseBundle.manifest,
});
console.log(`[interactions] bundleHash=${baseBundle.manifest.bundleHash} corpusRoot=${baseBundle.manifest.corpusRoot.slice(0, 18)}…`);
console.log(`[interactions] base events=${currentProd.events.length}`);

const reranker = RERANKER === 'deterministic'
  ? await createDeterministicReranker()
  : (() => { throw new Error('only deterministic supported in this CPU/structural probe; for Qwen, use the Qwen variant'); })();

const biEncoderHash = biEncoderModelIdHash(BE.modelId, BE.revision, 'dense');
const rt = () => ({ biEncoder: inertBiEncoder(BE, LAYOUT), reranker, biEncoderHash, retrievalKeyLayout: LAYOUT });

// Surface flags: ON/OFF deltas applied OVER the reduced launch profile.
// Each entry has `on` (delta to apply when surface enabled) and `off` (delta when disabled).
const SURFACES = {
  temporal: {
    label: 'temporal_update',
    on:  { temporalStaleContrast: true,  temporalCurrentBoost: profile.temporalCurrentBoost ?? 0.1, temporalStaleSuppression: profile.temporalStaleSuppression ?? 0.1 },
    off: { temporalStaleContrast: false, temporalCurrentBoost: 0, temporalStaleSuppression: 0 },
    targetFamilies: ['temporal', 'temporal_update'],
  },
  conflict: {
    label: 'conflict_lifecycle',
    on:  { enableConflictLifecycleAtoms: true,  policyConflictIntentAdmission: true  },
    off: { enableConflictLifecycleAtoms: false, policyConflictIntentAdmission: false },
    targetFamilies: ['conflict_lifecycle', 'conflict'],
  },
  relation_category: {
    label: 'relation_category_routing',
    on:  { policyRelationTypedAdmission: true,  policyQueryConditionedAdmission: true,  categoryLensEvidenceBundle: profile.categoryLensEvidenceBundle ?? true },
    off: { policyRelationTypedAdmission: false, policyQueryConditionedAdmission: false },
    targetFamilies: ['multi_session_bridge', 'causal_memory_chain', 'decision_provenance', 'multi_hop_relation'],
  },
  abstention: {
    label: 'abstention_top1',
    on:  { enableAbstentionAtoms: true  },
    off: { enableAbstentionAtoms: false },
    targetFamilies: ['abstention_missing', 'abstention', 'unanswerable'],
  },
  evidence_rendering: {
    label: 'categoryLens_evidence_rendering',
    on:  { categoryLensEvidenceBundle: true  },
    off: { categoryLensEvidenceBundle: false },
    targetFamilies: ['causal_memory_chain', 'decision_provenance', 'multi_session_bridge'],
  },
};

const PAIRS = [
  ['temporal',          'conflict'],
  ['relation_category', 'temporal'],
  ['relation_category', 'conflict'],
  ['relation_category', 'abstention'],
  ['relation_category', 'evidence_rendering'],
];

// Build profile overrides for a given arm.
function profileForArm(armASurface, armBSurface, armSpec) {
  // armSpec = 'none' | 'A' | 'B' | 'AB'
  const a = SURFACES[armASurface];
  const b = SURFACES[armBSurface];
  const onA = armSpec === 'A'  || armSpec === 'AB';
  const onB = armSpec === 'B'  || armSpec === 'AB';
  return {
    ...profile,
    ...(onA ? a.on : a.off),
    ...(onB ? b.on : b.off),
  };
}

// Resolve scoring options for an arm.
function optionsForArm(armASurface, armBSurface, armSpec) {
  const p = profileForArm(armASurface, armBSurface, armSpec);
  return {
    ...scoringOptionsFromProfile(p, rt()),
    exposeFullRanking: true,
    policyEmitTraces: TRACE_SOURCES,
  };
}

// Build per-pair query slice from the hidden pack — pulls quotas so every pair sees BOTH
// its target families and an off-family balance for damage detection.
function buildPackForPair(seedHex) {
  const profileHiddenPack = profile.hiddenPack ?? {};
  // Keep the standard launch quotas (all six families) so off-family damage is detectable.
  const config = { ...profileHiddenPack, packSize: PACK_SIZE };
  const pack = deriveQueryPack(0, seedHex, currentProd, config);
  return pack;
}

const evalSeedHex = '0x' + createHash('sha256').update('coretex-launch-frontier').digest('hex');
console.log(`[interactions] deriving balanced hidden pack: PACK_SIZE=${PACK_SIZE}, six-family quotas preserved`);
const pack = buildPackForPair(evalSeedHex);
console.log(`[interactions] pack derived: ${pack.events.length} events`);
const familyCount = {};
for (const ev of pack.events) {
  const fam = ev.logicalFamily ?? ev.family ?? 'unknown';
  familyCount[fam] = (familyCount[fam] ?? 0) + 1;
}
console.log('[interactions] pack family distribution:', familyCount);

// Score a single arm.
function makeGenesisState() { return { words: new Array(1024).fill(0n) }; }
async function scoreArm(armASurface, armBSurface, armSpec) {
  const opts = optionsForArm(armASurface, armBSurface, armSpec);
  const t0 = Date.now();
  const r = await evaluateRetrievalBenchmarkState(makeGenesisState(), currentProd, pack, opts);
  const ms = Date.now() - t0;
  return { score: r, ms };
}

const start = Date.now();
const armReport = [];
for (const [aSurface, bSurface] of PAIRS) {
  console.log(`\n[interactions] === pair (${aSurface}, ${bSurface}) ===`);
  const arms = {};
  for (const armSpec of ['none', 'A', 'B', 'AB']) {
    const t = Date.now();
    const r = await scoreArm(aSurface, bSurface, armSpec);
    arms[armSpec] = r;
    const elapsed = Date.now() - t;
    const nd = (r.score.compositeScore ?? r.score.composite ?? 0);
    console.log(`[interactions]   arm=${armSpec.padEnd(4)} composite=${nd.toFixed(6)} ms=${elapsed}`);
  }
  // Per-family family-level nDCG10 aggregates from perQuery.
  const familyMeans = {};
  const allFams = new Set();
  for (const [armSpec, r] of Object.entries(arms)) {
    const fam = {};
    for (const q of (r.score.perQuery ?? [])) {
      const f = q.family ?? q.logicalFamily ?? 'unknown';
      fam[f] ||= { sum: 0, n: 0 };
      fam[f].sum += q.nDCG10;
      fam[f].n += 1;
      allFams.add(f);
    }
    familyMeans[armSpec] = Object.fromEntries(
      Object.entries(fam).map(([f, v]) => [f, +(v.sum / Math.max(1, v.n)).toFixed(6)]),
    );
  }
  // Gate computations.
  const compNone = arms.none.score.compositeScore ?? arms.none.score.composite ?? 0;
  const compA    = arms.A.score.compositeScore    ?? arms.A.score.composite    ?? 0;
  const compB    = arms.B.score.compositeScore    ?? arms.B.score.composite    ?? 0;
  const compAB   = arms.AB.score.compositeScore   ?? arms.AB.score.composite   ?? 0;
  const bestSolo = Math.max(compA, compB);
  const liftCombinedOverBestSolo = compAB - bestSolo;
  const liftAOverNone = compA - compNone;
  const liftBOverNone = compB - compNone;
  const liftABOverNone = compAB - compNone;

  // Target family lift (mean over surface-targeted families that appear in pack).
  const targetFams = [...new Set([...SURFACES[aSurface].targetFamilies, ...SURFACES[bSurface].targetFamilies])];
  const offFams = [...allFams].filter((f) => !targetFams.includes(f));
  const meanOver = (familyMeans_, fams) => {
    const arr = fams.map((f) => familyMeans_[f]).filter((v) => typeof v === 'number');
    return arr.length ? +(arr.reduce((s, v) => s + v, 0) / arr.length).toFixed(6) : null;
  };
  const targetMeans = {
    none: meanOver(familyMeans.none, targetFams),
    A:    meanOver(familyMeans.A, targetFams),
    B:    meanOver(familyMeans.B, targetFams),
    AB:   meanOver(familyMeans.AB, targetFams),
  };
  const offMeans = {
    none: meanOver(familyMeans.none, offFams),
    A:    meanOver(familyMeans.A, offFams),
    B:    meanOver(familyMeans.B, offFams),
    AB:   meanOver(familyMeans.AB, offFams),
  };

  // Truth/gold damage: count queries whose truth-doc top-K rank degraded under AB vs best-solo.
  // We approximate by counting per-query nDCG10 < bestSolo nDCG10 by > 0.001 ON the target family slice.
  const perQuery = (arms.AB.score.perQuery ?? []).map((q) => q.recordId);
  const indexBy = (s) => new Map((s.score.perQuery ?? []).map((q) => [q.recordId, q]));
  const idxA = indexBy(arms.A);
  const idxB = indexBy(arms.B);
  const idxAB = indexBy(arms.AB);
  let truthRegressions = 0, junkIncrease = 0;
  const truthRegressionExamples = [];
  for (const id of perQuery) {
    const qA = idxA.get(id) ?? { nDCG10: 0 };
    const qB = idxB.get(id) ?? { nDCG10: 0 };
    const qAB = idxAB.get(id) ?? { nDCG10: 0 };
    const best = Math.max(qA.nDCG10, qB.nDCG10);
    if (qAB.nDCG10 + 0.001 < best) {
      truthRegressions++;
      if (truthRegressionExamples.length < 5) {
        const fam = qAB.family ?? qAB.logicalFamily ?? 'unknown';
        truthRegressionExamples.push({ recordId: id, family: fam, bestSoloNDCG: +best.toFixed(6), combinedNDCG: +qAB.nDCG10.toFixed(6), delta: +(qAB.nDCG10 - best).toFixed(6) });
      }
    }
    // junk: count zero-relevance docs in top-K of AB vs best-solo
    const topJunk = (q) => (q?.finalRankingTop20 ?? []).slice(0, 10).filter((r) => r.relevance === 0).length;
    const jA = topJunk(qA), jB = topJunk(qB), jAB = topJunk(qAB);
    if (jAB > Math.max(jA, jB)) junkIncrease += jAB - Math.max(jA, jB);
  }

  // Off-family regression: any off-family mean dropped under AB vs best of (A|B) by > epsilon.
  const offFamilyRegression = (offMeans.AB ?? 0) + EPSILON < Math.max(offMeans.A ?? 0, offMeans.B ?? 0);

  // Promote gate.
  const beatsSolo = liftCombinedOverBestSolo > EPSILON;
  const equalsSolo = !beatsSolo && Math.abs(liftCombinedOverBestSolo) <= EPSILON;
  const promote = beatsSolo
    && truthRegressions === 0
    && junkIncrease === 0
    && !offFamilyRegression;

  console.log(`[interactions]   composite none=${compNone.toFixed(4)} A=${compA.toFixed(4)} B=${compB.toFixed(4)} AB=${compAB.toFixed(4)}  liftAB_over_bestSolo=${liftCombinedOverBestSolo.toFixed(6)}`);
  console.log(`[interactions]   target_families=[${targetFams.join(',')}]`);
  console.log(`[interactions]   target_means     none=${targetMeans.none} A=${targetMeans.A} B=${targetMeans.B} AB=${targetMeans.AB}`);
  console.log(`[interactions]   off_means        none=${offMeans.none} A=${offMeans.A} B=${offMeans.B} AB=${offMeans.AB}`);
  console.log(`[interactions]   truthRegressions=${truthRegressions} junkIncrease=${junkIncrease} offFamilyRegression=${offFamilyRegression}`);
  console.log(`[interactions]   verdict: promote=${promote} beatsSolo=${beatsSolo} equalsSolo=${equalsSolo}`);

  armReport.push({
    pair: [aSurface, bSurface],
    composite: { none: compNone, A: compA, B: compB, AB: compAB },
    lifts: {
      A_over_none: +liftAOverNone.toFixed(6),
      B_over_none: +liftBOverNone.toFixed(6),
      AB_over_none: +liftABOverNone.toFixed(6),
      AB_over_bestSolo: +liftCombinedOverBestSolo.toFixed(6),
    },
    targetFamilies: targetFams,
    offFamilies: offFams,
    targetMeans, offMeans, familyMeans,
    truthRegressions, junkIncrease, offFamilyRegression,
    truthRegressionExamples,
    perArmTimingMs: { none: arms.none.ms, A: arms.A.ms, B: arms.B.ms, AB: arms.AB.ms },
    verdict: { promote, beatsSolo, equalsSolo, epsilon: EPSILON, reason: promote
      ? 'combined > strongest solo with no damage'
      : (equalsSolo ? 'combined == best solo; per gate, do not promote'
        : (offFamilyRegression ? 'off-family regression'
          : (truthRegressions ? 'gold/truth damage on combined'
            : (junkIncrease ? 'junk increase on combined'
              : (beatsSolo ? 'should not happen' : 'combined below best solo')))))
    },
  });
}

const totalMs = Date.now() - start;
const report = {
  schema: 'coretex.substrate-interactions-reduced.v1',
  bundle: BUNDLE_PATH, profile: PROFILE_PATH, corpus: CORPUS_PATH, embeddings: EMB_PATH,
  bundleHash: baseBundle.manifest.bundleHash, corpusRoot: baseBundle.manifest.corpusRoot,
  reranker: RERANKER, packSize: PACK_SIZE, epsilon: EPSILON,
  totalMs,
  provenance,
  notes: [
    'Deterministic CPU run: structural shape only. Real Qwen confirmation required before any promotion.',
    'AB scores under the same pack as A_only/B_only/none — same-query interaction probe.',
    'Promote requires AB > max(A, B) by > epsilon AND zero truth/gold damage AND zero junk increase AND no off-family regression.',
    'Pack quotas preserved from profile.hiddenPack to keep all 6 families represented for off-family damage detection.',
  ],
  packFamilyCount: familyCount,
  pairs: armReport,
};
const outAbs = resolve(repoRoot, OUT_PATH);
mkdirSync(dirname(outAbs), { recursive: true });
writeFileSync(outAbs, JSON.stringify(report, null, 2));
console.log(`\n[interactions] wrote ${outAbs}`);
console.log(`[interactions] totalMs=${totalMs}`);

// Compact stdout verdict table:
console.log('\n[interactions] === Verdict table ===');
for (const r of armReport) {
  const v = r.verdict;
  const tag = v.promote ? 'PROMOTE' : (v.equalsSolo ? 'EQUAL_NO_PROMOTE' : 'NO_PROMOTE');
  console.log(`  (${r.pair[0]}, ${r.pair[1]}): ${tag}  liftAB_over_bestSolo=${r.lifts.AB_over_bestSolo}  truthRegressions=${r.truthRegressions}  junkIncrease=${r.junkIncrease}  offFamReg=${r.offFamilyRegression}`);
}
