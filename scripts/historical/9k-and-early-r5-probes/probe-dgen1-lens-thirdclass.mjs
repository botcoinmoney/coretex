#!/usr/bin/env node
/**
 * Phase 2 — EMPIRICAL THIRD-CLASS PROBE (runbook §2): is there an honest, miner-facing
 * RETRIEVAL_KEYS / dense-lens strategy class on DGEN-1, distinct from relation-edge routing
 * and temporal-record currency?
 *
 * MECHANISM UNDER TEST. The lens is a STATIC bank of <=36 dense vectors written to the
 * RETRIEVAL_KEYS substrate region (words 384-671). At scoring time the scorer adds
 *   lensBonus = lensWeight * max_s cos(docVec, lensVec_s)
 * to EVERY pool doc's pre-rank + final score (retrieval-benchmark.ts §"Stage 2 bonuses").
 * The bank is NOT query-conditioned: the same <=36 vectors apply to every hidden query.
 *
 * HONEST (proposer-visible, NON-oracle) constraint (runbook §2A). Lens vectors are built
 * ONLY from train_visible + calibration structure: visible-split direct-answer doc
 * embeddings, family/grounding metadata, hard-negative separation, visible centroids.
 * FORBIDDEN: eval_hidden/canary truth docs, the hidden query's own answer edges,
 * query-local answer centroids, qrel-derived hidden labels, oracle answer-region vectors.
 *
 * ISOLATION (runbook §2B/2C). The lens arm runs with relation routing OFF
 * (categoryLensExpansionBudget=0) and temporal modulation OFF (boost/suppress=0), so the
 * ONLY substrate signal that can move a doc is the lens. OFF arm = empty substrate
 * (pure bi-cosine + reranker). Any ON-over-OFF lift is therefore attributable to
 * RETRIEVAL_KEYS. Attribution is computed from the scorer's already-exposed
 * cappedDocComponents.lensBonus (no scorer change), cross-checked against paired OFF/ON
 * rank movement — a doc counts as "via retrieval key" only if it entered top-10 under ON,
 * was outside top-10 under OFF, and lensBonus was its dominant admission component.
 *
 * BANKS:
 *   family-centroid : per-family centroid of visible direct-answer doc vecs (<=6 vecs)
 *   kmeans          : k-means(36) over all visible direct-answer doc vecs (max coverage/diversity)
 *   posneg          : per-family (answer-centroid - hardneg-centroid) discriminative direction
 *   random          : 36 seeded random unit vectors           [ANTI-CHEAT control: must not lift]
 *   hillclimb       : greedily select visible-answer vecs to maximize CALIBRATION bi-cosine
 *                     nDCG@10, then test transfer to eval_hidden [ADAPTIVE-GAMING control]
 *
 * Usage:
 *   node scripts/probe-dgen1-lens-thirdclass.mjs --corpus <c.json> --emb <e.json> \
 *     --bank all|family-centroid|kmeans|posneg|random|hillclimb \
 *     --reranker deterministic|gpu --pack-size 36 --pack-seed a5 --lens-weight <w> --out <dir>
 */
import { distIndex, repoRoot } from './_repo-root.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync, spawn } from 'node:child_process';

