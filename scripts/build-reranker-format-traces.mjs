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
const lifecycleOf = (id) => (supSrc.has(id) && !supDst.has(id)) ? 'current' : supDst.has(id) ? 'superseded' : 'none';
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

function render(d) {
  const text = d.text;
  if (format === 'F0') return text;
  if (format === 'F1') return `[as of ${tsOf(d)}] ${text}`;
  const subj = nonGeneric(d.entityIds)[0] ?? '?';
  const header = `[t=${tsOf(d)} | lifecycle=${lifecycleOf(d.id)} | subject=${subj}]`;
  if (format === 'F2') return `${header} ${text}`;
  if (format === 'F3') {
    const edges = (edgesBySrc.get(d.id) ?? []).slice(0, 4).map((r) => `${r.type}:${r.label}->${(nonGeneric(docById.get(r.dst)?.entityIds) ?? [])[0] ?? r.dst}`);
    return `${header}${edges.length ? ' [edges: ' + edges.join('; ') + ']' : ''} ${text}`;
  }
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
  const subj = nonGeneric(dPlus.entityIds)[0] ?? nonGeneric(q.entityIds ?? [])[0] ?? `q:${q.id}`;
  triples.push({ qid: q.id, query: q.queryText, family: q.family, kind, subject: subj,
    posId: dPlus.id, posText: render(dPlus), negId: dMinus.id, negText: render(dMinus),
    allStaleIds: (q.qrels ?? []).filter((r) => r.role === 'stale').map((r) => r.docId) });
}

// ENTITY-DISJOINT split: assign each subject deterministically to train|eval.
let s2 = (seed * 40503) >>> 0; const rnd2 = () => { s2 = (Math.imul(s2 ^ (s2 >>> 13), 0x45d9f3b) + 1) >>> 0; return s2 / 4294967296; };
const subjects = [...new Set(triples.map((t) => t.subject))];
const subjSplit = new Map(subjects.map((sub) => [sub, rnd2() < trainFrac ? 'train' : 'eval']));
for (const t of triples) t.split = subjSplit.get(t.subject);
// guarantee both splits non-empty
if (!triples.some((t) => t.split === 'eval')) triples.slice(-Math.max(1, Math.floor(triples.length * 0.3))).forEach((t) => t.split = 'eval');

const familyCounts = {};
for (const t of triples) familyCounts[t.family] = (familyCounts[t.family] || 0) + 1;
const nTrain = triples.filter((t) => t.split === 'train').length;
// entity-disjoint assertion
const trainSubj = new Set(triples.filter((t) => t.split === 'train').map((t) => t.subject));
const leak = triples.filter((t) => t.split === 'eval' && trainSubj.has(t.subject)).length;
if (leak) { console.error(`ENTITY-DISJOINT FAIL: ${leak} eval triples share a train subject`); process.exit(1); }

const meta = { generatedAt: new Date().toISOString(), corpus: corpusPath, format, shuffleTimestamps: shuffleTs,
  triples: triples.length, nTrain, nEval: triples.length - nTrain, familyCounts,
  temporal: triples.filter((t) => t.kind === 'temporal').length, routing: triples.filter((t) => t.kind === 'routing').length,
  surfaceEntropyBits: 0, entityDisjoint: true, subjectsTrain: trainSubj.size, subjectsEval: new Set(triples.filter((t) => t.split === 'eval').map((t) => t.subject)).size };
writeFileSync(out, JSON.stringify({ meta, triples }, null, 1));
console.log(JSON.stringify(meta, null, 1));
if (triples.length) { const s = triples.find((t) => t.kind === 'temporal') ?? triples[0]; console.log(`\nsample [${s.split}/${s.kind}]:\n  Q : ${s.query}\n  D+: ${s.posText.slice(0, 140)}\n  D-: ${s.negText.slice(0, 140)}`); }
