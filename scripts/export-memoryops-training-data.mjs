#!/usr/bin/env node
/**
 * MemoryOps training-data exporter — proves accepted CoreTex state advances become PORTABLE,
 * resolved-state-derived, ID-free MemoryOps training data.
 *
 * MODES:
 *   --from-ledger <ledger.jsonl>   PRIMARY (Phase 2): render Memory IR from the RESOLVED MemoryState the
 *                                  accepted advances produced (sidecar <ledger>.state.json). lifecycle comes
 *                                  from decoded.temporal (the miner's compiled substrate), NOT corpus labels.
 *   (no --from-ledger)             FALLBACK smoke: corpus-source lifecycle (state_source='corpus_smoke').
 *
 * memory_ir fields = PUBLIC resolved-state FEATURES (inputs). label = qrel/role SOFT score (TARGET only —
 * never an input feature → no free-label leakage). No doc/query IDs in trainable text. IDs only in roots/debug.
 *
 * Usage: node scripts/export-memoryops-training-data.mjs --from-ledger <l.jsonl> --corpus <c> --profile <p> --out <jsonl>
 */
import { distIndex, repoRoot } from './_repo-root.mjs';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

const C = await import(distIndex);
const { decodeSubstrate, stableRecordIdFor } = C;
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const base = 'release/calibration/2026-05-21-memory-corpus-v2';
const corpusPath = flag('corpus', `${base}/dgen1-r5-synth-corpus.json`);
const fromLedger = flag('from-ledger', null);
const splitFilterArg = flag('split', null);       // restrict source queries to one corpus split (default: all non-eval_hidden)
const out = flag('out', `${base}/memoryops-training.jsonl`);
const maxNegPerQuery = Number(flag('max-neg', '4'));
const seed = Number(flag('seed', '13'));

const corpus = JSON.parse(readFileSync(resolve(repoRoot, corpusPath), 'utf8'));
const { docs, relations, entities, queries } = corpus;
const docById = new Map(docs.map((d) => [d.id, d]));
const GENERIC = new Set(['e_universe']);
const nonGeneric = (ids) => (ids ?? []).filter((e) => !GENERIC.has(e));
const PUB = new Set(['supports', 'supersedes', 'coreference_of', 'causes', 'derived_from', 'co_occurs_with']);

// ── PUBLIC primitive indices (corpus relation FACTS — durable primitives, not serving labels) ──
const supSrc = new Set(), supDst = new Set(), contradictsSrc = new Set(), contradictsDst = new Set();
const supportInDeg = new Map(); const edgesBySrc = new Map(), edgesByDst = new Map();
for (const r of relations) {
  if (r.type === 'supersedes') { supSrc.add(r.src); supDst.add(r.dst); }
  if (r.label === 'contradicts') { contradictsSrc.add(r.src); contradictsDst.add(r.dst); }
  if (r.type === 'supports') supportInDeg.set(r.dst, (supportInDeg.get(r.dst) ?? 0) + 1);
  (edgesBySrc.get(r.src) ?? edgesBySrc.set(r.src, []).get(r.src)).push(r);
  (edgesByDst.get(r.dst) ?? edgesByDst.set(r.dst, []).get(r.dst)).push(r);
}
const conflictState = (id) => contradictsSrc.has(id) ? 'resolved' : contradictsDst.has(id) ? 'candidate' : 'none';
const hasEvidencePath = (id) => (edgesBySrc.get(id) ?? []).some((r) => PUB.has(r.type)) || (edgesByDst.get(id) ?? []).some((r) => PUB.has(r.type));
// evidence_role from PUBLIC STRUCTURE (NOT qrel): a doc that is a supports-TARGET = support; that has a
// causes/supersedes/coreference edge to the subject = answer-candidate; else context/none.
function evidenceRole(id, subjEnts) {
  const inc = (edgesBySrc.get(id) ?? []).concat(edgesByDst.get(id) ?? []).filter((r) => PUB.has(r.type));
  if (inc.length === 0) return 'none';
  const toSubj = inc.filter((r) => { const o = docById.get(r.src === id ? r.dst : r.src); return o && (o.entityIds ?? []).some((e) => subjEnts.has(e)); });
  if (toSubj.some((r) => ['causes', 'supersedes', 'coreference_of', 'derived_from'].includes(r.type))) return 'answer';
  if (supDst.has(id) ? false : (edgesByDst.get(id) ?? []).some((r) => r.type === 'supports')) return 'support';
  return 'context';
}
const nameToEnt = []; for (const e of entities ?? []) for (const n of [e.canonicalName, ...(e.aliases ?? [])].filter(Boolean)) nameToEnt.push([String(n).toLowerCase(), e.id]);
const querySubjects = (qt) => { const s = new Set(); const t = (qt ?? '').toLowerCase(); for (const [n, id] of nameToEnt) { if (id === 'e_universe') continue; if (n.length > 2 && t.includes(n)) s.add(id); } return s; };
function relationPath(candId, subjEnts) { const p = []; for (const r of (edgesBySrc.get(candId) ?? []).concat(edgesByDst.get(candId) ?? [])) { if (!PUB.has(r.type)) continue; const o = docById.get(r.src === candId ? r.dst : r.src); if (o && (o.entityIds ?? []).some((e) => subjEnts.has(e))) p.push(r.type); } return [...new Set(p)]; }
const scopeMatch = (qt, text) => { const m = (qt ?? '').toLowerCase().match(/for ([a-z ]+?),/); return m ? text.toLowerCase().includes(m[1].trim()) : null; };
const ROLE_SOFT = { direct: 1.0, support: 0.4, bridge: 0.4, stale: 0.2, scope_differs: 0.2, conflict: 0.0, wrong_aspect: 0.2 };

