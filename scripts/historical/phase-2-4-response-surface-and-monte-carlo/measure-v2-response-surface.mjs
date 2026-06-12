#!/usr/bin/env node
/**
 * Phase 3 — A100 fixed-threshold response surface (real-Qwen).
 *
 * Measures the real advance-rate / false-accept curve as a function of difficulty,
 * WITHOUT controller feedback. Key efficiency: a patch's deltaPpm is threshold-
 * independent, and the acceptance rule is
 *   accepted_at_T = floorsPass && deltaPpm > T + variancePpm + replayTolerancePpm.
 * So each patch is scored ONCE (anchored at the lowest grid threshold); acceptance at
 * every higher threshold is then exact in-memory. One run per (corpus, seed) yields the
 * full curve for all honest families + random + hillclimb across all thresholds.
 *
 * Honest families (shared lib, same levers Phase 5 applies) are swept over strength to
 * trace a curve: relation edgeCount {1,2,3,4}, temporal maxRecords {1,2,4,8,12},
 * mixed {rel4+temp(1,4,12)}. Random = from empty; hillclimb = mutate a known-good
 * (relation-lever) state — an adaptive miner.
 *
 * CPU smoke:
 *   node scripts/measure-v2-response-surface.mjs --reranker deterministic \
 *     --corpus .../p1-corpus.json --emb .../p1-embeddings.json --pack-size 24 --rerank-cap 32 --seed a5
 * A100:
 *   HF_HUB_CACHE=... CORETEX_RERANKER_PYTHON=/usr/bin/python3 \
 *   node scripts/measure-v2-response-surface.mjs --reranker gpu --corpus .../p3-corpus.json \
 *     --emb .../p3-embeddings.json --seed a5 --out <dir>
 */
import { distIndex, repoRoot } from './_repo-root.mjs';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { buildV2ProductionCorpus, inertBiEncoder } from './lib/build-v2-production-corpus.mjs';
import { makeStreamReranker } from './lib/stream-reranker.mjs';
import { honestPatch, relationUnits, makePatch, empty, hseed, mulberry32, randomPatch } from './lib/v2-patch-families.mjs';

const {
  scoringOptionsFromProfile, deriveQueryPack, evaluateBaseline, evaluateRetrievalBenchmarkPatch,
  applyPatch, createDeterministicReranker,
} = await import(distIndex);

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const corpusPath = flag('corpus', 'release/calibration/2026-05-21-memory-corpus-v2/p1-corpus.json');
const embPath = flag('emb', 'release/calibration/2026-05-21-memory-corpus-v2/p1-embeddings.json');
const profilePath = flag('profile', 'release/bundle/evaluator-profile-v2-ownerscope-r1.json');
const seed = flag('seed', 'a5');
const rerankerArg = flag('reranker', 'deterministic');
const packSizeOverride = Number(flag('pack-size', '0'));
const rerankCapOverride = Number(flag('rerank-cap', '0'));
const randomProbes = Number(flag('random-probes', '24'));
const hillclimbProbes = Number(flag('hillclimb-probes', '24'));
const thresholds = String(flag('thresholds', '2500,5000,7500,10000,15000,25000,50000,100000,150000')).split(',').map(Number);
const ownerFraction = Number(flag('owner-fraction', '1.0'));
const outDir = flag('out', 'release/calibration/2026-05-21-memory-corpus-v2/p3-rework');
const START_T = Date.now();

const profile = JSON.parse(readFileSync(resolve(repoRoot, profilePath), 'utf8'));
const { corpus, queryEvents, logical, LAYOUT, BE, RR, biEncoderHash } = buildV2ProductionCorpus({ corpusPath, embPath });
const logicalQById = new Map(logical.queries.map((q) => [q.id, q]));
const reranker = rerankerArg === 'gpu' || rerankerArg === 'cpu'
  ? makeStreamReranker({ model: RR.modelId, revision: RR.revision, python: process.env.CORETEX_RERANKER_PYTHON ?? '/usr/bin/python3', allowCuda: rerankerArg === 'gpu' })
  : await createDeterministicReranker();
const opts = scoringOptionsFromProfile(profile, { biEncoder: inertBiEncoder(BE, LAYOUT), reranker, biEncoderHash, retrievalKeyLayout: LAYOUT });
if (rerankCapOverride > 0) opts.rerankerInputTopK = rerankCapOverride;
const hiddenPack = packSizeOverride > 0 ? { ...profile.hiddenPack, packSize: packSizeOverride } : profile.hiddenPack;
const replayTol = Number(profile.replayTolerancePpm ?? 250);
const structFloors = { structuralFloor: profile.patchAcceptanceFloors.structuralFloor, protectedRegressionFloor: -50000, familyCatastrophicFloor: -100000 };