// ── persistent stream reranker (copied from p05-production-bridge.mjs) ──
function streamReranker({ model, revision, python, allowCuda }) {
  const env = { ...process.env, CORETEX_RERANKER_STREAM_MODEL_ID: model, CORETEX_RERANKER_STREAM_REVISION: revision,
    HF_HUB_CACHE: process.env.HF_HUB_CACHE ?? '/var/lib/coretex/model-cache', HF_HUB_OFFLINE: process.env.HF_HUB_OFFLINE ?? '1' };
  if (allowCuda) { env.CORETEX_RERANKER_ALLOW_CUDA = '1'; delete env.CUDA_VISIBLE_DEVICES; } else { env.CUDA_VISIBLE_DEVICES = ''; }
  const proc = spawn(python, [resolve(repoRoot, 'scripts/reranker_runner.py'), '--stream'], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = '', nextId = 0; const pending = new Map(); let readyResolve; const readyP = new Promise((r) => { readyResolve = r; });
  proc.stdout.on('data', (d) => {
    buf += d.toString(); let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.ready) { readyResolve(); continue; }
      if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    }
  });
  proc.on('exit', (code) => { for (const [, r] of pending) r({ error: `reranker stream exited ${code}` }); });
  return {
    async score(pairs) {
      if (!pairs || pairs.length === 0) return [];
      await readyP;
      const id = nextId++;
      const p = new Promise((res) => pending.set(id, res));
      proc.stdin.write(JSON.stringify({ id, pairs: pairs.map((x) => ({ query: x.query, document: x.document })) }) + '\n');
      const msg = await p;
      if (msg.error) throw new Error(msg.error);
      return msg.scores;
    },
    close() { try { proc.stdin.end(); } catch { /* noop */ } },
  };
}

const argv = process.argv.slice(2);
const START_T = Date.now();
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const corpusPath = flag('corpus', 'release/calibration/2026-05-21-memory-corpus-v2/dgen1-smoke-corpus.json');
const embPath = flag('emb', 'release/calibration/2026-05-21-memory-corpus-v2/dgen1-smoke-embeddings.json');
const packSize = Number(flag('pack-size', '36'));
const rerankCap = Number(flag('rerank-cap', '64'));
const rerankerArg = flag('reranker', 'deterministic');
const bankArg = flag('bank', 'all');
const packSeed = flag('pack-seed', 'a5');
const outDir = flag('out', 'release/calibration/2026-05-21-memory-corpus-v2/dgen1-rework');
const lensWeightOverride = (() => { const i = argv.indexOf('--lens-weight'); return i >= 0 ? Number(argv[i + 1]) : undefined; })();
const KMEANS_K = Number(flag('kmeans-k', '36'));

const {
  evaluateRetrievalBenchmarkState, biEncoderModelIdHash, computeCorpusRoot,
  createDeterministicReranker, rerankerFromEnv, encodeRetrievalKeySlot, scoringOptionsFromProfile,
} = await import(distIndex);

// ── bundle bi-encoder pin + layout ──
const manifest = JSON.parse(readFileSync(resolve(repoRoot, 'release/bundle/bundle-manifest-v2-ownerscope-candidate.json'), 'utf8'));
const BE = manifest.model.biEncoder;
const LAYOUT = { dim: BE.retrievalKeyLayout.dim, quantization: BE.retrievalKeyLayout.quantization, headerBytes: BE.retrievalKeyLayout.headerBytes };
const biEncoderHash = biEncoderModelIdHash(BE.modelId, BE.revision, 'dense');

// ── load corpus + embeddings; keep BOTH float (for lens math) and int8 (wire) forms ──
const logical = JSON.parse(readFileSync(corpusPath, 'utf8'));
const cache = JSON.parse(readFileSync(embPath, 'utf8'));
const b64ToVec = (b) => { const buf = Buffer.from(b, 'base64'); return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4); };
function int8Bytes(vec) {
  let maxAbs = 0; for (let i = 0; i < LAYOUT.dim; i++) maxAbs = Math.max(maxAbs, Math.abs(vec[i] ?? 0));
  const scale = maxAbs > 0 ? maxAbs / 127 : 1;
  const out = new Uint8Array(4 + LAYOUT.dim);
  new DataView(out.buffer).setFloat32(0, scale, false);
  for (let i = 0; i < LAYOUT.dim; i++) { let c = Math.round((vec[i] ?? 0) / scale); c = Math.max(-127, Math.min(127, c)); out[4 + i] = c & 0xff; }
  return out;
}
const docVecF = new Map(logical.docs.map((d) => [d.id, b64ToVec(cache.docs[d.id])]));
const qVecF = new Map(logical.queries.map((q) => [q.id, b64ToVec(cache.queries[q.id])]));
const docEmb = new Map(logical.docs.map((d) => [d.id, int8Bytes(docVecF.get(d.id))]));
const qEmb = new Map(logical.queries.map((q) => [q.id, int8Bytes(qVecF.get(q.id))]));
const docById = new Map(logical.docs.map((d) => [d.id, d]));

