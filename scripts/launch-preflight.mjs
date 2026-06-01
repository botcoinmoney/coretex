#!/usr/bin/env node
/**
 * LAUNCH PREFLIGHT GATE (300k canonical tree). Hard-fails unless the launch tree is coherent and
 * the runtime that will execute IS the runtime attested by the bundle. Emits a launch FINGERPRINT
 * (git commit + per-file sha256 manifest over the launch-relevant set + bundleHash/corpusRoot/
 * activeFrontierRoot/profileHash) that every result artifact MUST embed and that the A100 side must
 * reproduce byte-identically before any calibration/economics run.
 *
 * Discipline: the canonical /root/cortex launch tree is the authority; A100 is compute only; no
 * standalone reimplementation of launch policy. Any mismatch is a hard stop.
 *
 * Usage:
 *   node scripts/launch-preflight.mjs                              # deep gate (full corpus materialize + fingerprint)
 *   node scripts/launch-preflight.mjs --emit <path>                # also write fingerprint JSON
 *   node scripts/launch-preflight.mjs --compare <remoteFingerprint.json>  # assert parity vs A100
 *   node scripts/launch-preflight.mjs --mode=parity --compare <p>  # FAST parity (no corpus rebuild)
 *   node scripts/launch-preflight.mjs --profile <p> --bundle <b> --corpus <c> --emb <e>
 *
 * Modes:
 *   deep   (default): typecheck implied by .sh wrapper; rebuilds 300k production corpus, derives
 *                     corpusRoot + activeFrontierRoot, runs every coherence check, emits fingerprint.
 *                     Use ONCE locally before any A100 spend.
 *   parity (--mode=parity): hard-fails on any missing fingerprint root, verifies bundle manifest,
 *                     emits the file-walk fingerprint, compares against --compare. NO corpus
 *                     materialization — trusts the bundle's attested corpus.root + sha256 sidecars.
 *                     Use for A100 sync-integrity / parity (seconds, not minutes).
 */
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { argv, exit } from 'node:process';
import { distIndex, repoRoot } from './_repo-root.mjs';

const C = await import(distIndex);
const { verifyBundleManifest, computeCorpusRoot, makeLaunchFrontier, computePatchHash, computeAcceptanceThresholdPpm, computeProfileHash, deriveQueryPack, packQuotaCoverage } = C;

const flag = (n, d) => {
  const eq = argv.find((a) => a.startsWith(`--${n}=`));
  if (eq) return eq.slice(n.length + 3);
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d;
};
const MODE = flag('mode', 'deep');
if (MODE !== 'deep' && MODE !== 'parity') {
  console.error(`HARD FAIL: --mode must be 'deep' or 'parity' (got '${MODE}')`);
  exit(1);
}
const CORPUS  = flag('corpus',  'release/calibration/2026-05-21-memory-corpus-v2/dgen1-r5-synth-300k-final-corpus.json');
const EMB     = flag('emb',     'release/calibration/2026-05-21-memory-corpus-v2/dgen1-r5-synth-300k-final-embeddings.json');
const PROFILE = flag('profile', 'release/bundle/evaluator-profile-v2-dgen1-policy-r5-300k.json');
const BUNDLE  = flag('bundle',  'release/bundle/bundle-manifest-v2-dgen1-policy-r5-300k.json');

let pass = true;
const fails = [];
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); if (!ok) { pass = false; fails.push(name); } };
const sha256 = (buf) => '0x' + createHash('sha256').update(buf).digest('hex');
const sha256File = (p) => existsSync(resolve(repoRoot, p)) ? sha256(readFileSync(resolve(repoRoot, p))) : null;

console.log(`══════════ LAUNCH PREFLIGHT (mode=${MODE}, 300k canonical tree) ══════════`);
console.log(`profile: ${PROFILE}`);
console.log(`bundle:  ${BUNDLE}`);
console.log(`corpus:  ${CORPUS}`);