// Active corpus at the chosen owner fraction (full pool by default — the response
// surface measures the steady-state acceptance regime, not the growth transient).
const owners = [...new Set(queryEvents.filter((e) => e.ownerScoped === true && e.ownerEntityId).map((e) => e.ownerEntityId))];
const ownerOrder = [...owners].map((o) => [o, hseed(`${seed}:${o}`)]).sort((a, b) => a[1] - b[1]).map((p) => p[0]);
const kOwners = Math.max(1, Math.floor(ownerOrder.length * ownerFraction));
const activeOwners = new Set(ownerOrder.slice(0, kOwners));
const events = corpus.events.filter((e) => e.split !== 'eval_hidden' || e.ownerScoped !== true || activeOwners.has(e.ownerEntityId));
const ac = { ...corpus, events, byId: new Map(events.map((e) => [e.id, e])) };
const seedHex = '0x' + createHash('sha256').update(`${seed}:rs`).digest('hex');
const pack = deriveQueryPack(1, seedHex, ac, hiddenPack);
console.error(`[v2-rs] ${logical.phase} corpus=${corpus.events.length}evt activeOwners=${kOwners}/${owners.length} packN=${pack.events.length} cap=${opts.rerankerInputTopK} reranker=${rerankerArg}`);

const base = await evaluateBaseline(empty(), ac, pack, opts, { samples: 1 });
const variance = base.variancePpm;
const minT = Math.min(...thresholds);
// Score a patch once, anchored at the lowest threshold; capture deltaPpm + floorsPass.
async function scorePatch(state, patch) {
  const r = await evaluateRetrievalBenchmarkPatch(state, patch, ac, pack, opts, { ...structFloors, minImprovementPpm: minT, acceptanceThresholdPpm: minT + variance + replayTol });
  const comp = { retrieval: r.after.nDCG10 - r.before.nDCG10, temporal: r.after.temporal - r.before.temporal,
    relation: r.after.categoryLensRelationHit10 - r.before.categoryLensRelationHit10, abstention: r.after.abstention - r.before.abstention,
    structural: r.after.structuralValidity - r.before.structuralValidity };
  // floorsPass: accepted at the lowest threshold ⇒ floors passed AND delta>minT+var+tol.
  // For T>=minT the only binding constraint is delta>T+var+tol, so acceptance is exact.
  return { deltaPpm: r.deltaPpm, acceptedAtMin: r.accepted, reason: r.reason ?? null, comp };
}

// HONEST: strength-swept levers, ALL within the 4-word patch budget.
//   relation: edgeCount 1..4 (1..4 words)
//   temporal: per-query units at startIndex 0..4 (3 words each — different temporal queries)
//   mixed:    1 relation edge + 1 temporal unit at startIndex 0..2 (4 words)
const honestSpecs = [];
for (const ec of [1, 2, 3, 4]) honestSpecs.push({ family: 'relation', strength: `e${ec}`, patch: honestPatch({ state: empty(), family: 'relation', pack, logicalQById, edgeCount: ec }) });
for (const si of [0, 1, 2, 3, 4]) honestSpecs.push({ family: 'temporal', strength: `q${si}`, patch: honestPatch({ state: empty(), family: 'temporal', pack, logicalQById, startIndex: si }) });
for (const si of [0, 1, 2]) honestSpecs.push({ family: 'mixed', strength: `e1q${si}`, patch: honestPatch({ state: empty(), family: 'mixed', pack, logicalQById, startIndex: si }) });
const honest = [];
for (const s of honestSpecs) { const r = await scorePatch(empty(), s.patch); honest.push({ family: s.family, strength: s.strength, wordCount: s.patch.wordCount, ...r }); }

// ADVERSARIAL: random (from empty) + hillclimb (mutate a known-good relation-lever state).
const rand = mulberry32(hseed(`${seed}:adv`));
const relState = (() => { const ap = applyPatch(empty(), makePatch(empty(), relationUnits(4))); return ap.ok ? ap.state : empty(); })();
const randomResults = [], hillResults = [];
for (let i = 0; i < randomProbes; i++) { const r = await scorePatch(empty(), randomPatch(empty(), rand)); randomResults.push(r); }
for (let i = 0; i < hillclimbProbes; i++) { const r = await scorePatch(relState, randomPatch(relState, rand)); hillResults.push(r); }

