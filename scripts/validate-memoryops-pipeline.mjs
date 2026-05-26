#!/usr/bin/env node
/**
 * Phase-3 MANDATORY validation gates for the MemoryOps pipeline. MUST pass (exit 0) before any GPU training.
 *   1. EARNED-state   : empty substrate → resolved state has NO temporal records → no resolved IR values.
 *   2. NO-FREE-LABEL  : every exported memory_ir.lifecycle≠'none' corresponds to a doc the ACCEPTED ADVANCES
 *                       resolved (in the ledger's resolved set) — not read free from corpus.
 *   3. ID-LEAKAGE     : trainable fields (query, candidate_text, memory_ir, label) contain no doc/query/qrel ids.
 *   4. TRAIN/SERVE eq : the exporter's resolved lifecycle == the scorer's resolved render (rerankerMemoryIRSource
 *                       ='resolved') for the same final state, per doc.
 *   5. DETERMINISM    : two exports from the same ledger produce an identical output hash.
 *   6. SPLIT-safety   : train / validation / heldout_future subjects are disjoint.
 *
 * Usage: node scripts/validate-memoryops-pipeline.mjs --ledger <l.jsonl> --memops <m.jsonl> --corpus <c> --profile <p>
 */
import { distIndex, repoRoot } from './_repo-root.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execSync as sh } from 'node:child_process';
import { buildV2ProductionCorpus, inertBiEncoder } from './lib/build-v2-production-corpus.mjs';
import { buildMemoryIRContext, computeMemoryIR, resolvedLifecycleFromDecoded } from './lib/memory-ir.mjs';

const C = await import(distIndex);
const { decodeSubstrate, stableRecordIdFor, scoringOptionsFromProfile, deriveQueryPack, evaluateRetrievalBenchmarkState, createDeterministicReranker, renderMemoryIRDoc } = C;
const flag = (n, d) => { const a = process.argv.slice(2); const i = a.indexOf(`--${n}`); return i >= 0 && i + 1 < a.length ? a[i + 1] : d; };
const base = 'release/calibration/2026-05-21-memory-corpus-v2';
const ledgerPath = flag('ledger', '/tmp/ledger-r5.jsonl');
const memopsPath = flag('memops', '/tmp/memops-r5.jsonl');
const corpusPath = flag('corpus', `${base}/dgen1-r5-synth-corpus.json`);
const embPath = flag('emb', `${base}/dgen1-r5-synth-embeddings.json`);
const profilePath = flag('profile', 'release/bundle/evaluator-profile-v2-dgen1-policy-r5.json');

const fail = [];
const ok = (g, cond, detail) => { console.log(`${cond ? '✅' : '❌'} ${g}${detail ? ' — ' + detail : ''}`); if (!cond) fail.push(g); };