// 0. HARD-FAIL on missing fingerprint roots before doing anything expensive. Silent skip used to
//    let parity runs proceed with under-counted file walks; now any missing root is an instant stop.
const FINGERPRINT_ROOTS = [
  'packages/cortex/dist',
  'packages/cortex/src',
  'packages/cortex-py/cortex_py',
  'contracts/src',
  'specs',
  'scripts',
  'release/bundle',
];
const missingRoots = FINGERPRINT_ROOTS.filter((r) => !existsSync(resolve(repoRoot, r)));
if (missingRoots.length > 0) {
  console.error(`HARD FAIL: missing fingerprint roots — ${missingRoots.join(', ')}`);
  console.error('Sync these paths before running preflight (a100-sync.sh sync_code includes all roots).');
  exit(1);
}
for (const p of [CORPUS, EMB, PROFILE, BUNDLE]) {
  if (!existsSync(resolve(repoRoot, p))) {
    console.error(`HARD FAIL: required artifact missing — ${p}`);
    exit(1);
  }
}

// 1. git provenance (commit + dirty flag) — fingerprint captures actual file bytes, so dirty is allowed but recorded.
const gitCommit = (() => { try { return execSync('git rev-parse HEAD', { cwd: repoRoot }).toString().trim(); } catch { return 'unknown'; } })();
const dirty = (() => { try { return execSync('git status --porcelain', { cwd: repoRoot }).toString().trim().length > 0; } catch { return null; } })();
console.log(`git ${gitCommit}${dirty ? ' (DIRTY — fingerprint pins actual bytes)' : ''}`);

// 2. profile/bundle/corpus load + bundle verification (the runtime-attested set).
const profile = JSON.parse(readFileSync(resolve(repoRoot, PROFILE), 'utf8'));
check('bundle manifest exists', existsSync(resolve(repoRoot, BUNDLE)), BUNDLE);
let bundle = null;
if (existsSync(resolve(repoRoot, BUNDLE))) {
  bundle = JSON.parse(readFileSync(resolve(repoRoot, BUNDLE), 'utf8'));
  const errs = verifyBundleManifest(bundle, repoRoot);
  check('verifyBundleManifest CLEAN (attested src files match)', errs.length === 0, errs.length ? errs.join(' | ') : 'ok');
}

let corpusRoot = bundle?.corpus?.root ?? null;
let activeFrontierRoot = null;

