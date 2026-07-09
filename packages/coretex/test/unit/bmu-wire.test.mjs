/**
 * BMU v1 wire deltas (BMU_SPEC.md §8, §9 sites 2/3/4/17):
 *   - BMU bundle validation (site 17 additions): finite maxAge, armed
 *     liveEvalPack + familySlots, §2.3 composition, §2.4 threshold/variance
 *     pins, §13.2 judge grid + Rmax — all fail-closed via
 *     buildBundleManifest → validateProfile;
 *   - r5 profiles remain valid unchanged (replay pin), and BMU-only fields
 *     are refused on them;
 *   - scoringOptionsFromProfile: policyAtomsMode derives TRUE for the BMU
 *     pipeline (site 3 set-membership);
 *   - verifyScorerResult proof-kind + artifact-version pairing (§8.2 check 3
 *     / check 8) — BOTH directions fail closed;
 *   - buildAllowedPatchTypes set-membership (site 7): BMU suppresses
 *     KEY/CODEBOOK/HEADER updates exactly like r5;
 *   - policyAtomsModeFromManifest set-membership (site 6);
 *   - dual-pack proof kind emission + eval-report artifact version/shape.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_PROFILE,
  buildBundleManifest,
  verifyBundleManifest,
  scoringOptionsFromProfile,
  buildAllowedPatchTypes,
  dualPackProofFromPerPatchReceipt,
  buildPostRevealEvalReportArtifact,
  hashPostRevealEvalReportArtifact,
  expectedDualPackProofKind,
  bgeM3DenseManifest,
  qwen3Reranker06BManifest,
  memRerankerManifest,
  createDeterministicBiEncoder,
  PATCH_TYPE,
} from '../../dist/index.js';
import { verifyScorerResult } from '../../dist/coordinator/remote-scorer-verify.js';
import { policyAtomsModeFromManifest } from '../../dist/validator-sync-cli.js';
import { fileURLToPath } from 'node:url';

const B32 = (b) => '0x' + b.repeat(32);
const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url));

// ─── BMU profile fixture (the §6.2 pinned shape) ─────────────────────────────

const BMU_FRONTIER = {
  mode: 'C3',
  activeWindow: 9639,
  seed: 'frontier-precommit',
  baselineRecompute: 'activeRootChanged',
  majorDeltaPolicy: 'corpusRootChanged',
  maxRootDeltaPerEpoch: 24,
  maxAge: 32,
  liveEvalPack: {
    limit: 12,
    familyPriority: [
      'temporal_update', 'conflict_lifecycle', 'multi_session_bridge', 'causal_memory_chain',
      'decision_provenance', 'coreference_resolution', 'abstention_missing', 'entity_resolution_atom',
      'scope_atom', 'validity_atom',
    ],
    familySlots: { temporal: 3, conflict_lifecycle: 3, multi_hop_relation: 3, near_collision_abstention: 3 },
    freshWindow: 2,
  },
};

function bmuProfileFields(over = {}) {
  return {
    pipelineVersion: 'coretex-bmu-v1-r5state',
    hiddenPack: {
      packSize: 64,
      quotas: [
        { stratum: 'family=temporal', minCount: 10 },
        { stratum: 'family=conflict_lifecycle', minCount: 15 },
        { stratum: 'family=multi_hop_relation', minCount: 15 },
        { stratum: 'family=near_collision', minCount: 10 },
      ],
    },
    patchAcceptanceFloors: { ...DEFAULT_PROFILE.patchAcceptanceFloors, minImprovementPpm: 20_000 },
    baselineVarianceSource: 'unavailable',
    baselineParentScorePpm: 100_000,
    baselineSamples: 1,
    baselineEvalSeedHex: B32('a5'),
    // r5 policy atoms live under the BMU state law; caps pinned for Rmax.
    enableEvidenceBundleAtoms: true,
    enableConflictLifecycleAtoms: true,
    policyConflictIntentAdmission: true,
    enableAbstentionAtoms: true,
    policyMaxBudgetEvidence: 300,
    policyMaxBudgetConflict: 300,
    epochFrontier: BMU_FRONTIER,
    ...over,
  };
}

function biEnc() {
  return bgeM3DenseManifest({ revision: '0123456789abcdef0123456789abcdef01234567', files: [{ path: 'model.safetensors', sha256: 'a'.repeat(64), bytes: 1 }] });
}
function reranker() {
  return qwen3Reranker06BManifest({ revision: '89abcdef0123456789abcdef0123456789abcdef', files: [{ path: 'model.safetensors', sha256: 'b'.repeat(64), bytes: 1 }] });
}
function labeling() {
  return memRerankerManifest({ modelId: 'memreranker/4B', revision: 'cafebabedeadbeefcafebabedeadbeefcafebabe', files: [{ path: 'model.safetensors', sha256: 'c'.repeat(64), bytes: 1 }] });
}
function buildWith(evaluatorProfile) {
  return buildBundleManifest({
    repoRoot, corpusRoot: B32('11'), corpusFiles: [],
    biEncoder: biEnc(), reranker: reranker(), labelingReranker: labeling(),
    ...(evaluatorProfile ? { evaluatorProfile } : {}),
  });
}

describe('BMU bundle validation (§9 site 17)', () => {
  test('the pinned §6.2 BMU profile builds and verifies clean', () => {
    const m = buildWith(bmuProfileFields());
    assert.equal(m.evaluator.profile.pipelineVersion, 'coretex-bmu-v1-r5state');
    assert.deepEqual(verifyBundleManifest(m, repoRoot), []);
  });

  test('r5 default profile still builds clean (replay pin)', () => {
    assert.deepEqual(verifyBundleManifest(buildWith(), repoRoot), []);
  });

  test('maxAge null or absent is ILLEGAL under BMU (§6.2)', () => {
    assert.throws(() => buildWith(bmuProfileFields({ epochFrontier: { ...BMU_FRONTIER, maxAge: null } })), /FINITE epochFrontier.maxAge/);
    const { maxAge, ...noAge } = BMU_FRONTIER;
    assert.throws(() => buildWith(bmuProfileFields({ epochFrontier: noAge })), /FINITE epochFrontier.maxAge/);
  });

  test('missing epochFrontier / liveEvalPack / familySlots all refuse', () => {
    assert.throws(() => buildWith(bmuProfileFields({ epochFrontier: undefined })), /require epochFrontier/);
    const { liveEvalPack, ...noOverlay } = BMU_FRONTIER;
    assert.throws(() => buildWith(bmuProfileFields({ epochFrontier: noOverlay })), /armed epochFrontier.liveEvalPack/);
    const { familySlots, ...lawNoSlots } = BMU_FRONTIER.liveEvalPack;
    assert.throws(() => buildWith(bmuProfileFields({ epochFrontier: { ...BMU_FRONTIER, liveEvalPack: lawNoSlots } })), /familySlots/);
  });

  test('familySlots must sum to limit and use enum keys', () => {
    assert.throws(() => buildWith(bmuProfileFields({
      epochFrontier: { ...BMU_FRONTIER, liveEvalPack: { ...BMU_FRONTIER.liveEvalPack, familySlots: { temporal: 3, conflict_lifecycle: 3, multi_hop_relation: 3, near_collision_abstention: 2 } } },
    })), /must sum to limit/);
    assert.throws(() => buildWith(bmuProfileFields({
      epochFrontier: { ...BMU_FRONTIER, liveEvalPack: { ...BMU_FRONTIER.liveEvalPack, familySlots: { temporal: 3, conflict_lifecycle: 3, multi_hop_relation: 3, near_collision: 3 } } },
    })), /not a BMU family enum name/);
  });

  test('§2.3 composition: the rev3-F3 2/2/4/4 counterexample is rejected', () => {
    assert.throws(() => buildWith(bmuProfileFields({
      epochFrontier: { ...BMU_FRONTIER, liveEvalPack: { ...BMU_FRONTIER.liveEvalPack, familySlots: { temporal: 2, conflict_lifecycle: 2, multi_hop_relation: 4, near_collision_abstention: 4 } } },
    })), /composition/);
  });

  test('§2.4 pins: minImprovementPpm staircase bounds + variance source', () => {
    assert.throws(() => buildWith(bmuProfileFields({
      patchAcceptanceFloors: { ...DEFAULT_PROFILE.patchAcceptanceFloors, minImprovementPpm: 500 },
    })), /minImprovementPpm in \[15626, 31250\]/);
    assert.throws(() => buildWith(bmuProfileFields({
      patchAcceptanceFloors: { ...DEFAULT_PROFILE.patchAcceptanceFloors, minImprovementPpm: 31_251 },
    })), /minImprovementPpm/);
    assert.throws(() => buildWith(bmuProfileFields({
      baselineVarianceSource: 'rotating_pack', baselineVariancePpm: 100,
    })), /baselineVarianceSource = 'unavailable'/);
  });

  test('§13.2: judge grid, forced-alpha domain, and two-sided Rmax fail closed', () => {
    assert.doesNotThrow(() => buildWith(bmuProfileFields({ judgeScoreGrid: 1e-3 })));
    assert.doesNotThrow(() => buildWith(bmuProfileFields({ judgeScoreGrid: 0.1 })));
    assert.throws(() => buildWith(bmuProfileFields({ judgeScoreGrid: 0 })), /judgeScoreGrid/);
    assert.throws(() => buildWith(bmuProfileFields({ judgeScoreGrid: 0.5 })), /judgeScoreGrid/);
    // rev3.3: policy budget caps no longer drive Rmax (the per-doc ±1·UNIT
    // clamp bounds stacking); huge caps validate (still r5-range-checked).
    assert.doesNotThrow(() => buildWith(bmuProfileFields({ policyMaxBudgetEvidence: 65535, policyMaxBudgetConflict: 65535 })));
    // oversized FINAL-BONUS betas push Rmax = 1 + B + 2 past 4 → refused.
    assert.throws(() => buildWith(bmuProfileFields({ lensWeight: 0.9 })), /Rmax/);
    assert.doesNotThrow(() => buildWith(bmuProfileFields({ categoryLensScoreInheritance: 1 })));
    assert.throws(() => buildWith(bmuProfileFields({ categoryLensScoreInheritance: 1.01 })), /categoryLensScoreInheritance/);
    assert.throws(() => buildWith(bmuProfileFields({ categoryLensScoreInheritance: -0.01 })), /categoryLensScoreInheritance/);
  });

  test('judgeScoreGrid on a NON-BMU profile is refused', () => {
    assert.throws(() => buildWith({ judgeScoreGrid: 1e-3 }), /only meaningful under/);
  });
});

describe('site 3/6/7 set-membership', () => {
  test('scoringOptionsFromProfile derives policyAtomsMode=true for the BMU pipeline', () => {
    const m = buildWith(bmuProfileFields());
    const opts = scoringOptionsFromProfile(m.evaluator.profile, {
      biEncoder: createDeterministicBiEncoder({ modelId: 'm', revision: 'r', layout: { dim: 8, headerBytes: 9, quantization: 'int8' } }),
      reranker: { model: 'x', async score(p) { return p.map(() => 0); } },
      biEncoderHash: B32('77'),
      retrievalKeyLayout: { dim: 8, headerBytes: 9, quantization: 'int8' },
    });
    assert.equal(opts.policyAtomsMode, true);
    assert.equal(opts.pipelineVersion, 'coretex-bmu-v1-r5state');
  });

  test('policyAtomsModeFromManifest: true for r5 AND bmu-v1, false for r4', () => {
    assert.equal(policyAtomsModeFromManifest({ evaluator: { profile: { pipelineVersion: 'coretex-retrieval-v2-policy-r5' } } }), true);
    assert.equal(policyAtomsModeFromManifest({ evaluator: { profile: { pipelineVersion: 'coretex-bmu-v1-r5state' } } }), true);
    assert.equal(policyAtomsModeFromManifest({ evaluator: { profile: { pipelineVersion: 'coretex-retrieval-v2-lens-r4' } } }), false);
  });

  test('buildAllowedPatchTypes suppresses KEY/CODEBOOK/HEADER under BMU exactly like r5', () => {
    const bmu = buildAllowedPatchTypes({ pipelineVersion: 'coretex-bmu-v1-r5state' });
    const r5 = buildAllowedPatchTypes({ pipelineVersion: 'coretex-retrieval-v2-policy-r5' });
    assert.deepEqual(bmu, r5, 'BMU state law must equal the r5 state law byte-for-byte');
    const bytes = new Set(bmu.map((t) => t.byte));
    for (const suppressed of [PATCH_TYPE.KEY_UPDATE, PATCH_TYPE.CODEBOOK_UPDATE, PATCH_TYPE.HEADER_UPDATE]) {
      assert.ok(!bytes.has(suppressed), `suppressed type ${suppressed} advertised under BMU`);
    }
    // r4 keeps KEY_UPDATE — the set-membership change must not affect it.
    const r4bytes = new Set(buildAllowedPatchTypes({ pipelineVersion: 'coretex-retrieval-v2-lens-r4' }).map((t) => t.byte));
    assert.ok(r4bytes.has(PATCH_TYPE.KEY_UPDATE));
  });
});

describe('§8.2/§8.3 proof-kind + artifact-version pairing', () => {
  function minimalResult(over = {}) {
    return {
      jobId: 'job-1',
      accepted: true,
      deltaPpm: 42_000,
      gateScorePpm: 45_000,
      confirmScorePpm: 42_000,
      thresholdPpmUsed: 1_000,
      policyHash: B32('ee'),
      pairTraceHash: B32('aa'),
      scoreArrayHash: B32('bb'),
      evalReportHash: B32('e1'),
      artifactHash: B32('a1'),
      evaluationProof: { kind: 'coretex-dual-pack-v1' },
      scorerHealth: { modelId: 'm', revision: 'r', promptTemplateHash: B32('ab') },
      ...over,
    };
  }
  // job.epochId != active.epochId: getting PAST the schema check surfaces as
  // SCORER_STALE_CONTEXT — proves the kind pairing accepted it.
  const job = { jobId: 'job-1', epochId: 7, thresholdPpm: 1_000, policyHash: B32('ee') };
  const activeR5 = { epochId: 8, parentStateRoot: B32('01'), corpusRoot: B32('cc'), bundleHash: B32('dd'), coreVersionHash: B32('dd'), workPolicyHash: B32('ee'), thresholdPpm: 1_000, pipelineVersion: 'coretex-retrieval-v2-policy-r5' };
  const activeBmu = { ...activeR5, pipelineVersion: 'coretex-bmu-v1-r5state' };
  const expectedHealth = { modelId: 'm', revision: 'r', promptTemplateHash: B32('ab') };
  const outstanding = new Set(['job-1']);
  const verify = (result, active) => verifyScorerResult({ result, job, outstandingJobIds: outstanding, active, expectedHealth });

  test('an r5-law epoch REFUSES a BMU proof; a BMU-law epoch REFUSES an r5 proof', () => {
    const v1 = verify(minimalResult({ evaluationProof: { kind: 'coretex-bmu-dual-pack-v1' } }), activeR5);
    assert.equal(v1.ok, false);
    assert.equal(v1.code, 'SCORER_RESULT_MALFORMED');
    assert.match(v1.reason, /does not pair/);
    const v2 = verify(minimalResult(), activeBmu);
    assert.equal(v2.ok, false);
    assert.equal(v2.code, 'SCORER_RESULT_MALFORMED');
    assert.match(v2.reason, /does not pair/);
  });

  test('matched kinds pass the pairing (fail later at stale-context)', () => {
    const v1 = verify(minimalResult(), activeR5);
    assert.equal(v1.code, 'SCORER_STALE_CONTEXT');
    const v2 = verify(minimalResult({ evaluationProof: { kind: 'coretex-bmu-dual-pack-v1' } }), activeBmu);
    assert.equal(v2.code, 'SCORER_STALE_CONTEXT');
  });

  test('absent active pipelineVersion requires the r5 kinds (a BMU result can never slip past an un-armed coordinator)', () => {
    const { pipelineVersion, ...activeNone } = activeR5;
    const v = verify(minimalResult({ evaluationProof: { kind: 'coretex-bmu-dual-pack-v1' } }), activeNone);
    assert.equal(v.ok, false);
    assert.equal(v.code, 'SCORER_RESULT_MALFORMED');
  });

  test('expectedDualPackProofKind pairs kinds with the scoring law', () => {
    assert.equal(expectedDualPackProofKind('coretex-bmu-v1-r5state'), 'coretex-bmu-dual-pack-v1');
    assert.equal(expectedDualPackProofKind('coretex-retrieval-v2-policy-r5'), 'coretex-dual-pack-v1');
    assert.equal(expectedDualPackProofKind(undefined), 'coretex-dual-pack-v1');
  });

  test('dualPackProofFromPerPatchReceipt emits the BMU kind when asked, r5 kind by default', () => {
    const receipt = {
      patchHash: B32('01'), dedupKey: B32('02'), parentRoot: B32('03'), minerAddress: '0x' + '11'.repeat(20),
      epochId: 7, receivedAtBlock: 10, targetBlock: 25, blockhash: B32('04'),
      gateSeed: B32('05'), confirmSeed: B32('06'), gateScorePpm: 50_000, confirmScorePpm: 45_000, accepted: true,
    };
    const ctx = { corpusRoot: B32('cc'), coreVersionHash: B32('dd'), hiddenSeedCommit: B32('07'), targetBlockOffset: 15 };
    assert.equal(dualPackProofFromPerPatchReceipt(receipt, ctx).kind, 'coretex-dual-pack-v1');
    assert.equal(dualPackProofFromPerPatchReceipt(receipt, { ...ctx, proofKind: 'coretex-bmu-dual-pack-v1' }).kind, 'coretex-bmu-dual-pack-v1');
  });
});

describe('§8.3 BMU artifact version + shape', () => {
  const FAM_PPM = { temporal: 500000, conflict_lifecycle: 250000, multi_hop_relation: 0, near_collision_abstention: 1000000 };
  const REGRESSED = { temporal: 0, conflict_lifecycle: 1, multi_hop_relation: 0, near_collision_abstention: 0 };
  function artifactBody(version, extra = {}) {
    return {
      version,
      epochId: 7,
      minerAddress: '0x' + '11'.repeat(20),
      outcome: 'SCREENER_PASS',
      compactPatchBytesHex: '0x00',
      thresholdPpm: 20_250,
      seedDerivation: {
        mode: 'future_blockhash_dual_pack', epochId: 7, receivedAtBlock: 10, targetBlock: 25, targetBlockOffset: 15,
        blockhash: B32('04'), patchHash: B32('01'), parentStateRoot: B32('03'), corpusRoot: B32('cc'), bundleHash: B32('dd'),
      },
      receipt: {
        patchHash: B32('01'), dedupKey: B32('02'), parentRoot: B32('03'), minerAddress: '0x' + '11'.repeat(20),
        epochId: 7, receivedAtBlock: 10, targetBlock: 25, blockhash: B32('04'),
        gateSeed: B32('05'), confirmSeed: B32('06'), gateScorePpm: 50_000, confirmScorePpm: 45_000, accepted: true,
      },
      context: {
        parentStateRoot: B32('03'), corpusRoot: B32('cc'), coreVersionHash: B32('dd'), hiddenSeedCommit: B32('07'),
        replayTolerancePpm: 250, activeFrontierRoot: B32('08'),
      },
      ...extra,
    };
  }

  test('a BMU artifact with per-family aggregates hashes + builds like any artifact', () => {
    const artifact = buildPostRevealEvalReportArtifact(artifactBody('coretex-bmu-post-reveal-eval-report-v1', {
      bmuFamilySummary: {
        gate: { parentFamilyUtilitiesPpm: FAM_PPM, candidateFamilyUtilitiesPpm: FAM_PPM, regressedRowsByFamily: REGRESSED },
        confirm: { parentFamilyUtilitiesPpm: FAM_PPM, candidateFamilyUtilitiesPpm: FAM_PPM, regressedRowsByFamily: REGRESSED },
        exclusionSetDigest: B32('09'),
      },
    }));
    assert.equal(artifact.artifactHash, artifact.evalReportHash);
    assert.equal(hashPostRevealEvalReportArtifact(artifact), artifact.artifactHash);
    // the summary participates in the hash domain
    const without = buildPostRevealEvalReportArtifact(artifactBody('coretex-bmu-post-reveal-eval-report-v1'));
    assert.notEqual(without.artifactHash, artifact.artifactHash);
  });

  test('r5 artifact hashing is byte-identical to before (no new fields injected)', () => {
    const artifact = buildPostRevealEvalReportArtifact(artifactBody('coretex-post-reveal-eval-report-v1'));
    assert.ok(!('bmuFamilySummary' in artifact));
  });
});
