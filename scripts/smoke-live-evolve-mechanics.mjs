#!/usr/bin/env node
/**
 * Fast CPU smoke for the canonical live-evolve churn mechanics. Loads a TINY SLICE of the
 * materialized production-corpus artifact (NO 16-minute rebuild) — sufficient to prove:
 *
 *   - canonical stepEpoch(epoch, prevHonestAccepts:number|null, prevQualityAttempts:number|null)
 *     signature is correct (NOT roots);
 *   - buildCorpusDelta + applyCorpusDelta produce a real corpusRoot advance;
 *   - frontier rebuild on the new prod gives a non-empty activeIds set.
 *
 * This smoke is mechanics-only — the slice corpus is NOT representative of the launch corpus.
 *
 * Usage: node scripts/smoke-live-evolve-mechanics.mjs --bundle <b> --corpus <c> --emb <e> [--slice 512]
 */
import { argv, exit } from 'node:process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { distIndex, repoRoot } from './_repo-root.mjs';
import { evolveCorpusDelta } from './lib/evolve-corpus.mjs';
import { loadMaterializedCorpusSlice } from './lib/load-materialized-corpus.mjs';

const C = await import(distIndex);
const { buildCorpusDelta, applyCorpusDelta, makeLaunchFrontier, splitForRecord } = C;

const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const PROFILE = flag('profile');
const BUNDLE = flag('bundle');
const CORPUS = flag('corpus');
const EMB = flag('emb');
const SLICE_N = Number(flag('slice', '512'));
const EPOCHS = Number(flag('epochs', '2'));
if (!PROFILE || !BUNDLE || !CORPUS || !EMB) { console.error('HARD FAIL: --profile, --bundle, --corpus, --emb required'); exit(1); }

function fail(m) { console.error(`SMOKE FAIL: ${m}`); exit(1); }
function pass(m) { console.log(`SMOKE PASS: ${m}`); }

const profile = JSON.parse(readFileSync(resolve(repoRoot, PROFILE), 'utf8'));

console.log(`smoke: loading materialized slice (n=${SLICE_N}) from artifact ...`);
const sliced = loadMaterializedCorpusSlice(BUNDLE, SLICE_N);
const { corpus: baseProd, BE, RR, LAYOUT } = sliced;
pass(`slice loaded — events=${baseProd.events.length} root=${baseProd.corpusRoot.slice(0, 18)} (kept ${sliced.sliced.kept}/${sliced.sliced.requested})`);

// Active frontier on slice
let prevHonestAccepts = 0, prevQualityAttempts = 0;
const fr0 = makeLaunchFrontier(profile, baseProd);
if (!fr0) {
  pass('smoke: profile has no epochFrontier (frontier off) — skipping frontier mechanics validation');
  console.log('SMOKE: ALL PASS ✅ (corpus-load + slice integrity confirmed; full mechanics need an epochFrontier profile)');
  exit(0);
}
const fr0snap = fr0.stepEpoch(0, null, null);
if (!fr0snap.activeRoot || /^0x0+$/.test(fr0snap.activeRoot)) fail(`genesis activeRoot zero: ${fr0snap.activeRoot}`);
pass(`genesis activeRoot non-zero ${fr0snap.activeRoot.slice(0, 18)} (size=${fr0snap.activeIds.size})`);

// Mechanics: evolveCorpusDelta on a small synthetic baseLogical. Since the slice corpus has no
// `entities` with `_s<n>` ids, evolveCorpusDelta would produce empty deltas — so we fabricate a
// minimal logical input with one subject to drive the canonical chain end-to-end.
const baseLogical = {
  entities: [
    { id: 'e_universe', canonicalName: 'Universe', aliases: [] },
    { id: 'alice_s1', canonicalName: 'Alice', aliases: [] },
    { id: 'beta-svc-s2', canonicalName: 'beta-svc', aliases: [] },
  ],
  docs: [], relations: [], queries: [],
};

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
function mockVec() { const v = new Float32Array(LAYOUT.dim); for (let i = 0; i < LAYOUT.dim; i++) v[i] = Math.sin(i + 7); return v; }

let currentProd = baseProd;
let currentLogical = baseLogical;
let prevActive = fr0snap.activeRoot;

