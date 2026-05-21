#!/usr/bin/env node
/**
 * CoreTex Memory Corpus V2 — linter & leakage audit.
 *
 * Enforces the Layer-1 hard-reject rules from
 * `release/calibration/2026-05-21-memory-corpus-v2/CORETEX_MEMORY_CORPUS_V2_SPEC.md` §5.3
 * against the *logical* corpus format (docs + queries + public relations).
 * This is the gate that must be 100% green before any embedding/diagnostic run.
 *
 * The logical format is what P0a is hand-authored in and what the P0 generator
 * emits before embedding; the production v1 shape (with embeddings) is derived
 * from it, so linting at the logical layer catches content/leakage bugs early.
 *
 * Usage:
 *   node scripts/lint-memory-corpus-v2.mjs <path-to-logical-corpus.json> [--json]
 *
 * Exit code 0 = PASS (zero errors), 1 = FAIL.
 */
import { readFileSync } from 'node:fs';

const SPEC_VERSION = 'coretex.memory-corpus.v2-spec.r1';
const GRADES = new Set([0.0, 0.2, 0.4, 0.6, 0.8, 1.0]);
const BRIDGE_FAMILIES = new Set([
  'multi_session_bridge', 'causal_memory_chain', 'coreference_resolution', 'decision_provenance',
]);
const TEMPORAL_FAMILIES = new Set(['temporal_update', 'decision_provenance']);
const ALL_INVARIANTS = ['I1','I2','I3','I4','I5','I6','I7','I8','I9','I10','I11','I12','I13','I14'];

// §5.3.2 — label-like text that encodes the eval verdict. Case-insensitive.
// These are the tokens that leaked currency in the prior corpus.
const LABEL_LEAK_PATTERNS = [
  /\bdistractor\b/i,
  /\bvalidated current\b/i,
  /\bsuperseded distractor\b/i,
  /\bground truth\b/i,
  /\bgold (answer|doc|label)\b/i,
  /\bcorrect answer\b/i,
  /\b(is|the) current answer\b/i,
  /\brelevance (score|grade|label)\b/i,
  /\b(this is the|marked as) (correct|right) (doc|answer|memory)\b/i,
  /\bnon-?answer\b/i,
];

// §5.3.1 — analytical / aggregation shapes (forbidden; answer must be stored, not computed).
const ANALYTICS_PATTERNS = [
  /\b(highest|lowest|largest|smallest|maximum|minimum|most|fewest|greatest)\b[^?]*\b(then|and then|, then)\b/i,
  /\bargmax\b/i, /\bargmin\b/i,
  /\bgroup by\b/i, /\bjoin\b.*\bon\b/i,
  /\bratio of\b/i, /\bratio between\b/i,
  /\bhow many\b[^?]*\b(more|less|fewer|greater)\b/i,
  /\b(sum|average|mean|median|count) of\b/i,
  /\bwhich (one )?has the (highest|lowest|most|fewest)\b/i,
  /\bsort(ed)? by\b/i,
  /\bper (capita|unit|dollar)\b/i,
];

function fail(errors, code, msg) { errors.push({ code, msg }); }
function warn(warnings, code, msg) { warnings.push({ code, msg }); }

