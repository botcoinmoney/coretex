#!/usr/bin/env node
/**
 * Miner-facing API contract gate  (Launch hardening L10).
 *
 * Builds the PUBLIC status payload a miner fetches (from bundle + profile +
 * corpus + parent state — public inputs only) and proves the contract:
 *
 *   A) Required public fields present (epochId, currentStateRoot,
 *      bundleHash, corpusRoot, pipelineVersion, allowedPatchTypes + wordRanges,
 *      minImprovementPpm, stateAdvanceThresholdPpm, screenerThresholdPpm,
 *      perMinerScreenerCap, memoryIRSchemaVersion,
 *      activeSubstrateSurfaces, exampleValidPatch, hiddenEvalWarning).
 *   B) NO hidden leakage: deep scan finds no qrel / answer / truthDocument /
 *      epochSecret / hiddenPack-contents / per-query-failure-stat fields.
 *   C) A miner can build a VALID patch from the status payload's allowed types +
 *      word ranges → encodePatch/decodePatch round-trips and validatePatchType ok.
 *   D) Stable error taxonomy: a structurally invalid patch (reserved-range index,
 *      over-budget, type/range mismatch) maps to a stable E0x code.
 *
 * Pairs with docs/miner-api-contract.md (the human-readable schema).
 *
 * Usage: node scripts/miner-api-contract-gate.mjs
 *   [--profile release/bundle/evaluator-profile-v2-dgen1-policy-r5.json]
 *   [--bundle release/bundle/bundle-manifest-v2-dgen1-policy-r5-candidate.json]
 *   [--corpus ...dgen1-r5-synth-corpus.json] [--emb ...]
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { argv, exit } from 'node:process';
import { distIndex, repoRoot } from './_repo-root.mjs';

const m = await import(distIndex);
const {
  RANGES, PATCH_TYPE, encodePatch, decodePatch, validatePatchType, encodeRelationCategoryLens,
  merkleizeState, bytesToHex, keccak256, computeCoreTexScreenerThresholdPpm, DEFAULT_CORETEX_WORK_POLICY, applyPatch,
  splitForRecord, rewardActiveSubstrateSurfaces, canonicalJson,
} = m;

import { makeLaunchFrontier } from './lib/epoch-frontier.mjs';

const opt = (n, fb) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fb; };
const DEFAULT_ARTIFACT_MANIFEST = 'release/calibration/2026-06-04-memory-atom-v16/coretex-launch-v16-artifacts.json';
const artifactManifestPath = opt('manifest', DEFAULT_ARTIFACT_MANIFEST);
const artifactManifest = JSON.parse(readFileSync(resolve(repoRoot, artifactManifestPath), 'utf8'));
const payloadPath = (role) => artifactManifest.payloads?.find((p) => p.role === role)?.path;
const profilePath = opt('profile', artifactManifest.profilePath);
const bundlePath = opt('bundle', artifactManifest.bundlePath);
const corpusPath = opt('corpus', payloadPath('corpus'));
const embPath = opt('emb', payloadPath('embeddings'));
if (!profilePath || !bundlePath || !corpusPath || !embPath) {
  console.error(`FATAL: ${artifactManifestPath} does not define profile/bundle/corpus/embeddings paths`);
  exit(1);
}
const profile = JSON.parse(readFileSync(resolve(repoRoot, profilePath), 'utf8'));
const manifest = JSON.parse(readFileSync(resolve(repoRoot, bundlePath), 'utf8'));
if (artifactManifest.bundleHash && manifest.bundleHash !== artifactManifest.bundleHash) {
  console.error(`FATAL: bundleHash drift ${manifest.bundleHash} != artifact manifest ${artifactManifest.bundleHash}`);
  exit(1);
}
// The logical corpus is mandatory on this path (activeFrontierRoot derivation
// below hard-fails without it), so a read/parse failure surfaces directly
// instead of being masked behind a "metadata unavailable" note.
const rawCorpus = JSON.parse(readFileSync(resolve(repoRoot, corpusPath), 'utf8'));
const corpusMeta = {
  ...(Array.isArray(rawCorpus.docs) ? { docs: rawCorpus.docs.length } : {}),
  ...(Array.isArray(rawCorpus.queries) ? { queries: rawCorpus.queries.length } : {}),
  ...(Array.isArray(rawCorpus.events) ? { events: rawCorpus.events.length } : {}),
  ...(rawCorpus.biEncoderModelId ? { biEncoderModelId: rawCorpus.biEncoderModelId } : {}),
  ...(rawCorpus.biEncoderRevision ? { biEncoderRevision: rawCorpus.biEncoderRevision } : {}),
};
const corpusRoot = manifest.corpus?.root ?? profile.corpusRoot ?? '0x' + '00'.repeat(32);
if (artifactManifest.corpusRoot && artifactManifest.corpusRoot.toLowerCase() !== corpusRoot.toLowerCase()) {
  console.error(`FATAL: corpusRoot drift ${corpusRoot} != artifact manifest ${artifactManifest.corpusRoot}`);
  exit(1);
}
// C3 churn is launch-required. Derive the REAL genesis activeFrontierRoot from the canonical
// launch corpus + signed profile.epochFrontier. No fallback — V4 rejects bytes32(0), so the
// public contract MUST carry a real non-zero root. Fail hard if it can't be produced.
if (!rawCorpus || !Array.isArray(rawCorpus.queries)) {
  console.error(`FATAL: cannot derive activeFrontierRoot without logical corpus queries: ${corpusPath}`);
  exit(1);
}
const bucket = (f) => f === 'temporal_update' ? 'temporal'
  : (f === 'multi_session_bridge' || f === 'causal_memory_chain' || f === 'decision_provenance') ? 'multi_hop_relation'
  : f === 'conflict_lifecycle' ? 'conflict_lifecycle'
  : f === 'aspect_constraint' ? 'aspect_constraint'
  : f === 'coreference_resolution' ? 'coreference'
  : 'near_collision';
const prodCorpus = {
  events: rawCorpus.queries.map((q) => ({
    id: q.id,
    split: splitForRecord(q.id, 0),
    logicalFamily: q.family,
    family: bucket(q.family),
  })),
};
const launchFrontier = makeLaunchFrontier(profile, prodCorpus);
if (!launchFrontier) { console.error('FATAL: profile.epochFrontier missing/off — C3 churn is launch-required'); exit(1); }
const activeFrontierRoot = launchFrontier.stepEpoch(0, null, null).activeRoot;
if (!activeFrontierRoot || /^0x0+$/.test(activeFrontierRoot)) { console.error('FATAL: derived activeFrontierRoot is zero'); exit(1); }

const genesis = { words: new Array(1024).fill(0n) };
const parentStateRoot = bytesToHex(merkleizeState(genesis));

// canonicalJson is the package's single canonical serializer (canonical/json.ts);
// the keccak hashJson composition below is this gate's own hash domain.
const hashJson = (v) => bytesToHex(keccak256(new TextEncoder().encode(canonicalJson(v))));
const profileHash = '0x' + createHash('sha256').update(canonicalJson(profile)).digest('hex');
const artifactManifestHash = '0x' + createHash('sha256').update(readFileSync(resolve(repoRoot, artifactManifestPath))).digest('hex');
const rerankerRevision = manifest.model?.reranker?.revision ?? null;

// Single source of truth (B6): the canonical reward-active surface set the
// production coordinator validates the advertised list against at boot. Keeping
// this derivation here in sync with the boot assertion (one function) is the
// whole point — the gate and production can no longer drift.
const activeSubstrateSurfaces = [...rewardActiveSubstrateSurfaces(profile)];

// Active substrate surfaces from the effective launch profile (default-off surfaces excluded).
const surfaces = [];
surfaces.push({ surface: 'temporal_update', patchType: 'MIXED', wordRanges: [[RANGES.MEMORY_INDEX_START, RANGES.MEMORY_INDEX_END], [RANGES.TEMPORAL_START, RANGES.TEMPORAL_END]] });
surfaces.push({ surface: 'validity_atom', patchType: 'MIXED', wordRanges: [[RANGES.MEMORY_INDEX_START, RANGES.MEMORY_INDEX_END], [RANGES.TEMPORAL_START, RANGES.TEMPORAL_END]] });
if (profile.policyRelationTypedAdmission) surfaces.push({ surface: 'relation_category_routing', patchType: 'RELATION_UPDATE', wordRange: [RANGES.RELATIONS_START, RANGES.RELATIONS_END] });
if (profile.enableEvidenceBundleAtoms) surfaces.push({ surface: 'evidence_bundle', patchType: 'POLICY_UPDATE', wordRange: [RANGES.POLICY_EVIDENCE_START, RANGES.POLICY_EVIDENCE_END] });
if (profile.enableAbstentionAtoms) surfaces.push({ surface: 'abstention_top1', patchType: 'POLICY_UPDATE', wordRange: [RANGES.POLICY_ABSTENTION_START, RANGES.POLICY_ABSTENTION_END] });
if (profile.enableConflictLifecycleAtoms) surfaces.push({ surface: 'conflict_lifecycle', patchType: 'POLICY_UPDATE', wordRange: [RANGES.POLICY_CONFLICT_START, RANGES.POLICY_CONFLICT_END] });
if (profile.enableScopeAtoms) surfaces.push({ surface: 'scope_atom', patchType: 'MIXED', wordRange: [RANGES.MEMORY_INDEX_START + 192, RANGES.MEMORY_INDEX_START + 255] });
if (profile.enableEntityResolutionAtoms) surfaces.push({ surface: 'entity_resolution_atom', patchType: 'MIXED', wordRange: [RANGES.MEMORY_INDEX_START + 128, RANGES.MEMORY_INDEX_START + 191] });

const minImprovementPpm = Number(profile.patchAcceptanceFloors.minImprovementPpm);
const baselineVarianceSource = profile.baselineVarianceSource ?? 'unavailable';
const productionVariancePpm = baselineVarianceSource === 'rotating_pack' || baselineVarianceSource === 'broad_sampling'
  ? (profile.baselineVariancePpm ?? 0)
  : 0;
const stateAdvanceThresholdPpm = minImprovementPpm + (profile.replayTolerancePpm ?? 0) + productionVariancePpm;
const screenerThresholdPpm = Number(computeCoreTexScreenerThresholdPpm({
  baselineScorePpm: profile.baselineParentScorePpm,
  stateAdvanceThresholdPpm,
  policy: DEFAULT_CORETEX_WORK_POLICY,
}));
const baselineManifestHash = hashJson({
  parentStateRoot,
  corpusRoot,
  activeFrontierRoot,
  bundleHash: manifest.bundleHash,
  profileHash,
  rerankerRevision,
  parentScorePpm: profile.baselineParentScorePpm,
  variancePpm: profile.baselineVariancePpm,
  samples: profile.baselineSamples,
  replayTolerancePpm: profile.replayTolerancePpm,
});

// example valid patch: one relation category-lens edge (public, structural)
const exWordIdx = RANGES.RELATIONS_START + 127;
const exWord = encodeRelationCategoryLens({ entryIndex: 127, edgeType: 'supports', weight: 0x8000 });
const examplePatch = { patchType: PATCH_TYPE.RELATION_UPDATE, wordCount: 1, scoreDelta: 0n, parentStateRoot: merkleizeState(genesis), indices: [exWordIdx], newWords: [exWord] };

// ── the PUBLIC status payload (public inputs only) ──────────────────────────
const challenge = {
  epochId: 0,
  currentStateRoot: parentStateRoot,
  substrate: { uri: `/coretex/substrate/${parentStateRoot}` },
  bundleHash: manifest.bundleHash,
  coreVersionHash: manifest.bundleHash,
  artifactManifestHash,
  profileHash,
  rerankerRevision,
  baselineManifestHash,
  profileName: profile.name,
  pipelineVersion: profile.pipelineVersion,
  corpusRoot,
  corpusMeta,
  activeFrontierRoot, // C3 launch-required: real derived genesis frontier root (non-zero)
  allowedPatchTypes: m.buildAllowedPatchTypes({ pipelineVersion: profile.pipelineVersion }), // CANONICAL {name,byte,wordIndexRange}; r5 suppresses KEY/CODEBOOK and keeps MIXED for true cross-region compiles.
  patchWordRanges: surfaces, // active candidate surfaces (subset that is reward-active this candidate)
  patchWordBudget: 4,
  minImprovementPpm,
  stateAdvanceThresholdPpm,
  baselineParentScorePpm: Number(profile.baselineParentScorePpm ?? 0),
  baselineVarianceSource,
  fixedPackRepeatabilityPpm: Number(profile.baselineVariancePpm ?? 0),
  recentNoiseFloorPpm: 0,
  replayTolerancePpm: profile.replayTolerancePpm,
  screenerThresholdPpm,
  perMinerScreenerCap: 50, // canonical V4 default coreTexScreenerCapPerMinerPerEpoch (BotcoinMiningV4.sol) — was stale 8
  memoryIRSchemaVersion: 'memory_ir.v1',
  activeSubstrateSurfaces,
  exampleValidPatch: { patchType: examplePatch.patchType, wordCount: 1, indexRange: [RANGES.RELATIONS_START, RANGES.RELATIONS_END], encodedHex: '0x' + Buffer.from(encodePatch(examplePatch)).toString('hex') },
  pins: { corpusRoot, activeFrontierRoot, baselineManifestHash, hiddenSeedCommit: '0x' + '00'.repeat(32) },
  thresholds: {
    minImprovementPpm,
    replayTolerancePpm: profile.replayTolerancePpm,
    stateAdvanceThresholdPpm,
    screenerThresholdPpm,
    baselineParentScorePpm: Number(profile.baselineParentScorePpm ?? 0),
    baselineVarianceSource,
    recentNoiseFloorPpm: 0,
  },
  hiddenEvalWarning: 'Hidden eval query pack, qrels, answer IDs, and epochSecret are NOT public. Patches are scored against a hidden pack derived from a post-submission blockhash + epoch secret.',
};

let pass = true; const log = [];
const check = (n, ok, d = '') => { log.push(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`); if (!ok) pass = false; };

// A) required public fields present in the canonical /coretex/status payload
const required = ['epochId', 'currentStateRoot', 'substrate', 'bundleHash', 'corpusRoot', 'activeFrontierRoot', 'artifactManifestHash', 'profileHash', 'rerankerRevision', 'baselineManifestHash', 'pipelineVersion', 'allowedPatchTypes', 'patchWordRanges', 'minImprovementPpm', 'stateAdvanceThresholdPpm', 'screenerThresholdPpm', 'perMinerScreenerCap', 'memoryIRSchemaVersion', 'activeSubstrateSurfaces', 'exampleValidPatch', 'baselineParentScorePpm', 'baselineVarianceSource', 'recentNoiseFloorPpm', 'pins', 'thresholds', 'hiddenEvalWarning'];
const missing = required.filter((k) => challenge[k] === undefined || challenge[k] === null);
check('A) all required public fields present in /coretex/status', missing.length === 0, missing.length ? `missing: ${missing.join(',')}` : `${required.length} fields`);
// A2) v0 canonical naming — perMinerScreenerCap only; perMinerCap is removed and MUST NOT appear.
check('A2) public status uses perMinerScreenerCap (canonical) and not perMinerCap (removed)',
  challenge.perMinerScreenerCap !== undefined && challenge.perMinerCap === undefined && challenge.stateRoot === undefined && challenge.transitionCount === undefined,
  challenge.perMinerCap !== undefined ? 'REMOVED perMinerCap present' :
  challenge.stateRoot !== undefined ? 'REMOVED stateRoot alias present' :
  challenge.transitionCount !== undefined ? 'REMOVED transitionCount alias present' : 'OK');
const stateFloorBps = Number(DEFAULT_CORETEX_WORK_POLICY.screenerPass.calibration.stateAdvanceThresholdFloorBps ?? 0);
const minScreenerFromState = Math.ceil((stateAdvanceThresholdPpm * stateFloorBps) / 10_000);
check('A2.b) screener threshold is state-threshold-coupled',
  screenerThresholdPpm >= minScreenerFromState && screenerThresholdPpm <= stateAdvanceThresholdPpm,
  `screener=${screenerThresholdPpm} floor=${minScreenerFromState} state=${stateAdvanceThresholdPpm}`);

// A3) Canonical v0 route surface — exactly 5 endpoints. The production router (CORETEX_ENDPOINTS
// in packages/coretex/src/coordinator/endpoints.ts) MUST match this set, and removed routes MUST
// NOT reappear. The gate fails the build if either condition is violated.
const CANONICAL_V0_ROUTES = [
  'GET /coretex/health',
  'GET /coretex/status',
  'GET /coretex/substrate/:stateRoot',
  'POST /coretex/submit',
  'GET /coretex/receipt/:hash',
];
const REMOVED_V0_ROUTES = [
  'GET /coretex/challenge',
  'GET /coretex/patch/:hash',
  'GET /coretex/patch-received/:hash',
  'GET /coretex/eval-report/:hash',
  'GET /coretex/corpus-delta/:epoch',
  'GET /coretex/bundle/:bundleHash',
  'GET /coretex/bundle/by-core-version/:coreVersionHash',
];
const { CORETEX_ENDPOINTS: routerRoutes } = m;
const routerSet = new Set((routerRoutes ?? []).map((r) => `${r.method} ${r.path}`));
const missingFromRouter = CANONICAL_V0_ROUTES.filter((r) => !routerSet.has(r));
const extraInRouter = [...routerSet].filter((r) => !CANONICAL_V0_ROUTES.includes(r));
const removedReappeared = REMOVED_V0_ROUTES.filter((r) => routerSet.has(r));
check('A3.a) production router exposes EXACTLY the 5 canonical v0 routes',
  missingFromRouter.length === 0 && extraInRouter.length === 0,
  missingFromRouter.length ? `missing in router: ${missingFromRouter.join(',')}` :
  extraInRouter.length ? `extra in router: ${extraInRouter.join(',')}` : 'OK');
check('A3.b) production router does NOT expose any removed v0 route',
  removedReappeared.length === 0,
  removedReappeared.length ? `LEGACY ROUTES REAPPEARED: ${removedReappeared.join(',')}` : 'OK');

// B) no hidden leakage (deep key + value scan)
const FORBIDDEN_KEYS = /qrel|truthdoc|hardnegativ|answer|epochsecret|gateseed|confirmseed|evalseed(?!commit)|hiddenpack|truth|relevance|failurestat|perqueryfail|scorebeforeppm|scoreafterppm|perfamilydelta/i;
function scan(obj, path = '') {
  const hits = [];
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      if (FORBIDDEN_KEYS.test(k)) hits.push(`${path}${k}`);
      hits.push(...scan(v, `${path}${k}.`));
    }
  }
  return hits;
}
const leaks = scan(challenge);
check('B) no hidden qrel/answer/epochSecret/evalSeed/hiddenPack fields', leaks.length === 0, leaks.length ? `LEAK: ${leaks.join(',')}` : 'clean');
// also: the served pack itself is NOT embedded
check('B) status does not embed the eval pack / events array', !('events' in challenge) && !('pack' in challenge) && !('queries' in challenge));
check('B) status pins v16 artifact manifest', artifactManifestPath.includes('2026-06-04-memory-atom-v16') && manifest.bundleHash === artifactManifest.bundleHash, artifactManifestPath);
check('B) active surfaces include promoted v16 atoms', ['validity_atom', 'scope_atom', 'entity_resolution_atom'].every((s) => challenge.activeSubstrateSurfaces.includes(s)), challenge.activeSubstrateSurfaces.join(','));

// C) a valid patch can be built from the status contract
const built = decodePatch(Buffer.from(challenge.exampleValidPatch.encodedHex.slice(2), 'hex'));
const vt = validatePatchType(built.patchType, built.indices);
const inRange = built.indices.every((i) => i >= RANGES.RELATIONS_START && i <= RANGES.RELATIONS_END);
check('C) example patch round-trips + validates against allowed range', vt.ok && inRange && built.wordCount <= challenge.patchWordBudget, vt.ok ? `type=${built.patchType} idx∈relations` : vt.reason);
const appliedExample = applyPatch(genesis, examplePatch);
check('C) example patch applies onto genesis (structurally accepted)', appliedExample.ok === true, appliedExample.ok ? '' : appliedExample.code);

// D) stable error taxonomy on invalid patches
const reservedPatch = { patchType: PATCH_TYPE.MIXED, wordCount: 1, scoreDelta: 0n, parentStateRoot: merkleizeState(genesis), indices: [RANGES.RESERVED_START], newWords: [1n] };
const reservedRes = applyPatch(genesis, reservedPatch);
check('D) reserved-range write → stable E02', !reservedRes.ok && reservedRes.code === 'E02', reservedRes.ok ? 'accepted!' : reservedRes.code);
const typeMismatch = validatePatchType(PATCH_TYPE.TEMPORAL_UPDATE, [RANGES.RELATIONS_START]);
check('D) patch-type/range mismatch → rejected with reason', !typeMismatch.ok, typeMismatch.ok ? 'accepted!' : 'reason present');
let overBudget = null;
try { encodePatch({ patchType: PATCH_TYPE.MIXED, wordCount: 5, scoreDelta: 0n, parentStateRoot: merkleizeState(genesis), indices: [1, 2, 3, 4, 5], newWords: [1n, 2n, 3n, 4n, 5n] }); } catch (e) { overBudget = e.message; }
check('D) over-budget (>4 words) → rejected', overBudget !== null, overBudget ? 'throws' : 'accepted!');

console.log(log.join('\n'));
console.log('────────────────────────────────────────────────────────');
console.log(`status fields: ${Object.keys(challenge).length} | activeSurfaces: ${challenge.activeSubstrateSurfaces.join(', ')}`);
console.log(`minImprovementPpm=${minImprovementPpm} stateAdvanceThresholdPpm=${stateAdvanceThresholdPpm} screenerThresholdPpm=${screenerThresholdPpm} perMinerScreenerCap=${challenge.perMinerScreenerCap} budget=${challenge.patchWordBudget}w`);
console.log(pass ? 'RESULT: ALL PASS ✅ (public contract complete, no hidden leakage)' : 'RESULT: FAIL ❌');
exit(pass ? 0 : 1);