if (MODE === 'deep') {
  // 3. build production corpus → corpusRoot coherence + activeFrontierRoot derivation (canonical).
  console.log('building 300k production corpus (corpusRoot + frontier derivation)…');
  const { buildV2ProductionCorpus } = await import('./lib/build-v2-production-corpus.mjs');
  const { corpus } = buildV2ProductionCorpus({ corpusPath: CORPUS, embPath: EMB, bundlePath: BUNDLE });
  corpusRoot = computeCorpusRoot(corpus.events);
  check('corpusRoot == computeCorpusRoot(events)', corpusRoot === corpus.corpusRoot, corpusRoot);
  if (bundle) check('bundle.corpus.root == corpusRoot', (bundle.corpus?.root ?? '').toLowerCase() === corpusRoot.toLowerCase(), `bundle=${bundle.corpus?.root?.slice(0,18)} corpus=${corpusRoot.slice(0,18)}`);

  // 4. activeFrontierRoot: canonical derivation, non-zero, deterministic.
  const fr1 = makeLaunchFrontier(profile, corpus);
  check('profile.epochFrontier present (C3 churn launch-required)', fr1 != null);
  if (fr1) {
    activeFrontierRoot = fr1.stepEpoch(0, null, null).activeRoot;
    const fr2 = makeLaunchFrontier(profile, corpus).stepEpoch(0, null, null).activeRoot;
    check('activeFrontierRoot non-zero', activeFrontierRoot && !/^0x0+$/.test(activeFrontierRoot), activeFrontierRoot);
    check('activeFrontierRoot deterministic (2 derivations equal)', activeFrontierRoot === fr2);
  }

  // 5. baseline pinned (conservative posture) + acceptance threshold canonical.
  check('baseline pinned (parentScorePpm + samples>=3)', Number(profile.baselineParentScorePpm) > 0 && Number(profile.baselineSamples) >= 3,
    `parent=${profile.baselineParentScorePpm} samples=${profile.baselineSamples}`);
  check('acceptance threshold from canonical patchAcceptanceFloors + replayTolerancePpm', typeof computeAcceptanceThresholdPpm === 'function' && !!profile.patchAcceptanceFloors && typeof profile.replayTolerancePpm === 'number',
    profile.patchAcceptanceFloors ? `thr=${computeAcceptanceThresholdPpm(profile)}ppm` : 'MISSING floors');

  // 5b. hidden-pack quota coverage + exact packSize (so a sub-quota candidate cannot reach A100).
  const evalSeedHex = profile.baselineEvalSeedHex ?? '0x' + 'a5'.repeat(32);
  const _pack = deriveQueryPack(0, evalSeedHex, corpus, profile.hiddenPack);
  const _cov = packQuotaCoverage(_pack, profile.hiddenPack);
  for (const c of _cov) check(`hidden-pack quota satisfied: ${c.stratum} (${c.count}/${c.minCount})`, c.satisfied);
  check(`hidden-pack is exactly packSize (${_pack.events.length}/${profile.hiddenPack.packSize})`, _pack.events.length === profile.hiddenPack.packSize);

  // 6. r5 grammar + patch-hash domain present in the runtime.
  check('pipelineVersion pins r5 (policyAtomsMode derives true)', profile.pipelineVersion === 'coretex-retrieval-v2-policy-r5', profile.pipelineVersion);
  check('computePatchHash exported (domain-prefixed identity in runtime)', typeof computePatchHash === 'function');
} else {
  // parity mode: trust the bundle's attested corpusRoot + sha256 sidecars (verified above by
  // verifyBundleManifest). No materialization. activeFrontierRoot is NOT recomputed — the fingerprint
  // file-walk + bundleHash match is the parity contract.
  console.log('parity mode — skipping corpus materialization + frontier derivation (bundle attestation trusted)');
  check('pipelineVersion pins r5 (policyAtomsMode derives true)', profile.pipelineVersion === 'coretex-retrieval-v2-policy-r5', profile.pipelineVersion);
}

// 7. candidate-surface RECORD (posture-agnostic). The launch-path code is the candidate under test;
// a surface being candidate-enabled here is HOW we validate it. The preflight does NOT enforce a
// posture — it RECORDS the exact candidate config into the fingerprint so the A100 result attributes
// to it (a flags-ON candidate is its own signed candidate+fingerprint; the result decides promotion;
// invalidated surfaces are candidate-disabled in a follow-up signed candidate). Coherence (bundle
// attests THIS profile) is already enforced by verifyBundleManifest above.
const candidateSurfaces = {
  temporal: profile.temporalStaleContrast !== false,
  evidence_bundle: profile.enableEvidenceBundleAtoms === true,
  conflict_lifecycle: profile.enableConflictLifecycleAtoms === true,
  relation_typed: profile.policyRelationTypedAdmission === true,
  query_conditioned_admission: profile.policyQueryConditionedAdmission === true,
  conflict_intent_admission: profile.policyConflictIntentAdmission === true,
  abstention: profile.enableAbstentionAtoms === true,
  abstention_margin: profile.policyAbstentionMarginThreshold !== undefined,
  aspect_constraint: profile.enableAspectConstraintAtoms === true,
  aspect_intent_admission: profile.policyAspectIntentAdmission === true,
  aspect_boost: profile.policyAspectBoost !== undefined && Number(profile.policyAspectBoost) !== 0,
};
const enabledList = Object.entries(candidateSurfaces).filter(([, v]) => v).map(([k]) => k).join(', ');
console.log(`candidate-enabled surfaces (recorded, NOT enforced): ${enabledList || 'none'}`);

