#!/usr/bin/env node
/**
 * Corpus-evolve semantic audit (Task B of the runway verdict).
 *
 * Replays the deterministic evolveCorpusDelta for N epochs on the v15 logical corpus
 * and classifies every added doc / query / relation so we can answer:
 *   - are live deltas anchored on EXISTING subjects (real memory evolution)?
 *   - do added docs supersede / conflict-with / extend prior memories?
 *   - do added queries require temporal-update / conflict-resolution / relation-routing /
 *     abstention reasoning (memory operations), or are they isolated new tasks?
 *   - do frontier activations correspond to evolved docs, or unrelated reserve drains?
 *   - are qrels coherent (direct/stale/conflict roles structurally aligned)?
 *
 * Method:
 *   - load v15 logical corpus from --corpus
 *   - call evolveCorpusDelta(epoch=1..N, seed=coretex-launch-frontier, churn=0.05)
 *     repeatedly, applying each delta to currentLogical
 *   - per epoch, sample addedDocs / addedQueries / addedRelations
 *   - classify each item by the eight bins listed in the prompt and emit:
 *     before/after corpus snippets, subject overlap, qrels schema
 *
 * Output: --out audit.json + a stdout summary table.
 *
 * Usage:
 *   node scripts/corpus-evolve-semantic-audit.mjs \
 *     --corpus release/calibration/2026-05-21-memory-corpus-v2/dgen1-r5-synth-300k-v15-corpus.json \
 *     --epochs 8 --seed coretex-launch-frontier --churn 0.05 \
 *     --out release/calibration/2026-05-21-memory-corpus-v2/corpus-evolve-semantic-audit-2d953b71.json
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import process from 'node:process';
import { repoRoot } from './_repo-root.mjs';
import { evolveCorpusDelta } from './lib/evolve-corpus.mjs';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const CORPUS_PATH = flag('corpus', 'release/calibration/2026-05-21-memory-corpus-v2/dgen1-r5-synth-300k-v15-corpus.json');
const EPOCHS = Number(flag('epochs', '8'));
const SEED = flag('seed', 'coretex-launch-frontier');
const CHURN = Number(flag('churn', '0.05'));
const OUT = flag('out', 'release/calibration/2026-05-21-memory-corpus-v2/corpus-evolve-semantic-audit-2d953b71.json');
const SAMPLE = Number(flag('sample-per-epoch', '6'));

console.log(`[evolve-audit] corpus=${CORPUS_PATH} epochs=${EPOCHS} seed=${SEED} churn=${CHURN}`);
const corpusPathAbs = resolve(repoRoot, CORPUS_PATH);
const raw = JSON.parse(readFileSync(corpusPathAbs, 'utf8'));
console.log(`[evolve-audit] loaded ${raw.docs.length} docs, ${raw.queries.length} queries, ${raw.relations.length} relations, ${raw.entities.length} entities`);

// Indices over the base corpus.
const baseDocsById = new Map(raw.docs.map((d) => [d.id, d]));
const baseQueriesById = new Map(raw.queries.map((q) => [q.id, q]));
const baseEntitiesById = new Map(raw.entities.map((e) => [e.id, e]));
const subjectsSet = new Set(raw.entities.filter((e) => e.id !== 'e_universe' && /_s\d+$/.test(e.id)).map((e) => e.id));
// Prior-temporal map: per subject, the most recent temporal doc seen on it (the one a new
// epoch's temporal patch would SUPERSEDE).
function buildPriorTemporal(docs) {
  const m = new Map();
  for (const d of docs) {
    const sid = (d.entityIds || []).find((x) => x !== 'e_universe');
    if (sid && /temporal/.test(d.kind || '')) m.set(sid, d.id);
  }
  return m;
}

const FAMILY_BUCKETS = {
  temporal_update:    'temporal_supersession',
  conflict_lifecycle: 'conflict_update',
  multi_session_bridge: 'multi_session_bridge',
  causal_memory_chain:  'decision_or_causal_extension',
  decision_provenance:  'decision_or_causal_extension',
  abstention_missing:   'abstention',
};

function classifyAdded(doc, query, relations, currentDocsById, priorTemporalBefore) {
  // Doc-level classification, returning a label + diagnostic.
  if (!doc || !doc.id || !doc.kind) return { label: 'malformed', reason: 'missing doc id or kind' };
  const sid = (doc.entityIds || []).find((x) => x !== 'e_universe');
  if (!sid) return { label: 'malformed', reason: 'doc has no non-universe subject' };
  if (!subjectsSet.has(sid)) return { label: 'unrelated_new', reason: `subject ${sid} not in base corpus` };
  const priorDoc = priorTemporalBefore.get(sid);
  const hasSupersedes = relations.some((r) => r.src === doc.id && r.type === 'supersedes');
  const hasContradicts = relations.some((r) => (r.src === doc.id || r.dst === doc.id) && (r.label === 'contradicts' || r.type === 'co_occurs_with'));
  if (/temporal/.test(doc.kind)) {
    // Attribute-shape match: temporal_${attr} → the prior doc's kind should mention the same attr
    // (or be a generic 'temporal_*' from the base corpus we treat as compatible).
    const newAttr = (doc.kind.match(/^temporal_(.+)$/) || [])[1] ?? null;
    let attrMismatch = false;
    let priorAttr = null;
    if (priorDoc && newAttr) {
      const prior = currentDocsById.get(priorDoc);
      if (prior) {
        priorAttr = (prior.kind.match(/^temporal_(.+)$/) || [])[1] ?? prior.kind;
        // Heuristic: if priorAttr is a generic temporal kind (e.g. 'temporal_fact', or contains the same word),
        // it's compatible. Otherwise the supersession changes attribute → stale qrel will be incoherent.
        const compat = priorAttr === newAttr
          || /temporal_(fact|record|update)/.test(prior.kind ?? '')
          || (prior.text ?? '').toLowerCase().includes(newAttr);
        if (!compat) attrMismatch = true;
      }
    }
    if (priorDoc && hasSupersedes) {
      return { label: attrMismatch ? 'temporal_attribute_mismatch' : 'temporal_supersession', reason: attrMismatch ? `supersedes prior ${priorDoc}, but attribute changed from ${priorAttr ?? 'unknown'} → ${newAttr}` : `supersedes prior ${priorDoc} (same/compatible attribute)`, priorDocId: priorDoc, newAttr, priorAttr };
    }
    if (!priorDoc) return { label: 'temporal_supersession', reason: 'subject has no prior temporal doc yet (cold start)', priorDocId: null };
    return { label: 'temporal_supersession', reason: 'no supersedes relation emitted', priorDocId: priorDoc };
  }
  if (/conflict/.test(doc.kind) || doc.lifecycleState) {
    if (hasContradicts) return { label: 'conflict_update', reason: 'paired with contradicts edge', priorDocId: null, lifecycleState: doc.lifecycleState ?? null };
    return { label: 'conflict_update', reason: 'lifecycle_conflict shape but no contradicts edge', priorDocId: null, lifecycleState: doc.lifecycleState ?? null };
  }
  return { label: 'unrelated_new', reason: `doc kind ${doc.kind} not temporal or conflict`, priorDocId: null };
}

function classifyQuery(query, addedDocsThisEpoch, currentDocsById) {
  if (!query || !query.family) return { label: 'malformed', reason: 'missing query family' };
  const bucket = FAMILY_BUCKETS[query.family];
  if (!bucket) return { label: 'unrelated_new', reason: `family ${query.family} not in evolution buckets` };
  // qrel coherence: temporal_update should have direct + stale; conflict_lifecycle should have direct + conflict.
  const qrels = query.qrels ?? [];
  const roles = new Set(qrels.map((r) => r.role));
  const subjectInBase = subjectsSet.has(query.subjectEntityId);
  if (query.family === 'temporal_update') {
    const ok = roles.has('direct') && (qrels.length === 1 || roles.has('stale'));
    return { label: bucket, qrelCoherent: ok, roles: [...roles], subjectInBase };
  }
  if (query.family === 'conflict_lifecycle') {
    const ok = roles.has('direct') && roles.has('conflict');
    return { label: bucket, qrelCoherent: ok, roles: [...roles], subjectInBase };
  }
  return { label: bucket, qrelCoherent: true, roles: [...roles], subjectInBase };
}

// Replay (single docsById index updated incrementally; no per-doc O(N) rebuilds).
let currentDocs = raw.docs.slice();
let currentRelations = raw.relations.slice();
let currentQueries = raw.queries.slice();
let priorTemporal = buildPriorTemporal(currentDocs);
const docsById = new Map(currentDocs.map((d) => [d.id, d]));

const epochsOut = [];
const cumulativeAddedSubjects = new Set();
for (let epoch = 1; epoch <= EPOCHS; epoch++) {
  const delta = evolveCorpusDelta({ baseLogical: { entities: raw.entities, docs: currentDocs }, epoch, seed: SEED, churnFraction: CHURN });
  // Classify every doc and query (docsById reused across iterations).
  const docClasses = delta.addedDocs.map((d) => {
    const cls = classifyAdded(d, null, delta.addedRelations, docsById, priorTemporal);
    return { docId: d.id, kind: d.kind, subject: (d.entityIds || []).find((x) => x !== 'e_universe'), text: d.text, lifecycleState: d.lifecycleState ?? null, timestamp: d.timestamp ?? null, classification: cls };
  });
  const queryClasses = delta.addedQueries.map((q) => ({
    queryId: q.id, family: q.family, subjectEntityId: q.subjectEntityId, queryText: q.queryText, qrels: q.qrels, classification: classifyQuery(q, delta.addedDocs, docsById),
  }));
  // Aggregate stats.
  const docBuckets = {};
  for (const dc of docClasses) docBuckets[dc.classification.label] = (docBuckets[dc.classification.label] ?? 0) + 1;
  const queryBuckets = {};
  for (const qc of queryClasses) queryBuckets[qc.classification.label] = (queryBuckets[qc.classification.label] ?? 0) + 1;
  // Subject overlap with base corpus.
  const churnedSubjects = new Set(delta.churnedSubjects);
  const subjectsAlreadyChurnedBefore = [...churnedSubjects].filter((s) => cumulativeAddedSubjects.has(s)).length;
  for (const s of churnedSubjects) cumulativeAddedSubjects.add(s);
  const subjectsInBase = [...churnedSubjects].filter((s) => subjectsSet.has(s)).length;
  // qrel coherence stats.
  const qrelCoherent = queryClasses.filter((q) => q.classification.qrelCoherent).length;
  const qrelTotal = queryClasses.length;
  // Sample for the audit report.
  const sample = {
    docSamples: docClasses.slice(0, SAMPLE).map((dc) => {
      const beforeDocId = dc.classification.priorDocId ?? null;
      const beforeDoc = beforeDocId ? docsById.get(beforeDocId) : null;
      return {
        docId: dc.docId, kind: dc.kind, subject: dc.subject, text: dc.text,
        timestamp: dc.timestamp, lifecycleState: dc.lifecycleState,
        beforeDocId, beforeText: beforeDoc ? beforeDoc.text : null,
        classification: dc.classification,
      };
    }),
    querySamples: queryClasses.slice(0, SAMPLE).map((qc) => ({ queryId: qc.queryId, family: qc.family, subjectEntityId: qc.subjectEntityId, queryText: qc.queryText, qrels: qc.qrels, classification: qc.classification })),
  };
  epochsOut.push({
    epoch, churnFraction: CHURN, liveChurnRate: delta.liveChurnRate,
    addedDocs: delta.addedDocs.length, addedQueries: delta.addedQueries.length, addedRelations: delta.addedRelations.length,
    churnedSubjects: churnedSubjects.size, subjectsAlreadyChurnedBefore, subjectsInBase,
    docBuckets, queryBuckets, qrelCoherent, qrelTotal,
    sample,
  });
  console.log(`[evolve-audit] epoch ${epoch}: +${delta.addedDocs.length}docs +${delta.addedQueries.length}queries +${delta.addedRelations.length}rels, doc=${JSON.stringify(docBuckets)} query=${JSON.stringify(queryBuckets)} qrelCoherent=${qrelCoherent}/${qrelTotal} subjectsInBase=${subjectsInBase}/${churnedSubjects.size}`);
  // Apply delta for next epoch (in-place push + incremental priorTemporal update — avoid O(N) rebuild).
  for (const d of delta.addedDocs) {
    currentDocs.push(d);
    docsById.set(d.id, d);
    const sid = (d.entityIds || []).find((x) => x !== 'e_universe');
    if (sid && /temporal/.test(d.kind || '')) priorTemporal.set(sid, d.id);
  }
  for (const r of delta.addedRelations) currentRelations.push(r);
  for (const q of delta.addedQueries) currentQueries.push(q);
}

// Cross-epoch aggregates.
const allDocBuckets = {};
const allQueryBuckets = {};
for (const ep of epochsOut) {
  for (const [k, v] of Object.entries(ep.docBuckets)) allDocBuckets[k] = (allDocBuckets[k] ?? 0) + v;
  for (const [k, v] of Object.entries(ep.queryBuckets)) allQueryBuckets[k] = (allQueryBuckets[k] ?? 0) + v;
}
const totalAddedDocs = epochsOut.reduce((s, e) => s + e.addedDocs, 0);
const totalAddedQueries = epochsOut.reduce((s, e) => s + e.addedQueries, 0);
const totalQrelCoherent = epochsOut.reduce((s, e) => s + e.qrelCoherent, 0);
const totalQueriesClassified = epochsOut.reduce((s, e) => s + e.qrelTotal, 0);

const report = {
  schema: 'coretex.corpus-evolve-semantic-audit.v1',
  corpus: CORPUS_PATH,
  epochs: EPOCHS, seed: SEED, churnFraction: CHURN,
  totalAddedDocs, totalAddedQueries, totalQrelCoherent, totalQueriesClassified,
  qrelCoherenceRate: totalQueriesClassified ? totalQrelCoherent / totalQueriesClassified : 0,
  allDocBuckets, allQueryBuckets,
  notes: [
    'Reproduces evolveCorpusDelta deterministically (same seed) so this audit can be replayed.',
    'Classification bins follow the task spec: temporal_supersession, conflict_update, decision_or_causal_extension, multi_session_bridge, abstention, unrelated_new, malformed.',
    'qrelCoherent: temporal_update requires direct (+ optional stale); conflict_lifecycle requires direct + conflict.',
    'subjectsInBase: how many of the churned subjects exist in the original v15 corpus (= ALL by construction).',
  ],
  epochs_detail: epochsOut,
};

const outAbs = resolve(repoRoot, OUT);
mkdirSync(dirname(outAbs), { recursive: true });
writeFileSync(outAbs, JSON.stringify(report, null, 2));
console.log(`\n[evolve-audit] wrote ${outAbs}`);
console.log(`[evolve-audit] aggregate doc buckets: ${JSON.stringify(allDocBuckets)}`);
console.log(`[evolve-audit] aggregate query buckets: ${JSON.stringify(allQueryBuckets)}`);
console.log(`[evolve-audit] qrel coherence: ${totalQrelCoherent}/${totalQueriesClassified} = ${(totalQrelCoherent/Math.max(1,totalQueriesClassified)*100).toFixed(1)}%`);
