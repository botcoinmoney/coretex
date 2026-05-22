#!/usr/bin/env node
/**
 * V2 owner-scoped long-horizon harness (Layer 9, items 6+7) — production-faithful.
 *
 * Drives the difficulty controller over the owner-scoped V2 corpus's owner-growth
 * trajectory with REAL scoring, using the PRODUCTION acceptance rule and the
 * SIGNED-profile-derived scoring options (no bespoke opts). Two cleanly-separated
 * populations per epoch:
 *   - HONEST: the positive-control relation-lever patch (+ small variants) from
 *     the current BEST accepted state. Accepted honest patches FEED the controller
 *     (`observedAdvances`) so the RAMP branch is exercised, and update bestState.
 *   - ADVERSARIAL: RANDOM patches (from empty) + HILLCLIMB patches (mutate the
 *     current bestState — an adaptive miner). Acceptance is measured as the
 *     anti-cheat / gameability rate; it does NOT feed the controller.
 *
 * Production acceptance threshold = minImprovementPpm + variancePpm +
 * replayTolerancePpm. Baseline is recomputed on major-delta (owner-growth) epochs.
 *
 * CPU smoke (mechanics; deterministic reranker can't reward routing → honest
 * accepts ~0, but threshold/population/baseline-recompute plumbing is exercised):
 *   node scripts/simulate-v2-long-horizon.mjs --reranker deterministic --epochs 4 \
 *     --random-probes 4 --hillclimb-probes 2 --honest-per-epoch 1
 * A100 real signal:
 *   HF_HUB_CACHE=... CORETEX_RERANKER_PYTHON=/usr/bin/python3 \
 *   node scripts/simulate-v2-long-horizon.mjs --reranker gpu --epochs 12 \
 *     --random-probes 12 --hillclimb-probes 6 --honest-per-epoch 2 --out <dir>
 */
import { distIndex, repoRoot } from './_repo-root.mjs';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { buildV2ProductionCorpus, inertBiEncoder } from './lib/build-v2-production-corpus.mjs';
import { makeStreamReranker } from './lib/stream-reranker.mjs';

const {
  scoringOptionsFromProfile, deriveQueryPack, evaluateBaseline, evaluateRetrievalBenchmarkPatch,
  applyPatch, merkleizeState, nextMinImprovementPpm, isMajorDelta, createDeterministicReranker,
  encodeRelationCategoryLens, encodeMemoryIndexSlot, encodeTemporalRecord, stableRecordIdFor,
  PATCH_TYPE, RANGES, RESERVED_MASKS, MIN_IMPROVEMENT_PPM, MAX_IMPROVEMENT_PPM,
} = await import(distIndex);

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const corpusPath = flag('corpus', 'release/calibration/2026-05-21-memory-corpus-v2/p1-corpus.json');
const embPath = flag('emb', 'release/calibration/2026-05-21-memory-corpus-v2/p1-embeddings.json');
const profilePath = flag('profile', 'release/bundle/evaluator-profile-v2-ownerscope-r1.json');
const epochs = Number(flag('epochs', '12'));
const randomProbes = Number(flag('random-probes', '12'));
const hillclimbProbes = Number(flag('hillclimb-probes', '6'));
const honestPerEpoch = Number(flag('honest-per-epoch', '2'));
const baselineSamples = Number(flag('baseline-samples', '1'));
const targetAdvances = Number(flag('target-advances', '2'));
const rerankerArg = flag('reranker', 'deterministic');
const masterSeed = flag('seed', 'v2-lh-2026-05-22');
const ownerFractions = String(flag('owner-fractions', '0.34,0.67,1.0')).split(',').map(Number);
const epochsPerFraction = Number(flag('epochs-per-fraction', String(Math.ceil(epochs / ownerFractions.length))));
// Bounded-run overrides (keep A100 Qwen-pair budget tractable). 0 = use profile.
const packSizeOverride = Number(flag('pack-size', '0'));
const rerankCapOverride = Number(flag('rerank-cap', '0'));
const outDir = flag('out', 'release/calibration/2026-05-21-memory-corpus-v2');
// ── Phase 1 hardening flags ──
const num = (n) => { const v = flag(n, undefined); return v === undefined ? undefined : Number(v); };
const big = (n) => { const v = flag(n, undefined); return v === undefined ? undefined : BigInt(v); };
// Controller-shape sweep (undefined → controller defaults).
const rampUpMaxRatio = num('ramp-up-max-ratio');
const decayRatio = num('decay-ratio');
const smallDriftRatio = num('small-drift-ratio');
const qualityHighThresholdMult = num('quality-high-threshold-mult');
// Experimental clamp-bound overrides (research-only; pinned constants otherwise).
const minImprovementFloorPpm = big('min-improvement-floor-ppm');
const maxImprovementCeilingPpm = big('max-improvement-ceiling-ppm');
// Fixed-threshold response-curve mode: hold minImprovement fixed, optionally freeze
// the controller entirely (measure acceptance vs difficulty without feedback).
const fixedMinImprovementPpm = big('fixed-min-improvement-ppm');
const disableController = argv.includes('--disable-controller') || fixedMinImprovementPpm !== undefined;
// Honest patch families: relation | temporal | mixed | all (round-robin over the three).
const honestFamily = flag('honest-family', 'all');
// Checkpoint / resume for long A100 / many-epoch continuation.
const resumePath = flag('resume', undefined);
const stateOutPath = flag('state-out', undefined);
const START_T = Date.now();
const controllerOverrides = {
  ...(rampUpMaxRatio !== undefined ? { rampUpMaxRatio } : {}),
  ...(decayRatio !== undefined ? { decayRatio } : {}),
  ...(smallDriftRatio !== undefined ? { smallDriftRatio } : {}),
  ...(qualityHighThresholdMult !== undefined ? { qualityHighThreshold: qualityHighThresholdMult * targetAdvances } : {}),
  ...(minImprovementFloorPpm !== undefined ? { minClampPpm: minImprovementFloorPpm } : {}),
  ...(maxImprovementCeilingPpm !== undefined ? { maxClampPpm: maxImprovementCeilingPpm } : {}),
};

