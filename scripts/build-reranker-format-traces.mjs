#!/usr/bin/env node
/**
 * Memory-IR reranker FORMAT-ablation trace builder (Phase-3 format discovery).
 *
 * Emits (Q, D+, D-) triples where posText/negText are the document rendered in one FORMAT, so the
 * SAME train_shadow_epoch.py run on each format file answers "which input format best converts the
 * substrate's Memory-IR fields into reranker lift". Built DIRECTLY from the corpus (no endurance
 * checkpoint) so it covers temporal AND relation families.
 *
 *   F0  raw doc text (control)
 *   F1  + timestamp prefix
 *   F2  + Memory-IR header (timestamp · lifecycle current/superseded · subject entity)
 *   F3  F2 + relation-edge context (typed edges out of the doc)
 *
 * Triple sources (public, no qrel leakage into the TEXT — qrels only pick D+/D-):
 *   temporal_update      : D+ = direct (rel 1, current), D- = most-recent stale (rel 0.2) — recency
 *   multi_session_bridge / decision_provenance / causal_memory_chain :
 *                          D+ = direct (rel 1), D- = a hard-negative (relation_neighbor/distractor) — routing
 *
 * Holdout: ENTITY-DISJOINT split (no subject entity shared train/eval) — detects vocab/entity memorization.
 * Control variant --shuffle-timestamps re-labels timestamps randomly (format must NOT keep its lift if the
 * recency field is shuffled → proves the reranker uses the field, not a surface artifact).
 *
 * Usage: node scripts/build-reranker-format-traces.mjs --format F2 [--shuffle-timestamps] --out <triples.json>
 */
import { readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const has = (n) => argv.includes(`--${n}`);
const base = 'release/calibration/2026-05-21-memory-corpus-v2';
const corpusPath = flag('corpus', `${base}/dgen1-r5-synth-corpus.json`);
const format = flag('format', 'F0');
const kindFilter = flag('kind', 'both');   // temporal | routing | both
const shuffleTs = has('shuffle-timestamps');
const shuffleLifecycle = has('shuffle-lifecycle');  // CONTROL: permute current/superseded → F2 MUST collapse (else leakage)
const noLifecycle = has('no-lifecycle');            // ABLATION: F2 header w/o the lifecycle field → should drop near F1
const holdout = flag('holdout', 'entity');          // entity (subject-disjoint) | value (answer-value-disjoint)
const trainFrac = parseFloat(flag('train-frac', '0.6'));
const out = flag('out', `${base}/reranker-fmt-${format}${shuffleTs ? '-tsshuf' : ''}.json`);
const seed = Number(flag('seed', '7'));

const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'));
const { docs, relations, entities, queries } = corpus;
const docById = new Map(docs.map((d) => [d.id, d]));
const GENERIC = new Set(['e_universe']);
const nonGeneric = (ids) => (ids ?? []).filter((e) => !GENERIC.has(e));

// lifecycle from supersedes structure: src of a supersedes edge = current head, dst = superseded.
const supSrc = new Set(), supDst = new Set();
for (const r of relations) if (r.type === 'supersedes') { supSrc.add(r.src); supDst.add(r.dst); }
const trueLifecycle = (id) => (supSrc.has(id) && !supDst.has(id)) ? 'current' : supDst.has(id) ? 'superseded' : 'none';
// CONTROL: shuffle-lifecycle permutes the lifecycle LABELS across docs (the label no longer matches the
// real current/superseded doc). If F2 keeps its lift under this, the reranker is NOT using the label →
// leakage. If F2 collapses to chance/worse, the label genuinely carries the signal (sidecar-aware).
let lifecycleMap = null;
if (shuffleLifecycle) {
  const ids = docs.map((d) => d.id);
  const labels = ids.map((id) => trueLifecycle(id));
  let s = (seed * 2246822519) >>> 0; const rnd = () => { s = (Math.imul(s ^ (s >>> 13), 0x45d9f3b) + 1) >>> 0; return s / 4294967296; };
  for (let i = labels.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [labels[i], labels[j]] = [labels[j], labels[i]]; }
  lifecycleMap = new Map(ids.map((id, i) => [id, labels[i]]));
}
const lifecycleOf = (id) => (lifecycleMap ? lifecycleMap.get(id) : trueLifecycle(id));
// typed edges out of a doc (F3): "type:label->dstEntity"
const edgesBySrc = new Map();
for (const r of relations) { if (!edgesBySrc.has(r.src)) edgesBySrc.set(r.src, []); edgesBySrc.get(r.src).push(r); }

// optional timestamp-shuffle control: permute timestamps across docs (breaks the real recency signal).
let tsOverride = null;
if (shuffleTs) {
  let s = (seed * 2654435761) >>> 0; const rnd = () => { s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 1) >>> 0; return s / 4294967296; };
  const tss = docs.map((d) => d.timestamp);
  for (let i = tss.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [tss[i], tss[j]] = [tss[j], tss[i]]; }
  tsOverride = new Map(docs.map((d, i) => [d.id, tss[i]]));
}
const tsOf = (d) => (tsOverride ? tsOverride.get(d.id) : d.timestamp);

