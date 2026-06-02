#!/usr/bin/env node
/**
 * Bundle / profile attestation smoke  (Launch hardening L13).
 *
 * The bundleHash = keccak256(canonicalJson(manifest \ bundleHash)) MUST change
 * when any behavior-affecting field changes, so a validator that pins a
 * bundleHash is pinning the exact scoring/controller/model/replay behavior.
 *
 * Proves:
 *   1. The candidate manifest's stored bundleHash is self-consistent.
 *   2. Mutating each scoring-affecting profile knob flips the bundleHash:
 *      compositeWeights, replayTolerancePpm, rerankerTopK, abstentionThreshold,
 *      relationHopBudget, pipelineVersion, controllerParams, majorDeltaThreshold,
 *      baselineParentScorePpm, policyMaxBudgetEvidence, policyRelationTypedAdmission,
 *      raw-anchor/Phase-A/evidence-action reduced-profile gates.
 *   3. Mutating the pinned reranker model revision flips the hash; ADDING a
 *      reranker adapter flips the hash (a tuned-reranker promotion cannot be
 *      silent — dormant flywheel artifacts that are NOT pinned do not affect it).
 *   4. ENABLING conflict_state (enableConflictLifecycleAtoms + the
 *      policyConflictIntentAdmission selector) flips the hash → the conflict-
 *      intent knobs are attested whenever conflict_state is active.
 *
 * Usage: node scripts/bundle-attestation-smoke.mjs [--bundle <manifest.json>]
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { argv, exit } from 'node:process';
import { distIndex, repoRoot } from './_repo-root.mjs';

const { computeBundleHashFromManifest } = await import(distIndex);

const opt = (name, fb) => { const i = argv.indexOf(`--${name}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fb; };
const bundlePath = opt('bundle', 'release/bundle/bundle-manifest-v2-dgen1-policy-r5-candidate.json');
const manifest = JSON.parse(readFileSync(resolve(repoRoot, bundlePath), 'utf8'));
const clone = (o) => JSON.parse(JSON.stringify(o));
const hashOf = (mf) => { const { bundleHash, ...rest } = mf; return computeBundleHashFromManifest(rest); };

let pass = true; const log = [];
const check = (n, ok, d = '') => { log.push(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`); if (!ok) pass = false; };

const baseHash = hashOf(manifest);
check('0) stored bundleHash is self-consistent', baseHash === manifest.bundleHash.toLowerCase(), `${manifest.bundleHash}`);

// each mutation must flip the hash
function mutateAndCheck(label, mutate) {
  const mf = clone(manifest);
  mutate(mf.evaluator.profile, mf);
  const h = hashOf(mf);
  check(`knob change flips bundleHash: ${label}`, h !== baseHash, h === baseHash ? 'UNCHANGED (not attested!)' : `→ ${h.slice(0, 18)}…`);
}

mutateAndCheck('compositeWeights.w_retrieval', (p) => { p.compositeWeights.w_retrieval += 0.01; });
mutateAndCheck('replayTolerancePpm', (p) => { p.replayTolerancePpm += 1; });
mutateAndCheck('rerankerTopK', (p) => { p.rerankerTopK += 1; });
mutateAndCheck('abstentionThreshold', (p) => { p.abstentionThreshold = (p.abstentionThreshold ?? 0.001) + 0.0001; });
mutateAndCheck('relationHopBudget', (p) => { p.relationHopBudget = (p.relationHopBudget ?? 3) + 1; });
mutateAndCheck('pipelineVersion', (p) => { p.pipelineVersion = p.pipelineVersion + '-x'; });
mutateAndCheck('controllerParams.qualityHighThresholdMult', (p) => { p.controllerParams = { ...(p.controllerParams ?? {}), qualityHighThresholdMult: (p.controllerParams?.qualityHighThresholdMult ?? 1) + 1 }; });
mutateAndCheck('controllerParams.underTargetRecoveryRatio', (p) => { p.controllerParams = { ...(p.controllerParams ?? {}), underTargetRecoveryRatio: (p.controllerParams?.underTargetRecoveryRatio ?? 0.95) * 0.9 }; });
mutateAndCheck('majorDeltaThreshold', (p) => { p.majorDeltaThreshold = (p.majorDeltaThreshold ?? 10) + 1; });
mutateAndCheck('baselineParentScorePpm', (p) => { p.baselineParentScorePpm = (p.baselineParentScorePpm ?? 0) + 1; });
mutateAndCheck('policyMaxBudgetEvidence', (p) => { p.policyMaxBudgetEvidence = (p.policyMaxBudgetEvidence ?? 250) + 1; });
mutateAndCheck('policyRelationTypedAdmission', (p) => { p.policyRelationTypedAdmission = !(p.policyRelationTypedAdmission ?? true); });
mutateAndCheck('enableRawRoutingAnchors', (p) => { p.enableRawRoutingAnchors = !(p.enableRawRoutingAnchors ?? true); });
mutateAndCheck('enableRelationAnchorEdges', (p) => { p.enableRelationAnchorEdges = !(p.enableRelationAnchorEdges ?? true); });
mutateAndCheck('policyEvidenceAllowedActions', (p) => { p.policyEvidenceAllowedActions = ['bundle', 'boost']; });

// reranker model pin + adapter
mutateAndCheck('model.reranker.revision', (_p, mf) => { mf.model.reranker.revision = 'deadbeef' + mf.model.reranker.revision.slice(8); });
mutateAndCheck('model.reranker adapter ADDED (tuned-reranker promotion cannot be silent)', (_p, mf) => { mf.model.reranker.adapter = { id: 'memoryops-lora-candidate', revision: 'v1' }; });

// conflict_state knobs (launch-enabled) are attested: toggling either flips the hash
mutateAndCheck('enableConflictLifecycleAtoms toggle', (p) => { p.enableConflictLifecycleAtoms = !(p.enableConflictLifecycleAtoms ?? false); });
mutateAndCheck('policyConflictIntentAdmission toggle (strict selector)', (p) => { p.policyConflictIntentAdmission = !(p.policyConflictIntentAdmission ?? false); });
mutateAndCheck('policyMaxBudgetConflict', (p) => { p.policyMaxBudgetConflict = (p.policyMaxBudgetConflict ?? 1000) + 1; });
// aspect_constraint EXPERIMENTAL knobs (default-off; A100 candidate) are attested: enabling the
// experimental aspect surface or changing its boost flips the hash → it can never be silently toggled on.
mutateAndCheck('aspect experimental enable (enableAspectConstraintAtoms+policyAspectIntentAdmission+boost)', (p) => { p.enableAspectConstraintAtoms = true; p.policyAspectIntentAdmission = true; p.policyAspectBoost = 0.1; });
mutateAndCheck('policyAspectBoost', (p) => { p.policyAspectBoost = (p.policyAspectBoost ?? 0) + 0.05; });
// churn (launch-required) is attested: mutating the epochFrontier pin flips the hash
mutateAndCheck('epochFrontier.activeWindow (churn pin)', (p) => { p.epochFrontier = { ...(p.epochFrontier ?? { mode: 'C3', seed: 's', baselineRecompute: 'activeRootChanged', majorDeltaPolicy: 'corpusRootChanged' }), activeWindow: (p.epochFrontier?.activeWindow ?? 141) + 1 }; });
mutateAndCheck('epochFrontier.mode (churn controller)', (p) => { p.epochFrontier = { ...(p.epochFrontier ?? { activeWindow: 141, seed: 's', baselineRecompute: 'activeRootChanged', majorDeltaPolicy: 'corpusRootChanged' }), mode: p.epochFrontier?.mode === 'C3' ? 'C1' : 'C3' }; });

console.log(log.join('\n'));
console.log('────────────────────────────────────────────────────────');
console.log(`bundle      ${bundlePath}`);
console.log(`bundleHash  ${manifest.bundleHash}`);
console.log(`pipelineVersion ${manifest.evaluator.profile.pipelineVersion} | conflict_state enabled: ${manifest.evaluator.profile.enableConflictLifecycleAtoms === true}`);
console.log(pass ? 'RESULT: ALL PASS ✅ (every behavior knob is attested by bundleHash)' : 'RESULT: FAIL ❌ (a behavior knob is NOT attested)');
exit(pass ? 0 : 1);