// ── ProductionCorpus build (same mapping as p05-production-bridge.mjs, owner-scoped) ──
const bucket = (fam) => fam === 'temporal_update' ? 'temporal'
  : (fam === 'multi_session_bridge' || fam === 'causal_memory_chain' || fam === 'decision_provenance') ? 'multi_hop_relation'
  : 'near_collision';
const PROV = { source: 'synthetic_challenge', sourceHash: '0x' + '00'.repeat(32) };
const mkEmb = (queryBytes, perTruth, perNeg) => ({ modelId: BE.modelId, revision: BE.revision, layout: LAYOUT, query: queryBytes, perTruth: new Map(perTruth), perNegative: new Map(perNeg) });
const memId = (docId) => `mem_${docId}`;
const events = [];
const relBySrc = new Map();
for (const r of logical.relations) { if (!relBySrc.has(r.src)) relBySrc.set(r.src, []); relBySrc.get(r.src).push(r); }
for (const d of logical.docs) {
  const emb = docEmb.get(d.id);
  events.push({ id: memId(d.id), family: 'near_collision', domain: d.lane, split: 'train_visible', queryText: d.text,
    truthDocuments: [{ id: d.id, text: d.text, isCurrent: d.currentStaleFlag === false ? false : true }],
    hardNegatives: [], qrels: [{ documentId: d.id, relevance: 1.0 }], protected: false,
    relations: (relBySrc.get(d.id) ?? []).map((r) => ({ other_id: memId(r.dst), edgeType: r.type })),
    ...(Array.isArray(d.entityIds) && d.entityIds.length > 0 ? { entityIds: d.entityIds } : {}),
    provenance: PROV, embeddings: mkEmb(emb, [[d.id, emb]], []) });
}
for (const q of logical.queries) {
  if (q.abstain) continue;
  const fam = bucket(q.family);
  const truths = (q.qrels ?? []).filter((r) => r.relevance > 0).map((r) => {
    const d = docById.get(r.docId); return { id: r.docId, text: d.text, isCurrent: d.currentStaleFlag === false ? false : true };
  });
  const negs = (q.hardNegatives ?? []).map((n) => ({ id: n.docId, text: docById.get(n.docId).text, category: n.category }));
  const ev = { id: q.id, family: fam, domain: q.lane, split: q.split ?? 'eval_hidden', queryText: q.queryText,
    truthDocuments: truths, hardNegatives: negs, qrels: (q.qrels ?? []).map((r) => ({ documentId: r.docId, relevance: r.relevance })),
    protected: false, relations: [],
    ...(q.ownerEntityId !== undefined ? { ownerEntityId: q.ownerEntityId, ownerScoped: q.ownerScoped !== false } : {}),
    provenance: PROV, embeddings: mkEmb(qEmb.get(q.id), truths.map((t) => [t.id, docEmb.get(t.id)]), negs.map((n) => [n.id, docEmb.get(n.id)])) };
  if (fam === 'temporal') ev.temporal = { validFromEpoch: 1, validUntilEpoch: Number.MAX_SAFE_INTEGER, currentStaleFlag: false };
  events.push(ev);
}
const corpusRoot = computeCorpusRoot(events);
const corpus = { events, byId: new Map(events.map((e) => [e.id, e])), corpusRoot, corpusEpoch: 0,
  entities: (logical.entities ?? []).map((e) => ({ id: e.id, canonicalName: e.canonicalName, aliases: e.aliases ?? [] })),
  biEncoderModelId: BE.modelId, biEncoderRevision: BE.revision, biEncoderRetrievalKeyLayout: LAYOUT,
  labelingModelId: manifest.model.reranker.modelId, labelingModelRevision: manifest.model.reranker.revision };

