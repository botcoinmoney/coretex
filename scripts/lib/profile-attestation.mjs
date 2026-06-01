/**
 * Profile attestation for calibration artifacts.
 *
 * Returns the data a downstream reader needs to verify which profile
 * the artifact was produced against — without re-loading the corpus or
 * re-running the scorer.
 *
 * Surfaced fields:
 *   profilePath        — filesystem path of the loaded profile
 *   profileSha256      — sha256 of the canonical-JSON-stringified profile
 *                        (NOT the bundle's signed hash; a local
 *                        artifact-tracking digest. Stable across runs
 *                        that loaded the same file).
 *   scalarPins         — the scorer-relevant scalar configuration that
 *                        flowed into ScoringOptions, including the new
 *                        split budget. Lets a reader spot a stale
 *                        profile field without re-loading.
 *   pinnedThreshold    — for Run 4-shaped artifacts; the three terms
 *                        summed by computeAcceptanceThresholdPpm.
 */
import { createHash } from 'node:crypto';

export function profileAttestation(profile, profilePath) {
  const canonical = canonicalJsonStringify(profile);
  const profileSha256 = '0x' + createHash('sha256').update(canonical).digest('hex');
  return {
    profilePath: profilePath ?? null,
    profileSha256,
    pipelineVersion: profile?.pipelineVersion ?? null,
    scalarPins: {
      firstStageTopK: profile?.firstStageTopK ?? null,
      firstStageMode: profile?.firstStageMode ?? null,
      firstStageDenseWeight: profile?.firstStageDenseWeight ?? null,
      firstStageLexicalWeight: profile?.firstStageLexicalWeight ?? null,
      rerankerInputTopK: profile?.rerankerInputTopK ?? null,
      lensTopK: profile?.lensTopK ?? null,
      lensWeight: profile?.lensWeight ?? null,
      anchorWeight: profile?.anchorWeight ?? null,
      relationExpansionBudget: profile?.relationExpansionBudget ?? null,
      categoryLensExpansionBudget: profile?.categoryLensExpansionBudget ?? null,
      relationHopBudget: profile?.relationHopBudget ?? null,
      temporalCurrentBoost: profile?.temporalCurrentBoost ?? null,
      temporalStaleSuppression: profile?.temporalStaleSuppression ?? null,
      lensDiversityFloor: profile?.lensDiversityFloor ?? null,
      rerankerTopK: profile?.rerankerTopK ?? null,
      retrievalKeyTopK: profile?.retrievalKeyTopK ?? null,
      abstentionThreshold: profile?.abstentionThreshold ?? null,
    },
    pinnedThreshold: profile?.patchAcceptanceFloors ? {
      minImprovementPpm: profile.patchAcceptanceFloors.minImprovementPpm ?? null,
      replayTolerancePpm: profile.replayTolerancePpm ?? null,
      baselineVariancePpm: profile.baselineVariancePpm ?? null,
      total: (profile.patchAcceptanceFloors.minImprovementPpm ?? 0)
           + (profile.replayTolerancePpm ?? 0)
           + (profile.baselineVariancePpm ?? 0),
    } : null,
    hiddenPack: profile?.hiddenPack ? {
      packSize: profile.hiddenPack.packSize,
      quotas: profile.hiddenPack.quotas ?? [],
    } : null,
  };
}

// Canonical JSON: keys sorted, no extraneous whitespace. Sufficient for
// a stable digest across re-loads of the same file.
function canonicalJsonStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJsonStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJsonStringify(value[k])).join(',') + '}';
}
