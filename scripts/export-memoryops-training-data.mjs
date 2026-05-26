#!/usr/bin/env node
/**
 * MemoryOps training-data exporter (Phase 5/6 PIPELINE deliverable) — proves CoreTex traces become
 * PORTABLE MemoryOps training data, keyed on memory OPERATIONS (resolved-state features), NOT doc-IDs.
 *
 * Emits the protocol example format:
 *   { query, candidate_text, memory_ir: { lifecycle, subject_scope, evidence_role, relation_path,
 *     scope_match, conflict_state, has_public_evidence_path, answer_density }, label: <soft_score> }
 * memory_ir = PUBLIC resolved-state FEATURES (inputs); label = qrel/role-derived SOFT seed score (target).
 * (MemReranker recipe: these seed soft labels → teacher pairwise on a hard subset → Elo/BT calibration →
 * BCE pointwise → small InfoNCE/listwise. This exporter produces the BCE-pointwise seed corpus.)
 *
 * Train-visible ONLY. Entity-disjoint train/eval split. Covers ALL families. The point is a WELL-FORMED,
 * portable, ID-free dataset — not a winning E1 (Phase 2 showed substrate channels earn the lifts; the
 * sidecar reranker is redundant, so the value here is the pipeline + portability, not model promotion).
 *
 * Usage: node scripts/export-memoryops-training-data.mjs [--split train_visible] [--out <jsonl>]
 */
import { readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const base = 'release/calibration/2026-05-21-memory-corpus-v2';
const corpusPath = flag('corpus', `${base}/dgen1-r5-synth-corpus.json`);
const splitFilter = flag('split', 'train_visible');   // train-visible only (never hidden eval labels)
const out = flag('out', `${base}/memoryops-training.jsonl`);
const maxNegPerQuery = Number(flag('max-neg', '4'));

const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'));
const { docs, relations, entities, queries } = corpus;
const docById = new Map(docs.map((d) => [d.id, d]));
const GENERIC = new Set(['e_universe']);
const nonGeneric = (ids) => (ids ?? []).filter((e) => !GENERIC.has(e));
const PUB = new Set(['supports', 'supersedes', 'coreference_of', 'causes', 'derived_from', 'co_occurs_with']);

// resolved-state structural indices (public): supersedes head/tail (lifecycle), contradicts, support in-degree.
const supSrc = new Set(), supDst = new Set(), contradictsSrc = new Set(), contradictsDst = new Set();
const supportInDeg = new Map(); const edgesBySrc = new Map(), edgesByDst = new Map();
for (const r of relations) {
  if (r.type === 'supersedes') { supSrc.add(r.src); supDst.add(r.dst); }
  if (r.label === 'contradicts') { contradictsSrc.add(r.src); contradictsDst.add(r.dst); }
  if (r.type === 'supports') supportInDeg.set(r.dst, (supportInDeg.get(r.dst) ?? 0) + 1);
  (edgesBySrc.get(r.src) ?? edgesBySrc.set(r.src, []).get(r.src)).push(r);
  (edgesByDst.get(r.dst) ?? edgesByDst.set(r.dst, []).get(r.dst)).push(r);
}
const lifecycle = (id) => supDst.has(id) ? 'superseded' : (supSrc.has(id) ? 'current' : 'none');
const conflictState = (id) => contradictsSrc.has(id) ? 'resolved' : contradictsDst.has(id) ? 'candidate' : 'none';
const hasEvidencePath = (id) => (edgesBySrc.get(id) ?? []).some((r) => PUB.has(r.type)) || (edgesByDst.get(id) ?? []).some((r) => PUB.has(r.type));

const nameToEnt = []; for (const e of entities ?? []) for (const n of [e.canonicalName, ...(e.aliases ?? [])].filter(Boolean)) nameToEnt.push([String(n).toLowerCase(), e.id]);
function querySubjects(qt) { const s = new Set(); const t = (qt ?? '').toLowerCase(); for (const [n, id] of nameToEnt) { if (id === 'e_universe') continue; if (n.length > 2 && t.includes(n)) s.add(id); } return s; }
// relation_path = typed edges connecting the query's subject docs to a candidate (public structure).
function relationPath(candId, subjEnts) {
  const path = [];
  for (const r of (edgesBySrc.get(candId) ?? []).concat(edgesByDst.get(candId) ?? [])) {
    if (!PUB.has(r.type)) continue;
    const other = docById.get(r.src === candId ? r.dst : r.src);
    if (other && (other.entityIds ?? []).some((e) => subjEnts.has(e))) path.push(`${r.type}`);
  }
  return [...new Set(path)];
}
// scope qualifier in the query ("for production", "for weekday care") present in the candidate text?
function scopeMatch(qt, text) { const m = (qt ?? '').toLowerCase().match(/for ([a-z ]+?),/); if (!m) return null; return text.toLowerCase().includes(m[1].trim()); }
const ROLE_SOFT = { direct: 1.0, support: 0.4, bridge: 0.4, stale: 0.2, scope_differs: 0.2, conflict: 0.0, wrong_aspect: 0.2 };

const examples = [];
const famCount = {};
for (const q of queries) {
  if ((q.split ?? 'eval_hidden') !== splitFilter) continue;
  const subj = querySubjects(q.queryText);
  const subjId = nonGeneric([...subj])[0] ?? null;
  const qrels = q.qrels ?? [];
  // positives (by role) + a bounded set of hard negatives.
  const cands = [...qrels.map((r) => ({ docId: r.docId, role: r.role, soft: ROLE_SOFT[r.role] ?? r.relevance ?? 0 })),
    ...(q.hardNegatives ?? []).slice(0, maxNegPerQuery).map((n) => ({ docId: n.docId, role: 'hard_negative', soft: 0.0 }))];
  for (const c of cands) {
    const d = docById.get(c.docId); if (!d) continue;
    const role = c.role === 'direct' ? 'answer' : (c.role === 'support' || c.role === 'bridge') ? 'support' : (c.role === 'hard_negative') ? 'none' : 'context';
    examples.push({
      query: q.queryText, family: q.family, candidate_text: d.text,
      memory_ir: {
        lifecycle: lifecycle(d.id), subject_scope: nonGeneric(d.entityIds)[0] ?? '?',
        evidence_role: role, relation_path: relationPath(d.id, subj),
        scope_match: scopeMatch(q.queryText, d.text), conflict_state: conflictState(d.id),
        has_public_evidence_path: hasEvidencePath(d.id), answer_density: supportInDeg.get(d.id) ?? 0,
      },
      label: c.soft,
    });
  }
  famCount[q.family] = (famCount[q.family] ?? 0) + 1;
}
// portability assertion: NO doc-IDs / query-IDs / corpus-row identifiers in the example (only text + ops).
const idLeak = examples.filter((e) => /d\d{7}|q\d{7}|mem_/.test(JSON.stringify(e.memory_ir)) || /d\d{7}|q\d{7}/.test(JSON.stringify(e.label))).length;
writeFileSync(out, examples.map((e) => JSON.stringify(e)).join('\n') + '\n');
const lcDist = {}; for (const e of examples) lcDist[e.memory_ir.lifecycle] = (lcDist[e.memory_ir.lifecycle] ?? 0) + 1;
const roleDist = {}; for (const e of examples) roleDist[e.memory_ir.evidence_role] = (roleDist[e.memory_ir.evidence_role] ?? 0) + 1;
console.log(JSON.stringify({ split: splitFilter, examples: examples.length, queriesByFamily: famCount,
  lifecycleDist: lcDist, evidenceRoleDist: roleDist, idLeakInMemoryIR: idLeak,
  sample: examples.find((e) => e.family === 'temporal_update') ?? examples[0] }, null, 2));
console.log(`\nexported ${examples.length} MemoryOps examples → ${out} (idLeak=${idLeak}; portable iff 0)`);