// ── lens vector helpers ──
const DIM = LAYOUT.dim;
function zeros() { return new Float32Array(DIM); }
function addInto(acc, v) { for (let i = 0; i < DIM; i++) acc[i] += (v[i] ?? 0); }
function scaleInPlace(v, s) { for (let i = 0; i < DIM; i++) v[i] *= s; }
function normalize(v) { let n = 0; for (let i = 0; i < DIM; i++) n += v[i] * v[i]; n = Math.sqrt(n) || 1; const o = new Float32Array(DIM); for (let i = 0; i < DIM; i++) o[i] = v[i] / n; return o; }
function cos(a, b) { let d = 0, na = 0, nb = 0; for (let i = 0; i < DIM; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return d / (Math.sqrt(na) * Math.sqrt(nb) || 1); }
function centroid(vecs) { if (!vecs.length) return null; const acc = zeros(); for (const v of vecs) addInto(acc, v); scaleInPlace(acc, 1 / vecs.length); return normalize(acc); }

// ── PUBLIC (proposer-visible) structure: train_visible + calibration only ──
const PUBLIC_SPLITS = new Set(['train_visible', 'calibration']);
const visibleQ = logical.queries.filter((q) => !q.abstain && PUBLIC_SPLITS.has(q.split ?? 'eval_hidden'));
const directAnswerVec = (q) => { const a = (q.qrels ?? []).find((r) => r.role === 'direct'); return a ? docVecF.get(a.docId) : null; };
const visAnswersByFam = new Map();
const visNegsByFam = new Map();
for (const q of visibleQ) {
  const av = directAnswerVec(q); if (av) { if (!visAnswersByFam.has(q.family)) visAnswersByFam.set(q.family, []); visAnswersByFam.get(q.family).push(av); }
  for (const n of (q.hardNegatives ?? [])) { const nv = docVecF.get(n.docId); if (nv) { if (!visNegsByFam.has(q.family)) visNegsByFam.set(q.family, []); visNegsByFam.get(q.family).push(nv); } }
}
const allVisAnswerVecs = [...visAnswersByFam.values()].flat();

// deterministic RNG for random/kmeans-init/hillclimb
function rng(seedStr) { let s = 2166136261 >>> 0; for (const c of seedStr) { s ^= c.charCodeAt(0); s = Math.imul(s, 16777619); } return () => { s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 1) >>> 0; return s / 4294967296; }; }