function main() {
  const args = process.argv.slice(2);
  const jsonOut = args.includes('--json');
  const path = args.find((a) => !a.startsWith('--'));
  if (!path) {
    console.error('usage: node scripts/lint-memory-corpus-v2.mjs <corpus.json> [--json]');
    process.exit(2);
  }
  const corpus = JSON.parse(readFileSync(path, 'utf8'));
  const errors = [];
  const warnings = [];

  const phase = corpus.phase ?? 'unknown';
  const isP0a = phase === 'P0a';
  const minNegs = isP0a ? 1 : 8;
  const maxNegs = isP0a ? 99 : 25;

  // ── spec version ──
  if (corpus.specVersion !== SPEC_VERSION) {
    fail(errors, 'SPEC_VERSION', `specVersion ${corpus.specVersion} != ${SPEC_VERSION}`);
  }

  const docs = corpus.docs ?? [];
  const queries = corpus.queries ?? [];
  const relations = corpus.relations ?? [];
  const entities = corpus.entities ?? [];
  const docById = new Map(docs.map((d) => [d.id, d]));
  const entityIds = new Set(entities.map((e) => e.id));

  // ── duplicate doc ids ──
  if (docById.size !== docs.length) fail(errors, 'DUP_DOC_ID', 'duplicate document ids present');

  // ── public relation index (doc<->doc), used for bridge reachability ──
  const relAdj = new Map(); // docId -> Set(docId) (undirected for reachability)
  const relTyped = new Map(); // `${src}->${dst}` -> Set(type)
  for (const r of relations) {
    if (!docById.has(r.src)) fail(errors, 'REL_SRC_MISSING', `relation src ${r.src} not a doc`);
    if (!docById.has(r.dst)) fail(errors, 'REL_DST_MISSING', `relation dst ${r.dst} not a doc`);
    if (!relAdj.has(r.src)) relAdj.set(r.src, new Set());
    if (!relAdj.has(r.dst)) relAdj.set(r.dst, new Set());
    relAdj.get(r.src).add(r.dst);
    relAdj.get(r.dst).add(r.src);
    const key = `${r.src}->${r.dst}`;
    if (!relTyped.has(key)) relTyped.set(key, new Set());
    relTyped.get(key).add(r.type);
  }

  // ── per-doc checks: entity refs, label leakage, supersession consistency ──
  for (const d of docs) {
    for (const eid of d.entityIds ?? []) {
      if (!entityIds.has(eid)) fail(errors, 'DOC_ENTITY_MISSING', `${d.id} references unknown entity ${eid}`);
    }
    const text = d.text ?? '';
    for (const pat of LABEL_LEAK_PATTERNS) {
      if (pat.test(text)) fail(errors, 'LABEL_LEAK_TEXT', `${d.id} text matches label-leak pattern ${pat}`);
    }
    // supersession metadata consistency (§5.3.4)
    if (d.supersededByDocId) {
      if (!docById.has(d.supersededByDocId)) fail(errors, 'SUPERSEDE_MISSING', `${d.id} supersededByDocId ${d.supersededByDocId} missing`);
      if (d.currentStaleFlag === true) fail(errors, 'SUPERSEDE_FLAG', `${d.id} has supersededBy but currentStaleFlag=true (should be a stale/old doc => false)`);
      const key = `${d.supersededByDocId}->${d.id}`;
      if (!(relTyped.get(key)?.has('supersedes'))) fail(errors, 'SUPERSEDE_EDGE', `${d.id} superseded but no public 'supersedes' edge ${d.supersededByDocId}->${d.id}`);
    }
    if (d.supersedesDocId) {
      if (!docById.has(d.supersedesDocId)) fail(errors, 'SUPERSEDE_MISSING', `${d.id} supersedesDocId ${d.supersedesDocId} missing`);
      if (d.currentStaleFlag === false) fail(errors, 'SUPERSEDE_FLAG', `${d.id} supersedes another but currentStaleFlag=false (should be current => true)`);
      if (!d.timestamp) fail(errors, 'SUPERSEDE_TS', `${d.id} supersedes another but has no timestamp (currency must be curated metadata)`);
    }
  }

  // ── per-query checks ──
  const invariantSeen = new Set();
  const inspection = [];
  for (const q of queries) {
    const tag = q.id ?? '(no id)';
    if (q.invariant) invariantSeen.add(q.invariant);
    const qtext = q.queryText ?? '';

    // analytics shape (§5.3.1)
    for (const pat of ANALYTICS_PATTERNS) {
      if (pat.test(qtext)) fail(errors, 'ANALYTICS_SHAPE', `${tag} query matches analytics pattern ${pat}: "${qtext}"`);
    }
    // label leak in query text
    for (const pat of LABEL_LEAK_PATTERNS) {
      if (pat.test(qtext)) fail(errors, 'LABEL_LEAK_QUERY', `${tag} query text matches label-leak pattern ${pat}`);
    }
    // query must not contain a truth doc id (§ anti-cheat)
    for (const qr of q.qrels ?? []) {
      if (qr.docId && qtext.includes(qr.docId)) fail(errors, 'DOCID_IN_QUERY', `${tag} query text leaks doc id ${qr.docId}`);
    }

    const qrels = q.qrels ?? [];
    const negs = q.hardNegatives ?? [];
    // referential integrity
    for (const qr of qrels) {
      if (!docById.has(qr.docId)) fail(errors, 'QREL_DOC_MISSING', `${tag} qrel doc ${qr.docId} missing`);
      if (!GRADES.has(qr.relevance)) fail(errors, 'QREL_GRADE', `${tag} qrel ${qr.docId} relevance ${qr.relevance} not in graded scale`);
    }
    for (const n of negs) {
      if (!docById.has(n.docId)) fail(errors, 'NEG_DOC_MISSING', `${tag} hardNeg doc ${n.docId} missing`);
    }
    // a doc can't be both a strong-positive qrel and a hard negative
    const strongPos = new Set(qrels.filter((qr) => qr.relevance >= 0.8).map((qr) => qr.docId));
    for (const n of negs) {
      if (strongPos.has(n.docId)) fail(errors, 'NEG_IS_POS', `${tag} doc ${n.docId} is both a >=0.8 answer and a hard negative`);
    }

    if (q.abstain) {
      // §5.3.9 abstention: no doc at relevance >= 0.6, >=1 plausible trap
      const tooRelevant = qrels.filter((qr) => qr.relevance >= 0.6);
      if (tooRelevant.length > 0) fail(errors, 'ABSTAIN_HAS_ANSWER', `${tag} abstention query has qrel >=0.6: ${tooRelevant.map((x) => x.docId)}`);
      if (negs.length < 1) fail(errors, 'ABSTAIN_NO_TRAP', `${tag} abstention query has no plausible trap negative`);
    } else {
      // §5.3.5 every query has >=1 direct evidence doc (relevance >= 0.8)
      const direct = qrels.filter((qr) => qr.relevance >= 0.8);
      if (direct.length < 1) fail(errors, 'NO_DIRECT_EVIDENCE', `${tag} has no direct evidence doc (relevance>=0.8)`);
      // neg count band
      if (negs.length < minNegs) warn(warnings, 'FEW_NEGS', `${tag} has ${negs.length} hard negatives (< ${minNegs} target for ${phase})`);
      if (negs.length > maxNegs) warn(warnings, 'MANY_NEGS', `${tag} has ${negs.length} hard negatives (> ${maxNegs})`);
    }

    // §5.3.6 bridge families need a public bridge doc (>=0.4) reachable from a direct doc by a public edge
    if (BRIDGE_FAMILIES.has(q.family) && !q.abstain) {
      const directIds = qrels.filter((qr) => qr.relevance >= 0.8).map((qr) => qr.docId);
      const bridgeQrels = qrels.filter((qr) => qr.role === 'bridge' && qr.relevance >= 0.4);
      if (bridgeQrels.length < 1) {
        fail(errors, 'NO_BRIDGE_DOC', `${tag} family ${q.family} has no bridge qrel (role=bridge, relevance>=0.4)`);
      } else {
        // at least one bridge doc must be reachable by a public relation edge from a direct doc
        const reachable = bridgeQrels.some((b) => directIds.some((d) => relAdj.get(d)?.has(b.docId)));
        if (!reachable) fail(errors, 'BRIDGE_NOT_PUBLIC', `${tag} bridge doc not reachable from a direct doc via any public relation edge`);
      }
    }

    // §5.3.4 temporal families need realistic version metadata + no label leak (leak covered above)
    if (TEMPORAL_FAMILIES.has(q.family) && !q.abstain) {
      const docsForQ = qrels.map((qr) => docById.get(qr.docId)).filter(Boolean);
      const hasCurrencyMeta = docsForQ.some((d) => d.timestamp && (d.supersedesDocId || d.supersededByDocId || typeof d.currentStaleFlag === 'boolean'));
      if (!hasCurrencyMeta) fail(errors, 'TEMPORAL_NO_META', `${tag} temporal family but no curated currency metadata (timestamp + supersedes/currentStaleFlag) on its docs`);
      // there must be a stale counterpart so the task is non-trivial
      const hasStaleNeg = (q.hardNegatives ?? []).some((n) => n.category === 'temporal_stale')
        || qrels.some((qr) => qr.role === 'stale');
      if (!hasStaleNeg) warn(warnings, 'TEMPORAL_NO_STALE', `${tag} temporal family without an explicit stale counterpart`);
    }

    inspection.push({
      id: q.id, lane: q.lane, family: q.family, invariant: q.invariant,
      query: qtext,
      direct: qrels.filter((qr) => qr.relevance >= 0.8).map((qr) => qr.docId),
      graded: qrels.map((qr) => `${qr.docId}@${qr.relevance}${qr.role ? `(${qr.role})` : ''}`),
      negs: negs.map((n) => `${n.docId}:${n.category}`),
      abstain: !!q.abstain,
    });
  }

  // ── invariant coverage (Layer-0 says >=1 example per invariant) ──
  const missingInv = ALL_INVARIANTS.filter((i) => !invariantSeen.has(i));
  if (missingInv.length > 0) fail(errors, 'INVARIANT_COVERAGE', `invariants with no query: ${missingInv.join(', ')}`);

  // ── blend ratio (informational) ──
  const laneCounts = {};
  for (const d of docs) laneCounts[d.lane] = (laneCounts[d.lane] ?? 0) + 1;

  const result = {
    path, phase, specVersion: corpus.specVersion,
    counts: { docs: docs.length, queries: queries.length, relations: relations.length, entities: entities.length },
    laneCounts,
    invariantCoverage: { present: [...invariantSeen].sort(), missing: missingInv },
    errors, warnings,
    pass: errors.length === 0,
  };

  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`\n=== Memory Corpus V2 Lint — ${phase} ===`);
    console.log(`file: ${path}`);
    console.log(`docs=${docs.length} queries=${queries.length} relations=${relations.length} lanes=${JSON.stringify(laneCounts)}`);
    console.log(`invariants present: ${[...invariantSeen].sort().join(',')}`);
    console.log('\n--- per-query inspection ---');
    for (const r of inspection) {
      console.log(`${r.id} [${r.lane}/${r.family}/${r.invariant}]${r.abstain ? ' ABSTAIN' : ''}`);
      console.log(`   Q: ${r.query}`);
      console.log(`   qrels: ${r.graded.join(', ') || '(none)'}`);
      console.log(`   negs:  ${r.negs.join(', ') || '(none)'}`);
    }
    console.log('\n--- warnings ---');
    if (warnings.length === 0) console.log('   (none)');
    for (const w of warnings) console.log(`   [${w.code}] ${w.msg}`);
    console.log('\n--- errors ---');
    if (errors.length === 0) console.log('   (none)');
    for (const e of errors) console.log(`   [${e.code}] ${e.msg}`);
    console.log(`\nRESULT: ${result.pass ? 'PASS ✅' : 'FAIL ❌'} (${errors.length} errors, ${warnings.length} warnings)\n`);
  }
  process.exit(result.pass ? 0 : 1);
}

main();
