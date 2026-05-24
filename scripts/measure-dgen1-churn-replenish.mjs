#!/usr/bin/env node
/**
 * Measure the rate-matching model's two unknowns — REPLENISHMENT (new minable
 * temporal pairs per corpus-growth step) and CHURN (supersession density) — from
 * the EXISTING staged DGEN-1 realism scale curve (G1≈8k smoke → G2≈100k → G3≈300k).
 *
 * Replaces the swept assumptions in RUNWAY_RATEMATCH_FINDINGS.md with measured
 * structural values, then prints the per-epoch params to re-run the runway model.
 *
 * Mineable temporal pair = one `temporal_update` chain (1 current `currentStaleFlag`
 * doc + N stale priors via `supersedes` edges; the endurance harness mines one
 * temporal record per chain). eval_hidden chains are what the hidden eval actually
 * presents. Chain DEPTH (qrels length = 1 current + stales = nRev) is the
 * supersession density: a depth-D fact accumulated D−1 supersession events over its
 * life → churn maps to (D−1)/lifetimeEpochs under a stated revision cadence.
 *
 * Memory: processes one corpus at a time (peak = one parsed corpus). For G3 (113MB)
 * run with: node --max-old-space-size=4096 scripts/measure-dgen1-churn-replenish.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const base = 'release/calibration/2026-05-21-memory-corpus-v2';
// The realism scale curve = the staged growth snapshots (G1→G2→G3).
const STAGES = [
  { name: 'G1', label: '~8k smoke', file: `${base}/dgen1-realism-smoke-corpus.json` },
  { name: 'G2', label: '~100k',     file: `${base}/dgen1-realism-g2-corpus.json` },
  { name: 'G3', label: '~300k',     file: `${base}/dgen1-realism-corpus.json` },
];

function pctiles(arr) {
  if (!arr.length) return { n: 0 };
  const s = [...arr].sort((a, b) => a - b);
  const at = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, min: s[0], p50: at(0.5), mean: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(3), p90: at(0.9), max: s[s.length - 1] };
}

function measure(stage) {
  const c = JSON.parse(readFileSync(resolve(repoRoot, stage.file), 'utf8'));
  const docs = c.docs || [];
  const queries = c.queries || [];
  // subject map: docId -> in-universe subject tag (entityIds[1]); current docs flagged.
  const docSubject = new Map();
  let currentDocs = 0;
  for (const d of docs) {
    const subj = Array.isArray(d.entityIds) && d.entityIds.length > 1 ? d.entityIds[1] : (d.entityIds?.[0] ?? 'unk');
    docSubject.set(d.id, subj);
    if (d.currentStaleFlag) currentDocs++;
  }
  const supersedes = (c.relations || []).filter((r) => (r.type || r.relationType) === 'supersedes').length;

  // temporal_update chains (mineable pairs).
  const tq = queries.filter((q) => q.family === 'temporal_update');
  const depthsAll = [], depthsEval = [];
  const splitCount = {}, evalBand = {};
  const subjUpdatesEval = new Map();
  for (const q of tq) {
    const depth = (q.qrels || []).length; // 1 direct + stales = nRev
    depthsAll.push(depth);
    splitCount[q.split] = (splitCount[q.split] ?? 0) + 1;
    if (q.split === 'eval_hidden') {
      depthsEval.push(depth);
      evalBand[q.band] = (evalBand[q.band] ?? 0) + 1;
      const direct = (q.qrels || []).find((r) => r.role === 'direct');
      const subj = direct ? (docSubject.get(direct.docId) ?? 'unk') : 'unk';
      subjUpdatesEval.set(subj, (subjUpdatesEval.get(subj) ?? 0) + 1);
    }
  }
  const evalChains = depthsEval.length;
  // total stale-transition pairs (sum nRev-1) ≈ supersedes edges.
  const totalTransitionPairs = depthsAll.reduce((a, d) => a + (d - 1), 0);
  const evalTransitionPairs = depthsEval.reduce((a, d) => a + (d - 1), 0);
  return {
    stage: stage.name, label: stage.label,
    nDocs: docs.length, nQueries: queries.length, nEntities: (c.entities || []).length,
    currentDocs, supersedesEdges: supersedes,
    temporalChains: tq.length, temporalSplit: splitCount,
    evalHiddenChains: evalChains,
    depthAll: pctiles(depthsAll), depthEval: pctiles(depthsEval),
    totalTransitionPairs, evalTransitionPairs,
    evalBandHistogram: evalBand,
    distinctSubjectsWithEvalUpdates: subjUpdatesEval.size,
    evalUpdatesPerSubject: pctiles([...subjUpdatesEval.values()]),
  };
}

const stages = STAGES.map(measure);

// ── Growth-step deltas (G1→G2, G2→G3) ──
function delta(a, b) {
  return {
    from: a.stage, to: b.stage,
    dDocs: b.nDocs - a.nDocs,
    dTemporalChains: b.temporalChains - a.temporalChains,
    dEvalHiddenChains: b.evalHiddenChains - a.evalHiddenChains,
    dSupersedesEdges: b.supersedesEdges - a.supersedesEdges,
    dEvalTransitionPairs: b.evalTransitionPairs - a.evalTransitionPairs,
    dSubjectsWithEvalUpdates: b.distinctSubjectsWithEvalUpdates - a.distinctSubjectsWithEvalUpdates,
    // new minable eval pairs per 10k docs of growth (scale-normalized replenishment density):
    evalChainsPer10kDocs: +(1e4 * (b.evalHiddenChains - a.evalHiddenChains) / (b.nDocs - a.nDocs)).toFixed(3),
  };
}
const deltas = [delta(stages[0], stages[1]), delta(stages[1], stages[2])];

// ── Map to model params under explicit launch corpus-update CADENCE assumptions ──
// A "growth step" delivers dEvalHiddenChains new minable pairs. Spread over `epochsPerGrowthStep`
// epochs (the launch corpus-update cadence) gives per-epoch replenishment. Churn per epoch =
// (meanDepth-1) supersession events per fact amortized over the fact's lifetime in epochs;
// equivalently, the fraction of the working set that gets a new revision per epoch.
const G3 = stages[2];
const meanDepth = G3.depthEval.mean ?? G3.depthAll.mean;
const lastDelta = deltas[deltas.length - 1];
const cadences = [10, 50, 100, 365]; // epochs per growth-step (G2→G3 delta delivered over this many epochs)
const SUBSTRATE_CAP = 96;
const derived = cadences.map((epochsPerStep) => {
  const replenishPerEpoch = +(lastDelta.dEvalHiddenChains / epochsPerStep).toFixed(4);
  // churn: each fact of depth D contributes D-1 supersessions; if the corpus reaches G3 depth over
  // the same growth step, supersession events in eval set = dEvalTransitionPairs, amortized over the
  // step's epochs and the held working set. Express as fraction of cap superseded/epoch:
  const supersessionsPerEpoch = +(lastDelta.dEvalTransitionPairs / epochsPerStep).toFixed(4);
  const churnPerEpoch = +(Math.min(1, supersessionsPerEpoch / SUBSTRATE_CAP)).toFixed(4);
  return { epochsPerGrowthStep: epochsPerStep, replenishPerEpoch, supersessionsPerEpoch, impliedChurnRate: churnPerEpoch };
});

const summary = {
  generatedAt: new Date().toISOString(),
  source: 'DGEN-1 realism scale curve (G1 smoke / G2 100k / G3 300k) — existing artifacts',
  note: 'Mineable temporal pair = one temporal_update chain (one mined temporal record). Chain depth = qrels length = nRev (1 current + stales). Churn density = supersession edges. Per-epoch params depend on the launch corpus-update CADENCE (swept).',
  stages, deltas,
  meanEvalChainDepthG3: meanDepth,
  derivedModelParams: { substrateCap: SUBSTRATE_CAP, byCadence: derived },
};
const outPath = resolve(repoRoot, `${base}/dgen1-churn-replenish.json`);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(summary, null, 2));

// ── Report ──
const pad = (s, n) => String(s).padEnd(n), padN = (s, n) => String(s).padStart(n);
console.log('\n=== DGEN-1 churn / replenishment measurement (G1→G2→G3) ===\n');
console.log(`${pad('stage', 6)} ${pad('label', 10)} ${pad('docs', 9)} ${pad('tChains', 9)} ${pad('evalChains', 11)} ${pad('superEdges', 11)} ${pad('meanDepth', 10)} ${pad('subjects', 9)}`);
for (const s of stages) {
  console.log(`${pad(s.stage, 6)} ${pad(s.label, 10)} ${padN(s.nDocs, 9)} ${padN(s.temporalChains, 9)} ${padN(s.evalHiddenChains, 11)} ${padN(s.supersedesEdges, 11)} ${padN(s.depthEval.mean ?? '—', 10)} ${padN(s.distinctSubjectsWithEvalUpdates, 9)}`);
}
console.log('\n--- growth-step deltas ---');
for (const d of deltas) {
  console.log(`${d.from}→${d.to}: +${d.dDocs} docs, +${d.dTemporalChains} chains (+${d.dEvalHiddenChains} eval), +${d.dSupersedesEdges} supersedes, +${d.dEvalTransitionPairs} eval-transition-pairs, +${d.dSubjectsWithEvalUpdates} subjects | ${d.evalChainsPer10kDocs} eval-chains/10k-docs`);
}
console.log(`\nmean eval chain depth (G3): ${meanDepth} revisions/fact → ${(meanDepth - 1).toFixed(2)} supersession events/fact over its life`);
console.log('\n--- derived per-epoch model params (G2→G3 delta over cadence; cap=96) ---');
console.log(`${pad('epochs/step', 12)} ${pad('replenish/ep', 13)} ${pad('superseds/ep', 13)} ${pad('impliedChurn', 13)}`);
for (const d of derived) {
  console.log(`${padN(d.epochsPerGrowthStep, 12)} ${padN(d.replenishPerEpoch, 13)} ${padN(d.supersessionsPerEpoch, 13)} ${padN(d.impliedChurnRate, 13)}`);
}
console.log(`\nartifact: ${base}/dgen1-churn-replenish.json`);
console.log('Next: re-run the runway model at the measured operating points, e.g.:');
for (const d of derived) console.log(`  node scripts/simulate-v2-runway-ratematch.mjs --replenish ${d.replenishPerEpoch} --churn ${d.impliedChurnRate} --miners 10,50,100 --out ${base}/runway-ratematch-measured-cad${d.epochsPerGrowthStep}.json`);
