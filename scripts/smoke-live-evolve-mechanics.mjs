#!/usr/bin/env node
/**
 * Fast CPU smoke for the canonical live-evolve churn mechanics. Proves at small scale that
 *   evolveCorpusDelta → embed → buildCorpusDelta → applyCorpusDelta
 * produces a real corpusRoot progression per epoch (NOT just frontier rotation on a fixed corpus).
 *
 * Hard-fails on any of:
 *   - addedDocs.length === 0 at the smoke churnFraction (no live churn signal)
 *   - delta.previousRoot != currentProd.corpusRoot
 *   - applyCorpusDelta.corpusRoot != delta.nextRoot
 *   - newProd.corpusRoot === currentProd.corpusRoot (no advance ⇒ harness is frontier-only)
 *   - frontier rebuild on newProd fails or activeRoot is zero
 *
 * Uses a deterministic reranker (no GPU) and skips baseline-scoring; the goal is mechanics, not
 * score numbers. Total wall-clock target: <30 seconds.
 *
 * Usage:
 *   node scripts/smoke-live-evolve-mechanics.mjs --profile <p> --corpus <c> --emb <e> [--epochs 2] [--churn-fraction 0.5]
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { argv, exit } from 'node:process';
import { distIndex, repoRoot } from './_repo-root.mjs';
import { evolveCorpusDelta } from './lib/evolve-corpus.mjs';
import { buildV2ProductionCorpus } from './lib/build-v2-production-corpus.mjs';
import { embedTexts } from './_embed-v2.mjs';

const C = await import(distIndex);
const { buildCorpusDelta, applyCorpusDelta, makeLaunchFrontier, splitForRecord } = C;

const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const PROFILE = flag('profile');
const CORPUS = flag('corpus');
const EMB = flag('emb');
const EPOCHS = Number(flag('epochs', '2'));
const CHURN = Number(flag('churn-fraction', '0.5')); // higher rate so smoke has signal at small N

if (!PROFILE || !CORPUS || !EMB) { console.error('HARD FAIL: --profile, --corpus, --emb required'); exit(1); }

function fail(m) { console.error(`SMOKE FAIL: ${m}`); exit(1); }
function pass(m) { console.log(`SMOKE PASS: ${m}`); }

const profile = JSON.parse(readFileSync(resolve(repoRoot, PROFILE), 'utf8'));
const { corpus: baseProd, BE, RR, LAYOUT } = buildV2ProductionCorpus({ corpusPath: CORPUS, embPath: EMB });
pass(`base corpus loaded — events=${baseProd.events.length} root=${baseProd.corpusRoot.slice(0, 18)}`);

let currentProd = baseProd;
let currentLogical = JSON.parse(readFileSync(resolve(repoRoot, CORPUS), 'utf8'));
const docTextById = new Map(currentLogical.docs.map((d) => [d.id, d]));
const labelingProvenance = { modelId: RR.modelId, revision: RR.revision, runtime: 'coretex-retrieval-v2-policy-r5', batchHash: '0x' + '00'.repeat(32) };
const PROV = { source: 'synthetic_challenge', sourceHash: '0x' + '00'.repeat(32) };
const memId = (id) => `mem_${id}`;
const bucket = (f) => f === 'temporal_update' ? 'temporal' : f === 'conflict_lifecycle' ? 'conflict_lifecycle' : 'near_collision';
function int8Bytes(vec) {
  let m = 0; for (const v of vec) m = Math.max(m, Math.abs(v));
  const s = m > 0 ? m / 127 : 1;
  const o = new Uint8Array(4 + LAYOUT.dim);
  new DataView(o.buffer).setFloat32(0, s, false);
  for (let i = 0; i < LAYOUT.dim; i++) { let c = Math.round((vec[i] ?? 0) / s); c = Math.max(-127, Math.min(127, c)); o[4 + i] = c & 0xff; }
  return o;
}

let prevRoot = baseProd.corpusRoot;
let prevActive = makeLaunchFrontier(profile, baseProd).stepEpoch(0, null, null).activeRoot;
if (!prevActive || /^0x0+$/.test(prevActive)) fail(`genesis activeRoot is zero/missing: ${prevActive}`);
pass(`genesis activeRoot non-zero ${prevActive.slice(0, 18)}`);

for (let epoch = 1; epoch <= EPOCHS; epoch++) {
  console.log(`--- epoch ${epoch} ---`);
  const ld = evolveCorpusDelta({ baseLogical: currentLogical, epoch, seed: 'coretex-smoke', churnFraction: CHURN });
  if (ld.addedDocs.length === 0) fail(`epoch ${epoch}: addedDocs.length === 0 at churnFraction=${CHURN} — no live churn signal`);
  pass(`epoch ${epoch} evolveCorpusDelta: +${ld.addedDocs.length} docs / +${ld.addedQueries.length} queries / churnRate=${ld.liveChurnRate.toFixed(3)}`);

  const docVecs = await embedTexts(ld.addedDocs.map((d) => d.text));
  const qVecs = ld.addedQueries.length ? await embedTexts(ld.addedQueries.map((q) => q.queryText)) : [];
  for (const d of ld.addedDocs) docTextById.set(d.id, d);
  const memEmb = new Map(); ld.addedDocs.forEach((d, i) => memEmb.set(d.id, int8Bytes(docVecs[i])));

  const additions = [];
  const relsBySrc = new Map();
  for (const r of ld.addedRelations) { if (!relsBySrc.has(r.src)) relsBySrc.set(r.src, []); relsBySrc.get(r.src).push(r); }
  ld.addedDocs.forEach((d) => {
    const e = memEmb.get(d.id);
    additions.push({
      id: memId(d.id), family: 'near_collision', domain: d.lane, split: 'train_visible', queryText: d.text,
      truthDocuments: [{ id: d.id, text: d.text, isCurrent: d.currentStaleFlag === false ? false : true }],
      hardNegatives: [], qrels: [{ documentId: d.id, relevance: 1.0 }], protected: false,
      relations: (relsBySrc.get(d.id) ?? []).map((r) => ({ other_id: memId(r.dst), edgeType: r.type, ...(r.label ? { label: r.label } : {}) })),
      ...(d.entityIds ? { entityIds: d.entityIds } : {}),
      provenance: PROV,
      embeddings: { modelId: BE.modelId, revision: BE.revision, layout: LAYOUT, query: e, perTruth: new Map([[d.id, e]]), perNegative: new Map() },
    });
  });
  ld.addedQueries.forEach((q, i) => {
    const qe = int8Bytes(qVecs[i]);
    const lookup = (id) => memEmb.get(id) ?? currentProd.byId.get(memId(id))?.embeddings?.perTruth?.get(id);
    const truths = (q.qrels ?? []).filter((r) => r.relevance > 0).map((r) => { const d = docTextById.get(r.docId); return { id: r.docId, text: d.text, isCurrent: d.currentStaleFlag === false ? false : true }; });
    const negs = (q.hardNegatives ?? []).map((n) => { const d = docTextById.get(n.docId); return { id: n.docId, text: d.text, category: n.category }; });
    const ev = {
      id: q.id, family: bucket(q.family), logicalFamily: q.family, domain: q.lane, split: splitForRecord(q.id, currentProd.corpusEpoch),
      queryText: q.queryText, truthDocuments: truths, hardNegatives: negs,
      qrels: (q.qrels ?? []).map((r) => ({ documentId: r.docId, relevance: r.relevance })), protected: false, relations: [],
      ...(q.band ? { band: q.band } : {}), ...(q.subjectEntityId !== undefined ? { subjectEntityId: q.subjectEntityId } : {}),
      ...(q.ownerEntityId !== undefined ? { ownerEntityId: q.ownerEntityId, ownerScoped: q.ownerScoped !== false } : {}),
      provenance: PROV,
      embeddings: { modelId: BE.modelId, revision: BE.revision, layout: LAYOUT, query: qe,
        perTruth: new Map(truths.map((t) => [t.id, lookup(t.id)])), perNegative: new Map(negs.map((n) => [n.id, lookup(n.id)])) },
    };
    if (ev.family === 'temporal') ev.temporal = { validFromEpoch: 1, validUntilEpoch: Number.MAX_SAFE_INTEGER, currentStaleFlag: false };
    additions.push(ev);
  });

  const delta = buildCorpusDelta({ previousCorpus: currentProd, additions, removals: [], epoch, labelingProvenance });
  if (delta.previousRoot.toLowerCase() !== currentProd.corpusRoot.toLowerCase()) fail(`epoch ${epoch}: delta.previousRoot ${delta.previousRoot} != currentProd.corpusRoot ${currentProd.corpusRoot}`);
  pass(`epoch ${epoch} buildCorpusDelta: previousRoot continuity ok, added=${delta.addedIds.length}`);

  const newProd = applyCorpusDelta(currentProd, delta);
  if (newProd.corpusRoot.toLowerCase() !== delta.nextRoot.toLowerCase()) fail(`epoch ${epoch}: applyCorpusDelta nextRoot mismatch`);
  if (newProd.corpusRoot.toLowerCase() === currentProd.corpusRoot.toLowerCase()) fail(`epoch ${epoch}: corpusRoot did NOT advance — this is the frontier-only failure mode`);
  pass(`epoch ${epoch} applyCorpusDelta: nextRoot match, ${currentProd.corpusRoot.slice(0,18)} → ${newProd.corpusRoot.slice(0,18)}`);

  const fr = makeLaunchFrontier(profile, newProd).stepEpoch(epoch, prevRoot, prevActive);
  if (!fr.activeRoot || /^0x0+$/.test(fr.activeRoot)) fail(`epoch ${epoch}: frontier activeRoot zero`);
  pass(`epoch ${epoch} frontier rebuild on newProd: activeRoot=${fr.activeRoot.slice(0,18)}`);

  currentLogical = { ...currentLogical, docs: [...currentLogical.docs, ...ld.addedDocs], relations: [...currentLogical.relations, ...ld.addedRelations], queries: [...currentLogical.queries, ...ld.addedQueries] };
  currentProd = newProd; prevRoot = newProd.corpusRoot; prevActive = fr.activeRoot;
}

console.log('SMOKE: ALL PASS ✅ — canonical live-evolve mechanics confirmed (real corpusRoot progression)');
exit(0);
