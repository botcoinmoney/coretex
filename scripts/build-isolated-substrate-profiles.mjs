#!/usr/bin/env node
/**
 * Derives one ISOLATED calibration profile per reclaimed substrate from the all-on calibration
 * profile. Each isolated profile turns OFF every reclaimed substrate except the named one
 * (+ that substrate's REQUIRED siblings per canonical validation rules). Writes:
 *
 *   release/bundle/evaluator-profile-v2-dgen1-policy-r5-300k-isolated-<surface>.json
 *
 * Then builds a matching bundle:
 *
 *   release/bundle/bundle-manifest-v2-dgen1-policy-r5-300k-isolated-<surface>.json
 *
 * Surfaces:
 *   temporal           — temporalStaleContrast only
 *   abstention         — enableAbstentionAtoms + policyAbstentionMarginThreshold (top1+margin)
 *   evidence_bundle    — enableEvidenceBundleAtoms + query-conditioned + relation-typed admission
 *   relation_typed     — relation-typed admission alone (admission without atoms)
 *   conflict_lifecycle — enableConflictLifecycleAtoms + policyConflictIntentAdmission
 *   aspect_sandbox     — aspect re-enabled for isolated re-measurement (NOT a candidate profile;
 *                        a clean substrate-isolated probe; the all-on calibration profile keeps
 *                        aspect off after the 2026-05-30 damage finding)
 *
 * Each isolated profile keeps the corpus+frontier+baseline pins identical so the bundle's
 * corpus.root + epochFrontier remain comparable across isolations.
 *
 * Usage: node scripts/build-isolated-substrate-profiles.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { repoRoot } from './_repo-root.mjs';

const execAsync = promisify(exec);
const BASE_PROFILE = 'release/bundle/evaluator-profile-v2-dgen1-policy-r5-300k-calibration.json';
const CORPUS = 'release/calibration/2026-05-21-memory-corpus-v2/dgen1-r5-synth-300k-final-corpus.json';
const EMB = 'release/calibration/2026-05-21-memory-corpus-v2/dgen1-r5-synth-300k-final-embeddings.json';

const base = JSON.parse(readFileSync(resolve(repoRoot, BASE_PROFILE), 'utf8'));

// All reclaimed-substrate knobs we toggle. Resetting these on each isolation guarantees a
// clean per-surface measurement.
const ALL_OFF = {
  enableEvidenceBundleAtoms: false,
  enableConflictLifecycleAtoms: false,
  enableAbstentionAtoms: false,
  enableAspectConstraintAtoms: false,
  policyQueryConditionedAdmission: false,
  policyRelationTypedAdmission: false,
  policyConflictIntentAdmission: false,
  policyAspectIntentAdmission: false,
  policyAspectBoost: 0,
  // temporalStaleContrast stays unless explicitly disabled (probe semantics)
  // policyAbstentionMarginThreshold removed unless explicitly set
};

function makeIsolated(name, overrides, note) {
  const p = { ...base, ...ALL_OFF, ...overrides };
  delete p.policyAbstentionMarginThreshold;
  if (name === 'temporal') p.temporalStaleContrast = true;
  else if (overrides._tempBaseOff === true) { p.temporalStaleContrast = false; delete p._tempBaseOff; }
  p.name = `coretex-evaluator-v2-dgen1-policy-r5-isolated-${name}`;
  p.version = `r5-isolated-${name}-2026-05-30`;
  p._isolatedProfileNote = note;
  delete p._calibrationPolicyNote;
  delete p._aspectDisabledNote;
  delete p._noiseSuppressionNote;
  // Re-apply abstention margin if abstention isolation
  if (name === 'abstention') p.policyAbstentionMarginThreshold = 0.05;
  return p;
}

const SURFACES = [
  {
    name: 'temporal',
    overrides: {},
    note: 'TEMPORAL-ONLY isolation. temporalStaleContrast on; every other reclaimed substrate off. Use to measure pack-interference vs isolated yield for the temporal currency substrate.',
  },
  {
    name: 'abstention',
    overrides: { enableAbstentionAtoms: true, _tempBaseOff: true },
    note: 'ABSTENTION-ONLY isolation. enableAbstentionAtoms on + policyAbstentionMarginThreshold=0.05; every other reclaimed substrate off. Use to measure clean top1/margin separation without contamination from other surfaces.',
  },
  {
    name: 'evidence_bundle',
    overrides: { enableEvidenceBundleAtoms: true, policyQueryConditionedAdmission: true, policyRelationTypedAdmission: true, _tempBaseOff: true },
    note: 'EVIDENCE_BUNDLE-ONLY isolation. enableEvidenceBundleAtoms + relation-typed query-conditioned admission; every other reclaimed substrate off. Use to measure clean evidence-bundle lift without contamination from temporal/abstention/conflict.',
  },
  {
    name: 'relation_typed',
    overrides: { policyQueryConditionedAdmission: true, policyRelationTypedAdmission: true, _tempBaseOff: true },
    note: 'RELATION_TYPED-ONLY isolation. Relation-typed admission WITHOUT enableEvidenceBundleAtoms — measures whether typed admission alone (no policy atoms written) changes scoring. Useful for separating "the admission mechanism" from "the atoms themselves".',
  },
  {
    name: 'conflict_lifecycle',
    overrides: { enableConflictLifecycleAtoms: true, policyConflictIntentAdmission: true, _tempBaseOff: true },
    note: 'CONFLICT_LIFECYCLE-ONLY isolation. enableConflictLifecycleAtoms + policyConflictIntentAdmission (required by validation); every other reclaimed substrate off.',
  },
  {
    name: 'aspect_sandbox',
    overrides: { enableAspectConstraintAtoms: true, policyAspectIntentAdmission: true, policyAspectBoost: 0.1, _tempBaseOff: true },
    note: 'ASPECT-SANDBOX isolation. enableAspectConstraintAtoms + policyAspectIntentAdmission + policyAspectBoost=0.1. NOT a candidate profile — the all-on calibration profile keeps aspect OFF after the 2026-05-30 damage finding (-0.30 nDCG / 175 primary-gold-damaged on 621 slice). This sandbox lets a re-measure or redesign run isolated WITHOUT contaminating the calibration profile.',
  },
];

const outputs = [];
for (const s of SURFACES) {
  const profile = makeIsolated(s.name, s.overrides, s.note);
  const profilePath = `release/bundle/evaluator-profile-v2-dgen1-policy-r5-300k-isolated-${s.name}.json`;
  const bundlePath = `release/bundle/bundle-manifest-v2-dgen1-policy-r5-300k-isolated-${s.name}.json`;
  writeFileSync(resolve(repoRoot, profilePath), JSON.stringify(profile, null, 2));
  console.log(`wrote ${profilePath}`);
  console.log(`  building bundle ...`);
  const cmd = `node scripts/build-v2-bundle-candidate.mjs --corpus ${CORPUS} --emb ${EMB} --profile ${profilePath} --out ${bundlePath}`;
  const { stdout, stderr } = await execAsync(cmd, { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 });
  const result = JSON.parse(stdout);
  if (!result.ok) { console.error(`HARD FAIL: bundle build for ${s.name}: ${stderr}`); process.exit(1); }
  console.log(`  bundleHash ${result.bundleHash}`);
  outputs.push({ surface: s.name, profile: profilePath, bundle: bundlePath, bundleHash: result.bundleHash });
}

console.log('\n=== ISOLATED PROFILES BUILT ===');
console.log(JSON.stringify(outputs, null, 2));
