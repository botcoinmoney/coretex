#!/usr/bin/env node
/**
 * Build the reduced CoreTex launch-candidate profile and matching bundle.
 *
 * This derives from the all-on v15 calibration profile, keeps only the surfaces
 * promoted by the 2026-06-02 handoff, and leaves sandbox/damaging surfaces off.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { distIndex, repoRoot } from './_repo-root.mjs';
import { buildV2ProductionCorpus } from './lib/build-v2-production-corpus.mjs';

const {
  buildBundleManifest,
  verifyBundleManifest,
  bgeM3DenseManifest,
  qwen3Reranker06BManifest,
  memReranker4BManifest,
} = await import(distIndex);

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d;
};

const baseProfilePath = flag('base-profile', 'release/bundle/evaluator-profile-v2-dgen1-policy-r5-300k-calibration.json');
const corpusPath = flag('corpus', 'release/calibration/2026-05-21-memory-corpus-v2/dgen1-r5-synth-300k-v15-corpus.json');
const embPath = flag('emb', 'release/calibration/2026-05-21-memory-corpus-v2/dgen1-r5-synth-300k-v15-embeddings.json');
const pinBundlePath = flag('bundle', 'release/bundle/bundle-manifest-v2-dgen1-policy-r5-300k-calibration.json');
const outProfilePath = flag('out-profile', 'release/bundle/evaluator-profile-v2-dgen1-policy-r5-300k-launch-reduced.json');
const outBundlePath = flag('out-bundle', 'release/bundle/bundle-manifest-v2-dgen1-policy-r5-300k-launch-reduced.json');

const base = JSON.parse(readFileSync(resolve(repoRoot, baseProfilePath), 'utf8'));
const profile = structuredClone(base);

profile.name = 'coretex-evaluator-v2-dgen1-policy-r5-launch-reduced';
profile.version = 'r5-launch-reduced-2026-06-02';
profile.hiddenPack = {
  packSize: 64,
  quotas: [
    { stratum: 'family=near_collision', minCount: 12 },
    { stratum: 'family=temporal', minCount: 14 },
    { stratum: 'family=multi_hop_relation', minCount: 16 },
    { stratum: 'family=conflict_lifecycle', minCount: 10 },
  ],
};

profile.temporalStaleContrast = true;
profile.temporalCurrentBoost = 0.1;
profile.temporalStaleSuppression = 0.1;
profile.enableEvidenceBundleAtoms = true;
profile.categoryLensEvidenceBundle = true;
profile.policyQueryConditionedAdmission = true;
profile.policyRelationTypedAdmission = true;
profile.enableConflictLifecycleAtoms = true;
profile.policyConflictIntentAdmission = true;
profile.enableAbstentionAtoms = true;
delete profile.policyAbstentionMarginThreshold;

profile.enableAspectConstraintAtoms = false;
profile.policyAspectIntentAdmission = false;
profile.policyAspectBoost = 0;

profile.controllerParams = {
  ...(profile.controllerParams ?? {}),
  rampUpMaxRatio: 1.1,
  decayRatio: 0.8,
  smallDriftRatio: 1.05,
  underTargetRecoveryRatio: 0.9,
  qualityHighThresholdMult: 1,
};

profile.activeSubstrateSurfaces = [
  'temporal_update',
  'conflict_lifecycle',
  'causal_decision_lensOnly',
  'evidence_bundle_bundleOnly',
  'relation_category_routing',
  'abstention_top1',
];
profile.disabledSubstrateSurfaces = [
  'phaseAEdges',
  'combined_relation_routing',
  'raw_anchors',
  'evidence_reach_only',
  'coreference',
  'aspect_constraint',
  'noise_suppression',
];
profile._launchReducedProfileNote = 'Launch-candidate reduced profile derived 2026-06-02 from the v15 all-on calibration profile. Keeps only promoted surfaces; sandbox/damaging surfaces stay off. Hidden-pack quotas remove aspect/coreference hard quotas, while free fill still samples the full eval-hidden corpus for damage detection.';
delete profile._calibrationPolicyNote;
delete profile._aspectDisabledNote;
delete profile._noiseSuppressionNote;

mkdirSync(dirname(resolve(repoRoot, outProfilePath)), { recursive: true });
writeFileSync(resolve(repoRoot, outProfilePath), JSON.stringify(profile, null, 2) + '\n');

const { corpus } = buildV2ProductionCorpus({ corpusPath, embPath, bundlePath: pinBundlePath });
const corpusFiles = [
  relative(repoRoot, resolve(repoRoot, corpusPath)).replaceAll('\\', '/'),
  relative(repoRoot, resolve(repoRoot, embPath)).replaceAll('\\', '/'),
];
const manifest = buildBundleManifest({
  repoRoot,
  corpusRoot: corpus.corpusRoot,
  corpusFiles,
  biEncoder: bgeM3DenseManifest(),
  reranker: qwen3Reranker06BManifest(),
  labelingReranker: memReranker4BManifest(),
  evaluatorProfile: profile,
});
const errors = verifyBundleManifest(manifest, repoRoot);
if (errors.length > 0) {
  console.error(JSON.stringify({ ok: false, errors }, null, 2));
  process.exit(2);
}

mkdirSync(dirname(resolve(repoRoot, outBundlePath)), { recursive: true });
writeFileSync(resolve(repoRoot, outBundlePath), JSON.stringify(manifest, null, 2) + '\n');

console.log(JSON.stringify({
  ok: true,
  profile: outProfilePath,
  bundle: outBundlePath,
  bundleHash: manifest.bundleHash,
  corpusRoot: manifest.corpus.root,
  hiddenPackQuotas: profile.hiddenPack.quotas,
  activeSubstrateSurfaces: profile.activeSubstrateSurfaces,
}, null, 2));