const edgesOf = (d) => (edgesBySrc.get(d.id) ?? []).slice(0, 4).map((r) => `${r.type}:${r.label}->${(nonGeneric(docById.get(r.dst)?.entityIds) ?? [])[0] ?? r.dst}`);
const mirHeader = (d) => { const subj = nonGeneric(d.entityIds)[0] ?? '?'; return noLifecycle ? `[t=${tsOf(d)} | subject=${subj}]` : `[t=${tsOf(d)} | lifecycle=${lifecycleOf(d.id)} | subject=${subj}]`; };
// F4 listwise packet: the candidate SET's compact MIR headers (lifecycle/subject/edge), as context for
// every candidate, so the reranker scores each doc IN the list (QRRanker-style memory-aware reranking).
function render(d, packet) {
  const text = d.text;
  if (format === 'F0') return text;
  if (format === 'F1') return `[as of ${tsOf(d)}] ${text}`;
  const header = mirHeader(d);
  if (format === 'F2') return `${header} ${text}`;
  if (format === 'F3') { const e = edgesOf(d); return `${header}${e.length ? ' [edges: ' + e.join('; ') + ']' : ''} ${text}`; }
  if (format === 'F4') { const e = edgesOf(d); return `[candidates: ${packet ?? ''}] ${header}${e.length ? ' [edges: ' + e.join('; ') + ']' : ''} ${text}`; }
  return text;
}

