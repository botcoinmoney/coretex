#!/usr/bin/env node
/**
 * P0.5 — production-scorer bridge. Confirms the Layer-5 proxy lift reproduces
 * through the REAL `evaluateRetrievalBenchmarkState` decoder/scorer path.
 *
 * Maps the logical V2 corpus → an in-memory ProductionCorpus (every doc becomes a
 * train_visible MEMORY event so the full ~1599-doc pool is present and answers stay
 * buried; every query becomes an eval_hidden QUERY event with relations to its
 * answer's memory event). Family-bucketed onto the decoder's 4-family code
 * (temporal_update→temporal; bridge/causal→multi_hop_relation; else near_collision).
 * Explicit splits, NO split:null.
 *
 * Two real compiled substrates vs an empty substrate (same pool, OFF/ON):
 *   - RELATION arm  : corpus-native categoryLensBFS over public supports/causes edges
 *                     (NO anchoring — driven by stage-1 finding the bridge + the edge).
 *   - TEMPORAL arm  : substrate memory slots + temporal records (suppress stale / boost current).
 * Reads finalRankingTop20 source attribution (categoryLensBFS / temporalBonus).
 *
 * Local gate: --reranker deterministic (plumbing + routing/source-attribution).
 * A100 confirm: --reranker env  (pinned Qwen-0.6B → real quality lift).
 *
 * Usage: node scripts/p05-production-bridge.mjs --corpus <logical.json> --emb <cache.json>
 *        [--pack-size 24] [--reranker deterministic|env] [--out dir]
 */
import { distIndex, repoRoot } from './_repo-root.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync, spawn } from 'node:child_process';

// Custom PERSISTENT stream reranker — loads model + CUDA ONCE (per-spawn CUDA init is
// ~5-8s, so one-shot-per-query times out). Drives reranker_runner.py --stream with our
// own request/response client (the Node stream wrapper deadlocked / wouldn't engage CUDA).
// Implements CrossEncoderReranker: score(pairs:{query,document}[]) -> Promise<number[]>.
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
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const corpusPath = flag('corpus', 'release/calibration/2026-05-21-memory-corpus-v2/p0-corpus.json');
const embPath = flag('emb', 'release/calibration/2026-05-21-memory-corpus-v2/p0-embeddings.json');
const packSize = Math.min(32, Number(flag('pack-size', '24')));
const rerankCap = Number(flag('rerank-cap', '128')); // rerankerInputTopK (lower → fewer Qwen pairs for CPU-bounded runs)
// Relation traversal mode. DEFAULT 'no-query' (P1.5 #2 quarantine): query-event query→answer relations are
// scorer/metric-only and must NEVER be traversed by categoryLensBFS. 'all' (legacy, LEAKY — reproduces the
// query→answer bookmark) and 'no-memory' (query-only) are kept for the leak-ablation smoke.
const relMode = flag('rel-mode', 'no-query');
const rerankerArg = flag('reranker', 'deterministic');
const outDir = flag('out', 'release/calibration/2026-05-21-memory-corpus-v2');

const {
  evaluateRetrievalBenchmarkState, biEncoderModelIdHash, computeCorpusRoot,
  createDeterministicBiEncoder, createDeterministicReranker, rerankerFromEnv, biEncoderFromEnv,
  encodeMemoryIndexSlot, encodeRelationCategoryLens, encodeTemporalRecord, stableRecordIdFor,
  DEFAULT_COMPOSITE_WEIGHTS,
} = await import(distIndex);

// ── bundle bi-encoder pin + layout ──
const manifest = JSON.parse(readFileSync(resolve(repoRoot, 'release/bundle/bundle-manifest-launch-v3.json'), 'utf8'));
const BE = manifest.model.biEncoder;
const LAYOUT = { dim: BE.retrievalKeyLayout.dim, quantization: BE.retrievalKeyLayout.quantization, headerBytes: BE.retrievalKeyLayout.headerBytes };
const biEncoderHash = biEncoderModelIdHash(BE.modelId, BE.revision, 'dense');

