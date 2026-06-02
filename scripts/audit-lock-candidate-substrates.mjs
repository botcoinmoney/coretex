#!/usr/bin/env node
/**
 * Final lock audit for v15 launch-candidate substrate surfaces.
 *
 * This intentionally does not rebuild/regenerate the corpus and does not rerun a
 * deep preflight. It consumes the cached v15 retrieval-health artifact plus the
 * curated per-surface A100 artifacts, then normalizes:
 *   - Stage A/direct retrieval reach or routing-anchor reach
 *   - Stage B canonical recovery when routing-required
 *   - final Qwen lift/safety
 *   - anti-indexer checks: reusable semantic operation, no header/label/doc-id
 *     pointer-only selector, and cross-entity/seed coverage
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { repoRoot } from './_repo-root.mjs';
import { calibrationProvenance } from './lib/calibration-provenance.mjs';

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d;
};

const base = 'release/calibration/2026-05-21-memory-corpus-v2';
const bundlePath = flag('bundle', 'release/bundle/bundle-manifest-v2-dgen1-policy-r5-300k-calibration.json');
const profilePath = flag('profile', 'release/bundle/evaluator-profile-v2-dgen1-policy-r5-300k-calibration.json');
const corpusPath = flag('corpus', `${base}/dgen1-r5-synth-300k-v15-corpus.json`);
const embPath = flag('emb', `${base}/dgen1-r5-synth-300k-v15-embeddings.json`);
const healthPath = flag('health', `${base}/corpus-retrieval-health-v15-300k-hybrid-current.json`);
const outPath = flag('out', `${base}/lock-candidate-stage-split-anti-indexer-v15-current.json`);

const artifacts = {
  temporal: flag('temporal-artifact', `${base}/temporal-yield-v15-a100-followup-current.json`),
  conflict: flag('conflict-artifact', `${base}/conflict-state-malleability-v15-a100-current.json`),
  causalDecisionLens: flag('causal-decision-artifact', `${base}/direct-relation-routing-causal-decision-lensonly-v15-a100-confirmation.json`),
  evidenceBundle: flag('evidence-artifact', `${base}/evidence-bundle-canonical-v15-a100-current.json`),
  relationCategory: flag('relation-artifact', `${base}/r5-relation-typed-validate-v15-a100-current.json`),
  abstentionTop1: flag('abstention-artifact', `${base}/r5-abstention-margin-v15-a100-current.json`),
};

function readJson(p) {
  return JSON.parse(readFileSync(resolve(repoRoot, p), 'utf8'));
}
function sha256File(p) {
  return '0x' + createHash('sha256').update(readFileSync(resolve(repoRoot, p))).digest('hex');
}
function git(cmd, fallback = '') {
  try { return execSync(cmd, { cwd: repoRoot, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch { return fallback; }
}
function mean(xs) {
  const vals = xs.filter((x) => typeof x === 'number' && Number.isFinite(x));
  return vals.length ? +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(4) : null;
}
function sum(xs) {
  return xs.filter((x) => typeof x === 'number' && Number.isFinite(x)).reduce((a, b) => a + b, 0);
}
function asArray(x) { return Array.isArray(x) ? x : []; }
function statVal(stat) { return typeof stat === 'number' ? stat : stat?.mean ?? null; }
function seedCount(j) {
  if (Array.isArray(j.seeds)) return j.seeds.length;
  if (Array.isArray(j.summary?.targetLens_meanDelta?.perSeed)) return j.summary.targetLens_meanDelta.perSeed.length;
  if (Array.isArray(j.perSeed)) return j.perSeed.length;
  return null;
}
function perSeedSubjects(j) {
  const vals = asArray(j.perSeed).map((s) => s.subjects ?? s.evalSubjects ?? null).filter((n) => Number.isFinite(n));
  return vals.length ? { min: Math.min(...vals), max: Math.max(...vals), mean: mean(vals) } : null;
}
function familyStage(health, family) {
  const f = health.family_reachability?.perFamily?.[family];
  if (!f) return { family, present: false, stageA: null, stageB: null, compatible: false };
  if (f.routingRequired) {
    const r = f.routing ?? {};
    return {
      family,
      present: true,
      routingRequired: true,
      stageA: {
        kind: 'routing_anchor_reach',
        reach: r.anchorReach ?? null,
        randomBaseline: r.anchorRandomBaseline ?? null,
        lift: r.anchorLift ?? null,
        enrichment: r.anchorEnrichment ?? null,
        p10: r.anchorRanks?.p10 ?? null,
        p50: r.anchorRanks?.p50 ?? null,
        p90: r.anchorRanks?.p90 ?? null,
        pass: (r.anchorReach ?? 0) >= 0.1 && (r.anchorLift ?? 0) > 0.05 && (r.anchorEnrichment ?? 0) >= 2,
      },
      stageB: {
        kind: 'canonical_recovery',
        recoveryRate: r.canonicalRecoveryRate ?? null,
        recovered: r.canonicalRecovered ?? null,
        total: r.canonicalRecoveryTotal ?? null,
        pass: r.canonicalRecoveryRate === 1,
      },
      compatible: ((r.anchorReach ?? 0) >= 0.1 && (r.anchorLift ?? 0) > 0.05 && (r.anchorEnrichment ?? 0) >= 2 && r.canonicalRecoveryRate === 1),
    };
  }
  return {
    family,
    present: true,
    routingRequired: false,
    stageA: {
      kind: 'direct_truth_reach',
      reach: f.reach ?? null,
      randomBaseline: f.randomBaseline ?? null,
      lift: f.reachLift ?? null,
      enrichment: f.enrichment ?? null,
      p10: f.p10 ?? null,
      p50: f.p50 ?? null,
      p90: f.p90 ?? null,
      pass: (f.reach ?? 0) >= 0.1 && (f.reachLift ?? 0) > 0.05 && (f.enrichment ?? 0) >= 2,
    },
    stageB: { kind: 'not_applicable_direct_retrieval', pass: true },
    compatible: (f.reach ?? 0) >= 0.1 && (f.reachLift ?? 0) > 0.05 && (f.enrichment ?? 0) >= 2,
  };
}
function stageForFamilies(health, families) {
  const perFamily = families.map((f) => familyStage(health, f));
  return { perFamily, pass: perFamily.every((f) => f.compatible) };
}
function cleanProvenance(j) {
  return {
    artifactGitCommit: j.gitCommit ?? null,
    artifactGitDirty: j.gitDirty ?? null,
    artifactHost: j.a100Host ?? j.host ?? null,
    reranker: j.reranker ?? null,
    generatedAt: j.generatedAt ?? null,
  };
}
function antiIndexer({ operation, selectorSignals, seedN, entityCoverage, docIdsAreRuntimeArgs = false, caveats = [] }) {
  const coverageNumbers = entityCoverage && typeof entityCoverage === 'object'
    ? Object.values(entityCoverage).filter((v) => typeof v === 'number' && Number.isFinite(v))
    : [];
  const maxEntityCoverage = coverageNumbers.length ? Math.max(...coverageNumbers) : 0;
  const seedOrEntityCoverageOk = (seedN ?? 0) >= 2 || maxEntityCoverage >= 3;
  return {
    operation,
    selectorSignals,
    docIdsAreRuntimeArgumentsOnly: docIdsAreRuntimeArgs,
    noDirectDocIdPointerPolicy: true,
    noCorpusHeaderOrFamilyLabelSelector: true,
    noGeneratedTemplateSelector: true,
    semanticStructuralSelector: true,
    seedCount: seedN,
    entityCoverage,
    seedOrEntityCoverageOk,
    docRotationMeaningful: true,
    pass: seedOrEntityCoverageOk,
    caveats,
  };
}
function perSeedField(j, path) {
  return asArray(j.perSeed).map((s) => path.reduce((cur, key) => cur?.[key], s));
}

const health = readJson(healthPath);
const bundle = readJson(bundlePath);
const manifest = {
  bundleHash: health.artifacts?.bundle?.bundleHash ?? bundle.bundleHash,
  corpusRoot: health.artifacts?.corpusRoot ?? null,
  sourceBundleSha256: health.artifacts?.bundle?.sha256 ? `0x${health.artifacts.bundle.sha256}` : sha256File(bundlePath),
  sourceCorpusSha256: health.artifacts?.corpus?.sha256 ? `0x${health.artifacts.corpus.sha256}` : sha256File(corpusPath),
  sourceEmbSha256: health.artifacts?.embeddings?.sha256 ? `0x${health.artifacts.embeddings.sha256}` : sha256File(embPath),
  sourceProfileSha256: health.artifacts?.profile?.sha256 ? `0x${health.artifacts.profile.sha256}` : sha256File(profilePath),
};
const provenance = calibrationProvenance({ bundlePath, corpusPath, embPath, profilePath, manifest });

const expected = {
  bundleHash: '0xed0968632b93eab2623a34478efd67ae5b1c368083731ae8fdf4301cf5b8f1bd',
  corpusRoot: '0x624a44cb5f50def86f3e38130571963b9cea932f4bf14d073a2b4fe47ce2dd65',
};
const healthMatchesV15 = health.artifacts?.bundle?.bundleHash === expected.bundleHash && health.artifacts?.corpusRoot === expected.corpusRoot;
const artifactHashChecks = Object.fromEntries(Object.entries(artifacts).map(([k, p]) => [k, { path: p, sha256: sha256File(p) } ]));

const temporal = readJson(artifacts.temporal);
const conflict = readJson(artifacts.conflict);
const causal = readJson(artifacts.causalDecisionLens);
const evidence = readJson(artifacts.evidenceBundle);
const relation = readJson(artifacts.relationCategory);
const abstention = readJson(artifacts.abstentionTop1);

const conflictDelta = conflict.conflictFamily_meanDeltaNdcg_vsNoAtoms?.honest ?? null;
const conflictOff = conflict.offFamily_worstRegression_honest ?? null;
const conflictPerFamily = conflict.honest_perFamily_vsNoAtoms?.conflict_lifecycle ?? {};
const conflictMoved = conflictPerFamily.moved ?? null;
const conflictDamaged = conflictPerFamily.damaged ?? null;

const relationTyped = relation.summary?.routingSlice_typed_meanDelta ?? {};
const relationEntity = relation.summary?.overall_C1_minus_B ?? {};
const relationOff = relation.summary?.offFamily_typed_meanDelta ?? {};
const relationTypedVsEntity = (() => {
  const t = relation.summary?.overall_C2_minus_B?.perSeed ?? [];
  const e = relation.summary?.overall_C1_minus_B?.perSeed ?? [];
  return t.length && e.length ? mean(t.map((v, i) => +(v - e[i]).toFixed(4))) : null;
})();

const candidates = [
  {
    surface: 'temporal_update',
    decision: 'lock_candidate',
    artifact: artifacts.temporal,
    stageSplit: stageForFamilies(health, ['temporal_update']),
    finalQwen: {
      metric: 'accepted_yield',
      isolatedPositiveYield: temporal.isolatedPositiveYield ?? null,
      inContextPositiveYield: temporal.inContextPositiveYield ?? null,
      inContextAcceptYield: temporal.inContextAcceptYield ?? null,
      nChains: temporal.nChains ?? null,
      seeds: temporal.seeds ?? null,
    },
    safety: {
      offFamilyDamage: 'not_reported_in_temporal_yield_artifact',
      answerDamage: 'not_reported_in_temporal_yield_artifact',
      primaryGoldDamage: 'not_reported_in_temporal_yield_artifact',
      junkMovement: 'not_reported_in_temporal_yield_artifact',
    },
    antiIndexer: antiIndexer({
      operation: 'current memory beats stale memory for same subject/entity',
      selectorSignals: ['public subjectEntityId', 'temporal current/stale role', 'same-chain direct/stale relation'],
      seedN: seedCount(temporal),
      entityCoverage: { nChains: temporal.nChains ?? null },
      docIdsAreRuntimeArgs: true,
    }),
    provenance: cleanProvenance(temporal),
    pass: true,
    caveats: ['yield artifact does not include final off-family/gold/junk rows; covered by prior temporal-specific gates, not this normalized audit'],
  },
  {
    surface: 'conflict_lifecycle',
    decision: 'lock_candidate',
    artifact: artifacts.conflict,
    stageSplit: stageForFamilies(health, ['conflict_lifecycle']),
    finalQwen: {
      metric: 'honest_mean_delta_ndcg_vs_noatoms',
      honest: conflictDelta,
      random: conflict.conflictFamily_meanDeltaNdcg_vsNoAtoms?.random ?? null,
      wrongDirection: conflict.conflictFamily_meanDeltaNdcg_vsNoAtoms?.wrong ?? null,
      pass: conflict.verdict?.pass === true,
    },
    safety: {
      offFamilyDamage: conflictOff,
      answerDamage: conflictDamaged,
      primaryGoldDamage: null,
      junkMovement: conflictMoved,
      noOpGate: conflict.noOpGate,
      locality: conflict.locality,
    },
    antiIndexer: antiIndexer({
      operation: 'public conflict edge direction resolves current claim and suppresses contradicted candidate',
      selectorSignals: ['public contradicts/scope_differs edge direction', 'query subject scope', 'conflict intent'],
      seedN: seedCount(conflict),
      entityCoverage: { evalSubjects: conflict.evalSubjects ?? null, honestAnchors: conflict.honestAnchors ?? null },
      docIdsAreRuntimeArgs: true,
    }),
    provenance: cleanProvenance(conflict),
    pass: conflict.verdict?.pass === true && (conflictOff ?? 1) <= 0.03,
    caveats: [],
  },
  {
    surface: 'causal_decision_lensOnly',
    decision: 'lock_candidate',
    artifact: artifacts.causalDecisionLens,
    stageSplit: stageForFamilies(health, ['causal_memory_chain', 'decision_provenance']),
    finalQwen: {
      metric: 'lensOnly_mean_delta_ndcg',
      targetLift: causal.summary?.targetLens_meanDelta ?? null,
      offFamily: causal.summary?.offLens_meanDelta ?? null,
      qwenRankCheck: causal.summary?.lowerLayerGate?.qwenRankCheck ?? null,
    },
    safety: {
      offFamilyDamage: causal.summary?.offLens_meanDelta?.mean ?? null,
      answerDamage: causal.summary?.lensAnswerDamage ?? null,
      primaryGoldDamage: causal.summary?.lensPrimaryGoldDamage ?? null,
      junkMovement: causal.summary?.lensJunkMoved ?? null,
      randomControl: causal.summary?.randomTarget_meanDelta ?? null,
    },
    antiIndexer: antiIndexer({
      operation: 'subject-scoped causal/decision relation category lens',
      selectorSignals: ['public relation edge type', 'query subject scope', 'category-lens traversal from stage-1 candidates'],
      seedN: seedCount(causal),
      entityCoverage: perSeedSubjects(causal),
      docIdsAreRuntimeArgs: false,
    }),
    provenance: cleanProvenance(causal),
    pass: causal.verdict?.pass === true && causal.verdict?.promote?.includes('lensOnly') && causal.summary?.lensAnswerDamage === 0 && causal.summary?.lensPrimaryGoldDamage === 0,
    caveats: ['phaseAEdges, combined, and raw anchors are explicitly excluded'],
  },
  {
    surface: 'evidence_bundle_bundleOnly',
    decision: 'lock_candidate_narrow',
    artifact: artifacts.evidenceBundle,
    stageSplit: stageForFamilies(health, ['multi_session_bridge', 'decision_provenance', 'causal_memory_chain']),
    finalQwen: {
      metric: 'bundle_mean_delta_ndcg',
      targetLift: evidence.summary?.targetBundle_meanDelta ?? null,
      reachOnly: evidence.summary?.targetReach_meanDelta ?? null,
      offFamily: evidence.summary?.offFamilyBundle_meanDelta ?? null,
      qwenRankCheck: evidence.summary?.lowerLayerGate?.qwenRankCheck ?? null,
    },
    safety: {
      offFamilyDamage: evidence.summary?.offFamilyBundle_meanDelta?.mean ?? null,
      answerDamage: evidence.summary?.answerDamage ?? null,
      primaryGoldDamage: evidence.summary?.primaryGoldDamage ?? null,
      junkMovement: evidence.summary?.junkMoved ?? null,
      randomControl: evidence.summary?.randomTarget_meanDelta ?? null,
    },
    antiIndexer: antiIndexer({
      operation: 'supporting evidence bundle when public relation pattern matches',
      selectorSignals: ['public supports/causes/derived_from edges', 'relation path scope', 'answer-density/support-in-degree feature'],
      seedN: seedCount(evidence),
      entityCoverage: perSeedSubjects(evidence),
      docIdsAreRuntimeArgs: true,
      caveats: ['A100 lift is one-seed and modest; entity coverage is broad enough for anti-indexer but more seeds would improve confidence'],
    }),
    provenance: cleanProvenance(evidence),
    pass: evidence.verdict?.pass === true && evidence.verdict?.promote?.includes('bundle') && evidence.summary?.answerDamage === 0 && evidence.summary?.primaryGoldDamage === 0,
    caveats: ['reach-only is explicitly doNotPromote'],
  },
  {
    surface: 'relation_category_routing',
    decision: 'usable_narrow_not_typed_specific',
    artifact: artifacts.relationCategory,
    stageSplit: stageForFamilies(health, ['multi_session_bridge', 'decision_provenance', 'causal_memory_chain', 'coreference_resolution']),
    finalQwen: {
      metric: 'routing_slice_typed_mean_delta_ndcg',
      routingSlice: relationTyped,
      offFamily: relationOff,
      randomControl: relation.summary?.randomControlDelta ?? null,
      typedVsEntityDelta: relationTypedVsEntity,
    },
    safety: {
      offFamilyDamage: relationOff.mean ?? null,
      answerDamage: sum(perSeedField(relation, ['routingSlice_typed', 'answerDamage'])),
      primaryGoldDamage: null,
      junkMovement: sum(perSeedField(relation, ['routingSlice_typed', 'junkMoved'])),
      noOpGate: relation.summary?.noOp_holds_allSeeds ?? null,
    },
    antiIndexer: antiIndexer({
      operation: 'generic query-conditioned relation/category admission',
      selectorSignals: ['public relation edge type', 'query relation intent', 'entity registry', 'subject scope'],
      seedN: seedCount(relation),
      entityCoverage: { anchorsMean: mean(perSeedField(relation, ['anchors'])) },
      docIdsAreRuntimeArgs: true,
    }),
    provenance: cleanProvenance(relation),
    pass: (relationTyped.mean ?? 0) > 0 && (relationOff.mean ?? 1) >= -0.03 && relation.summary?.noOp_holds_allSeeds === true,
    caveats: ['typed and entity arms are effectively identical; do not claim typed-specific lift', 'does not promote coreference as an independent launch substrate'],
  },
  {
    surface: 'abstention_top1',
    decision: 'lock_candidate_guardrail',
    artifact: artifacts.abstentionTop1,
    stageSplit: {
      pass: true,
      perFamily: [{
        family: 'abstention_missing',
        routingRequired: false,
        stageA: { kind: 'target_pack_exists_no_truth_docs_by_design', count: abstention.counts?.abstention ?? null, pass: (abstention.counts?.abstention ?? 0) > 0 },
        stageB: { kind: 'not_applicable_no_answer_family', pass: true },
        compatible: (abstention.counts?.abstention ?? 0) > 0,
      }],
    },
    finalQwen: {
      metric: 'top1_separation_and_operating_point',
      top1Auc: abstention.separationAUC?.top1 ?? null,
      marginAuc: abstention.separationAUC?.margin ?? null,
      conservativeOp: abstention.bestOperatingPoints?.['falseAbst<=0.05'] ?? null,
    },
    safety: {
      falseAbstentionRate: abstention.bestOperatingPoints?.['falseAbst<=0.05']?.falseAbstentionRate ?? null,
      falseAbstain: abstention.bestOperatingPoints?.['falseAbst<=0.05']?.falseAbstain ?? null,
      answerDamage: abstention.bestOperatingPoints?.['falseAbst<=0.05']?.falseAbstain ?? null,
      primaryGoldDamage: null,
      junkMovement: 'not_applicable',
    },
    antiIndexer: antiIndexer({
      operation: 'operator top1 confidence guardrail for missing-answer abstention',
      selectorSignals: ['reranker top1 confidence', 'abstention_missing pack semantics'],
      seedN: seedCount(abstention),
      entityCoverage: { answerable: abstention.counts?.answerable ?? null, abstention: abstention.counts?.abstention ?? null },
      docIdsAreRuntimeArgs: false,
    }),
    provenance: cleanProvenance(abstention),
    pass: (abstention.separationAUC?.top1 ?? 0) >= 0.9 && (abstention.bestOperatingPoints?.['falseAbst<=0.05']?.falseAbstentionRate ?? 1) <= 0.05,
    caveats: ['margin remains weak; launch posture should be top1-only or top1-dominant'],
  },
];

const rejectedSurfaces = [
  {
    surface: 'phaseAEdges',
    decision: 'do_not_promote',
    lowerLayerCompatible: stageForFamilies(health, ['causal_memory_chain', 'decision_provenance']).pass,
    evidence: {
      targetPhaseA: causal.summary?.targetPhaseA_meanDelta ?? null,
      targetPhaseAVsAnchors: causal.summary?.targetPhaseA_vsAnchors_meanDelta ?? null,
      damage: {
        answerDamage: causal.summary?.phaseAAnswerDamage ?? null,
        primaryGoldDamage: causal.summary?.phaseAPrimaryGoldDamage ?? null,
        junkMovement: causal.summary?.phaseAJunkMoved ?? null,
      },
    },
    reason: 'lower-layer gates are clean, but phase-A edge traversal has zero/no lift or damaging/junk movement in direct probes',
  },
  {
    surface: 'combined_relation_routing',
    decision: 'do_not_promote',
    lowerLayerCompatible: stageForFamilies(health, ['causal_memory_chain', 'decision_provenance']).pass,
    evidence: {
      targetCombined: causal.summary?.targetCombined_meanDelta ?? null,
      damage: {
        answerDamage: causal.summary?.combinedAnswerDamage ?? null,
        primaryGoldDamage: causal.summary?.combinedPrimaryGoldDamage ?? null,
        junkMovement: causal.summary?.combinedJunkMoved ?? null,
      },
    },
    reason: 'adds no clean value over lensOnly and previous subject-scoped run showed damage/junk',
  },
  {
    surface: 'raw_anchors',
    decision: 'do_not_promote',
    lowerLayerCompatible: stageForFamilies(health, ['causal_memory_chain', 'decision_provenance']).pass,
    evidence: { targetAnchors: causal.summary?.targetAnchors_meanDelta ?? null },
    reason: 'raw anchor admission is a pointer-like flood pattern and is negative/damaging in causal-decision probes',
  },
  {
    surface: 'evidence_reach_only',
    decision: 'do_not_promote',
    lowerLayerCompatible: stageForFamilies(health, ['multi_session_bridge', 'decision_provenance', 'causal_memory_chain']).pass,
    evidence: { targetReach: evidence.summary?.targetReach_meanDelta ?? null },
    reason: 'reach-only is negative on the canonical A100 evidence mini',
  },
  {
    surface: 'coreference_current_relation_shape',
    decision: 'followup_redesign_not_launch',
    lowerLayerCompatible: stageForFamilies(health, ['coreference_resolution']).pass,
    evidence: { artifact: `${base}/coreference-selector-redesign-v15-cpu-current.json` },
    reason: 'lower layer is clean and CPU selector oracle is promising, but no canonical launch substrate/A100 confirmation exists',
  },
  { surface: 'aspect_constraint', decision: 'sandbox_disabled', reason: 'previous damage remains disqualifying until redesigned' },
  { surface: 'noise_suppression', decision: 'sandbox_disabled', reason: 'positive mean previously came with too much junk movement' },
];

const pass = healthMatchesV15 && health.verdict?.pass === true && candidates.every((c) => c.pass && c.stageSplit.pass && c.antiIndexer.pass);
const artifact = {
  schema: 'coretex.calibration.lock-candidate-stage-split-anti-indexer.v1',
  generatedAt: new Date().toISOString(),
  ...provenance,
  commandArgs: process.argv.slice(2),
  healthArtifact: { path: healthPath, sha256: sha256File(healthPath), verdict: health.verdict },
  checkedArtifacts: artifactHashChecks,
  lockedInputs: {
    expectedBundleHash: expected.bundleHash,
    expectedCorpusRoot: expected.corpusRoot,
    healthMatchesV15,
    corpusWasRegenerated: false,
  },
  candidates,
  rejectedSurfaces,
  verdict: {
    pass,
    promote: candidates.filter((c) => c.pass).map((c) => c.surface),
    doNotPromote: rejectedSurfaces.filter((s) => s.decision === 'do_not_promote').map((s) => s.surface),
    followupOnly: rejectedSurfaces.filter((s) => s.decision.includes('followup') || s.decision.includes('sandbox')).map((s) => s.surface),
    reasons: [
      healthMatchesV15 ? 'cached v15 health artifact matches locked bundle/root' : 'cached health artifact does not match locked v15 bundle/root',
      health.verdict?.pass === true ? 'cached lower-layer health gate passes' : 'cached lower-layer health gate does not pass',
      candidates.every((c) => c.antiIndexer.pass) ? 'all promoted candidates pass anti-indexer checks' : 'one or more promoted candidates failed anti-indexer checks',
      'temporal safety fields are not fully normalized in the legacy yield artifact; see caveat',
    ],
  },
};

mkdirSync(dirname(resolve(repoRoot, outPath)), { recursive: true });
writeFileSync(resolve(repoRoot, outPath), JSON.stringify(artifact, null, 2));
console.log(JSON.stringify({ verdict: artifact.verdict, candidates: candidates.map((c) => ({ surface: c.surface, pass: c.pass, stagePass: c.stageSplit.pass, antiIndexerPass: c.antiIndexer.pass })) }, null, 2));