const ROUTING = new Set(['multi_session_bridge', 'decision_provenance', 'causal_memory_chain']);
const triples = [];
for (const q of queries) {
  const direct = (q.qrels ?? []).find((r) => r.role === 'direct' && r.relevance >= 1);
  if (!direct) continue;
  const dPlus = docById.get(direct.docId); if (!dPlus) continue;
  let dMinus = null, kind = null;
  if (q.family === 'temporal_update') {
    const stale = (q.qrels ?? []).filter((r) => r.role === 'stale').map((r) => docById.get(r.docId)).filter(Boolean);
    if (!stale.length) continue;
    stale.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
    dMinus = stale[0]; kind = 'temporal';
  } else if (ROUTING.has(q.family)) {
    // hardest public negative: a hard-negative doc (relation_neighbor / distractor), else any non-gold qrel doc.
    const negId = (q.hardNegatives ?? [])[0]?.docId ?? (q.qrels ?? []).find((r) => r.role !== 'direct')?.docId;
    dMinus = negId ? docById.get(negId) : null; kind = 'routing';
  } else continue;
  if (!dMinus || dMinus.id === dPlus.id) continue;
  if (kindFilter !== 'both' && kind !== kindFilter) continue;
  // F4 listwise packet = compact MIR headers of the query's candidate set (qrel docs + a few hard-negs).
  let packet = '';
  if (format === 'F4') {
    const candIds = [...new Set([...(q.qrels ?? []).map((r) => r.docId), ...(q.hardNegatives ?? []).slice(0, 4).map((n) => n.docId)])];
    packet = candIds.map((id) => docById.get(id)).filter(Boolean).map((d) => `{lc=${lifecycleOf(d.id)};subj=${nonGeneric(d.entityIds)[0] ?? '?'}}`).join(' ');
  }
  const subj = nonGeneric(dPlus.entityIds)[0] ?? nonGeneric(q.entityIds ?? [])[0] ?? `q:${q.id}`;
  // value = the answer VALUE (last alphanumeric token of D+'s raw text, e.g. "maven", "Lisbon") for
  // value-disjoint holdout (detects memorizing the value rather than learning the lifecycle field).
  const valTok = (docById.get(dPlus.id)?.text ?? '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim().split(/\s+/).pop() ?? '?';
  triples.push({ qid: q.id, query: q.queryText, family: q.family, kind, subject: subj, value: valTok,
    posId: dPlus.id, posText: render(dPlus, packet), negId: dMinus.id, negText: render(dMinus, packet),
    allStaleIds: (q.qrels ?? []).filter((r) => r.role === 'stale').map((r) => r.docId) });
}

// HOLDOUT split: entity-disjoint (split by subject) OR value-disjoint (split by answer value).
const splitKeyOf = (t) => (holdout === 'value' ? t.value : t.subject);
let s2 = (seed * 40503) >>> 0; const rnd2 = () => { s2 = (Math.imul(s2 ^ (s2 >>> 13), 0x45d9f3b) + 1) >>> 0; return s2 / 4294967296; };
const splitKeys = [...new Set(triples.map(splitKeyOf))];
const keySplit = new Map(splitKeys.map((k) => [k, rnd2() < trainFrac ? 'train' : 'eval']));
for (const t of triples) t.split = keySplit.get(splitKeyOf(t));
// guarantee both splits non-empty
if (!triples.some((t) => t.split === 'eval')) triples.slice(-Math.max(1, Math.floor(triples.length * 0.3))).forEach((t) => t.split = 'eval');

const familyCounts = {};
for (const t of triples) familyCounts[t.family] = (familyCounts[t.family] || 0) + 1;
const nTrain = triples.filter((t) => t.split === 'train').length;
// disjointness assertion (by the active holdout key)
const trainKeys = new Set(triples.filter((t) => t.split === 'train').map(splitKeyOf));
const leak = triples.filter((t) => t.split === 'eval' && trainKeys.has(splitKeyOf(t))).length;
if (leak) { console.error(`${holdout.toUpperCase()}-DISJOINT FAIL: ${leak} eval triples share a train ${holdout} key`); process.exit(1); }

const meta = { generatedAt: new Date().toISOString(), corpus: corpusPath, format, shuffleTimestamps: shuffleTs,
  triples: triples.length, nTrain, nEval: triples.length - nTrain, familyCounts,
  temporal: triples.filter((t) => t.kind === 'temporal').length, routing: triples.filter((t) => t.kind === 'routing').length,
  surfaceEntropyBits: 0, holdout, shuffleLifecycle, noLifecycle, keysTrain: trainKeys.size, keysEval: new Set(triples.filter((t) => t.split === 'eval').map(splitKeyOf)).size };
writeFileSync(out, JSON.stringify({ meta, triples }, null, 1));
console.log(JSON.stringify(meta, null, 1));
if (triples.length) { const s = triples.find((t) => t.kind === 'temporal') ?? triples[0]; console.log(`\nsample [${s.split}/${s.kind}]:\n  Q : ${s.query}\n  D+: ${s.posText.slice(0, 140)}\n  D-: ${s.negText.slice(0, 140)}`); }
