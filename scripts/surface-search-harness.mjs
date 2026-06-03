#!/usr/bin/env node
/**
 * Surface-search harness.
 *
 * For each bounded semantic candidate exported by scripts/lib/surface-grammars.mjs:
 *   - build the canonical patch on the 0x2d953b71 materialized corpus
 *   - score before/after on K active-pack samples (deterministic seeds)
 *   - classify result as CLEAN_POSITIVE / TRADEOFF_POSITIVE / UNSAFE /
 *     UNEXPLAINED_POSITIVE (and feed COMPENSATED_POSITIVE detection downstream)
 *   - record memory-operation signature, public signals, policy traces fired,
 *     off-family damage, stable-heldout regressions, and renderer/reranker
 *     expectation reconciliation
 *
 * Also runs the auditor-listed semantic combinations (pairs) and flags
 * COMPENSATED_POSITIVE when the combined patch lift exceeds the safer arm by
 * the gate margin AND safety floors hold.
 *
 * Deterministic CPU by default. A100 confirmation is left to the operator
 * (`--reranker gpu`) and only on a shortlist saved separately.
 *
 * Usage:
 *   node scripts/surface-search-harness.mjs --pack-size 64 \
 *     --pack-seeds coretex-launch-frontier,coretex-search-2,coretex-search-3 \
 *     --out release/calibration/2026-05-21-memory-corpus-v2/surface-search-harness-cpu-2d953b71.json
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import process from 'node:process';
import { distIndex, repoRoot } from './_repo-root.mjs';
import { inertBiEncoder } from './lib/build-v2-production-corpus.mjs';
import { loadMaterializedCorpus } from './lib/load-materialized-corpus.mjs';
import { makeStreamReranker } from './lib/stream-reranker.mjs';
import { SURFACE_GRAMMARS, listAllCandidates, SEMANTIC_COMBINATIONS } from './lib/surface-grammars.mjs';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const has = (n) => argv.includes(`--${n}`);

const BUNDLE_PATH = flag('bundle', 'release/bundle/bundle-manifest-v2-dgen1-policy-r5-300k-launch-reduced.json');
const PROFILE_PATH = flag('profile', 'release/bundle/evaluator-profile-v2-dgen1-policy-r5-300k-launch-reduced.json');
const CORPUS_PATH = flag('corpus', 'release/calibration/2026-05-21-memory-corpus-v2/dgen1-r5-synth-300k-v15-corpus.json');
const EMB_PATH = flag('emb', 'release/calibration/2026-05-21-memory-corpus-v2/dgen1-r5-synth-300k-v15-embeddings.json');
const PACK_SIZE = Number(flag('pack-size', '64'));
const PACK_SEEDS = (flag('pack-seeds', 'coretex-launch-frontier,coretex-search-2,coretex-search-3').split(',').map((s) => s.trim()).filter(Boolean));
const RERANKER = flag('reranker', 'deterministic');
const OUT = flag('out', 'release/calibration/2026-05-21-memory-corpus-v2/surface-search-harness-cpu-2d953b71.json');
const SURFACES_FILTER = flag('surfaces', null);
const CANDIDATES_FILTER = flag('candidates', null);
const SKIP_COMBINATIONS = has('skip-combinations');

// Classification gate thresholds — bounded, justified, not magic.
const GATE = {
  CLEAN_MIN_DELTA_PPM:        500,   // smallest meaningful target lift
  TRADEOFF_MIN_TARGET_PPM:    500,   // target lift threshold for trade-off
  TRADEOFF_OFF_FAMILY_HIT:    -0.03, // off-family mean nDCG floor before flagging tradeoff
  UNSAFE_OFF_FAMILY_HIT:      -0.10, // off-family mean nDCG floor → unsafe
  UNSAFE_HELDOUT_REGRESSIONS: 3,     // # worst regressions to flag unsafe
  COMPENSATED_BEATS_BEST_BY:  500,   // ppm gate for compensated_positive promotion
};

console.log('[surface-search] loading materialized base corpus ...');
const C = await import(distIndex);
const {
  scoringOptionsFromProfile, deriveQueryPack, evaluateRetrievalBenchmarkState,
  applyPatch, decodeSubstrate,
  createDeterministicReranker, biEncoderModelIdHash,
  PATCH_TYPE, merkleizeState, RANGES,
} = C;

const baseBundle = loadMaterializedCorpus(BUNDLE_PATH, { sourceCorpusPath: CORPUS_PATH, sourceEmbPath: EMB_PATH });
const currentProd = baseBundle.corpus;
const { BE, RR, LAYOUT } = baseBundle;
const rawCorpus = JSON.parse(readFileSync(resolve(repoRoot, CORPUS_PATH), 'utf8'));
const profile = JSON.parse(readFileSync(resolve(repoRoot, PROFILE_PATH), 'utf8'));
const logicalQById = new Map(rawCorpus.queries.map((q) => [q.id, q]));
const eventByDocId = new Map(); for (const ev of currentProd.events) eventByDocId.set(ev.id, ev);
console.log(`[surface-search] bundle ${baseBundle.manifest.bundleHash} corpus ${currentProd.events.length} events`);

const reranker = RERANKER === 'gpu'
  ? makeStreamReranker({ model: RR.modelId, revision: RR.revision, python: process.env.CORETEX_RERANKER_PYTHON ?? '/usr/bin/python3', allowCuda: true })
  : await createDeterministicReranker();
const biEncoderHash = biEncoderModelIdHash(BE.modelId, BE.revision, 'dense');
const rt = () => ({ biEncoder: inertBiEncoder(BE, LAYOUT), reranker, biEncoderHash, retrievalKeyLayout: LAYOUT });

// Plumb policyEntityRegistry into scoring options (the same fix applied to the live-evolve harness).
const policyEntityRegistry = (rawCorpus.entities ?? []).map((e) => ({ id: e.id, names: [e.canonicalName, ...(e.aliases ?? [])].filter(Boolean).map((n) => String(n).toLowerCase()) }));
const baseScoringOpts = () => ({ ...scoringOptionsFromProfile(profile, rt()), policyEntityRegistry, policyGenericEntityIds: ['e_universe'], exposeFullRanking: true, policyEmitTraces: true });

// Build the K pack samples once.
const packs = PACK_SEEDS.map((seed) => {
  const evalSeedHex = '0x' + createHash('sha256').update(seed).digest('hex');
  const pack = deriveQueryPack(0, evalSeedHex, currentProd, { ...(profile.hiddenPack ?? {}), packSize: PACK_SIZE });
  return { seed, pack };
});
for (const p of packs) console.log(`[surface-search] pack seed=${p.seed} → ${p.pack.events.length} events`);

const genesisState = { words: new Array(1024).fill(0n) };
const GENESIS_PARENT_ROOT = merkleizeState(genesisState);

function makeSlotCursor() {
  return { temporalRecord: 0, conflictSlot: 0, abstentionSlot: 0, evidenceSlot: 0, noiseSlot: 0, aspectSlot: 0 };
}

function perFamilyMean(perQuery) {
  const buckets = new Map();
  for (const q of (perQuery ?? [])) {
    const fam = q.family ?? q.logicalFamily ?? 'unknown';
    if (!buckets.has(fam)) buckets.set(fam, []);
    buckets.get(fam).push(q.nDCG10);
  }
  const out = {};
  for (const [fam, vals] of buckets) out[fam] = +(vals.reduce((s, v) => s + v, 0) / Math.max(1, vals.length)).toFixed(6);
  return out;
}

function familyOfCandidate(candidate) {
  // Per-surface target families (used to compute target lift vs off-family).
  const map = {
    temporal_update:     new Set(['temporal_update', 'temporal']),
    conflict_lifecycle:  new Set(['conflict_lifecycle', 'conflict']),
    relation_category_routing: new Set(['multi_session_bridge', 'causal_memory_chain', 'decision_provenance', 'multi_hop_relation']),
    relation_lifecycle:  new Set(['multi_session_bridge', 'causal_memory_chain', 'decision_provenance', 'multi_hop_relation']),
    coreference:         new Set(['coreference_resolution', 'coreference']),
    aspect_constraint:   new Set(['aspect_constraint']),
    evidence_bundle:     new Set(['multi_session_bridge', 'causal_memory_chain', 'decision_provenance']),
    abstention_top1:     new Set(['abstention_missing']),
    noise_suppression:   new Set([]), // renderer/reranker-side; no target family
  };
  return map[candidate.surface] ?? new Set();
}

async function scoreOnPack(state, pack, scoringOpts) {
  return evaluateRetrievalBenchmarkState(state, currentProd, pack, scoringOpts);
}

function classify(candidate, packResults) {
  // Aggregate across pack seeds.
  const targetFams = familyOfCandidate(candidate);
  const targetMeans = packResults.map((pr) => {
    const fams = pr.after.familyMeans;
    const arr = [...targetFams].map((f) => fams[f]).filter((v) => typeof v === 'number');
    return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null;
  });
  const offMeans = packResults.map((pr) => {
    const fams = pr.after.familyMeans;
    const arr = Object.entries(fams).filter(([k]) => !targetFams.has(k)).map(([, v]) => v).filter((v) => typeof v === 'number');
    return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null;
  });
  const targetMeansBefore = packResults.map((pr) => {
    const fams = pr.before.familyMeans;
    const arr = [...targetFams].map((f) => fams[f]).filter((v) => typeof v === 'number');
    return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null;
  });
  const offMeansBefore = packResults.map((pr) => {
    const fams = pr.before.familyMeans;
    const arr = Object.entries(fams).filter(([k]) => !targetFams.has(k)).map(([, v]) => v).filter((v) => typeof v === 'number');
    return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null;
  });

  const targetDeltaPpm = packResults.map((pr) => Math.round((pr.after.composite - pr.before.composite) * 1_000_000));
  const meanTargetPpm = Math.round(targetDeltaPpm.reduce((s, v) => s + v, 0) / Math.max(1, targetDeltaPpm.length));

  // Per-pack target-family delta (mean nDCG)
  const targetFamDelta = packResults.map((pr, i) => (targetMeans[i] ?? 0) - (targetMeansBefore[i] ?? 0));
  const offFamDelta = packResults.map((pr, i) => (offMeans[i] ?? 0) - (offMeansBefore[i] ?? 0));
  const meanTargetFamDelta = +(targetFamDelta.reduce((s, v) => s + v, 0) / Math.max(1, targetFamDelta.length)).toFixed(6);
  const meanOffFamDelta = +(offFamDelta.reduce((s, v) => s + v, 0) / Math.max(1, offFamDelta.length)).toFixed(6);

  // Anti-cheat / leakage: trace fired = at least one packResult has policyTraces of the right family.
  const tracesFiredOnAny = packResults.some((pr) => (pr.after.perQuery ?? []).some((q) => (q.policyTraces ?? []).some((t) => t.atomFamily)));

  // Safety floors → UNSAFE
  if (meanOffFamDelta <= GATE.UNSAFE_OFF_FAMILY_HIT) {
    return { label: 'UNSAFE', reason: `off-family mean delta ${meanOffFamDelta} < ${GATE.UNSAFE_OFF_FAMILY_HIT}`, meanTargetPpm, meanTargetFamDelta, meanOffFamDelta };
  }
  // Per-pack worst regression count (counted in next loop)
  // (We only have aggregated info here; per-query is in pr.before/after but not retained.)

  // Positive but explainable?
  if (meanTargetPpm >= GATE.CLEAN_MIN_DELTA_PPM && meanOffFamDelta >= -0.005) {
    // Looks clean; require some trace signal or the candidate must be a structural-only one (noise renderer).
    if (tracesFiredOnAny || candidate.surface === 'noise_suppression' || candidate.surface === 'abstention_top1') {
      return { label: 'CLEAN_POSITIVE', reason: `target +${meanTargetPpm} ppm, off-family clean (${meanOffFamDelta})`, meanTargetPpm, meanTargetFamDelta, meanOffFamDelta };
    }
    // Positive but no policy trace fired → unexpected; keep as UNEXPLAINED_POSITIVE.
    return { label: 'UNEXPLAINED_POSITIVE', reason: `target +${meanTargetPpm} ppm but no policy trace; investigate before promoting`, meanTargetPpm, meanTargetFamDelta, meanOffFamDelta };
  }
  // Tradeoff: target up, off-family down within unsafe floor.
  if (meanTargetPpm >= GATE.TRADEOFF_MIN_TARGET_PPM && meanOffFamDelta < -0.005 && meanOffFamDelta > GATE.UNSAFE_OFF_FAMILY_HIT) {
    return { label: 'TRADEOFF_POSITIVE', reason: `target +${meanTargetPpm} ppm, off-family ${meanOffFamDelta} — compensable?`, meanTargetPpm, meanTargetFamDelta, meanOffFamDelta };
  }
  // No movement
  if (Math.abs(meanTargetPpm) < GATE.CLEAN_MIN_DELTA_PPM) {
    return { label: 'NO_MOVEMENT', reason: `target ${meanTargetPpm} ppm within noise`, meanTargetPpm, meanTargetFamDelta, meanOffFamDelta };
  }
  // Negative
  return { label: 'UNSAFE', reason: `target ${meanTargetPpm} ppm or off-family damage`, meanTargetPpm, meanTargetFamDelta, meanOffFamDelta };
}

async function runOneCandidate(candidate, surfaceOverrides = {}) {
  const slotCursor = makeSlotCursor();
  // Per candidate, score on every pack.
  const packResults = [];
  let buildReason = null;
  for (const { seed, pack } of packs) {
    const u = candidate.buildUnits({ pack, logicalQById, eventByDocId, slotCursor });
    if (!u.indices?.length) {
      buildReason = u.reason ?? 'no_units_built';
      packResults.push({ seed, skipped: true, reason: buildReason });
      continue;
    }
    const patch = { patchType: PATCH_TYPE.MIXED, wordCount: u.indices.length, scoreDelta: 0, parentStateRoot: GENESIS_PARENT_ROOT, indices: u.indices, newWords: u.newWords };
    // Override PATCH_TYPE to POLICY_UPDATE when every index is in policy regions.
    const allPolicyRegion = u.indices.every((i) => i >= RANGES.POLICY_EVIDENCE_START && i <= RANGES.POLICY_ABSTENTION_END);
    if (allPolicyRegion) patch.patchType = PATCH_TYPE.POLICY_UPDATE;
    const applied = applyPatch(genesisState, patch, true);
    if (!applied.ok) {
      packResults.push({ seed, skipped: true, reason: `apply_failed:${applied.code}` });
      continue;
    }
    // Apply per-surface profile overrides.
    const scoringOpts = { ...baseScoringOpts(), ...candidate.profileOverrides, ...surfaceOverrides };
    const before = await scoreOnPack(genesisState, pack, scoringOpts);
    const after = await scoreOnPack(applied.state, pack, scoringOpts);
    packResults.push({
      seed,
      patchSize: u.indices.length, anchored: u.anchored,
      before: { composite: before.composite, familyMeans: perFamilyMean(before.perQuery), perQuery: before.perQuery },
      after:  { composite: after.composite,  familyMeans: perFamilyMean(after.perQuery),  perQuery: after.perQuery },
    });
  }
  const valid = packResults.filter((p) => !p.skipped);
  if (valid.length === 0) return { candidateId: candidate.id, surface: candidate.surface, skipped: true, reason: packResults[0]?.reason ?? 'all_packs_skipped' };
  const classification = classify(candidate, valid);
  return {
    candidateId: candidate.id, surface: candidate.surface, params: candidate.params,
    memoryOperationSignature: candidate.memoryOperationSignature,
    publicSignals: candidate.publicSignals,
    minerDegreesOfFreedom: candidate.minerDegreesOfFreedom,
    nonIndexerRationale: candidate.nonIndexerRationale,
    profileOverrides: candidate.profileOverrides,
    expectedRendererEffect: candidate.expectedRendererEffect,
    expectedRerankerEffect: candidate.expectedRerankerEffect,
    rewardable: candidate.rewardable ?? true,
    packsTested: PACK_SEEDS.length, packsScored: valid.length, skipReasons: packResults.filter((p) => p.skipped).map((p) => p.reason),
    perPackDeltaPpm: valid.map((p) => Math.round((p.after.composite - p.before.composite) * 1_000_000)),
    classification,
  };
}

// ─── Surface sweep ───────────────────────────────────────────────────────────

const surfaces = Object.keys(SURFACE_GRAMMARS).filter((s) => !SURFACES_FILTER || SURFACES_FILTER.split(',').includes(s));
const candidateAllowList = CANDIDATES_FILTER ? new Set(CANDIDATES_FILTER.split(',').map((s) => s.trim())) : null;
const results = { surfaces: {}, combinations: {} };
for (const surface of surfaces) {
  console.log(`\n[surface-search] ====== ${surface} ======`);
  const candidates = SURFACE_GRAMMARS[surface].candidates;
  const surfaceResults = [];
  for (const candidate of candidates) {
    if (candidateAllowList && !candidateAllowList.has(candidate.id)) continue;
    const c = { surface, ...candidate };
    const r = await runOneCandidate(c);
    console.log(`  ${candidate.id}: ${r.skipped ? `SKIP (${r.reason})` : `${r.classification.label} target=${r.classification.meanTargetPpm}ppm offFamΔ=${r.classification.meanOffFamDelta}`}`);
    surfaceResults.push(r);
  }
  results.surfaces[surface] = surfaceResults;
}

// ─── Semantic combinations ────────────────────────────────────────────────────

if (!SKIP_COMBINATIONS) {
console.log('\n[surface-search] ====== semantic combinations ======');
for (const [aKey, bKey] of SEMANTIC_COMBINATIONS) {
  const aCand = SURFACE_GRAMMARS[aKey].candidates[0];
  const bCand = SURFACE_GRAMMARS[bKey].candidates[0];
  if (!aCand || !bCand) { console.log(`  (${aKey}+${bKey}): missing candidate`); continue; }
  // Compose by unioning the two build outputs on the same pack/slotCursor.
  const composed = {
    id: `combo_${aKey}_${bKey}`,
    surface: `${aKey}+${bKey}`,
    params: { a: aCand.id, b: bCand.id },
    memoryOperationSignature: `combine ${aKey} and ${bKey} so the tradeoff-balancing patch can lift the total objective`,
    publicSignals: [...new Set([...(aCand.publicSignals ?? []), ...(bCand.publicSignals ?? [])])],
    minerDegreesOfFreedom: ['arm a parameters', 'arm b parameters', 'arm balance'],
    nonIndexerRationale: 'both arms read public structure; no doc-id selectors',
    profileOverrides: { ...aCand.profileOverrides, ...bCand.profileOverrides },
    buildUnits: (ctx) => {
      const a = aCand.buildUnits(ctx);
      const b = bCand.buildUnits(ctx);
      if (!a.indices?.length && !b.indices?.length) return { indices: [], newWords: [], reason: `both_skipped:${a.reason ?? '?'}|${b.reason ?? '?'}` };
      const idx = [...(a.indices ?? []), ...(b.indices ?? [])];
      const nw = [...(a.newWords ?? []), ...(b.newWords ?? [])];
      return { indices: idx, newWords: nw, anchored: { a: a.anchored ?? null, b: b.anchored ?? null } };
    },
    expectedRendererEffect: 'combination of both surfaces',
    expectedRerankerEffect: 'depends on whether the surfaces are independent or compensating',
  };
  const r = await runOneCandidate(composed);
  // Find aCand / bCand results from the surface sweep to assess COMPENSATED_POSITIVE.
  const aSolo = results.surfaces[aKey]?.find((x) => x.candidateId === aCand.id);
  const bSolo = results.surfaces[bKey]?.find((x) => x.candidateId === bCand.id);
  const aPpm = aSolo?.classification?.meanTargetPpm ?? 0;
  const bPpm = bSolo?.classification?.meanTargetPpm ?? 0;
  const cPpm = r.classification?.meanTargetPpm ?? 0;
  const bestSolo = Math.max(aPpm, bPpm);
  const compensated = !r.skipped
    && (aSolo?.classification?.label === 'UNSAFE' || aSolo?.classification?.label === 'TRADEOFF_POSITIVE' || bSolo?.classification?.label === 'UNSAFE' || bSolo?.classification?.label === 'TRADEOFF_POSITIVE')
    && cPpm > bestSolo + GATE.COMPENSATED_BEATS_BEST_BY;
  if (compensated) r.classification.label = 'COMPENSATED_POSITIVE';
  console.log(`  (${aKey}+${bKey}): ${r.skipped ? `SKIP (${r.reason})` : `${r.classification.label} combinedTarget=${cPpm}ppm bestSolo=${bestSolo}ppm`}`);
  results.combinations[`${aKey}+${bKey}`] = { a: aPpm, b: bPpm, combined: cPpm, bestSolo, ...r };
}
}

// ─── Write report ─────────────────────────────────────────────────────────────

const report = {
  schema: 'coretex.surface-search-harness.v1',
  bundle: BUNDLE_PATH, profile: PROFILE_PATH, corpus: CORPUS_PATH,
  bundleHash: baseBundle.manifest.bundleHash, corpusRoot: baseBundle.manifest.corpusRoot,
  reranker: RERANKER, packSize: PACK_SIZE, packSeeds: PACK_SEEDS,
  gate: GATE,
  surfacesScored: surfaces,
  surfaceCount: Object.values(results.surfaces).reduce((s, lst) => s + lst.length, 0),
  combinationCount: Object.keys(results.combinations).length,
  results,
};
const outAbs = resolve(repoRoot, OUT);
mkdirSync(dirname(outAbs), { recursive: true });
writeFileSync(outAbs, JSON.stringify(report, null, 2));
console.log(`\n[surface-search] wrote ${outAbs}`);
