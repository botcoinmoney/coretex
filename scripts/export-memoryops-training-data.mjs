#!/usr/bin/env node
/**
 * MemoryOps training-data exporter — accepted CoreTex state advances → PORTABLE, resolved-state-derived,
 * ID-free, FULL-Memory-IR training data (2026-05-26 correction: full multi-field IR + realistic candidate
 * pools + multi-corpus scale, so the reranker is trained on the same lists+render it will be served).
 *
 * SOURCES (merge primary + supplement; family-balanced):
 *   --corpus <c>            primary corpus (DGEN1 scale for the non-temporal bulk + temporal sanity)
 *   --from-ledger <l>       resolve lifecycle for the primary from the accepted-state substrate sidecar
 *   --supplement <c2>       secondary corpus (r5-synth: supplies conflict/aspect/abstention families)
 *   --supplement-ledger <l2>
 *
 * CANDIDATE POOL per query (the kind of list the reranker actually ranks): ALL qrel ROLES (current/stale/
 * bridge/conflict/wrong_aspect/scope_differs siblings) + curated hard negatives sampled across CATEGORIES
 * (relation_neighbor / near_collision_attribute / temporal_stale / coreference distractors / no-evidence).
 *
 * memory_ir = PUBLIC resolved-state FEATURES (the shared `buildMemoryIRContext`/`computeMemoryIR`); label =
 * qrel/role SOFT score (TARGET only, never an input). memory_ir_text = the shared protocol render
 * (renderMemoryIRDoc) — exactly the trainer's/scorer's served document. No doc/query IDs in trainable text.
 *
 * Usage: node scripts/export-memoryops-training-data.mjs --corpus <c> [--from-ledger <l>]
 *        [--supplement <c2> --supplement-ledger <l2>] --split train_visible --out <jsonl>
 */
import { distIndex, repoRoot } from './_repo-root.mjs';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { buildMemoryIRContext, computeMemoryIR, nonGeneric, resolvedLifecycleFromDecoded } from './lib/memory-ir.mjs';

const C = await import(distIndex);
const { decodeSubstrate, stableRecordIdFor, renderMemoryIRDoc } = C;
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const base = 'release/calibration/2026-05-21-memory-corpus-v2';
const out = flag('out', `${base}/memoryops-training.jsonl`);
const splitFilterArg = flag('split', 'train_visible');
const maxNegPerQuery = Number(flag('max-neg', '6'));
const seed = Number(flag('seed', '13'));
const perFamilyCap = Number(flag('per-family-cap', '0'));   // 0 = no cap (balance reporting only)

