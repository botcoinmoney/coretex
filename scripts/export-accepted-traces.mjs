#!/usr/bin/env node
// Export accepted temporal traces -> (Q, D+, D-) triples for the reranker shadow-epoch probe.
//
// See release/calibration/2026-05-21-memory-corpus-v2/RERANKER_SHADOW_EPOCH_DESIGN.md.
// The endurance checkpoint stores `minedTemporalDocs` (the accepted *current*-doc ids = the
// positive class) but NOT triples. The corpus supplies the rest: each temporal_update query
// carries qrels with role="direct" (relevance 1 = D+) and role="stale" (relevance 0.2 = D-).
// A trace = a temporal_update query whose direct doc was mined/accepted by the substrate.
//
// Strict split (P1.5 quarantine): triples are ordered by mining order (minedTemporalDocs index,
// which is epoch order) and partitioned train|eval so eval pairs are mined in LATER epochs that
// the E1 candidate never trains on. We assert zero positive/negative/query overlap across splits.
//
// Usage: node scripts/export-accepted-traces.mjs --corpus <corpus.json> --ckpt <ckpt.json> \
//          --out <triples.json> [--train-frac 0.66]
import fs from 'node:fs';

function parseArgs() {
  const a = { trainFrac: 0.66 };
  const v = process.argv.slice(2);
  for (let i = 0; i < v.length; i++) {
    if (v[i] === '--corpus') a.corpus = v[++i];
    else if (v[i] === '--ckpt') a.ckpt = v[++i];
    else if (v[i] === '--out') a.out = v[++i];
    else if (v[i] === '--train-frac') a.trainFrac = parseFloat(v[++i]);
  }
  if (!a.corpus || !a.ckpt || !a.out) {
    console.error('required: --corpus --ckpt --out');
    process.exit(2);
  }
  return a;
}

function shannonEntropy(counts) {
  const total = Object.values(counts).reduce((s, n) => s + n, 0);
  if (!total) return 0;
  let h = 0;
  for (const n of Object.values(counts)) {
    if (!n) continue;
    const p = n / total;
    h -= p * Math.log2(p);
  }
  return h;
}

const args = parseArgs();
const corpus = JSON.parse(fs.readFileSync(args.corpus, 'utf8'));
const ckpt = JSON.parse(fs.readFileSync(args.ckpt, 'utf8'));

const docById = new Map(corpus.docs.map((d) => [d.id, d]));
const minedOrder = new Map((ckpt.minedTemporalDocs || []).map((id, i) => [id, i]));
const minedSet = new Set(ckpt.minedTemporalDocs || []);

// Build a trace for every temporal_update query whose direct (relevance-1) doc was mined.
const triples = [];
const familyCounts = {};
let queriesScanned = 0;
let minedDirectHits = 0;
let missingDocText = 0;
let noStale = 0;
for (const q of corpus.queries) {
  if (q.family !== 'temporal_update') continue;
  queriesScanned++;
  const direct = (q.qrels || []).find((r) => r.role === 'direct' && r.relevance >= 1);
  if (!direct || !minedSet.has(direct.docId)) continue;
  minedDirectHits++;
  const staleIds = (q.qrels || []).filter((r) => r.role === 'stale').map((r) => r.docId);
  if (!staleIds.length) { noStale++; continue; }
  const dPlus = docById.get(direct.docId);
  // Hardest negative = the stale doc with the most recent timestamp (closest to "current").
  const staleDocs = staleIds.map((id) => docById.get(id)).filter(Boolean);
  if (!dPlus || !staleDocs.length) { missingDocText++; continue; }
  staleDocs.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
  const dMinus = staleDocs[0];
  familyCounts[q.family] = (familyCounts[q.family] || 0) + 1;
  triples.push({
    qid: q.id,
    query: q.queryText,
    family: q.family,
    band: q.band,
    posId: dPlus.id,
    posText: dPlus.text,
    posTimestamp: dPlus.timestamp,
    negId: dMinus.id,
    negText: dMinus.text,
    negTimestamp: dMinus.timestamp,
    allStaleIds: staleIds,
    minedIndex: minedOrder.has(dPlus.id) ? minedOrder.get(dPlus.id) : 1e9,
  });
}

// Order by mining order (epoch order) and split train|eval.
triples.sort((a, b) => a.minedIndex - b.minedIndex);
const nTrain = Math.max(1, Math.floor(triples.length * args.trainFrac));
triples.forEach((t, i) => { t.split = i < nTrain ? 'train' : 'eval'; });

// Strict-quarantine assertions: no positive / negative / query shared across splits.
const trainPos = new Set(), trainNeg = new Set(), trainQ = new Set();
for (const t of triples) if (t.split === 'train') { trainPos.add(t.posId); t.allStaleIds.forEach((s) => trainNeg.add(s)); trainQ.add(t.qid); }
const leaks = triples.filter((t) => t.split === 'eval' && (trainPos.has(t.posId) || trainQ.has(t.qid) || t.allStaleIds.some((s) => trainNeg.has(s))));
if (leaks.length) {
  console.error(`QUARANTINE FAIL: ${leaks.length} eval triples overlap train (pos/neg/query). Aborting.`);
  process.exit(1);
}

const out = {
  meta: {
    generatedAt: new Date().toISOString(),
    corpus: args.corpus,
    ckpt: args.ckpt,
    minedTemporalDocs: minedSet.size,
    temporalQueriesScanned: queriesScanned,
    minedDirectHits,
    triples: triples.length,
    coverage: minedSet.size ? +(minedDirectHits / minedSet.size).toFixed(3) : 0,
    droppedNoStale: noStale,
    droppedMissingText: missingDocText,
    nTrain,
    nEval: triples.length - nTrain,
    surfaceEntropyBits: +shannonEntropy(familyCounts).toFixed(4),
    familyCounts,
  },
  triples,
};
fs.writeFileSync(args.out, JSON.stringify(out, null, 1));
console.log(JSON.stringify(out.meta, null, 1));
console.log(`\nexported ${triples.length} triples -> ${args.out} (train ${nTrain} / eval ${triples.length - nTrain})`);
console.log(`surface_entropy = ${out.meta.surfaceEntropyBits} bits (families: ${JSON.stringify(familyCounts)})`);
if (triples.length) {
  const s = triples[0];
  console.log(`\nsample triple [${s.split}]:\n  Q : ${s.query}\n  D+: (${s.posTimestamp}) ${s.posText}\n  D-: (${s.negTimestamp}) ${s.negText}`);
}