const profile = JSON.parse(readFileSync(resolve(repoRoot, profilePath), 'utf8'));
const { corpus, queryEvents, logical, LAYOUT, BE, RR, biEncoderHash } = buildV2ProductionCorpus({ corpusPath, embPath });
const logicalQById = new Map(logical.queries.map((q) => [q.id, q]));
const reranker = rerankerArg === 'gpu' || rerankerArg === 'cpu'
  ? makeStreamReranker({ model: RR.modelId, revision: RR.revision, python: process.env.CORETEX_RERANKER_PYTHON ?? '/usr/bin/python3', allowCuda: rerankerArg === 'gpu' })
  : await createDeterministicReranker();
// CANONICAL: scoring options from the signed profile (no bespoke opts). Bounded-run
// cap override only narrows the reranker pool (compute), not substrate expressivity.
const opts = scoringOptionsFromProfile(profile, { biEncoder: inertBiEncoder(BE, LAYOUT), reranker, biEncoderHash, retrievalKeyLayout: LAYOUT });
if (rerankCapOverride > 0) opts.rerankerInputTopK = rerankCapOverride;
const hiddenPack = packSizeOverride > 0 ? { ...profile.hiddenPack, packSize: packSizeOverride } : profile.hiddenPack;
const replayTol = Number(profile.replayTolerancePpm ?? 250);
// Effective major-delta threshold MUST come from the profile (auditable, not a
// silent default). Warn loudly if the profile lacks it rather than quietly using 0.1.
if (profile.majorDeltaThreshold === undefined) console.error('[v2-lh] WARN: profile lacks majorDeltaThreshold; falling back to 0.1 (NOT profile-pinned)');
const effMajorDelta = Number(profile.majorDeltaThreshold ?? 0.1);
// Production-count semantics (Phase 1 item 7): isMajorDelta compares an ABSOLUTE
// new-minus-prev eval_hidden COUNT. A ratio-like value (0<v<1) in production-profile
// mode is almost certainly a misconfiguration — refuse it loudly.
if (profile.majorDeltaThreshold !== undefined && effMajorDelta > 0 && effMajorDelta < 1) {
  console.error(`[v2-lh] FATAL: profile.majorDeltaThreshold=${effMajorDelta} is ratio-like; isMajorDelta expects an integer new-eval_hidden COUNT. Refusing.`);
  process.exit(2);
}
const structFloors = {
  structuralFloor: profile.patchAcceptanceFloors.structuralFloor,
  protectedRegressionFloor: -50000, familyCatastrophicFloor: -100000,
};