// ── RESOLVED-STATE lifecycle (Phase 2): from the accepted advances' substrate (decoded.temporal), NOT corpus.
let resolvedLifecycle = new Map();   // eventId -> 'current'|'superseded'
let stateSource = 'corpus_smoke', roots = { corpusRoot: corpus.corpusRoot ?? null };
let coveredQ = null; // covered query ids from the ledger (for state_source provenance)
if (fromLedger) {
  const sidecar = fromLedger.replace(/\.jsonl$/, '') + '.state.json';
  if (!existsSync(resolve(repoRoot, sidecar))) { console.error(`missing resolved state sidecar ${sidecar}`); process.exit(2); }
  const st = JSON.parse(readFileSync(resolve(repoRoot, sidecar), 'utf8'));
  const state = { words: st.words.map((w) => BigInt(w)) };
  const decoded = decodeSubstrate(state, { policyAtomsMode: true });
  // map MemoryIndex slot.recordId -> corpus event id (mem_<docId>); recordId = stableRecordIdFor(mem_<docId>)
  const recordIdToEvent = new Map();
  for (const d of docs) recordIdToEvent.set(stableRecordIdFor(`mem_${d.id}`).toString(), `mem_${d.id}`);
  for (const tr of decoded.temporal ?? []) {
    const staleSlot = decoded.memoryIndex?.[tr.memorySlot];
    if (!staleSlot) continue;
    const staleEv = recordIdToEvent.get(staleSlot.recordId?.toString());
    if (tr.currentStaleFlag && staleEv) {
      resolvedLifecycle.set(staleEv, 'superseded');
      if (tr.supersededBy !== undefined && tr.supersededBy !== 0xff) {
        const curSlot = decoded.memoryIndex?.[tr.supersededBy];
        const curEv = curSlot && recordIdToEvent.get(curSlot.recordId?.toString());
        if (curEv) resolvedLifecycle.set(curEv, 'current');
      }
    } else if (!tr.currentStaleFlag && staleEv) resolvedLifecycle.set(staleEv, 'current');
  }
  const led = readFileSync(resolve(repoRoot, fromLedger), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  coveredQ = new Set(led.map((r) => r.coveredQueryId).filter(Boolean));
  stateSource = 'resolved_after'; roots = { corpusRoot: corpus.corpusRoot ?? null, stateRoot: st.finalStateRoot ?? null, advances: led.length };
  console.error(`[memoryops] from-ledger: ${led.length} advances, resolved lifecycle for ${resolvedLifecycle.size} events (decoded.temporal=${(decoded.temporal ?? []).length})`);
}
// resolved lifecycle reads the SUBSTRATE; corpus-smoke falls back to corpus supersedes (flagged).
const lifecycle = (memId, docId) => fromLedger ? (resolvedLifecycle.get(memId) ?? 'none') : (supDst.has(docId) ? 'superseded' : supSrc.has(docId) ? 'current' : 'none');

// ── entity-disjoint split (train/validation/heldout_future) ──
let s2 = (seed * 2654435761) >>> 0; const rnd = () => { s2 = (Math.imul(s2 ^ (s2 >>> 15), 0x2c1b3c6d) + 1) >>> 0; return s2 / 4294967296; };
const subjSplit = new Map();
const splitOf = (subj) => { if (!subjSplit.has(subj)) { const r = rnd(); subjSplit.set(subj, r < 0.7 ? 'train' : r < 0.85 ? 'validation' : 'heldout_future'); } return subjSplit.get(subj); };

const examples = [];
const famCount = {};
for (const q of queries) {
  const qsplit = q.split ?? 'eval_hidden';
  if (splitFilterArg ? qsplit !== splitFilterArg : qsplit === 'eval_hidden') continue;  // never hidden-eval as source
  const subj = querySubjects(q.queryText);
  const subjId = nonGeneric([...subj])[0] ?? `q:${q.id}`;
  const cands = [...(q.qrels ?? []).map((r) => ({ docId: r.docId, role: r.role, soft: ROLE_SOFT[r.role] ?? r.relevance ?? 0 })),
    ...(q.hardNegatives ?? []).slice(0, maxNegPerQuery).map((n) => ({ docId: n.docId, role: 'hard_negative', soft: 0.0 }))];
  for (const c of cands) {
    const d = docById.get(c.docId); if (!d) continue;
    examples.push({
      query: q.queryText, candidate_text: d.text,
      memory_ir: {
        lifecycle: lifecycle(`mem_${d.id}`, d.id), subject_scope: nonGeneric(d.entityIds)[0] ?? '?',
        evidence_role: evidenceRole(d.id, subj), relation_path: relationPath(d.id, subj),
        scope_match: scopeMatch(q.queryText, d.text), conflict_state: conflictState(d.id),
        has_public_evidence_path: hasEvidencePath(d.id), answer_density: supportInDeg.get(d.id) ?? 0,
      },
      label: c.soft, label_source: 'qrel_role', split: splitOf(subjId), family: q.family,
      state_source: stateSource, roots,
      _split_key: subjId,   // PROVENANCE only (entity id, NOT a trainable field) — for split-disjointness audit
    });
  }
  famCount[q.family] = (famCount[q.family] ?? 0) + 1;
}
// ID-leakage gate: no doc/query/mem IDs in the TRAINABLE fields (query, candidate_text, memory_ir).
const trainable = (e) => JSON.stringify({ query: e.query, candidate_text: e.candidate_text, memory_ir: e.memory_ir, label: e.label });
const idLeak = examples.filter((e) => /\bd\d{7}\b|\bq\d{7}\b|mem_d/.test(trainable(e))).length;
writeFileSync(resolve(repoRoot, out), examples.map((e) => JSON.stringify(e)).join('\n') + '\n');
const dist = (f) => { const m = {}; for (const e of examples) { const k = f(e); m[k] = (m[k] ?? 0) + 1; } return m; };
const meta = { from: fromLedger ?? 'corpus_smoke', stateSource, examples: examples.length, queriesByFamily: famCount,
  lifecycleDist: dist((e) => e.memory_ir.lifecycle), evidenceRoleDist: dist((e) => e.memory_ir.evidence_role),
  splitDist: dist((e) => e.split), labelBuckets: dist((e) => e.label >= 0.8 ? 'pos' : e.label <= 0.05 ? 'neg' : 'partial'),
  idLeakInTrainable: idLeak, roots, out };
writeFileSync(resolve(repoRoot, out.replace(/\.jsonl$/, '') + '.manifest.json'), JSON.stringify(meta, null, 2));
console.log(JSON.stringify({ ...meta, sample: examples.find((e) => e.family === 'temporal_update') ?? examples[0] }, null, 2));
console.log(`\nexported ${examples.length} MemoryOps examples → ${out} (state_source=${stateSource}; idLeak=${idLeak}; portable iff 0)`);