const rawCorpus = JSON.parse(readFileSync(resolve(repoRoot, corpusPath), 'utf8'));
const docById = new Map(rawCorpus.docs.map((d) => [d.id, d]));
const memops = readFileSync(resolve(repoRoot, memopsPath), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const sidecar = ledgerPath.replace(/\.jsonl$/, '') + '.state.json';
const st = JSON.parse(readFileSync(resolve(repoRoot, sidecar), 'utf8'));
const finalState = { words: st.words.map((w) => BigInt(w)) };

// resolved lifecycle from the final state (same logic as the exporter) → the EARNED set.
const recordIdToDoc = new Map();
for (const d of rawCorpus.docs) recordIdToDoc.set(stableRecordIdFor(`mem_${d.id}`).toString(), d.id);
const decoded = decodeSubstrate(finalState, { policyAtomsMode: true });
const earnedLifecycle = new Map();  // docId -> current|superseded
for (const tr of decoded.temporal ?? []) {
  const ss = decoded.memoryIndex?.[tr.memorySlot]; const sd = ss && recordIdToDoc.get(ss.recordId?.toString());
  if (tr.currentStaleFlag && sd) { earnedLifecycle.set(sd, 'superseded'); const cs = tr.supersededBy !== 0xff && decoded.memoryIndex?.[tr.supersededBy]; const cd = cs && recordIdToDoc.get(cs.recordId?.toString()); if (cd) earnedLifecycle.set(cd, 'current'); }
  else if (!tr.currentStaleFlag && sd) earnedLifecycle.set(sd, 'current');
}

// GATE 1 — EARNED-state: empty substrate resolves to NO temporal records.
const emptyDecoded = decodeSubstrate({ words: new Array(1024).fill(0n) }, { policyAtomsMode: true });
ok('1 earned-state', (emptyDecoded.temporal ?? []).length === 0, `empty substrate decoded.temporal=${(emptyDecoded.temporal ?? []).length} (must be 0)`);

// GATE 2 — NO-FREE-LABEL: every exported lifecycle≠none doc must be in the EARNED set. (Match by UNIQUE
// text only — alias-collision docs share text across subjects so text→docId is ambiguous; the exporter
// reads lifecycle ONLY from decoded.temporal by construction, so unique-text docs verify the property.)
const textCount = new Map(); for (const d of rawCorpus.docs) textCount.set(d.text, (textCount.get(d.text) ?? 0) + 1);
const docOfText = new Map(); for (const d of rawCorpus.docs) if (textCount.get(d.text) === 1) docOfText.set(d.text, d.id);
let freeLabel = 0, freeCompared = 0;
for (const e of memops) { if (e.memory_ir.lifecycle === 'none') continue; const did = docOfText.get(e.candidate_text); if (!did) continue; freeCompared++; if (!earnedLifecycle.has(did)) freeLabel++; }
ok('2 no-free-label', freeLabel === 0 && freeCompared > 0, `${freeLabel}/${freeCompared} (unique-text) exported lifecycle labels NOT earned (must be 0)`);

// GATE 3 — ID-leakage in trainable fields.
const idRe = /\bd\d{7}\b|\bq\d{7}\b|mem_d|qrel/i;
const leak = memops.filter((e) => idRe.test(JSON.stringify({ q: e.query, c: e.candidate_text, m: e.memory_ir, l: e.label }))).length;
ok('3 id-leakage', leak === 0, `${leak} trainable examples contain ids (must be 0)`);

// GATE 4 — TRAIN/SERVE byte-equality (FULL IR): the scorer's full-IR serve path (shared lookup + protocol
// renderer) reproduces the exporter's `memory_ir_text` EXACTLY on real (query, candidate) pairs. This is the
// operationalized golden test through the actual serve-time render path (the prior loop's defect — multi-field
// export but lifecycle-only serve — fails here). Plus a wiring check that the scorer emits [memory_ir …] headers.
const reranker = await createDeterministicReranker();
const { corpus, logical, LAYOUT, BE, biEncoderHash } = buildV2ProductionCorpus({ corpusPath, embPath });
const r5 = JSON.parse(readFileSync(resolve(repoRoot, profilePath), 'utf8'));
const rt = { biEncoder: inertBiEncoder(BE, LAYOUT), reranker, biEncoderHash, retrievalKeyLayout: LAYOUT };
// build the SAME full-IR lookup the scorer/harness uses (shared module + resolved state).
const irCtx = buildMemoryIRContext(logical);
const irDocById = new Map(logical.docs.map((d) => [d.id, d]));
const irQueryById = new Map(logical.queries.map((q) => [q.id, q]));
const resolvedLc = resolvedLifecycleFromDecoded(decoded, logical.docs, stableRecordIdFor);
const lifecycleOf = (docId) => resolvedLc.get(`mem_${docId}`) ?? 'none';
const irLookup = (queryId, eventId) => { const q = irQueryById.get(queryId); const d = irDocById.get(eventId.startsWith('mem_') ? eventId.slice(4) : eventId); return (q && d) ? computeMemoryIR(irCtx, q.queryText, d, lifecycleOf(d.id)) : null; };
// (a) substantive: scorer-lookup-render == exporter memory_ir_text on real export rows (unique-text + resolvable query).
const qTextToId = new Map(); { const c = new Map(); for (const q of logical.queries) c.set(q.queryText, (c.get(q.queryText) ?? 0) + 1); for (const q of logical.queries) if (c.get(q.queryText) === 1) qTextToId.set(q.queryText, q.id); }
let serveMismatch = 0, serveCompared = 0;
for (const e of memops) {
  const qid = qTextToId.get(e.query); const did = docOfText.get(e.candidate_text);
  if (!qid || !did || e.memory_ir_text === undefined) continue;
  const rendered = renderMemoryIRDoc(irLookup(qid, `mem_${did}`), e.candidate_text);
  serveCompared++; if (rendered !== e.memory_ir_text) serveMismatch++;
}
// (b) wiring: the scorer in rerankerMemoryIRMode='full' actually emits the protocol header for header docs.
const captured = [];
const cap = { async score(pairs) { for (const p of pairs) captured.push(p.document); return pairs.map(() => 0.5); } };
const opts = { ...scoringOptionsFromProfile(r5, { ...rt, reranker: cap }), rerankerMemoryIRMode: 'full', rerankerMemoryIRLookup: irLookup, policyGenericEntityIds: ['e_universe'] };
const pack = deriveQueryPack(1, '0x' + 'f3'.repeat(32), corpus, { ...r5.hiddenPack, packSize: 120, quotas: [] });
await evaluateRetrievalBenchmarkState(finalState, corpus, pack, opts);
const headerEmitted = captured.filter((s) => s.startsWith('[memory_ir ')).length;
ok('4 train/serve-equality (full IR)', serveMismatch === 0 && serveCompared > 0 && headerEmitted > 0,
  `scorer full-IR render == exporter memory_ir_text: ${serveCompared} compared, ${serveMismatch} mismatch; scorer emitted ${headerEmitted}/${captured.length} [memory_ir] headers`);
if (typeof reranker.close === 'function') reranker.close();

// GATE 5 — DETERMINISM: re-export with the SAME full invocation (incl. supplement + split) and hash-compare.
const splitArg = flag('split', null);
const supp = flag('supplement', null), suppLedger = flag('supplement-ledger', null);
const h = (p) => createHash('sha256').update(readFileSync(resolve(repoRoot, p))).digest('hex');
const reexport = `node ${process.env.NODE_OPTIONS ? '' : ''}scripts/export-memoryops-training-data.mjs --corpus ${corpusPath} --from-ledger ${ledgerPath}`
  + `${supp ? ` --supplement ${supp}${suppLedger ? ` --supplement-ledger ${suppLedger}` : ''}` : ''}`
  + `${splitArg ? ' --split ' + splitArg : ''} --out /tmp/memops-det2.jsonl`;
sh(reexport, { cwd: repoRoot, stdio: 'ignore', env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=8192' } });
ok('5 determinism', h(memopsPath) === h('/tmp/memops-det2.jsonl'), `two exports ${h(memopsPath) === h('/tmp/memops-det2.jsonl') ? 'identical' : 'DIFFER'}`);

// GATE 6 — SPLIT-safety: train/validation/heldout disjoint by the SPLIT KEY (query subject entity, the
// entity-disjoint axis), recorded in the _split_key provenance field (NOT the doc subject_scope feature).
const bySplit = { train: new Set(), validation: new Set(), heldout_future: new Set() };
for (const e of memops) (bySplit[e.split] ?? (bySplit[e.split] = new Set())).add(e._split_key);
const inter = (a, b) => [...a].filter((x) => b.has(x)).length;
const overlaps = inter(bySplit.train, bySplit.validation) + inter(bySplit.train, bySplit.heldout_future) + inter(bySplit.validation, bySplit.heldout_future);
ok('6 split-safety', overlaps === 0, `subject overlap across splits = ${overlaps} (must be 0)`);

console.log(`\n${fail.length === 0 ? '✅ ALL GATES PASS — pipeline launch-safe, GPU training unblocked.' : '❌ GATES FAILED: ' + fail.join(', ')}`);
process.exit(fail.length === 0 ? 0 : 1);