function bankFamilyCentroid() {
  const out = [];
  for (const [, vecs] of [...visAnswersByFam.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) { const c = centroid(vecs); if (c) out.push(c); }
  return out.slice(0, 36);
}
function bankPosNeg() {
  const out = [];
  for (const fam of [...visAnswersByFam.keys()].sort()) {
    const ac = centroid(visAnswersByFam.get(fam) ?? []); const nc = centroid(visNegsByFam.get(fam) ?? []);
    if (!ac) continue; if (!nc) { out.push(ac); continue; }
    const diff = zeros(); for (let i = 0; i < DIM; i++) diff[i] = ac[i] - nc[i]; out.push(normalize(diff));
  }
  return out.slice(0, 36);
}
function bankKmeans(k) {
  const data = allVisAnswerVecs; if (data.length === 0) return [];
  const kk = Math.min(k, data.length); const r = rng(`kmeans:${packSeed}`);
  // k-means++ style spread init
  const centers = [normalize(data[Math.floor(r() * data.length)])];
  while (centers.length < kk) {
    let best = null, bestD = -1;
    for (let t = 0; t < 64; t++) { const cand = data[Math.floor(r() * data.length)]; let mind = Infinity; for (const c of centers) mind = Math.min(mind, 1 - cos(cand, c)); if (mind > bestD) { bestD = mind; best = cand; } }
    centers.push(normalize(best));
  }
  for (let iter = 0; iter < 12; iter++) {
    const buckets = Array.from({ length: kk }, () => []);
    for (const v of data) { let bi = 0, bs = -Infinity; for (let i = 0; i < kk; i++) { const s = cos(v, centers[i]); if (s > bs) { bs = s; bi = i; } } buckets[bi].push(v); }
    for (let i = 0; i < kk; i++) { const c = centroid(buckets[i]); if (c) centers[i] = c; }
  }
  return centers;
}
function bankRandom() { const r = rng(`random:${packSeed}`); const out = []; for (let s = 0; s < 36; s++) { const v = new Float32Array(DIM); for (let i = 0; i < DIM; i++) v[i] = r() * 2 - 1; out.push(normalize(v)); } return out; }

// hillclimb: greedily pick visible-answer vecs maximizing CALIBRATION bi-cosine nDCG@10
// (cheap proxy, no reranker), then test transfer to eval_hidden. Adaptive-gaming control.
function biCosineNdcgProxy(lensVecs, calibQ, lw) {
  // per calib query: rank a small candidate set (qrels + hardNegs + sampled owner docs) by biCosine + lensBonus
  const r = rng(`proxy:${packSeed}`);
  let sum = 0, n = 0;
  for (const q of calibQ) {
    const qv = qVecF.get(q.id); if (!qv) continue;
    const cands = new Map();
    for (const rl of (q.qrels ?? [])) cands.set(rl.docId, rl.relevance);
    for (const nn of (q.hardNegatives ?? [])) if (!cands.has(nn.docId)) cands.set(nn.docId, 0);
    // sample owner docs as filler negatives
    for (let t = 0; t < 60; t++) { const d = logical.docs[Math.floor(r() * logical.docs.length)]; if (!cands.has(d.id)) cands.set(d.id, 0); }
    const scored = [...cands.keys()].map((id) => {
      const dv = docVecF.get(id); let lmax = 0; for (const lv of lensVecs) { const c = cos(dv, lv); if (c > lmax) lmax = c; }
      return { id, rel: cands.get(id), s: cos(qv, dv) + lw * lmax };
    }).sort((a, b) => b.s - a.s);
    // nDCG@10
    let dcg = 0; for (let i = 0; i < Math.min(10, scored.length); i++) dcg += scored[i].rel / Math.log2(i + 2);
    const ideal = [...cands.values()].sort((a, b) => b - a); let idcg = 0; for (let i = 0; i < Math.min(10, ideal.length); i++) idcg += ideal[i] / Math.log2(i + 2);
    if (idcg > 0) { sum += dcg / idcg; n++; }
  }
  return n ? sum / n : 0;
}
function bankHillclimb(lw) {
  const calibQ = logical.queries.filter((q) => !q.abstain && (q.split === 'calibration') && (q.qrels ?? []).some((r) => r.role === 'direct'));
  const pool = allVisAnswerVecs.slice(0, 240);
  if (!pool.length || !calibQ.length) return [];
  const chosen = []; let curScore = 0;
  for (let slot = 0; slot < 36; slot++) {
    let best = null, bestScore = curScore;
    for (const cand of pool) {
      const trial = chosen.concat([cand]);
      const sc = biCosineNdcgProxy(trial, calibQ, lw);
      if (sc > bestScore + 1e-6) { bestScore = sc; best = cand; }
    }
    if (!best) break; chosen.push(best); curScore = bestScore;
  }
  return chosen.length ? chosen : [pool[0]];
}

const RK_START = 384, WORDS_PER_SLOT = 8;
const emptyWords = () => new Array(1024).fill(0n);
function lensSubstrate(lensVecs) {
  const words = emptyWords();
  for (let s = 0; s < Math.min(36, lensVecs.length); s++) {
    const vec = lensVecs[s];
    let norm = 0; for (let i = 0; i < DIM; i++) norm += vec[i] * vec[i]; norm = Math.sqrt(norm) || 1;
    const slotWords = encodeRetrievalKeySlot({ versionTag: 1, modelIdHash: biEncoderHash, l2Norm: norm, quantizedBytes: int8Bytes(vec) }, { retrievalKeyHeaderBytes: LAYOUT.headerBytes });
    for (let j = 0; j < WORDS_PER_SLOT; j++) words[RK_START + s * WORDS_PER_SLOT + j] = slotWords[j];
  }
  return { words };
}
function bankDiversity(lensVecs) { // mean pairwise cosine across active lenses (lower = more diverse)
  if (lensVecs.length < 2) return null; let sum = 0, n = 0;
  for (let i = 0; i < lensVecs.length; i++) for (let j = i + 1; j < lensVecs.length; j++) { sum += cos(lensVecs[i], lensVecs[j]); n++; }
  return n ? +(sum / n).toFixed(4) : null;
}

// ── eval slice: split-pure eval_hidden, seed-shuffled, family-balanced up to packSize ──
function hseed(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
const shuf = (arr) => arr.map((x) => [x, hseed(`${packSeed}:${x.id}`)]).sort((a, b) => a[1] - b[1]).map((p) => p[0]);
const evalQ = shuf(logical.queries.filter((q) => !q.abstain && (q.split ?? 'eval_hidden') === 'eval_hidden' && (q.qrels ?? []).some((r) => r.role === 'direct')));
const pack = evalQ.slice(0, packSize).map((q) => corpus.byId.get(q.id));
const logQById = new Map(logical.queries.map((q) => [q.id, q]));

// ── scoring options: lens ACTIVE, relation OFF, temporal OFF (isolated lens arm) ──
const biEncoder = { modelId: BE.modelId, revision: BE.revision, layout: LAYOUT, async encode() { throw new Error('embeddings pre-baked'); } };
const RR = manifest.model.reranker;
const reranker = rerankerArg === 'gpu' || rerankerArg === 'cpu'
  ? streamReranker({ model: RR.modelId, revision: RR.revision, python: process.env.CORETEX_RERANKER_PYTHON ?? '/usr/bin/python3', allowCuda: rerankerArg === 'gpu' })
  : rerankerArg === 'env' ? await rerankerFromEnv() : await createDeterministicReranker();
const V2_PROFILE = JSON.parse(readFileSync(resolve(repoRoot, flag('profile', 'release/bundle/evaluator-profile-v2-ownerscope-r1.json')), 'utf8'));
const baseOpts = {
  ...scoringOptionsFromProfile(V2_PROFILE, { biEncoder, reranker, biEncoderHash, retrievalKeyLayout: LAYOUT }),
  firstStageTopK: V2_PROFILE.firstStageTopK ?? 3200,
  rerankerInputTopK: rerankCap,
  categoryLensExpansionBudget: 0,        // relation routing OFF
  temporalCurrentBoost: 0,               // temporal OFF
  temporalStaleSuppression: 0,
  anchorWeight: 0,                        // no anchors anyway; keep explicit
  ownerScopeMode: V2_PROFILE.ownerScopeMode ?? 'restrict',
  pipelineVersion: 'coretex-retrieval-v2-lens-r3',
  ...(lensWeightOverride !== undefined ? { lensWeight: lensWeightOverride } : {}),
};
const LENS_WEIGHT = baseOpts.lensWeight;
const mkPack = (evs) => ({ epochId: 0, evalSeedCommit: '0x' + (packSeed.length >= 2 ? packSeed.slice(0, 2) : 'a5').repeat(32), corpusRoot, events: evs });

// ── metrics ──
function ndcgRecallByFamily(score) {
  const overall = { nDCG10: score.nDCG10, recall10: score.recall10 };
  const byFam = {};
  for (const pq of score.perQuery ?? []) {
    const lf = logQById.get(pq.recordId)?.family ?? '?';
    byFam[lf] = byFam[lf] || { n: 0 };
    byFam[lf].n++;
  }
  return { overall, byFam };
}
// answerViaRetrievalKey@10 + induced lens junk, paired ON vs OFF
function lensAttribution(onScore, offScore) {
  const offByRec = new Map((offScore.perQuery ?? []).map((pq) => [pq.recordId, pq]));
  let n = 0, viaRK = 0; const junkArr = [];
  for (const on of onScore.perQuery ?? []) {
    const off = offByRec.get(on.recordId); if (!off) continue; n++;
    const lq = logQById.get(on.recordId);
    const ansDoc = (lq?.qrels ?? []).find((r) => r.role === 'direct')?.docId;
    const offRank = new Map((off.finalRankingTop20 ?? []).map((r) => [r.docId, r.rank]));
    const rankOff = (id) => offRank.get(id) ?? 999;
    const onTop = (on.finalRankingTop20 ?? []).filter((r) => r.rank <= 10);
    // dominant-lens component lookup from cappedDocComponents
    const capIdx = new Map((on.cappedDocIds ?? []).map((id, i) => [id, i]));
    const lensDominant = (docId) => {
      const i = capIdx.get(docId); if (i === undefined) return false;
      const c = (on.cappedDocComponents ?? [])[i]; if (!c) return false;
      const lb = c.lensBonus ?? 0;
      return lb > 0 && lb >= (c.anchorBonus ?? 0) && lb >= (c.categoryLensBonus ?? 0) && lb >= (c.temporalBonus ?? 0);
    };
    // answer surfaced via retrieval key: in ON top-10, OFF outside top-10, lens dominant
    if (ansDoc && onTop.some((r) => r.docId === ansDoc) && rankOff(ansDoc) > 10 && lensDominant(ansDoc)) viaRK++;
    // induced lens junk: irrelevant in ON top-10, OFF outside top-10, lens dominant
    let junk = 0; for (const r of onTop) { if ((r.relevance ?? 0) === 0 && rankOff(r.docId) > 10 && lensDominant(r.docId)) junk++; }
    junkArr.push(junk);
  }
  const sorted = [...junkArr].sort((a, b) => a - b);
  const pctl = (p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0;
  const mean = junkArr.length ? junkArr.reduce((a, b) => a + b, 0) / junkArr.length : 0;
  return { n, answerViaRetrievalKey10Rate: n ? +(viaRK / n).toFixed(3) : null,
    lensJunkTop10Mean: +mean.toFixed(3), lensJunkTop10P95: pctl(0.95), lensJunkTop10Max: sorted.length ? sorted[sorted.length - 1] : 0 };
}

// ── run one bank: OFF (empty) vs ON (bank) ──
const offState = { words: emptyWords() };
const offScore = await evaluateRetrievalBenchmarkState(offState, corpus, mkPack(pack), baseOpts);

const banksToRun = bankArg === 'all' ? ['family-centroid', 'kmeans', 'posneg', 'random', 'hillclimb'] : bankArg.split(',').map((s) => s.trim()).filter(Boolean);
const builders = {
  'family-centroid': () => bankFamilyCentroid(),
  'kmeans': () => bankKmeans(KMEANS_K),
  'posneg': () => bankPosNeg(),
  'random': () => bankRandom(),
  'hillclimb': () => bankHillclimb(LENS_WEIGHT),
};
const results = {};
for (const bank of banksToRun) {
  const t0 = Date.now();
  const lensVecs = builders[bank]();
  if (!lensVecs.length) { results[bank] = { error: 'no lens vectors built (no visible answers?)' }; continue; }
  const onScore = await evaluateRetrievalBenchmarkState(lensSubstrate(lensVecs), corpus, mkPack(pack), baseOpts);
  const off = ndcgRecallByFamily(offScore), on = ndcgRecallByFamily(onScore);
  const attr = lensAttribution(onScore, offScore);
  results[bank] = {
    isControl: bank === 'random' || bank === 'hillclimb',
    nLensVecs: lensVecs.length, diversityMeanPairwiseCos: bankDiversity(lensVecs),
    off: off.overall, on: on.overall,
    deltaNDCG10: +((on.overall.nDCG10 ?? 0) - (off.overall.nDCG10 ?? 0)).toFixed(4),
    deltaRecall10: +((on.overall.recall10 ?? 0) - (off.overall.recall10 ?? 0)).toFixed(4),
    attribution: attr,
    wallSec: +((Date.now() - t0) / 1000).toFixed(1),
  };
  console.error(`[lens-probe] bank=${bank} dNDCG=${results[bank].deltaNDCG10} dRecall=${results[bank].deltaRecall10} viaRK=${attr.answerViaRetrievalKey10Rate} junk(mean/p95/max)=${attr.lensJunkTop10Mean}/${attr.lensJunkTop10P95}/${attr.lensJunkTop10Max}`);
}

// ── gate (runbook §2D), applied to the best HONEST bank (non-control) ──
const honestBanks = banksToRun.filter((b) => b !== 'random' && b !== 'hillclimb' && results[b] && !results[b].error);
const controlBanks = banksToRun.filter((b) => (b === 'random' || b === 'hillclimb') && results[b] && !results[b].error);
const bestHonest = honestBanks.map((b) => ({ b, ...results[b] })).sort((a, b) => b.deltaNDCG10 - a.deltaNDCG10)[0];
const maxControlLift = Math.max(0, ...controlBanks.map((b) => Math.max(results[b].deltaNDCG10, results[b].deltaRecall10)));
const gate = bestHonest ? {
  bestHonestBank: bestHonest.b,
  liftOK: (bestHonest.deltaNDCG10 >= 0.02 || bestHonest.deltaRecall10 >= 0.02),
  attributionOK: (bestHonest.attribution.answerViaRetrievalKey10Rate ?? 0) > 0,
  junkOK: (bestHonest.attribution.lensJunkTop10Mean <= 1 && bestHonest.attribution.lensJunkTop10P95 <= 3 && bestHonest.attribution.lensJunkTop10Max <= 4),
  controlsOK: maxControlLift <= 0.01,
} : null;
if (gate) gate.PASS = gate.liftOK && gate.attributionOK && gate.junkOK && gate.controlsOK;

const gitSha = (() => { try { return execSync('git rev-parse --short HEAD', { cwd: repoRoot }).toString().trim(); } catch { return 'unknown'; } })();
const distHash = (() => { try { return execSync('sha256sum packages/cortex/dist/eval/retrieval-benchmark.js', { cwd: repoRoot }).toString().trim().slice(0, 16); } catch { return 'unknown'; } })();
const dirtyTree = (() => { try { return execSync('git status --porcelain', { cwd: repoRoot }).toString().trim().length > 0; } catch { return null; } })();
const report = {
  probe: 'dgen1-retrieval-keys-third-class', runbook: 'Phase 2 §2A-2D',
  provenance: { specVersion: logical.specVersion, phase: logical.phase, corpusPath, embPath, corpusRoot, gitSha,
    distHashRetrievalBenchmark: distHash, dirtyTree, reranker: rerankerArg === 'gpu' ? `Qwen/Qwen3-Reranker-0.6B@${RR.revision} (gpu)` : (rerankerArg === 'env' ? 'qwen-env' : 'deterministic-stub'),
    biEncoder: BE.modelId, layout: LAYOUT, lensWeight: LENS_WEIGHT, lensTopK: baseOpts.lensTopK, rerankerInputTopK: rerankCap, packSize: pack.length, packSeed,
    isolation: { categoryLensExpansionBudget: 0, temporalCurrentBoost: 0, temporalStaleSuppression: 0, anchorWeight: 0, ownerScopeMode: baseOpts.ownerScopeMode },
    publicSplitsUsed: [...PUBLIC_SPLITS], nVisibleAnswerVecs: allVisAnswerVecs.length },
  packFamilies: (() => { const h = {}; for (const e of pack) { const f = logQById.get(e.id)?.family ?? '?'; h[f] = (h[f] ?? 0) + 1; } return h; })(),
  offBaseline: { nDCG10: offScore.nDCG10, recall10: offScore.recall10 },
  banks: results,
  gate,
  cost: { wallClockSec: +((Date.now() - START_T) / 1000).toFixed(1) },
};
const suffix = rerankerArg === 'gpu' || rerankerArg === 'env' ? 'qwen' : 'det';
const phaseTag = (logical.phase || 'p').toLowerCase().replace(/[^a-z0-9]+/g, '');
const outName = `LENS_THIRDCLASS_${phaseTag}_${suffix}_${bankArg}_cap${rerankCap}_${packSeed}.json`;
writeFileSync(resolve(outDir, outName), JSON.stringify(report, null, 2));
console.error(`[lens-probe] wrote ${outName}`);
console.log(JSON.stringify(report, null, 2));
if (typeof reranker.close === 'function') reranker.close();