// 8. launch fingerprint over the runtime-relevant file set.
const fileSet = [];
const walk = (rel) => { const abs = resolve(repoRoot, rel); if (!existsSync(abs)) return; const st = statSync(abs); if (st.isDirectory()) { for (const e of execSync(`find ${abs} -type f`).toString().trim().split('\n').filter(Boolean)) fileSet.push(e.replace(repoRoot + '/', '')); } else fileSet.push(rel); };
// Fingerprint the FULL launch-relevant tree: executed runtime (dist), all canonical SOURCE
// (so dist can be proven to come from attested src), harness scripts, contracts, specs, the signed
// bundle, and the corpus+embeddings data. (node_modules excluded — not launch-authored; deps are
// pinned via lockfile separately.)
['packages/cortex/dist', 'packages/cortex/src', 'packages/cortex-py/cortex_py', 'contracts/src', 'specs', 'scripts', 'release/bundle'].forEach(walk);
[CORPUS, EMB].forEach((p) => fileSet.push(p));
const fileHashes = {};
for (const p of fileSet.sort()) { const h = sha256File(p); if (h) fileHashes[p] = h; }
const manifestHash = sha256(Buffer.from(Object.entries(fileHashes).map(([k, v]) => `${k}:${v}`).join('\n')));

const fingerprint = {
  schema: 'coretex.launch-fingerprint.v1', gitCommit, dirty, generatedAtNote: 'stamp externally (no clock in determinism path)',
  corpus: CORPUS, corpusFileSha256: sha256File(CORPUS), embFileSha256: sha256File(EMB),
  corpusRoot, activeFrontierRoot, bundleHash: bundle?.bundleHash ?? null, profileHash: typeof computeProfileHash === 'function' ? computeProfileHash(profile) : null,
  candidateSurfaces, // EXACT enabled-surface config this run validates (results attribute to this)
  fileCount: Object.keys(fileHashes).length, manifestHash,
};
console.log('────────── FINGERPRINT ──────────');
console.log(JSON.stringify({ ...fingerprint, fileHashes: undefined }, null, 0));
console.log(`manifestHash ${manifestHash} over ${fingerprint.fileCount} files`);

const emitPath = flag('emit', null);
if (emitPath) { writeFileSync(resolve(repoRoot, emitPath), JSON.stringify({ ...fingerprint, fileHashes }, null, 2)); console.log(`wrote ${emitPath}`); }

const cmpPath = flag('compare', null);
if (cmpPath) {
  const remote = JSON.parse(readFileSync(resolve(repoRoot, cmpPath), 'utf8'));
  check('A100 parity: manifestHash matches', remote.manifestHash === manifestHash, `local=${manifestHash.slice(0,18)} remote=${(remote.manifestHash||'').slice(0,18)}`);
  check('A100 parity: corpusRoot matches', (remote.corpusRoot||'').toLowerCase() === corpusRoot.toLowerCase());
  check('A100 parity: bundleHash matches', remote.bundleHash === fingerprint.bundleHash);
  // per-file diff for actionable output
  if (remote.fileHashes) {
    const diffs = [];
    const all = new Set([...Object.keys(fileHashes), ...Object.keys(remote.fileHashes)]);
    for (const f of all) if (fileHashes[f] !== remote.fileHashes[f]) diffs.push(f);
    check('A100 parity: every launch file hash matches', diffs.length === 0, diffs.length ? `${diffs.length} differ: ${diffs.slice(0,8).join(', ')}` : 'all match');
  }
}

console.log('═════════════════════════════════════════════');
console.log(pass ? 'PREFLIGHT: ALL PASS ✅ — tree coherent; cleared for A100 run' : `PREFLIGHT: HARD FAIL ❌ (${fails.length}) — ${fails.join('; ')}`);
exit(pass ? 0 : 1);