// ── load logical corpus + embedding cache; reconstruct int8 bytes ──
const logical = JSON.parse(readFileSync(corpusPath, 'utf8'));
const cache = JSON.parse(readFileSync(embPath, 'utf8'));
const b64ToVec = (b) => { const buf = Buffer.from(b, 'base64'); return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4); };
function int8Bytes(vec) { // reconstruct runner wire format: float32-BE scale + dim int8 codes
  let maxAbs = 0; for (const v of vec) maxAbs = Math.max(maxAbs, Math.abs(v));
  const scale = maxAbs > 0 ? maxAbs / 127 : 1;
  const out = new Uint8Array(4 + LAYOUT.dim);
  new DataView(out.buffer).setFloat32(0, scale, false);
  for (let i = 0; i < LAYOUT.dim; i++) { let c = Math.round((vec[i] ?? 0) / scale); c = Math.max(-127, Math.min(127, c)); out[4 + i] = c & 0xff; }
  return out;
}
const docEmb = new Map(logical.docs.map((d) => [d.id, int8Bytes(b64ToVec(cache.docs[d.id]))]));
const qEmb = new Map(logical.queries.map((q) => [q.id, int8Bytes(b64ToVec(cache.queries[q.id]))]));
const docById = new Map(logical.docs.map((d) => [d.id, d]));

const bucket = (fam) => fam === 'temporal_update' ? 'temporal'
  : (fam === 'multi_session_bridge' || fam === 'causal_memory_chain' || fam === 'decision_provenance') ? 'multi_hop_relation'
  : 'near_collision';
const PROV = { source: 'synthetic_challenge', sourceHash: '0x' + '00'.repeat(32) };
const mkEmb = (queryBytes, perTruth, perNeg) => ({ modelId: BE.modelId, revision: BE.revision, layout: LAYOUT, query: queryBytes, perTruth: new Map(perTruth), perNegative: new Map(perNeg) });

// ── build ProductionCorpus events ──
// MEMORY events first (so pool dedup assigns each doc's owner = its mem event), train_visible.
const memId = (docId) => `mem_${docId}`;
const events = [];
// logical doc->doc relations grouped by src doc
const relBySrc = new Map();
for (const r of logical.relations) { if (!relBySrc.has(r.src)) relBySrc.set(r.src, []); relBySrc.get(r.src).push(r); }
for (const d of logical.docs) {
  const emb = docEmb.get(d.id);
  events.push({
    id: memId(d.id), family: 'near_collision', domain: d.lane, split: 'train_visible',
    queryText: d.text,
    truthDocuments: [{ id: d.id, text: d.text, isCurrent: d.currentStaleFlag === false ? false : true }],
    hardNegatives: [], qrels: [{ documentId: d.id, relevance: 1.0 }], protected: false,
    relations: relMode === 'no-memory' ? [] : (relBySrc.get(d.id) ?? []).map((r) => ({ other_id: memId(r.dst), edgeType: r.type })),
    provenance: PROV, embeddings: mkEmb(emb, [[d.id, emb]], []),
  });
}
// QUERY events, eval_hidden.
for (const q of logical.queries) {
  if (q.abstain) continue;
  const fam = bucket(q.family);
  const truths = (q.qrels ?? []).filter((r) => r.relevance > 0).map((r) => {
    const d = docById.get(r.docId);
    const isCurrent = d.currentStaleFlag === false ? false : true;
    return { id: r.docId, text: d.text, isCurrent };
  });
  const negs = (q.hardNegatives ?? []).map((n) => ({ id: n.docId, text: docById.get(n.docId).text, category: n.category }));
  const perTruth = truths.map((t) => [t.id, docEmb.get(t.id)]);
  const perNeg = negs.map((n) => [n.id, docEmb.get(n.id)]);
  // answer doc = highest-relevance qrel; relation query->mem(answer) for multi-hop metric + routing
  const answer = [...(q.qrels ?? [])].sort((a, b) => b.relevance - a.relevance)[0];
  const relations = (relMode === 'no-query' || !answer) ? [] : [{ other_id: memId(answer.docId), edgeType: q.family === 'causal_memory_chain' ? 'causes' : 'supports' }];
  const ev = {
    id: q.id, family: fam, domain: q.lane, split: 'eval_hidden',
    queryText: q.queryText, truthDocuments: truths, hardNegatives: negs,
    qrels: (q.qrels ?? []).map((r) => ({ documentId: r.docId, relevance: r.relevance })),
    protected: false, relations,
    provenance: PROV, embeddings: mkEmb(qEmb.get(q.id), perTruth, perNeg),
  };
  if (fam === 'temporal') {
    ev.temporal = { validFromEpoch: 1, validUntilEpoch: Number.MAX_SAFE_INTEGER, currentStaleFlag: false };
  }
  events.push(ev);
}
const corpusRoot = computeCorpusRoot(events);
const corpus = {
  events, byId: new Map(events.map((e) => [e.id, e])), corpusRoot, corpusEpoch: 0,
  biEncoderModelId: BE.modelId, biEncoderRevision: BE.revision, biEncoderRetrievalKeyLayout: LAYOUT,
  labelingModelId: manifest.model.reranker.modelId, labelingModelRevision: manifest.model.reranker.revision,
};