// owner-growth: activate the first `frac` of owners (deterministic order).
const owners = [...new Set(queryEvents.filter((e) => e.ownerScoped === true && e.ownerEntityId).map((e) => e.ownerEntityId))];
function hseed(s) { let h = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h; }
const ownerOrder = [...owners].map((o) => [o, hseed(`${masterSeed}:${o}`)]).sort((a, b) => a[1] - b[1]).map((p) => p[0]);
// Active subset corpus: eval_hidden restricted to active owners (+ pooled families always on); all mem docs kept.
function activeCorpus(frac) {
  const k = Math.max(1, Math.floor(ownerOrder.length * frac));
  const active = new Set(ownerOrder.slice(0, k));
  const events = corpus.events.filter((e) => e.split !== 'eval_hidden' || e.ownerScoped !== true || active.has(e.ownerEntityId));
  return { ...corpus, events, byId: new Map(events.map((e) => [e.id, e])),
    evalHiddenCount: events.filter((e) => e.split === 'eval_hidden').length };
}

// ── honest patch families ──
// All three are GENUINE substrate compiles (proposer-visible memory structure, no
// query→answer leak): the relation lever compiles category-lens edges; the temporal
// lever compiles the corpus's own current/stale memory roles + a TemporalRecord (the
// same construction the validated p05 ON arm uses). Each builds indices/newWords that
// the harness wraps into a MIXED patch parented on `state` (mutate-best semantics).
const empty = () => ({ words: new Array(1024).fill(0n) });
const RELATION_EDGES = ['supports', 'causes', 'supersedes', 'coreference_of'];

// relation-only: category-lens entries for the canonical edge set at top entryIndices.
function relationUnits() {
  const indices = [], newWords = [];
  RELATION_EDGES.forEach((et, i) => {
    indices.push(RANGES.RELATIONS_START + (128 - 1 - i));
    newWords.push(encodeRelationCategoryLens({ entryIndex: 128 - 1 - i, edgeType: et, weight: 0x8000 }));
  });
  return { indices, newWords };
}

// temporal-only: for each temporal_update query in the pack, allocate stale+current
// memory-index slots (revoked vs valid) and one TemporalRecord. Bounded to 12 records
// / 42 slots (the substrate temporal/memory-index capacity used by the canonical bridge).
function temporalUnits(pack) {
  const indices = [], newWords = [];
  let slot = 0, rec = 0;
  for (const ev of pack.events) {
    if (rec >= 12 || slot >= 42) break;
    const lq = logicalQById.get(ev.id);
    if (!lq || lq.family !== 'temporal_update') continue;
    const cur = (lq.qrels ?? []).find((r) => r.role === 'direct');
    const stale = (lq.qrels ?? []).find((r) => r.role === 'stale');
    if (!cur || !stale) continue;
    const staleSlot = slot++, curSlot = slot++;
    const sw = encodeMemoryIndexSlot({ slotIndex: staleSlot, recordId: stableRecordIdFor(`mem_${stale.docId}`), family: 'temporal', domainBits: 1n, valid: true, revoked: true, protected: false, retrievalSlot: staleSlot, expiryEpoch: 0n });
    for (let j = 0; j < 8; j++) { indices.push(RANGES.MEMORY_INDEX_START + staleSlot * 8 + j); newWords.push(sw[j]); }
    const cw = encodeMemoryIndexSlot({ slotIndex: curSlot, recordId: stableRecordIdFor(`mem_${cur.docId}`), family: 'temporal', domainBits: 1n, valid: true, revoked: false, protected: false, retrievalSlot: curSlot, expiryEpoch: 0n });
    for (let j = 0; j < 8; j++) { indices.push(RANGES.MEMORY_INDEX_START + curSlot * 8 + j); newWords.push(cw[j]); }
    const tw = encodeTemporalRecord({ recordIndex: rec, memorySlot: staleSlot, supersededBy: curSlot, validFromEpoch: 1n, validUntilEpoch: (2n ** 40n - 1n), currentStaleFlag: true });
    for (let j = 0; j < 8; j++) { indices.push(RANGES.TEMPORAL_START + rec * 8 + j); newWords.push(tw[j]); }
    rec++;
  }
  return { indices, newWords };
}