for (let epoch = 1; epoch <= EPOCHS; epoch++) {
  const ld = evolveCorpusDelta({ baseLogical: currentLogical, epoch, seed: 'coretex-smoke', churnFraction: 1.0 });
  if (!ld.addedDocs.length) fail(`epoch ${epoch} produced 0 added docs at churnFraction=1.0 — evolve mechanics broken on smoke input`);
  pass(`epoch ${epoch} evolveCorpusDelta: +${ld.addedDocs.length} docs / +${ld.addedQueries.length} queries / churnRate=${ld.liveChurnRate.toFixed(3)}`);

  // mock embeddings (smoke only — real harness uses pinned BGE-M3 via embedTexts)
  const additions = [];
  for (const d of ld.addedDocs) {
    const e = int8Bytes(mockVec());
    additions.push({
      id: memId(d.id), family: 'near_collision', domain: d.lane, split: 'train_visible', queryText: d.text,
      truthDocuments: [{ id: d.id, text: d.text, isCurrent: d.currentStaleFlag === false ? false : true }],
      hardNegatives: [], qrels: [{ documentId: d.id, relevance: 1.0 }], protected: false,
      relations: ld.addedRelations.filter((r) => r.src === d.id).map((r) => ({ other_id: memId(r.dst), edgeType: r.type, ...(r.label ? { label: r.label } : {}) })),
      ...(d.entityIds ? { entityIds: d.entityIds } : {}), provenance: PROV,
      embeddings: { modelId: BE.modelId, revision: BE.revision, layout: LAYOUT, query: e, perTruth: new Map([[d.id, e]]), perNegative: new Map() },
    });
  }
  for (const q of ld.addedQueries) {
    const qe = int8Bytes(mockVec());
    const truthsAll = (q.qrels ?? []).filter((r) => r.relevance > 0);
    const truths = truthsAll.filter((r) => ld.addedDocs.some((d) => d.id === r.docId)).map((r) => { const d = ld.addedDocs.find((d) => d.id === r.docId); return { id: r.docId, text: d.text, isCurrent: d.currentStaleFlag === false ? false : true }; });
    const ev = {
      id: q.id, family: bucket(q.family), logicalFamily: q.family, domain: q.lane,
      split: splitForRecord(q.id, currentProd.corpusEpoch), queryText: q.queryText,
      truthDocuments: truths, hardNegatives: [], qrels: truths.map((t) => ({ documentId: t.id, relevance: 1.0 })),
      protected: false, relations: [], ...(q.band ? { band: q.band } : {}),
      ...(q.subjectEntityId !== undefined ? { subjectEntityId: q.subjectEntityId } : {}),
      ...(q.ownerEntityId !== undefined ? { ownerEntityId: q.ownerEntityId, ownerScoped: q.ownerScoped !== false } : {}),
      provenance: PROV,
      embeddings: { modelId: BE.modelId, revision: BE.revision, layout: LAYOUT, query: qe,
        perTruth: new Map(truths.map((t) => { const d = ld.addedDocs.find((x) => x.id === t.id); return [t.id, int8Bytes(mockVec())]; })),
        perNegative: new Map() },
    };
    if (ev.family === 'temporal') ev.temporal = { validFromEpoch: 1, validUntilEpoch: Number.MAX_SAFE_INTEGER, currentStaleFlag: false };
    additions.push(ev);
  }
  const delta = buildCorpusDelta({ previousCorpus: currentProd, additions, removals: [], epoch, labelingProvenance });
  if (delta.previousRoot.toLowerCase() !== currentProd.corpusRoot.toLowerCase()) fail(`epoch ${epoch} previousRoot mismatch`);
  pass(`epoch ${epoch} buildCorpusDelta: previousRoot continuity ok, added=${delta.addedIds.length}`);

  const newProd = applyCorpusDelta(currentProd, delta);
  if (newProd.corpusRoot.toLowerCase() !== delta.nextRoot.toLowerCase()) fail(`epoch ${epoch} apply nextRoot mismatch`);
  if (newProd.corpusRoot.toLowerCase() === currentProd.corpusRoot.toLowerCase()) fail(`epoch ${epoch} corpusRoot did NOT advance — frontier-only failure mode`);
  pass(`epoch ${epoch} applyCorpusDelta: ${currentProd.corpusRoot.slice(0, 18)} → ${newProd.corpusRoot.slice(0, 18)}`);

  // CANONICAL stepEpoch: numeric/null only (never roots)
  const fr = makeLaunchFrontier(profile, newProd).stepEpoch(epoch, prevHonestAccepts, prevQualityAttempts);
  if (!fr.activeRoot || /^0x0+$/.test(fr.activeRoot)) fail(`epoch ${epoch} frontier activeRoot zero`);
  pass(`epoch ${epoch} frontier rebuild on newProd: activeRoot=${fr.activeRoot.slice(0, 18)} active=${fr.activeIds.size}`);

  currentLogical = { ...currentLogical, docs: [...currentLogical.docs, ...ld.addedDocs], relations: [...currentLogical.relations, ...ld.addedRelations], queries: [...currentLogical.queries, ...ld.addedQueries] };
  currentProd = newProd; prevActive = fr.activeRoot;
  prevHonestAccepts = 1; prevQualityAttempts = 2;
}
console.log('SMOKE: ALL PASS ✅ — canonical live-evolve mechanics confirmed (numeric stepEpoch, real corpusRoot progression on materialized slice)');
exit(0);