// ── build packs (≤ packSize, split-pure eval_hidden) ──
const seedHex = '0x' + 'a5'.repeat(32);
const leverQ = (famLogical) => logical.queries.filter((q) => !q.abstain && q.family === famLogical).map((q) => corpus.byId.get(q.id));
const relationPack = [...leverQ('multi_session_bridge').slice(0, Math.floor(packSize / 2)), ...leverQ('causal_memory_chain').slice(0, packSize - Math.floor(packSize / 2))].slice(0, packSize);
const temporalPack = leverQ('temporal_update').slice(0, packSize);

// ── substrate states ──
const RANGES = { MEMORY_INDEX_START: 32, RELATIONS_START: 672, TEMPORAL_START: 800 };
const emptyWords = () => new Array(1024).fill(0n);

function relationSubstrate() {
  // categoryLensBFS: category-lens entries for supports/causes/supersedes at top entryIndices.
  const words = emptyWords();
  const edges = ['supports', 'causes', 'supersedes', 'coreference_of'];
  for (let i = 0; i < edges.length; i++) {
    words[RANGES.RELATIONS_START + (128 - 1 - i)] = encodeRelationCategoryLens({ entryIndex: 128 - 1 - i, edgeType: edges[i], weight: 0x8000 });
  }
  return { words };
}

function temporalSubstrate(pack) {
  // For each temporal query: memory slots for the stale + current doc's MEM events + a temporal record.
  const words = emptyWords();
  let slot = 0, rec = 0;
  for (const q of pack) {
    if (rec >= 12 || slot >= 42) break;
    const lq = logical.queries.find((x) => x.id === q.id);
    const cur = lq.qrels.find((r) => r.role === 'direct'); const stale = lq.qrels.find((r) => r.role === 'stale');
    if (!cur || !stale) continue;
    const staleSlot = slot++, curSlot = slot++;
    const sw = encodeMemoryIndexSlot({ slotIndex: staleSlot, recordId: stableRecordIdFor(memId(stale.docId)), family: 'temporal', domainBits: 1n, valid: true, revoked: true, protected: false, retrievalSlot: staleSlot, expiryEpoch: 0n });
    for (let j = 0; j < 8; j++) words[RANGES.MEMORY_INDEX_START + staleSlot * 8 + j] = sw[j];
    const cw = encodeMemoryIndexSlot({ slotIndex: curSlot, recordId: stableRecordIdFor(memId(cur.docId)), family: 'temporal', domainBits: 1n, valid: true, revoked: false, protected: false, retrievalSlot: curSlot, expiryEpoch: 0n });
    for (let j = 0; j < 8; j++) words[RANGES.MEMORY_INDEX_START + curSlot * 8 + j] = cw[j];
    const tw = encodeTemporalRecord({ recordIndex: rec, memorySlot: staleSlot, supersededBy: curSlot, validFromEpoch: 1n, validUntilEpoch: (2n ** 40n - 1n), currentStaleFlag: true });
    for (let j = 0; j < 8; j++) words[RANGES.TEMPORAL_START + rec * 8 + j] = tw[j];
    rec++;
  }
  return { words };
}