function makePatch(state, units) {
  return { patchType: PATCH_TYPE.MIXED, wordCount: units.indices.length, scoreDelta: 0n, parentStateRoot: merkleizeState(state), indices: units.indices, newWords: units.newWords };
}
// family ∈ {relation, temporal, mixed}. mixed = relation ∪ temporal (disjoint ranges).
function honestPatch(state, family, pack) {
  if (family === 'relation') return makePatch(state, relationUnits());
  if (family === 'temporal') return makePatch(state, temporalUnits(pack));
  const r = relationUnits(), t = temporalUnits(pack);
  return makePatch(state, { indices: [...r.indices, ...t.indices], newWords: [...r.newWords, ...t.newWords] });
}
const HONEST_FAMILIES = honestFamily === 'all' ? ['relation', 'temporal', 'mixed'] : [honestFamily];
function mulberry32(seed) { let t = seed >>> 0; return () => { t += 0x6D2B79F5; let x = Math.imul(t ^ (t >>> 15), 1 | t); x ^= x + Math.imul(x ^ (x >>> 7), 61 | x); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; }; }
function randomWord(rand, mask) { let v = 0n; for (let i = 0; i < 4; i++) v = (v << 64n) | (BigInt(Math.floor(rand() * 0x100000000)) << 32n) | BigInt(Math.floor(rand() * 0x100000000)); return v & (~mask); }
function randomPatch(state, rand) { const n = 1 + Math.floor(rand() * 4); const used = new Set(); const indices = [], newWords = []; while (indices.length < n) { const idx = Math.floor(rand() * RANGES.WORD_COUNT); if (used.has(idx)) continue; used.add(idx); const mask = RESERVED_MASKS[idx] ?? 0n; let w = randomWord(rand, mask); if (w === (state.words[idx] ?? 0n)) w = (w + 1n) & (~mask); indices.push(idx); newWords.push(w); } return { patchType: PATCH_TYPE.MIXED, wordCount: n, scoreDelta: 0n, parentStateRoot: merkleizeState(state), indices, newWords }; }

async function evalPatch(state, patch, corpus_, pack, acceptanceThresholdPpm, minImprovementPpm) {
  return evaluateRetrievalBenchmarkPatch(state, patch, corpus_, pack, opts, { ...structFloors, minImprovementPpm, acceptanceThresholdPpm });
}

// State (de)serialization for checkpoint/resume — bigint words ↔ decimal strings.
const serializeState = (s) => s.words.map((w) => w.toString());
const deserializeState = (arr) => ({ words: arr.map((x) => BigInt(x)) });