// ── resolved-state lifecycle from an accepted-state ledger's substrate sidecar (decoded.temporal). ──
function resolvedLifecycleMap(ledgerPath, docs) {
  const m = new Map();
  if (!ledgerPath) return { map: m, advances: 0, stateRoot: null };
  const sidecar = ledgerPath.replace(/\.jsonl$/, '') + '.state.json';
  if (!existsSync(resolve(repoRoot, sidecar))) { console.error(`missing resolved state sidecar ${sidecar}`); process.exit(2); }
  const st = JSON.parse(readFileSync(resolve(repoRoot, sidecar), 'utf8'));
  const state = { words: st.words.map((w) => BigInt(w)) };
  const decoded = decodeSubstrate(state, { policyAtomsMode: true });
  const resolved = resolvedLifecycleFromDecoded(decoded, docs, stableRecordIdFor);
  for (const [k, v] of resolved) m.set(k, v);
  const led = readFileSync(resolve(repoRoot, ledgerPath), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { map: m, advances: led.length, stateRoot: st.finalStateRoot ?? null };
}

const ROLE_SOFT = { direct: 1.0, support: 0.4, bridge: 0.4, stale: 0.2, scope_differs: 0.2, conflict: 0.0, wrong_aspect: 0.2 };

// deterministic entity-disjoint split (subject → train/validation/heldout_future). HASH of the subject id
// (ORDER-INDEPENDENT) so a subject lands in the same split whether exported alone or merged across corpora.
const splitOf = (subj) => {
  const h = parseInt(createHash('sha1').update(`${seed}:${subj}`).digest('hex').slice(0, 8), 16) / 0xffffffff;
  return h < 0.7 ? 'train' : h < 0.85 ? 'validation' : 'heldout_future';
};

function exportCorpus(corpusPath, ledgerPath, tag, examples) {
  const corpus = JSON.parse(readFileSync(resolve(repoRoot, corpusPath), 'utf8'));
  const { docs, queries } = corpus;
  const docById = new Map(docs.map((d) => [d.id, d]));
  const ctx = buildMemoryIRContext(corpus);
  const { map: resolved, advances, stateRoot } = resolvedLifecycleMap(ledgerPath, docs);
  const stateSource = ledgerPath ? 'resolved_after' : 'corpus_smoke';
  // lifecycle: resolved substrate (ledger) for temporal events; corpus-smoke falls back to supersedes edges.
  const lifecycleOf = (docId) => ledgerPath
    ? (resolved.get(`mem_${docId}`) ?? 'none')
    : (ctx.supDst.has(docId) ? 'superseded' : ctx.supSrc.has(docId) ? 'current' : 'none');
  console.error(`[memoryops] ${tag}: corpus=${corpusPath} ledger=${ledgerPath ?? '(none)'} advances=${advances} resolvedLifecycle=${resolved.size}`);

  for (const q of queries) {
    const qsplit = q.split ?? 'eval_hidden';
    if (splitFilterArg ? qsplit !== splitFilterArg : qsplit === 'eval_hidden') continue;  // never hidden-eval as source
    // per-query sampling rng seeded by query id (ORDER/TAG-INDEPENDENT) → identical rows whether this corpus
    // is exported alone or merged as primary/supplement.
    let qs = parseInt(createHash('sha1').update(`${seed}:${q.id}`).digest('hex').slice(0, 8), 16) >>> 0;
    const rng = () => { qs = (Math.imul(qs ^ (qs >>> 13), 0x5bd1e995) + 1) >>> 0; return qs / 4294967296; };
    const subj = ctx.querySubjects(q.queryText);
    const subjId = nonGeneric([...subj])[0] ?? `q:${q.id}`;
    // realistic candidate pool: all qrel roles + hard negatives sampled across categories (not just first N).
    const negs = [...(q.hardNegatives ?? [])];
    // group by category, round-robin sample so the pool spans relation_neighbor / near_collision / etc.
    const byCat = new Map();
    for (const n of negs) { const c = n.category ?? 'other'; (byCat.get(c) ?? byCat.set(c, []).get(c)).push(n); }
    const sampledNegs = [];
    const cats = [...byCat.keys()];
    let gi = 0;
    while (sampledNegs.length < maxNegPerQuery && cats.some((c) => byCat.get(c).length > 0)) {
      const c = cats[gi % cats.length]; gi++;
      const arr = byCat.get(c); if (arr.length === 0) continue;
      const idx = Math.floor(rng() * arr.length); sampledNegs.push({ ...arr.splice(idx, 1)[0], _cat: c });
    }
    const cands = [
      ...(q.qrels ?? []).map((r) => ({ docId: r.docId, role: r.role, soft: ROLE_SOFT[r.role] ?? r.relevance ?? 0, cat: `role:${r.role}` })),
      ...sampledNegs.map((n) => ({ docId: n.docId, role: 'hard_negative', soft: 0.0, cat: n._cat })),
    ];
    for (const c of cands) {
      const d = docById.get(c.docId); if (!d) continue;
      const ir = computeMemoryIR(ctx, q.queryText, d, lifecycleOf(d.id));
      examples.push({
        query: q.queryText, candidate_text: d.text,
        memory_ir: ir,
        memory_ir_text: renderMemoryIRDoc(ir, d.text),   // the EXACT served/trained document (shared renderer)
        label: c.soft, label_source: 'qrel_role', candidate_source: c.cat,
        split: splitOf(subjId), family: q.family, corpus_tag: tag,
        state_source: stateSource, roots: { stateRoot, advances },
        _split_key: subjId,   // PROVENANCE only (entity id, NOT a trainable field)
      });
    }
  }
}

const examples = [];
exportCorpus(flag('corpus', `${base}/dgen1-corpus.json`), flag('from-ledger', null), 'primary', examples);
const supp = flag('supplement', null);
if (supp) exportCorpus(supp, flag('supplement-ledger', null), 'supplement', examples);

if (perFamilyCap > 0) {  // optional balance: cap examples per family (keeps non-temporal from being swamped)
  const byFam = new Map();
  for (const e of examples) (byFam.get(e.family) ?? byFam.set(e.family, []).get(e.family)).push(e);
  examples.length = 0;
  for (const arr of byFam.values()) for (const e of arr.slice(0, perFamilyCap)) examples.push(e);
}

// ID-leakage gate: no doc/query/mem IDs in the TRAINABLE fields (query, candidate_text, memory_ir, memory_ir_text).
const trainable = (e) => JSON.stringify({ query: e.query, candidate_text: e.candidate_text, memory_ir: e.memory_ir, memory_ir_text: e.memory_ir_text, label: e.label });
const idLeak = examples.filter((e) => /\bd\d{7}\b|\bq\d{7}\b|mem_d/.test(trainable(e))).length;
writeFileSync(resolve(repoRoot, out), examples.map((e) => JSON.stringify(e)).join('\n') + '\n');

const dist = (f) => { const m = {}; for (const e of examples) { const k = f(e); m[k] = (m[k] ?? 0) + 1; } return m; };
const TEMPORAL = new Set(['temporal_update']);
const meta = {
  generatedAt: new Date().toISOString(), out, splitFilter: splitFilterArg, examples: examples.length,
  byFamily: dist((e) => e.family),
  temporalVsNonTemporal: { temporal: examples.filter((e) => TEMPORAL.has(e.family)).length, non_temporal: examples.filter((e) => !TEMPORAL.has(e.family)).length },
  bySplit: dist((e) => e.split), byCorpus: dist((e) => e.corpus_tag),
  lifecycleDist: dist((e) => e.memory_ir.lifecycle), evidenceRoleDist: dist((e) => e.memory_ir.evidence_role),
  conflictStateDist: dist((e) => e.memory_ir.conflict_state), relationPathPresent: examples.filter((e) => (e.memory_ir.relation_path ?? []).length > 0).length,
  scopeMatchDist: dist((e) => String(e.memory_ir.scope_match)), evidencePathTrue: examples.filter((e) => e.memory_ir.has_public_evidence_path).length,
  headerRendered: examples.filter((e) => e.memory_ir_text !== e.candidate_text).length,
  candidateSourceDist: dist((e) => e.candidate_source),
  labelBuckets: dist((e) => e.label >= 0.8 ? 'pos' : e.label <= 0.05 ? 'neg' : 'partial'),
  stateSourceDist: dist((e) => e.state_source), resolvedStateCoverage: examples.filter((e) => e.state_source === 'resolved_after').length,
  idLeakInTrainable: idLeak,
};
writeFileSync(resolve(repoRoot, out.replace(/\.jsonl$/, '') + '.manifest.json'), JSON.stringify(meta, null, 2));
console.log(JSON.stringify(meta, null, 2));
console.log(`\nexported ${examples.length} MemoryOps examples → ${out} (idLeak=${idLeak}; portable iff 0; non-temporal=${meta.temporalVsNonTemporal.non_temporal})`);