// ── scoring options ──
// Inert bi-encoder stub: the scorer never calls encode() (corpus/query embeddings are
// pre-baked), and createDeterministicBiEncoder is refused under CORETEX_RERANKER_PRODUCTION=1.
const biEncoder = { modelId: BE.modelId, revision: BE.revision, layout: LAYOUT, async encode() { throw new Error('biEncoder.encode not used — embeddings are pre-baked'); } };
const RR = manifest.model.reranker;
const reranker = rerankerArg === 'gpu' || rerankerArg === 'cpu'
  ? streamReranker({ model: RR.modelId, revision: RR.revision, python: process.env.CORETEX_RERANKER_PYTHON ?? '/usr/bin/python3', allowCuda: rerankerArg === 'gpu' })
  : rerankerArg === 'env' ? await rerankerFromEnv() : await createDeterministicReranker();
const baseOpts = {
  weights: DEFAULT_COMPOSITE_WEIGHTS, biEncoder, reranker, retrievalKeyLayout: LAYOUT, biEncoderHash,
  relationHopBudget: 3, abstentionThreshold: 0.001, rerankerTopK: 10, retrievalKeyTopK: 50,
  firstStageTopK: (() => { const i = argv.indexOf('--first-stage-topk'); return i >= 0 ? Number(argv[i + 1]) : 3200; })(), rerankerInputTopK: rerankCap, lensTopK: 36, lensWeight: 0.4, anchorWeight: 0.6,
  relationExpansionBudget: 12, categoryLensExpansionBudget: 0,
  temporalCurrentBoost: 0.1, temporalStaleSuppression: 0.1,
  pipelineVersion: 'coretex-retrieval-v2-lens-r3',
};
const lensBonusWeight = (() => { const i = argv.indexOf('--lens-bonus-weight'); return i >= 0 ? Number(argv[i + 1]) : undefined; })();
const catBudget = (() => { const i = argv.indexOf('--cat-budget'); return i >= 0 ? Number(argv[i + 1]) : 50; })();
const relOptsOff = { ...baseOpts, categoryLensExpansionBudget: 0 };
const relOptsOn = { ...baseOpts, categoryLensExpansionBudget: catBudget, categoryLensTraversalDirection: 'bidirectional',
  ...(lensBonusWeight !== undefined ? { categoryLensBonusWeight: lensBonusWeight } : {}) };
const tempOptsOff = { ...baseOpts, temporalCurrentBoost: 0, temporalStaleSuppression: 0 };
const tempOptsOn = { ...baseOpts, temporalCurrentBoost: 0.1, temporalStaleSuppression: 0.1 };

const mkPack = (evs) => ({ epochId: 0, evalSeedCommit: seedHex, corpusRoot, events: evs });

console.error(`[p05] corpus events=${events.length} (mem=${logical.docs.length}, query=${events.length - logical.docs.length}); relationPack=${relationPack.length} temporalPack=${temporalPack.length}; reranker=${rerankerArg}`);

// ── run arms ──
const empty = { words: emptyWords() };
const relOff = await evaluateRetrievalBenchmarkState(empty, corpus, mkPack(relationPack), relOptsOff);
const relOn = await evaluateRetrievalBenchmarkState(relationSubstrate(), corpus, mkPack(relationPack), relOptsOn);
const tmpOff = await evaluateRetrievalBenchmarkState(empty, corpus, mkPack(temporalPack), tempOptsOff);
const tmpOn = await evaluateRetrievalBenchmarkState(temporalSubstrate(temporalPack), corpus, mkPack(temporalPack), tempOptsOn);

