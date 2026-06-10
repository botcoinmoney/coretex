#!/usr/bin/env node
/**
 * CoreTex scorer parity compare.
 *
 * Reads two `coretex-scorer-parity-harness.mjs` result.json files (ref = CPU fp32 validator path,
 * cmp = GPU fp32 scorer path) and gates the GPU run against the CPU run at the eval-RESULT level.
 *
 * Run-context assertions (FAIL LOUDLY if any differ — a parity claim is meaningless if the two
 * runs scored different inputs):
 *   bundleHash, profileHash, corpusRoot, queryPackRoot(s) per pack, promptTemplateHash,
 *   modelRevision, maxSeqLen, topK.
 *
 * PASS criteria (the user's bar):
 *   - maxPairScoreDelta  <= 1 ppm   (max abs per-query-per-doc reranker score delta, in ppm)
 *   - compositeDeltaPpm  <= 10      (abs diff of each scenario's composite / deltaPpm, ppm)
 *   - no accept/reject flip on any scenario
 *   - no top-10 ranking flip that CHANGES the per-query nDCG/reward result on any query
 *   - artifact hash present + schema-valid on scenarios 4/5 (and cpu==gpu artifactHash where present)
 *
 * Emits a structured JSON verdict and exits nonzero on any failure.
 *
 * Usage:
 *   node scripts/coretex-scorer-parity-compare.mjs --ref parity-cpu.json --cmp parity-gpu.json [--out verdict.json]
 *   node scripts/coretex-scorer-parity-compare.mjs <ref.json> <cmp.json>
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { argv, exit } from 'node:process';

function flag(name, fb) {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  return fb;
}

// Positional fallback: first two non-flag args are ref, cmp.
const positionals = argv.slice(2).filter((a, idx, arr) => !a.startsWith('--') && !(idx > 0 && arr[idx - 1].startsWith('--')));
const refPath = flag('ref', positionals[0]);
const cmpPath = flag('cmp', positionals[1]);
const outPath = flag('out', null);

// PASS-criteria knobs (defaults = user's bar).
const MAX_PAIR_SCORE_DELTA_PPM = Number(flag('max-pair-score-delta-ppm', '1'));
const MAX_COMPOSITE_DELTA_PPM = Number(flag('max-composite-delta-ppm', '10'));
const RANK_FLIP_TOP_N = Number(flag('rank-flip-top-n', '10'));
// TEST-ONLY bypass: skips ONLY the DETERMINISTIC_MODE + MAX_QUERIES_USED production guards so the
// local smoke can exercise the full-trace PASS path with two identical deterministic subset runs.
// It does NOT relax any score/trace/composite/artifact guard. NEVER pass this for a real parity run.
const SMOKE_ALLOW_DETERMINISTIC_AND_SUBSET = argv.includes('--smoke-allow-deterministic-and-subset');

if (!refPath || !cmpPath) {
  console.error('usage: coretex-scorer-parity-compare.mjs --ref <cpu.json> --cmp <gpu.json> [--out <verdict.json>]');
  exit(2);
}

const ref = JSON.parse(readFileSync(resolve(refPath), 'utf8'));
const cmp = JSON.parse(readFileSync(resolve(cmpPath), 'utf8'));

const failures = [];
const fail = (code, detail) => failures.push({ code, detail });
const ppm = (x) => Math.round((x ?? 0) * 1_000_000);

// ─── 0. Production-fidelity guards (a parity claim is meaningless on a smoke run) ─
// rerankerMode is read from runContext (canonical) with a top-level fallback for older artifacts.
const rerankerModeOf = (r) => r.runContext?.rerankerMode ?? r.rerankerMode ?? null;
// maxQueriesUsed: prefer the explicit runContext boolean; fall back to legacy signals
// (hiddenPackQuotasCleared / top-level smoke / maxQueries).
const maxQueriesUsedOf = (r) =>
  r.runContext?.maxQueriesUsed === true
  || r.runContext?.hiddenPackQuotasCleared === true
  || r.smoke === true
  || (typeof r.maxQueries === 'number' && r.maxQueries > 0);

for (const [side, r] of [['ref', ref], ['cmp', cmp]]) {
  if (rerankerModeOf(r) === 'deterministic') {
    if (SMOKE_ALLOW_DETERMINISTIC_AND_SUBSET) {
      console.error(`[compare] WARNING smoke bypass: ${side} rerankerMode=deterministic (DETERMINISTIC_MODE guard skipped — smoke only)`);
    } else {
      fail('DETERMINISTIC_MODE', `${side}: rerankerMode=deterministic — production parity must be qwen-cpu vs gpu (real model)`);
    }
  }
  if (maxQueriesUsedOf(r)) {
    if (SMOKE_ALLOW_DETERMINISTIC_AND_SUBSET) {
      console.error(`[compare] WARNING smoke bypass: ${side} maxQueriesUsed=true (MAX_QUERIES_USED guard skipped — smoke only)`);
    } else {
      fail('MAX_QUERIES_USED', `${side}: maxQueriesUsed=true — production parity must be a full hidden pack (no --max-queries)`);
    }
  }
}

// ─── 1. Run-context assertions (loud) ────────────────────────────────────────
const CTX_FIELDS = ['bundleHash', 'profileHash', 'corpusRoot', 'modelRevision', 'modelId', 'promptTemplateHash', 'maxSeqLen', 'topK'];
const contextDiffs = [];
for (const f of CTX_FIELDS) {
  const a = ref.runContext?.[f];
  const b = cmp.runContext?.[f];
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    contextDiffs.push({ field: f, ref: a, cmp: b });
    fail('RUN_CONTEXT_MISMATCH', `${f}: ref=${JSON.stringify(a)} cmp=${JSON.stringify(b)}`);
  }
}

// Scenario set must match.
const refScenarios = Object.keys(ref.scenarios ?? {});
const cmpScenarios = Object.keys(cmp.scenarios ?? {});
const scenarioSet = refScenarios.filter((s) => cmpScenarios.includes(s));
for (const s of refScenarios) if (!cmpScenarios.includes(s)) fail('SCENARIO_MISSING_IN_CMP', s);
for (const s of cmpScenarios) if (!refScenarios.includes(s)) fail('SCENARIO_MISSING_IN_REF', s);

// queryPackRoot(s) per pack must match per scenario (else they scored different packs).
function packRoots(scn) {
  const out = {};
  for (const [packName, p] of Object.entries(scn?.packs ?? {})) out[packName] = p.queryPackRoot;
  return out;
}

// ─── 2/3/4. Per-scenario metrics ─────────────────────────────────────────────
const scenarioReports = {};
let globalMaxPairScoreDeltaPpm = 0;
// Scenarios where the OUTPUT scores legitimately differ within tolerance (CPU vs GPU ULP) — recorded
// for visibility, NOT a hard fail. The INPUT-identity (pairTraceHash) IS a hard fail.
const scoreArrayHashDiffs = [];

// Walk every (composite branch) inside a scenario uniformly. A scenario's composite is either a
// flat summary (baseline / per-patch sometimes) or { gate, confirm } (dual-pack / per-patch).
function compositeBranches(scn) {
  const c = scn?.composite ?? {};
  if (typeof c.compositePpm === 'number') return { _: c };
  return c; // { gate, confirm }
}
function perQueryBranches(scn) {
  const pq = scn?.perQuery;
  if (Array.isArray(pq)) return { _: pq };
  return pq ?? {};
}
function deltaBranches(scn) {
  const d = scn?.deltaPpm;
  if (d === null || d === undefined) return {};
  if (typeof d === 'number') return { _: d };
  // { gate, confirm, min }
  const out = {};
  for (const k of ['gate', 'confirm']) if (typeof d[k] === 'number') out[k] = d[k];
  return out;
}

for (const name of scenarioSet) {
  const rScn = ref.scenarios[name];
  const cScn = cmp.scenarios[name];
  const rep = { name, checks: [] };

  // queryPackRoot parity.
  const rRoots = packRoots(rScn), cRoots = packRoots(cScn);
  for (const packName of new Set([...Object.keys(rRoots), ...Object.keys(cRoots)])) {
    if (rRoots[packName] !== cRoots[packName]) {
      fail('QUERY_PACK_ROOT_MISMATCH', `${name}.${packName}: ref=${rRoots[packName]} cmp=${cRoots[packName]}`);
      rep.checks.push({ check: 'queryPackRoot', pack: packName, ok: false, ref: rRoots[packName], cmp: cRoots[packName] });
    }
  }

  // accept/reject flip.
  if (rScn.accepted !== cScn.accepted) {
    fail('ACCEPT_REJECT_FLIP', `${name}: ref.accepted=${rScn.accepted} cmp.accepted=${cScn.accepted}`);
  }
  rep.acceptedRef = rScn.accepted ?? null;
  rep.acceptedCmp = cScn.accepted ?? null;

  // ── Full scored-pair trace parity (the strongest input-identity check) ──
  // totalScoredPairCount must match exactly: a different count means the two runs scored a different
  // set of (query,candidate) pairs. pairTraceHash chains every pair's promptHash in call order — it
  // is the INPUT-identity proof and MUST be identical. scoreArrayHash chains the OUTPUT scores; CPU
  // and GPU may legitimately differ by ULP, so a mismatch is RECORDED, not failed (the score
  // tolerance is enforced separately by maxPairScoreDeltaPpm<=1).
  rep.totalScoredPairCount = { ref: rScn.totalScoredPairCount ?? null, cmp: cScn.totalScoredPairCount ?? null };
  rep.pairTraceHash = { ref: rScn.pairTraceHash ?? null, cmp: cScn.pairTraceHash ?? null };
  rep.scoreArrayHash = { ref: rScn.scoreArrayHash ?? null, cmp: cScn.scoreArrayHash ?? null };
  if (rep.totalScoredPairCount.ref !== rep.totalScoredPairCount.cmp) {
    fail('PAIR_COUNT_DIFF', `${name}: totalScoredPairCount ref=${rep.totalScoredPairCount.ref} cmp=${rep.totalScoredPairCount.cmp}`);
  }
  if (rep.pairTraceHash.ref !== rep.pairTraceHash.cmp) {
    fail('PAIR_TRACE_HASH_DIFF', `${name}: pairTraceHash ref=${rep.pairTraceHash.ref} cmp=${rep.pairTraceHash.cmp} (scored DIFFERENT inputs)`);
  }
  // SCORE_ARRAY_HASH_DIFF: report-only (see above). Surfaced in the verdict summary, never failed.
  if (rep.scoreArrayHash.ref !== rep.scoreArrayHash.cmp) {
    scoreArrayHashDiffs.push({ scenario: name, ref: rep.scoreArrayHash.ref, cmp: rep.scoreArrayHash.cmp });
  }
  rep.scoreArrayHashMatches = rep.scoreArrayHash.ref === rep.scoreArrayHash.cmp;

  // composite / deltaPpm parity.
  const rComp = compositeBranches(rScn), cComp = compositeBranches(cScn);
  rep.compositeDeltaPpm = {};
  for (const branch of Object.keys(rComp)) {
    const a = rComp[branch]?.compositePpm, b = cComp[branch]?.compositePpm;
    if (typeof a === 'number' && typeof b === 'number') {
      const d = Math.abs(a - b);
      rep.compositeDeltaPpm[branch] = d;
      if (d > MAX_COMPOSITE_DELTA_PPM) fail('COMPOSITE_DELTA_EXCEEDED', `${name}.${branch}: |${a}-${b}|=${d}ppm > ${MAX_COMPOSITE_DELTA_PPM}`);
    }
  }
  // deltaPpm parity (gate/confirm patch scenarios).
  const rDelta = deltaBranches(rScn), cDelta = deltaBranches(cScn);
  rep.scoreDeltaPpm = {};
  for (const branch of Object.keys(rDelta)) {
    const a = rDelta[branch], b = cDelta[branch];
    if (typeof a === 'number' && typeof b === 'number') {
      const d = Math.abs(a - b);
      rep.scoreDeltaPpm[branch] = d;
      if (d > MAX_COMPOSITE_DELTA_PPM) fail('DELTA_PPM_EXCEEDED', `${name}.${branch}: |${a}-${b}|=${d}ppm > ${MAX_COMPOSITE_DELTA_PPM}`);
    }
  }

  // per-query: max pair-score delta + rank-flip-changes-reward.
  const rPQ = perQueryBranches(rScn), cPQ = perQueryBranches(cScn);
  let scnMaxPairDeltaPpm = 0;
  let rankFlipCount = 0, rankFlipChangesReward = 0;
  for (const branch of Object.keys(rPQ)) {
    const rqs = rPQ[branch] ?? [];
    const cqs = new Map((cPQ[branch] ?? []).map((q) => [q.recordId, q]));
    for (const rq of rqs) {
      const cq = cqs.get(rq.recordId);
      if (!cq) { fail('PER_QUERY_MISSING', `${name}.${branch}: ${rq.recordId} absent in cmp`); continue; }
      // max abs per-doc reranker score delta (ppm).
      const cByDoc = new Map((cq.top ?? []).map((r) => [r.docId, r]));
      for (const rr of rq.top ?? []) {
        const cr = cByDoc.get(rr.docId);
        if (!cr) continue; // doc absent in cmp top — captured by the rank-flip check below.
        const dPpm = Math.abs(ppm(rr.rerankerScore) - ppm(cr.rerankerScore));
        if (dPpm > scnMaxPairDeltaPpm) scnMaxPairDeltaPpm = dPpm;
      }
      // top-N ordering flip + whether it changed the per-query nDCG/reward.
      const rTop = (rq.top ?? []).slice(0, RANK_FLIP_TOP_N).map((r) => r.docId);
      const cTop = (cq.top ?? []).slice(0, RANK_FLIP_TOP_N).map((r) => r.docId);
      const orderingFlipped = JSON.stringify(rTop) !== JSON.stringify(cTop);
      const ndcgDelta = Math.abs(ppm(rq.nDCG10) - ppm(cq.nDCG10));
      const mrrDelta = Math.abs(ppm(rq.mrr10) - ppm(cq.mrr10));
      if (orderingFlipped) {
        rankFlipCount++;
        if (ndcgDelta > 0 || mrrDelta > 0) {
          rankFlipChangesReward++;
          fail('RANK_FLIP_CHANGES_REWARD', `${name}.${branch}.${rq.recordId}: top-${RANK_FLIP_TOP_N} ordering flipped AND nDCGΔ=${ndcgDelta}ppm mrrΔ=${mrrDelta}ppm`);
        }
      }
    }
  }
  if (scnMaxPairDeltaPpm > globalMaxPairScoreDeltaPpm) globalMaxPairScoreDeltaPpm = scnMaxPairDeltaPpm;
  rep.maxPairScoreDeltaPpm = scnMaxPairDeltaPpm;
  rep.rankFlipCount = rankFlipCount;
  rep.rankFlipChangesReward = rankFlipChangesReward;
  if (scnMaxPairDeltaPpm > MAX_PAIR_SCORE_DELTA_PPM) {
    fail('PAIR_SCORE_DELTA_EXCEEDED', `${name}: maxPairScoreDelta=${scnMaxPairDeltaPpm}ppm > ${MAX_PAIR_SCORE_DELTA_PPM}`);
  }

  // artifact hash (scenarios 4/5): present + schema-valid on accept; cpu==gpu where both present.
  if (name === 'accepted-patch' || name === 'rejected-patch') {
    const rHash = rScn.artifactHash ?? null;
    const cHash = cScn.artifactHash ?? null;
    rep.artifactHashRef = rHash;
    rep.artifactHashCmp = cHash;
    const expectArtifact = rScn.accepted === true; // production only commits an artifact on accept.
    if (expectArtifact) {
      if (!rHash || !/^0x[0-9a-f]{64}$/.test(rHash)) fail('ARTIFACT_HASH_INVALID', `${name}: ref artifactHash=${rHash}`);
      if (!cHash || !/^0x[0-9a-f]{64}$/.test(cHash)) fail('ARTIFACT_HASH_INVALID', `${name}: cmp artifactHash=${cHash}`);
      if (rHash && cHash && rHash !== cHash) fail('ARTIFACT_HASH_MISMATCH', `${name}: ref=${rHash} cmp=${cHash}`);
      // Schema sanity: the embedded artifact (if present) must self-hash to artifactHash.
      for (const [side, scn] of [['ref', rScn], ['cmp', cScn]]) {
        const art = scn.artifact;
        if (art) {
          if (art.evalReportHash !== art.artifactHash) fail('ARTIFACT_SCHEMA_INVALID', `${name}.${side}: evalReportHash != artifactHash`);
          if (!art.receipt?.accepted) fail('ARTIFACT_SCHEMA_INVALID', `${name}.${side}: artifact carries non-accepted receipt`);
        }
      }
    } else {
      // Rejected per-patch: no artifact expected; the rejection reason MUST be identical between
      // ref and cmp (a CPU/GPU score split must not change WHY a patch was rejected).
      if (rScn.rejectionReason !== cScn.rejectionReason) {
        fail('REJECTION_REASON_DIFF', `${name}: ref=${rScn.rejectionReason} cmp=${cScn.rejectionReason}`);
      }
      rep.rejectionReason = rScn.rejectionReason ?? null;
      rep.rejectionReasonCmp = cScn.rejectionReason ?? null;
    }
  }

  scenarioReports[name] = rep;
}

// Bit-identical detection (e.g. deterministic-vs-deterministic smoke). Strips volatile wall-timing
// fields (elapsedSec) that differ between runs without changing the eval RESULT.
function stripVolatile(value) {
  if (Array.isArray(value)) return value.map(stripVolatile);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === 'elapsedSec') continue;
      out[k] = stripVolatile(v);
    }
    return out;
  }
  return value;
}
const bitIdentical = JSON.stringify(stripVolatile(ref.scenarios)) === JSON.stringify(stripVolatile(cmp.scenarios));

const pass = failures.length === 0;
const verdict = {
  schemaVersion: 'coretex.scorer-parity-compare.v1',
  generatedAt: new Date().toISOString(),
  verdict: pass ? (bitIdentical ? 'PASS / BIT_IDENTICAL' : 'PASS') : 'FAIL',
  pass,
  ref: { path: refPath, rerankerMode: ref.rerankerMode, fidelity: ref.fidelity, smoke: ref.smoke ?? null },
  cmp: { path: cmpPath, rerankerMode: cmp.rerankerMode, fidelity: cmp.fidelity, smoke: cmp.smoke ?? null },
  criteria: {
    maxPairScoreDeltaPpm: MAX_PAIR_SCORE_DELTA_PPM,
    maxCompositeDeltaPpm: MAX_COMPOSITE_DELTA_PPM,
    rankFlipTopN: RANK_FLIP_TOP_N,
    smokeAllowDeterministicAndSubset: SMOKE_ALLOW_DETERMINISTIC_AND_SUBSET,
  },
  productionGuards: {
    refRerankerMode: rerankerModeOf(ref),
    cmpRerankerMode: rerankerModeOf(cmp),
    refMaxQueriesUsed: maxQueriesUsedOf(ref),
    cmpMaxQueriesUsed: maxQueriesUsedOf(cmp),
    bypassed: SMOKE_ALLOW_DETERMINISTIC_AND_SUBSET,
  },
  summary: {
    bitIdentical,
    globalMaxPairScoreDeltaPpm,
    contextDiffs,
    // SCORE_ARRAY_HASH_DIFF entries: OUTPUT-score chain mismatches (report-only; gated by ppm).
    scoreArrayHashDiffCount: scoreArrayHashDiffs.length,
    scoreArrayHashDiffs,
    scenarioCount: scenarioSet.length,
    failureCount: failures.length,
  },
  scenarios: scenarioReports,
  failures,
};

if (outPath) {
  mkdirSync(dirname(resolve(outPath)), { recursive: true });
  writeFileSync(resolve(outPath), JSON.stringify(verdict, null, 2) + '\n');
}
console.log(JSON.stringify(verdict, null, 2));
exit(pass ? 0 : 1);
