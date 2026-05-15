#!/usr/bin/env node
/**
 * Calibration Run 1 — first-stage Top-K sweep, per-stratum recall@K.
 *
 * Spec: docs/CORETEX_SUBSTRATE_EXPANSION_HARDENING.md §5 Run 1.
 *
 * Picks the launch-pinned `firstStageTopK` for the v2-lens scorer by
 * measuring per-stratum recall@K of `firstStageCandidates` against the
 * eval_hidden split's truth-doc qrels.
 *
 * Selection rule (per the hardening doc):
 *   Pick the smallest K where the WORST stratum (population ≥ 100)
 *   has recall@K ≥ 0.90. The global average follows for free.
 *
 * Strata: query.family × {causalDepth, relationHopDepth} bins. For the
 * launch corpus these depth annotations aren't yet populated, so the
 * stratification collapses to query.family for now — when Phase B
 * adds depth annotations, the same code path picks up the finer
 * stratification automatically.
 *
 * Sampling: with 101k eval_hidden events and ~570ms per query at
 * launch scale, the full sweep would take ~16h. We stratified-sample
 * 250 queries per family by default (~1000 queries total → ~10 min)
 * which gives ±3% CI on per-family recall — tight enough for K
 * selection.
 *
 * Usage:
 *   node --max-old-space-size=16384 \
 *     scripts/calibrate-first-stage-topk.mjs \
 *     --corpus /var/lib/coretex/corpus-epoch-0-launch-MERGED.json \
 *     --bundle-profile /etc/coretex/bundle-profile.json \
 *     --queries-per-family 250 \
 *     --k-sweep 50,100,200,400,800,1600,3200 \
 *     --target-recall 0.90 \
 *     --out /var/lib/coretex/reports/first-stage-topk-sweep.json
 *
 * Exit codes:
 *   0 = sweep completed; report written
 *   1 = setup error
 *   2 = no K in the sweep meets the worst-stratum recall target
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { argv, exit } from 'node:process';
import { createHash } from 'node:crypto';

function flag(name, fb) {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  return fb;
}

const corpusPath = flag('corpus');
const profilePath = flag('bundle-profile');
const queriesPerFamily = Number(flag('queries-per-family', '250'));
const kSweepArg = flag('k-sweep', '50,100,200,400,800,1600,3200');
const targetRecall = Number(flag('target-recall', '0.90'));
const minStratumPopulation = Number(flag('min-stratum-population', '100'));
const reportPath = flag('out', '/var/lib/coretex/reports/first-stage-topk-sweep.json');
const seedHex = flag('seed', '0x' + '00'.repeat(32));

function fail(msg, code = 1) {
  console.error(`[calibrate-first-stage-topk] ${msg}`);
  exit(code);
}

if (!corpusPath || !existsSync(corpusPath)) fail(`--corpus missing or not found: ${corpusPath}`);
const kSweep = kSweepArg.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
if (kSweep.length === 0) fail('--k-sweep must contain at least one positive integer');

const {
  loadProductionCorpus,
  buildPublicCorpusIndex,
  firstStageCandidates,
} = await import('/root/cortex/packages/cortex/dist/index.js');

console.log(`[calibrate-first-stage-topk] loading corpus ${corpusPath}`);
const t0 = Date.now();
const corpus = loadProductionCorpus(corpusPath, { verifyCorpusRoot: false, verifySplits: false });
console.log(`  loaded ${corpus.events.length} events in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

console.log(`[calibrate-first-stage-topk] building PublicCorpusIndex`);
const tIdx = Date.now();
const index = buildPublicCorpusIndex(corpus);
console.log(`  indexed ${index.docs.length} unique docs in ${((Date.now() - tIdx) / 1000).toFixed(1)} s; indexHash=${index.indexHash}`);

// Stratified-sample eval_hidden split, by family.
const evalHidden = corpus.events.filter((e) => e.split === 'eval_hidden');
console.log(`[calibrate-first-stage-topk] eval_hidden population: ${evalHidden.length}`);

// Deterministic stratified sample: keccak256(seed || event.id) -> uniform float.
function hashScore(id) {
  const h = createHash('sha256').update(seedHex + ':' + id).digest('hex');
  // take first 8 hex chars as uint32 → uniform fraction in [0,1)
  return parseInt(h.slice(0, 8), 16) / 0xffffffff;
}

const byFamily = new Map();
for (const e of evalHidden) {
  const fam = e.family;
  if (!byFamily.has(fam)) byFamily.set(fam, []);
  byFamily.get(fam).push(e);
}

const sample = [];
for (const [fam, events] of byFamily) {
  // sort by hashScore and take the first `queriesPerFamily`
  const scored = events.map((e) => ({ e, score: hashScore(e.id) }));
  scored.sort((a, b) => a.score - b.score);
  const pickN = Math.min(queriesPerFamily, scored.length);
  for (let i = 0; i < pickN; i++) sample.push(scored[i].e);
  console.log(`  family ${fam}: ${events.length} total → sampled ${pickN}`);
}

console.log(`[calibrate-first-stage-topk] sweeping K ∈ {${kSweep.join(', ')}} on ${sample.length} queries`);

const Kmax = kSweep[kSweep.length - 1];

// For each query, run firstStageCandidates(Kmax) once; recall@K for all
// smaller Ks comes from prefix slices of the same ranked list. This is
// O(N_queries × cosine_over_index) — single pass.
const layout = index.layout;
const { dim, headerBytes } = layout;

// Result accumulator: per (family, K) → { truthsRecalled, truthsTotal, queries }
const strata = new Map(); // key = family
for (const fam of byFamily.keys()) {
  strata.set(fam, {
    family: fam,
    population: byFamily.get(fam).length,
    sampleSize: 0,
    perK: kSweep.map((k) => ({ k, truthsRecalled: 0, truthsTotal: 0, queries: 0 })),
  });
}

let queryIdx = 0;
let lastLog = Date.now();
const queryDurations = [];
for (const query of sample) {
  queryIdx++;
  const bytes = query.embeddings.query;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const scale = dv.getFloat32(0, false);
  const offset = dv.getFloat32(4, false);
  const queryVec = new Float32Array(dim);
  for (let i = 0; i < dim; i++) {
    const b = bytes[headerBytes + i];
    const signed = b > 127 ? b - 256 : b;
    queryVec[i] = scale * signed + offset;
  }

  const qStart = Date.now();
  const topKmax = firstStageCandidates(queryVec, index, Kmax);
  queryDurations.push(Date.now() - qStart);

  const truthIds = new Set(query.truthDocuments.map((d) => d.id));
  // Compute recall@K for each K by prefix-scanning
  const stratum = strata.get(query.family);
  for (let i = 0; i < kSweep.length; i++) {
    const k = kSweep[i];
    const prefix = topKmax.slice(0, k);
    let recalled = 0;
    for (const d of prefix) if (truthIds.has(d.id)) recalled++;
    stratum.perK[i].truthsRecalled += recalled;
    stratum.perK[i].truthsTotal += truthIds.size;
    stratum.perK[i].queries += 1;
  }
  stratum.sampleSize += 1;

  if (Date.now() - lastLog > 30_000) {
    const avgMs = queryDurations.slice(-50).reduce((a, b) => a + b, 0) / Math.min(50, queryDurations.length);
    console.log(`  progress: ${queryIdx}/${sample.length} queries (~${avgMs.toFixed(0)} ms/query, ETA ${((sample.length - queryIdx) * avgMs / 1000 / 60).toFixed(1)} min)`);
    lastLog = Date.now();
  }
}

// Compute recall@K per family per K
const familyResults = [];
for (const [fam, stratum] of strata) {
  const perK = stratum.perK.map((row) => ({
    k: row.k,
    recall: row.truthsTotal > 0 ? row.truthsRecalled / row.truthsTotal : 0,
    truthsRecalled: row.truthsRecalled,
    truthsTotal: row.truthsTotal,
    queries: row.queries,
  }));
  familyResults.push({ family: fam, population: stratum.population, sampleSize: stratum.sampleSize, perK });
}

// Selection: smallest K where every stratum (pop ≥ min) has recall@K ≥ target.
const eligibleStrata = familyResults.filter((s) => s.population >= minStratumPopulation);
let pinnedK = null;
let worstStratumAtK = null;
for (const k of kSweep) {
  const recallByFamily = eligibleStrata.map((s) => ({
    family: s.family,
    recall: s.perK.find((r) => r.k === k).recall,
  }));
  const worst = recallByFamily.reduce((acc, x) => (x.recall < acc.recall ? x : acc), { family: '<none>', recall: 1.0 });
  if (worst.recall >= targetRecall) {
    pinnedK = k;
    worstStratumAtK = worst;
    break;
  }
}

const aggregate = kSweep.map((k) => {
  let totalRecalled = 0; let totalTruths = 0;
  for (const s of familyResults) {
    const row = s.perK.find((r) => r.k === k);
    totalRecalled += row.truthsRecalled;
    totalTruths += row.truthsTotal;
  }
  return { k, globalRecall: totalTruths > 0 ? totalRecalled / totalTruths : 0 };
});

const report = {
  schemaVersion: 'coretex.first-stage-topk-sweep.v1',
  generatedAt: new Date().toISOString(),
  inputs: {
    corpus: corpusPath,
    corpusRoot: corpus.corpusRoot,
    indexHash: index.indexHash,
    eventCount: corpus.events.length,
    uniqueDocCount: index.docs.length,
    bundleProfile: profilePath ?? null,
  },
  sampling: {
    seedHex,
    queriesPerFamily,
    totalQueries: sample.length,
    minStratumPopulation,
  },
  sweep: kSweep,
  perStratum: familyResults,
  aggregate,
  selection: {
    rule: `smallest K where every stratum (population >= ${minStratumPopulation}) has recall@K >= ${targetRecall}`,
    pinnedK,
    worstStratumAtPinnedK: worstStratumAtK,
    failure: pinnedK === null ? `no K in sweep met the target — expand --k-sweep beyond ${Kmax} or accept a lower --target-recall` : null,
  },
  perQueryLatencyMs: {
    p50: queryDurations.length > 0 ? queryDurations.slice().sort((a, b) => a - b)[Math.floor(queryDurations.length / 2)] : null,
    p95: queryDurations.length > 0 ? queryDurations.slice().sort((a, b) => a - b)[Math.floor(queryDurations.length * 0.95)] : null,
    p99: queryDurations.length > 0 ? queryDurations.slice().sort((a, b) => a - b)[Math.floor(queryDurations.length * 0.99)] : null,
  },
};

mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(`[calibrate-first-stage-topk] report → ${reportPath}`);

if (pinnedK !== null) {
  console.log(`[calibrate-first-stage-topk] PIN: firstStageTopK = ${pinnedK} (worst stratum: ${worstStratumAtK.family} @ ${(worstStratumAtK.recall * 100).toFixed(1)}% recall)`);
  exit(0);
} else {
  console.error(`[calibrate-first-stage-topk] FAIL: no K in sweep met target recall ${targetRecall} on worst stratum`);
  exit(2);
}