// debug: inspect why memory-doc routing does/doesn't tag the answer (P1.5 #3)
if (argv.includes('--debug')) {
  const lq = new Map(logical.queries.map((q) => [q.id, q]));
  for (let i = 0; i < Math.min(3, relationPack.length); i++) {
    const ev = relationPack[i]; const pq = relOn.perQuery?.[i];
    const q = lq.get(ev.id);
    const answerDoc = [...(q.qrels ?? [])].sort((a, b) => b.relevance - a.relevance)[0]?.docId;
    const bridgeDoc = (q.qrels ?? []).find((r) => r.role === 'bridge')?.docId;
    const inCapped = (id) => { const k = (pq?.cappedDocIds ?? []).indexOf(id); return k >= 0 ? (pq.cappedDocSources?.[k] ?? []).join('+') : 'NOT-IN-POOL'; };
    const inTop20 = (id) => { const r = (pq?.finalRankingTop20 ?? []).find((x) => x.docId === id); return r ? `rank${r.rank}[${(r.sources ?? []).join('+')}]` : 'not-top20'; };
    console.error(`[debug] ${ev.id} answer=${answerDoc} bridge=${bridgeDoc}`);
    console.error(`   answer: pool=${inCapped(answerDoc)} | ${inTop20(answerDoc)}`);
    console.error(`   bridge: pool=${inCapped(bridgeDoc)} | ${inTop20(bridgeDoc)}`);
  }
}

// categoryLensBFS attribution: relevant doc in top-10 reached via categoryLensBFS
function bfsAttribution(score) {
  let n = 0, viaLens = 0;
  for (const pq of score.perQuery ?? []) {
    n++;
    const top = pq.finalRankingTop20 ?? [];
    if (top.some((r) => r.rank <= 10 && r.relevance >= 0.8 && (r.sources ?? []).includes('categoryLensBFS'))) viaLens++;
  }
  return { n, viaLens };
}
const gitSha = (() => { try { return execSync('git rev-parse --short HEAD', { cwd: repoRoot }).toString().trim(); } catch { return 'unknown'; } })();

const report = {
  provenance: { specVersion: logical.specVersion, corpusRoot, gitSha, reranker: (rerankerArg === 'env' || rerankerArg === 'gpu' || rerankerArg === 'cpu') ? `Qwen/Qwen3-Reranker-0.6B (${rerankerArg})` : 'deterministic-stub',
    biEncoder: BE.modelId, layout: LAYOUT, packSizeCap: packSize, rerankerInputTopK: rerankCap, relMode, splits: { memory: 'train_visible', queries: 'eval_hidden' } },
  relation: {
    pack: relationPack.map((e) => e.id), n: relationPack.length,
    off: { nDCG10: relOff.nDCG10, recall10: relOff.recall10, multiHopRecall10: relOff.multiHopRecall10, categoryLensRelationHit10: relOff.categoryLensRelationHit10 },
    on: { nDCG10: relOn.nDCG10, recall10: relOn.recall10, multiHopRecall10: relOn.multiHopRecall10, categoryLensRelationHit10: relOn.categoryLensRelationHit10 },
    attribution: { off: bfsAttribution(relOff), on: bfsAttribution(relOn) },
  },
  temporal: {
    pack: temporalPack.map((e) => e.id), n: temporalPack.length,
    off: { nDCG10: tmpOff.nDCG10, recall10: tmpOff.recall10, temporal: tmpOff.temporal },
    on: { nDCG10: tmpOn.nDCG10, recall10: tmpOn.recall10, temporal: tmpOn.temporal },
  },
};
const suffix = (rerankerArg === 'env' || rerankerArg === 'gpu' || rerankerArg === 'cpu') ? 'qwen' : 'det';
const relTag = relMode === 'all' ? '' : `_${relMode}`;
writeFileSync(resolve(outDir, `P05_PRODUCTION_BRIDGE_${suffix}${relTag}.json`), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (typeof reranker.close === 'function') reranker.close();