// Initial minImprovement: fixed-threshold mode pins it; else the profile floor.
let current = fixedMinImprovementPpm !== undefined ? fixedMinImprovementPpm : BigInt(Number(profile.patchAcceptanceFloors.minImprovementPpm) || 5000);
let bestState = empty();
let prevEH = 0, clampHits = 0, maxClampWhileAdvancing = 0, baselineRecomputes = 0;
let cachedVariance = null, cachedFrac = null;
let startEpoch = 1;
let rows = [];
if (resumePath) {
  const ck = JSON.parse(readFileSync(resolve(repoRoot, resumePath), 'utf8'));
  bestState = deserializeState(ck.bestState);
  if (!disableController) current = BigInt(ck.current);
  prevEH = ck.prevEH ?? 0; clampHits = ck.clampHits ?? 0; maxClampWhileAdvancing = ck.maxClampWhileAdvancing ?? 0;
  baselineRecomputes = ck.baselineRecomputes ?? 0; cachedVariance = ck.cachedVariance ?? null; cachedFrac = ck.cachedFrac ?? null;
  rows = ck.rows ?? []; startEpoch = (ck.lastEpoch ?? 0) + 1;
  console.error(`[v2-lh] RESUMED from ${resumePath} at epoch ${startEpoch} (rows=${rows.length}, current=${current})`);
}
function writeStateOut(lastEpoch) {
  if (!stateOutPath) return;
  const ck = { lastEpoch, current: current.toString(), prevEH, clampHits, maxClampWhileAdvancing, baselineRecomputes,
    cachedVariance, cachedFrac, bestState: serializeState(bestState), rows };
  writeFileSync(resolve(repoRoot, stateOutPath), JSON.stringify(ck));
}
console.error(`[v2-lh] corpus=${corpus.events.length} evt, scopedOwners=${owners.length}, reranker=${rerankerArg}, profile=${profilePath}, epochs=${epochs}, families=[${HONEST_FAMILIES}], controller=${disableController ? 'DISABLED(fixed=' + current + ')' : 'on'}`);
for (let epoch = startEpoch; epoch <= epochs; epoch++) {
  const fracIdx = Math.min(ownerFractions.length - 1, Math.floor((epoch - 1) / Math.max(1, epochsPerFraction)));
  const frac = ownerFractions[fracIdx] ?? 1;
  const ac = activeCorpus(frac);
  const majorDeltaActive = isMajorDelta(ac.evalHiddenCount, prevEH, effMajorDelta); prevEH = ac.evalHiddenCount;
  const seedHex = '0x' + createHash('sha256').update(`${masterSeed}:${epoch}`).digest('hex');
  const pack = deriveQueryPack(epoch, seedHex, ac, hiddenPack);

  // Baseline + variance: recompute on first epoch or major-delta (owner-growth).
  if (cachedVariance === null || majorDeltaActive || frac !== cachedFrac) {
    const base = await evaluateBaseline(bestState, ac, pack, opts, { samples: baselineSamples });
    cachedVariance = base.variancePpm; cachedFrac = frac; baselineRecomputes++;
  }
  const acceptanceThresholdPpm = Number(current) + cachedVariance + replayTol;

  // HONEST population: genuine substrate-compile levers from bestState, rotating over
  // the selected families (relation / temporal / mixed). Major-delta epochs are a
  // controller grace freeze, but we still measure advances honestly. Per-component
  // deltas (retrieval/temporal/relation/abstention/structural) are recorded so
  // non-retrieval fluff can be filtered out downstream (Phase 1 item 5).
  const compDelta = () => ({ retrieval: 0, temporal: 0, relation: 0, abstention: 0, structural: 0 });
  const familyStats = {}; for (const f of HONEST_FAMILIES) familyStats[f] = { attempts: 0, accepts: 0, deltaPpm: [], comp: compDelta() };
  let honestAccepts = 0, honestAttempts = 0; let pcDelta = null;
  for (let h = 0; h < honestPerEpoch; h++) {
    const family = HONEST_FAMILIES[(epoch + h) % HONEST_FAMILIES.length];
    const r = await evalPatch(bestState, honestPatch(bestState, family, pack), ac, pack, acceptanceThresholdPpm, Number(current));
    honestAttempts++; familyStats[family].attempts++;
    if (h === 0) pcDelta = r.deltaPpm;
    familyStats[family].deltaPpm.push(r.deltaPpm);
    const c = familyStats[family].comp;
    c.retrieval += r.after.nDCG10 - r.before.nDCG10;
    c.temporal += r.after.temporal - r.before.temporal;
    c.relation += r.after.categoryLensRelationHit10 - r.before.categoryLensRelationHit10;
    c.abstention += r.after.abstention - r.before.abstention;
    c.structural += r.after.structuralValidity - r.before.structuralValidity;
    if (r.accepted) { honestAccepts++; familyStats[family].accepts++; const ap = applyPatch(bestState, honestPatch(bestState, family, pack)); if (ap.ok) bestState = ap.state; }
  }

  // ADVERSARIAL population: random (from empty) + hillclimb (mutate bestState).
  const rand = mulberry32(hseed(`${masterSeed}:adv:${epoch}`));
  let randAccepts = 0, hillAccepts = 0; const randDeltas = [], hillDeltas = [];
  for (let i = 0; i < randomProbes; i++) { const r = await evalPatch(empty(), randomPatch(empty(), rand), ac, pack, acceptanceThresholdPpm, Number(current)); randDeltas.push(r.deltaPpm); if (r.accepted) randAccepts++; }
  for (let i = 0; i < hillclimbProbes; i++) { const r = await evalPatch(bestState, randomPatch(bestState, rand), ac, pack, acceptanceThresholdPpm, Number(current)); hillDeltas.push(r.deltaPpm); if (r.accepted) hillAccepts++; }

  // Controller: ONLY honest advances feed observedAdvances. In fixed-threshold /
  // disable-controller mode the threshold is held constant (Phase 3 response-surface
  // measurement) — no ramp/decay feedback.
  const minImprBefore = Number(current);
  let reason = 'fixed_threshold';
  if (!disableController) {
    const d = nextMinImprovementPpm({ current, observedAdvances: honestAccepts, targetAdvances, qualityAttempts: honestAttempts, majorDeltaActive, ...controllerOverrides });
    if (d.clamped) clampHits++;
    const effMax = maxImprovementCeilingPpm !== undefined ? Number(maxImprovementCeilingPpm) : Number(MAX_IMPROVEMENT_PPM);
    if (Number(d.next) === effMax && honestAccepts > targetAdvances) maxClampWhileAdvancing++;
    current = d.next; reason = d.reason;
  }
  // Round per-family component deltas for readability.
  const fstats = {};
  for (const f of HONEST_FAMILIES) {
    const s = familyStats[f]; const r4 = (x) => +x.toFixed(6);
    fstats[f] = { attempts: s.attempts, accepts: s.accepts, deltaPpmMax: s.deltaPpm.length ? Math.max(...s.deltaPpm) : null,
      componentDelta: { retrieval: r4(s.comp.retrieval), temporal: r4(s.comp.temporal), relation: r4(s.comp.relation), abstention: r4(s.comp.abstention), structural: r4(s.comp.structural) } };
  }
  rows.push({ epoch, ownerFraction: frac, activeEvalHidden: ac.evalHiddenCount, majorDeltaActive, packN: pack.events.length,
    acceptanceThresholdPpm, variancePpm: cachedVariance,
    honestAccepts, honestAttempts, positiveControlDeltaPpm: pcDelta, familyStats: fstats,
    randomProbes, randomAccepts: randAccepts, randomAcceptanceRate: +(randAccepts / Math.max(1, randomProbes)).toFixed(4), randomDeltaPpmMax: randDeltas.length ? Math.max(...randDeltas) : null,
    hillclimbProbes, hillclimbAccepts: hillAccepts, hillclimbAcceptanceRate: +(hillAccepts / Math.max(1, hillclimbProbes)).toFixed(4), hillclimbDeltaPpmMax: hillDeltas.length ? Math.max(...hillDeltas) : null,
    minImprBefore, minImprAfter: Number(current), reason });
  writeStateOut(epoch);
  console.error(`[v2-lh] ep ${epoch}/${epochs} frac=${frac} packN=${pack.events.length} thr=${acceptanceThresholdPpm} | honest ${honestAccepts}/${honestAttempts}(Δ${pcDelta}) rand ${randAccepts}/${randomProbes} hill ${hillAccepts}/${hillclimbProbes} | minImpr ${minImprBefore}→${Number(current)} [${reason}]`);
}
const gitSha = (() => { try { return execSync('git rev-parse --short HEAD', { cwd: repoRoot }).toString().trim(); } catch { return 'unknown'; } })();
const distHash = (() => { try { return execSync('sha256sum packages/cortex/dist/eval/retrieval-benchmark.js', { cwd: repoRoot }).toString().trim().slice(0, 16); } catch { return 'unknown'; } })();
const dirtyTree = (() => { try { return execSync('git status --porcelain', { cwd: repoRoot }).toString().trim().length > 0; } catch { return null; } })();
const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
const out = {
  generatedAt: new Date().toISOString(),
  provenance: { corpus: corpusPath, corpusRoot: corpus.corpusRoot, profile: profilePath, gitSha, distHashRetrievalBenchmark: distHash, dirtyTree,
    reranker: rerankerArg === 'gpu' || rerankerArg === 'cpu' ? `Qwen/Qwen3-Reranker-0.6B@${RR.revision} (${rerankerArg})` : 'deterministic-stub',
    seed: masterSeed, replayTolerancePpm: replayTol, majorDeltaThreshold: effMajorDelta,
    majorDeltaThresholdProfilePinned: profile.majorDeltaThreshold !== undefined,
    clampBounds: { minPpm: minImprovementFloorPpm !== undefined ? Number(minImprovementFloorPpm) : Number(MIN_IMPROVEMENT_PPM),
      maxPpm: maxImprovementCeilingPpm !== undefined ? Number(maxImprovementCeilingPpm) : Number(MAX_IMPROVEMENT_PPM),
      pinnedMinPpm: Number(MIN_IMPROVEMENT_PPM), pinnedMaxPpm: Number(MAX_IMPROVEMENT_PPM),
      overridden: minImprovementFloorPpm !== undefined || maxImprovementCeilingPpm !== undefined },
    honestFamilies: HONEST_FAMILIES, targetAdvances,
    controllerMode: disableController ? (fixedMinImprovementPpm !== undefined ? `fixed=${fixedMinImprovementPpm}` : 'disabled') : 'feedback',
    controllerOverrides: { rampUpMaxRatio: rampUpMaxRatio ?? 1.5, decayRatio: decayRatio ?? 0.85, smallDriftRatio: smallDriftRatio ?? 1.05, qualityHighThresholdMult: qualityHighThresholdMult ?? 4 },
    acceptanceRule: 'delta > minImprovementPpm + variancePpm + replayTolerancePpm' },
  summary: {
    epochs, scopedOwners: owners.length, baselineRecomputes,
    honestAcceptedEpochs: rows.filter((r) => r.honestAccepts > 0).length,
    meanRandomAcceptanceRate: +mean(rows.map((r) => r.randomAcceptanceRate)).toFixed(4),
    maxRandomAcceptanceRate: Math.max(...rows.map((r) => r.randomAcceptanceRate)),
    meanHillclimbAcceptanceRate: +mean(rows.map((r) => r.hillclimbAcceptanceRate)).toFixed(4),
    maxHillclimbAcceptanceRate: Math.max(...rows.map((r) => r.hillclimbAcceptanceRate)),
    clampHits, plateauRiskAtMax: maxClampWhileAdvancing,
    minImprFirst: rows[0]?.minImprBefore, minImprLast: rows.at(-1)?.minImprAfter,
    approxQwenPairs: rows.reduce((s, r) => s + r.packN * opts.rerankerInputTopK * 2 * (r.honestAttempts + r.randomProbes + r.hillclimbProbes + 1), 0),
    wallClockSec: +((Date.now() - START_T) / 1000).toFixed(1),
    // EVIDENCE (not launch proof): anti-cheat = random+hillclimb acceptance ~0;
    // advance signal = honest accepts present; plateau = MAX-clamp-while-advancing.
    antiCheatCleanRandom: mean(rows.map((r) => r.randomAcceptanceRate)) <= 0.01,
    antiCheatCleanHillclimb: mean(rows.map((r) => r.hillclimbAcceptanceRate)) <= 0.01,
    advanceSignalPresent: rows.some((r) => r.honestAccepts > 0),
    // Per-family advance signal: which honest families actually produced accepts /
    // real retrieval+temporal gains over the run (filters single-family longevity).
    perFamily: Object.fromEntries(HONEST_FAMILIES.map((f) => {
      const accepts = rows.reduce((s, r) => s + (r.familyStats?.[f]?.accepts ?? 0), 0);
      const attempts = rows.reduce((s, r) => s + (r.familyStats?.[f]?.attempts ?? 0), 0);
      const dRetr = rows.reduce((s, r) => s + (r.familyStats?.[f]?.componentDelta?.retrieval ?? 0), 0);
      const dTemp = rows.reduce((s, r) => s + (r.familyStats?.[f]?.componentDelta?.temporal ?? 0), 0);
      const dRel = rows.reduce((s, r) => s + (r.familyStats?.[f]?.componentDelta?.relation ?? 0), 0);
      return [f, { attempts, accepts, acceptanceRate: +(accepts / Math.max(1, attempts)).toFixed(4), sumRetrievalDelta: +dRetr.toFixed(6), sumTemporalDelta: +dTemp.toFixed(6), sumRelationDelta: +dRel.toFixed(6) }];
    })),
  },
  epochs: rows,
};
const suffix = rerankerArg === 'gpu' || rerankerArg === 'cpu' ? 'qwen' : 'det';
mkdirSync(resolve(outDir), { recursive: true });
const tag = flag('tag', undefined);
const tagSuffix = tag !== undefined ? `_${tag}` : '';
const path = resolve(outDir, `V2_LONG_HORIZON_${(profile.name || 'p').toLowerCase().replace(/[^a-z0-9]+/g, '-')}_${suffix}${tagSuffix}.json`);
writeFileSync(path, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out.summary, null, 2));
console.log(`wrote ${path}`);
if (typeof reranker.close === 'function') reranker.close();
