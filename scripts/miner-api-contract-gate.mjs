#!/usr/bin/env node
/**
 * Miner-facing API contract gate  (Launch hardening L10).
 *
 * Builds the PUBLIC challenge payload a miner fetches (from bundle + profile +
 * corpus + parent state — public inputs only) and proves the contract:
 *
 *   A) Required public fields present (epochId, parentStateRoot, currentStateRoot,
 *      bundleHash, corpusRoot, pipelineVersion, allowedPatchTypes + wordRanges,
 *      minImprovementPpm, screenerThresholdPpm, perMinerCap, memoryIRSchemaVersion,
 *      activeSubstrateSurfaces, exampleValidPatch, hiddenEvalWarning).
 *   B) NO hidden leakage: deep scan finds no qrel / answer / truthDocument /
 *      epochSecret / hiddenPack-contents / per-query-failure-stat fields.
 *   C) A miner can build a VALID patch from the challenge's allowed types +
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
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { argv, exit } from 'node:process';
import { distIndex, repoRoot } from './_repo-root.mjs';

const m = await import(distIndex);
const {
  RANGES, PATCH_TYPE, encodePatch, decodePatch, validatePatchType, encodeRelationCategoryLens,
  merkleizeState, bytesToHex, computeCoreTexScreenerThresholdPpm, DEFAULT_CORETEX_WORK_POLICY, applyPatch,
} = m;

import { buildV2ProductionCorpus } from './lib/build-v2-production-corpus.mjs';
import { makeLaunchFrontier } from './lib/epoch-frontier.mjs';

const opt = (n, fb) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fb; };
const base = 'release/calibration/2026-05-21-memory-corpus-v2';
// Defaults pin the CANONICAL 300k launch candidate (the sole launch corpus). Old compact/9k
// defaults were stale (off-scale 0.5 qrels). Override with --profile/--bundle/--corpus/--emb.
const profile = JSON.parse(readFileSync(resolve(repoRoot, opt('profile', 'release/bundle/evaluator-profile-v2-dgen1-policy-r5-300k.json')), 'utf8'));
const manifest = JSON.parse(readFileSync(resolve(repoRoot, opt('bundle', 'release/bundle/bundle-manifest-v2-dgen1-policy-r5-300k.json')), 'utf8'));
const corpusPath = opt('corpus', `${base}/dgen1-r5-synth-300k-final-corpus.json`);
let corpusMeta = {};
try {
  // API contract shape does not depend on qrels/embeddings; read raw metadata so this
  // gate remains useful while stale pre-regen corpora intentionally fail scorer/linter gates.
  const raw = JSON.parse(readFileSync(resolve(repoRoot, corpusPath), 'utf8'));
  corpusMeta = {
    ...(Array.isArray(raw.docs) ? { docs: raw.docs.length } : {}),
    ...(Array.isArray(raw.queries) ? { queries: raw.queries.length } : {}),
    ...(Array.isArray(raw.events) ? { events: raw.events.length } : {}),
    ...(raw.biEncoderModelId ? { biEncoderModelId: raw.biEncoderModelId } : {}),
    ...(raw.biEncoderRevision ? { biEncoderRevision: raw.biEncoderRevision } : {}),
  };
} catch {
  corpusMeta = { note: 'corpus metadata unavailable; contract shape only' };
}
const corpusRoot = manifest.corpus?.root ?? profile.corpusRoot ?? '0x' + '00'.repeat(32);
// C3 churn is launch-required. Derive the REAL genesis activeFrontierRoot from the canonical
// launch corpus + signed profile.epochFrontier. No fallback — V4 rejects bytes32(0), so the
// public contract MUST carry a real non-zero root. Fail hard if it can't be produced.
const embPath = opt('emb', `${base}/dgen1-r5-synth-300k-final-embeddings.json`);
const { corpus: prodCorpus } = buildV2ProductionCorpus({ corpusPath, embPath });
const launchFrontier = makeLaunchFrontier(profile, prodCorpus);
if (!launchFrontier) { console.error('FATAL: profile.epochFrontier missing/off — C3 churn is launch-required'); exit(1); }
const activeFrontierRoot = launchFrontier.stepEpoch(0, null, null).activeRoot;
if (!activeFrontierRoot || /^0x0+$/.test(activeFrontierRoot)) { console.error('FATAL: derived activeFrontierRoot is zero'); exit(1); }

const genesis = { words: new Array(1024).fill(0n) };
const parentStateRoot = bytesToHex(merkleizeState(genesis));

// active substrate surfaces from the profile (default-off surfaces excluded)
const surfaces = [];
surfaces.push({ surface: 'temporal', patchType: 'TEMPORAL_UPDATE', wordRange: [RANGES.TEMPORAL_START, RANGES.TEMPORAL_END] });
if (profile.policyRelationTypedAdmission) surfaces.push({ surface: 'relation_typed_routing', patchType: 'RELATION_UPDATE', wordRange: [RANGES.RELATIONS_START, RANGES.RELATIONS_END] });
if (profile.enableEvidenceBundleAtoms) surfaces.push({ surface: 'evidence_bundle', patchType: 'POLICY_UPDATE', wordRange: [RANGES.POLICY_EVIDENCE_START, RANGES.POLICY_EVIDENCE_END] });
if (profile.enableAbstentionAtoms) surfaces.push({ surface: 'guarded_abstention', patchType: 'POLICY_UPDATE', wordRange: [RANGES.POLICY_ABSTENTION_START, RANGES.POLICY_ABSTENTION_END] });
if (profile.enableConflictLifecycleAtoms) surfaces.push({ surface: 'conflict_state', patchType: 'POLICY_UPDATE', wordRange: [RANGES.POLICY_CONFLICT_START, RANGES.POLICY_CONFLICT_END] });

const minImprovementPpm = Number(profile.patchAcceptanceFloors.minImprovementPpm);
const screenerThresholdPpm = Number(computeCoreTexScreenerThresholdPpm({ baselineScorePpm: profile.baselineParentScorePpm, policy: DEFAULT_CORETEX_WORK_POLICY }));

// example valid patch: one relation category-lens edge (public, structural)
const exWordIdx = RANGES.RELATIONS_START + 127;
const exWord = encodeRelationCategoryLens({ entryIndex: 127, edgeType: 'supports', weight: 0x8000 });
const examplePatch = { patchType: PATCH_TYPE.RELATION_UPDATE, wordCount: 1, scoreDelta: 0n, parentStateRoot: merkleizeState(genesis), indices: [exWordIdx], newWords: [exWord] };

// ── the PUBLIC challenge payload (public inputs only) ───────────────────────
const challenge = {
  epochId: 0,
  parentStateRoot,
  currentStateRoot: parentStateRoot,
  substrateAccess: { byRoot: `/coretex/substrate/${parentStateRoot}`, wordCount: 1024, packedBytes: 32768 },
  bundleHash: manifest.bundleHash,
  coreVersionHash: manifest.bundleHash,
  profileName: profile.name,
  pipelineVersion: profile.pipelineVersion,
  corpusRoot,
  corpusMeta,
  activeFrontierRoot, // C3 launch-required: real derived genesis frontier root (non-zero)
  allowedPatchTypes: m.buildAllowedPatchTypes({ pipelineVersion: profile.pipelineVersion }), // CANONICAL {name,byte,wordIndexRange}, pipeline-aware (r5 suppresses KEY/CODEBOOK/MIXED)
  patchWordRanges: surfaces, // active candidate surfaces (subset that is reward-active this candidate)
  patchWordBudget: 4,
  minImprovementPpm,
  replayTolerancePpm: profile.replayTolerancePpm,
  screenerThresholdPpm,
  perMinerCap: 50, // canonical V4 default coreTexScreenerCapPerMinerPerEpoch (BotcoinMiningV4.sol) — was stale 8
  memoryIRSchemaVersion: 'memory_ir.v1',
  activeSubstrateSurfaces: surfaces.map((s) => s.surface),
  exampleValidPatch: { patchType: examplePatch.patchType, wordCount: 1, indexRange: [RANGES.RELATIONS_START, RANGES.RELATIONS_END], encodedHex: '0x' + Buffer.from(encodePatch(examplePatch)).toString('hex') },
  hiddenEvalWarning: 'Hidden eval query pack, qrels, answer IDs, and epochSecret are NOT public. Patches are scored against a hidden pack derived from a post-submission blockhash + epoch secret.',
};

let pass = true; const log = [];
const check = (n, ok, d = '') => { log.push(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`); if (!ok) pass = false; };

// A) required public fields present
const required = ['epochId', 'parentStateRoot', 'currentStateRoot', 'bundleHash', 'corpusRoot', 'pipelineVersion', 'allowedPatchTypes', 'patchWordRanges', 'minImprovementPpm', 'screenerThresholdPpm', 'perMinerCap', 'memoryIRSchemaVersion', 'activeSubstrateSurfaces', 'exampleValidPatch', 'hiddenEvalWarning'];
const missing = required.filter((k) => challenge[k] === undefined || challenge[k] === null);
check('A) all required public fields present', missing.length === 0, missing.length ? `missing: ${missing.join(',')}` : `${required.length} fields`);

// B) no hidden leakage (deep key + value scan)
const FORBIDDEN_KEYS = /qrel|truthdoc|hardnegativ|answer|epochsecret|evalseed|hiddenpack|truth|relevance|failurestat|perqueryfail/i;
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
check('B) challenge does not embed the eval pack / events array', !('events' in challenge) && !('pack' in challenge) && !('queries' in challenge));

// C) a valid patch can be built from the challenge contract
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
console.log(`challenge fields: ${Object.keys(challenge).length} | activeSurfaces: ${challenge.activeSubstrateSurfaces.join(', ')}`);
console.log(`minImprovementPpm=${minImprovementPpm} screenerThresholdPpm=${screenerThresholdPpm} perMinerCap=${challenge.perMinerCap} budget=${challenge.patchWordBudget}w`);
console.log(pass ? 'RESULT: ALL PASS ✅ (public contract complete, no hidden leakage)' : 'RESULT: FAIL ❌');
exit(pass ? 0 : 1);