// Build the acceptance-vs-threshold curves (exact, in-memory).
const acceptedAt = (r, T) => r.acceptedAtMin && r.deltaPpm > T + variance + replayTol;
const families = ['relation', 'temporal', 'mixed'];
const curve = thresholds.map((T) => {
  const row = { threshold: T, acceptanceThresholdPpm: T + variance + replayTol };
  for (const f of families) {
    const fs = honest.filter((h) => h.family === f);
    row[`honest_${f}`] = +(fs.filter((h) => acceptedAt(h, T)).length / Math.max(1, fs.length)).toFixed(4);
  }
  row.honest_any = +(honest.filter((h) => acceptedAt(h, T)).length / Math.max(1, honest.length)).toFixed(4);
  row.random = +(randomResults.filter((r) => acceptedAt(r, T)).length / Math.max(1, randomResults.length)).toFixed(4);
  row.hillclimb = +(hillResults.filter((r) => acceptedAt(r, T)).length / Math.max(1, hillResults.length)).toFixed(4);
  return row;
});

// Gates (runbook Phase 3 response-surface gates).
const honestMonotone = (() => { for (let i = 1; i < curve.length; i++) if (curve[i].honest_any > curve[i - 1].honest_any + 1e-9) return false; return true; })();
const randomMax = Math.max(...curve.map((r) => r.random));
const hillMax = Math.max(...curve.map((r) => r.hillclimb));
const honestRealGain = honest.filter((h) => h.acceptedAtMin).every((h) => h.comp.retrieval > 0 || h.comp.temporal > 0 || h.comp.relation > 0);
const junkExplosion = randomResults.concat(hillResults).some((r) => r.acceptedAtMin && r.comp.retrieval > 0.0 && (r.comp.structural < -0.01)); // accepted junk that wrecks structure

const gitSha = (() => { try { return execSync('git rev-parse --short HEAD', { cwd: repoRoot }).toString().trim(); } catch { return 'unknown'; } })();
const distHash = (() => { try { return execSync('sha256sum packages/coretex/dist/eval/retrieval-benchmark.js', { cwd: repoRoot }).toString().trim().slice(0, 16); } catch { return 'unknown'; } })();
const dirtyTree = (() => { try { return execSync('git status --porcelain', { cwd: repoRoot }).toString().trim().length > 0; } catch { return null; } })();
const out = {
  generatedAt: new Date().toISOString(),
  provenance: { corpus: corpusPath, corpusRoot: corpus.corpusRoot, phase: logical.phase, profile: profilePath, gitSha, distHashRetrievalBenchmark: distHash, dirtyTree,
    reranker: rerankerArg === 'gpu' || rerankerArg === 'cpu' ? `Qwen/Qwen3-Reranker-0.6B@${RR.revision} (${rerankerArg})` : 'deterministic-stub',
    seed, ownerFraction, activeOwners: kOwners, packN: pack.events.length, rerankCap: opts.rerankerInputTopK,
    variancePpm: variance, replayTolerancePpm: replayTol, thresholds, alpha: profile.categoryLensScoreInheritance,
    acceptanceRule: 'floorsPass && deltaPpm > threshold + variancePpm + replayTolerancePpm' },
  gates: { honestAcceptanceMonotoneDecreasing: honestMonotone, randomAcceptanceMax: randomMax, hillclimbAcceptanceMax: hillMax,
    randomCleanLE001: randomMax <= 0.01, hillclimbCleanLE001: hillMax <= 0.01, honestAcceptsShowRealGain: honestRealGain, noJunkExplosion: !junkExplosion,
    PASS: honestMonotone && randomMax <= 0.01 && hillMax <= 0.01 && honestRealGain && !junkExplosion },
  curve,
  honestPatches: honest,
  adversarialSummary: { randomDeltaPpmMax: Math.max(...randomResults.map((r) => r.deltaPpm)), randomAcceptedAtMin: randomResults.filter((r) => r.acceptedAtMin).length,
    hillclimbDeltaPpmMax: Math.max(...hillResults.map((r) => r.deltaPpm)), hillclimbAcceptedAtMin: hillResults.filter((r) => r.acceptedAtMin).length },
  wallClockSec: +((Date.now() - START_T) / 1000).toFixed(1),
};
mkdirSync(resolve(repoRoot, outDir), { recursive: true });
const suffix = rerankerArg === 'gpu' || rerankerArg === 'cpu' ? 'qwen' : 'det';
const path = resolve(repoRoot, outDir, `V2_RESPONSE_SURFACE_${(logical.phase || 'p').toLowerCase()}_${seed}_${suffix}.json`);
writeFileSync(path, JSON.stringify(out, null, 2));
console.log(JSON.stringify({ provenance: out.provenance, gates: out.gates, curve: out.curve }, null, 2));
console.log(`wrote ${path}`);
if (typeof reranker.close === 'function') reranker.close();
