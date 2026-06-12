#!/usr/bin/env node
/**
 * EvidencePolicy 3rd-class probe (EVIDENCE_POLICY_DESIGN.md). Tests whether an honest,
 * proposer-visible CODEBOOK policy atom (`high_density_evidence`, code=5) produces
 * accepted, non-junk hidden lift attributable to the CODEBOOK region — a third
 * miner-facing strategy class distinct from temporal records / relation edges / lenses.
 *
 * MECHANISM (additive, opt-in, default off — implemented in retrieval-benchmark.ts):
 * the policy atom asserts "boost candidates whose event has PUBLIC supports-edge
 * in-degree >= K, with weight W". In-degree is corpus-derived (public, auditable); the
 * miner writes only the POLICY (K, W), never a doc/query/answer map.
 *
 * HONESTY: K and W are chosen from PUBLIC (train_visible + calibration) supports
 * in-degree statistics only. Isolated arm: relation routing OFF + temporal OFF, so only
 * the policy can move a doc. OFF = policy disabled (default path). Attribution via paired
 * OFF/ON rank movement (no scorer change needed beyond the opt-in flag).
 *
 * NOTE (realism prerequisite): on a corpus where answers have supports in-degree ~1
 * (e.g. current DGEN-1), this probe is EXPECTED to show ~0 lift / flood — that is the
 * honest "no policy-rewarding structure" result, not a bug. Run it on a realistic
 * corroboration-density policy slice to test the surface fairly.
 *
 * Usage:
 *   node scripts/probe-dgen1-evidence-policy.mjs --corpus <c.json> --emb <e.json> \
 *     --bank high-density|random|hillclimb|all --reranker deterministic|gpu \
 *     --pack-size 36 --pack-seed a5 --out <dir>
 */
import { distIndex, repoRoot } from './_repo-root.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync, spawn } from 'node:child_process';

function streamReranker({ model, revision, python, allowCuda }) {
  const env = { ...process.env, CORETEX_RERANKER_STREAM_MODEL_ID: model, CORETEX_RERANKER_STREAM_REVISION: revision,
    HF_HUB_CACHE: process.env.HF_HUB_CACHE ?? '/var/lib/coretex/model-cache', HF_HUB_OFFLINE: process.env.HF_HUB_OFFLINE ?? '1' };
  if (allowCuda) { env.CORETEX_RERANKER_ALLOW_CUDA = '1'; delete env.CUDA_VISIBLE_DEVICES; } else { env.CUDA_VISIBLE_DEVICES = ''; }
  const proc = spawn(python, [resolve(repoRoot, 'scripts/reranker_runner.py'), '--stream'], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = '', nextId = 0; const pending = new Map(); let readyResolve; const readyP = new Promise((r) => { readyResolve = r; });
  proc.stdout.on('data', (d) => { buf += d.toString(); let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (!line.trim()) continue; let msg; try { msg = JSON.parse(line); } catch { continue; } if (msg.ready) { readyResolve(); continue; } if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } } });
  proc.on('exit', (code) => { for (const [, r] of pending) r({ error: `reranker stream exited ${code}` }); });
  return { async score(pairs) { if (!pairs || pairs.length === 0) return []; await readyP; const id = nextId++; const p = new Promise((res) => pending.set(id, res)); proc.stdin.write(JSON.stringify({ id, pairs: pairs.map((x) => ({ query: x.query, document: x.document })) }) + '\n'); const msg = await p; if (msg.error) throw new Error(msg.error); return msg.scores; }, close() { try { proc.stdin.end(); } catch { /* noop */ } } };
}

const argv = process.argv.slice(2);
const START_T = Date.now();
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const corpusPath = flag('corpus', 'release/calibration/2026-05-21-memory-corpus-v2/dgen1-corpus.json');
const embPath = flag('emb', 'release/calibration/2026-05-21-memory-corpus-v2/dgen1-embeddings.json');
const packSize = Number(flag('pack-size', '36'));
const rerankCap = Number(flag('rerank-cap', '64'));
const rerankerArg = flag('reranker', 'deterministic');
const bankArg = flag('bank', 'all');
const packSeed = flag('pack-seed', 'a5');
const outDir = flag('out', 'release/calibration/2026-05-21-memory-corpus-v2/dgen1-rework');

const {
  evaluateRetrievalBenchmarkState, biEncoderModelIdHash, computeCorpusRoot,
  createDeterministicReranker, rerankerFromEnv, encodeCodebookEntry, scoringOptionsFromProfile,
} = await import(distIndex);
const { RANGES } = await import(resolve(repoRoot, 'packages/coretex/dist/state/types.js'));

const manifest = JSON.parse(readFileSync(resolve(repoRoot, 'release/bundle/bundle-manifest-v2-ownerscope-candidate.json'), 'utf8'));
const BE = manifest.model.biEncoder;
const LAYOUT = { dim: BE.retrievalKeyLayout.dim, quantization: BE.retrievalKeyLayout.quantization, headerBytes: BE.retrievalKeyLayout.headerBytes };
const biEncoderHash = biEncoderModelIdHash(BE.modelId, BE.revision, 'dense');

const logical = JSON.parse(readFileSync(corpusPath, 'utf8'));
const cache = JSON.parse(readFileSync(embPath, 'utf8'));
const b64ToVec = (b) => { const buf = Buffer.from(b, 'base64'); return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4); };
function int8Bytes(vec) { let maxAbs = 0; for (let i = 0; i < LAYOUT.dim; i++) maxAbs = Math.max(maxAbs, Math.abs(vec[i] ?? 0)); const scale = maxAbs > 0 ? maxAbs / 127 : 1; const out = new Uint8Array(4 + LAYOUT.dim); new DataView(out.buffer).setFloat32(0, scale, false); for (let i = 0; i < LAYOUT.dim; i++) { let c = Math.round((vec[i] ?? 0) / scale); c = Math.max(-127, Math.min(127, c)); out[4 + i] = c & 0xff; } return out; }
const docEmb = new Map(logical.docs.map((d) => [d.id, int8Bytes(b64ToVec(cache.docs[d.id]))]));
const qEmb = new Map(logical.queries.map((q) => [q.id, int8Bytes(b64ToVec(cache.queries[q.id]))]));
const docById = new Map(logical.docs.map((d) => [d.id, d]));

const bucket = (fam) => fam === 'temporal_update' ? 'temporal' : (fam === 'multi_session_bridge' || fam === 'causal_memory_chain' || fam === 'decision_provenance') ? 'multi_hop_relation' : 'near_collision';
const PROV = { source: 'synthetic_challenge', sourceHash: '0x' + '00'.repeat(32) };
const mkEmb = (q, pt, pn) => ({ modelId: BE.modelId, revision: BE.revision, layout: LAYOUT, query: q, perTruth: new Map(pt), perNegative: new Map(pn) });
const memId = (docId) => `mem_${docId}`;
const events = [];
const relBySrc = new Map();
for (const r of logical.relations) { if (!relBySrc.has(r.src)) relBySrc.set(r.src, []); relBySrc.get(r.src).push(r); }
for (const d of logical.docs) {
  const emb = docEmb.get(d.id);
  events.push({ id: memId(d.id), family: 'near_collision', domain: d.lane, split: 'train_visible', queryText: d.text,
    truthDocuments: [{ id: d.id, text: d.text, isCurrent: d.currentStaleFlag === false ? false : true }], hardNegatives: [],
    qrels: [{ documentId: d.id, relevance: 1.0 }], protected: false,
    relations: (relBySrc.get(d.id) ?? []).map((r) => ({ other_id: memId(r.dst), edgeType: r.type })),
    ...(Array.isArray(d.entityIds) && d.entityIds.length > 0 ? { entityIds: d.entityIds } : {}),
    provenance: PROV, embeddings: mkEmb(emb, [[d.id, emb]], []) });
}
for (const q of logical.queries) {
  if (q.abstain) continue;
  const fam = bucket(q.family);
  const truths = (q.qrels ?? []).filter((r) => r.relevance > 0).map((r) => { const d = docById.get(r.docId); return { id: r.docId, text: d.text, isCurrent: d.currentStaleFlag === false ? false : true }; });
  const negs = (q.hardNegatives ?? []).map((n) => ({ id: n.docId, text: docById.get(n.docId).text, category: n.category }));
  const ev = { id: q.id, family: fam, domain: q.lane, split: q.split ?? 'eval_hidden', queryText: q.queryText, truthDocuments: truths, hardNegatives: negs,
    qrels: (q.qrels ?? []).map((r) => ({ documentId: r.docId, relevance: r.relevance })), protected: false, relations: [],
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

// ── PUBLIC supports in-degree (train_visible+calibration only) → proposer chooses K ──
const PUBLIC = new Set(['train_visible', 'calibration']);
const publicDocIds = new Set(logical.docs.filter((d) => PUBLIC.has(d.split ?? 'eval_hidden')).map((d) => d.id));
const inDegPublic = new Map(); // memId(target) -> count of incoming supports from PUBLIC sources
for (const r of logical.relations) {
  if (r.type !== 'supports') continue;
  if (!publicDocIds.has(r.src)) continue; // only edges visible to the proposer
  const t = memId(r.dst); inDegPublic.set(t, (inDegPublic.get(t) ?? 0) + 1);
}
const degVals = [...inDegPublic.values()].sort((a, b) => a - b);
const pctile = (p) => degVals.length ? degVals[Math.min(degVals.length - 1, Math.floor(p * degVals.length))] : 1;
const maxDeg = degVals.length ? degVals[degVals.length - 1] : 1;
// honest K: the high-corroboration cutoff from the PUBLIC distribution (p90, >=2). If the
// corpus has no corroboration density (all in-degree ~1), K collapses to 1 → boosts
// everything → no discrimination (the honest no-signal result).
const honestK = Math.max(2, pctile(0.90));

function rng(seedStr) { let s = 2166136261 >>> 0; for (const c of seedStr) { s ^= c.charCodeAt(0); s = Math.imul(s, 16777619); } return () => { s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 1) >>> 0; return s / 4294967296; }; }
const emptyWords = () => new Array(1024).fill(0n);
function policySubstrate(k, weightPpm) {
  const words = emptyWords();
  const enc = encodeCodebookEntry({ entryIndex: 0, code: 5, codeType: 'int8_scale_zero', valid: true, payload: (BigInt(Math.round(weightPpm)) << 16n) | BigInt(Math.max(1, Math.round(k))), payloadCont: 0n });
  words[RANGES.CODEBOOK_START] = enc[0]; words[RANGES.CODEBOOK_START + 1] = enc[1];
  return { words };
}
// hillclimb: pick K on the CALIBRATION slice (bi-cosine + policy proxy) maximizing nDCG@10, test transfer.
function hillclimbK(weightPpm) {
  const calibQ = logical.queries.filter((q) => !q.abstain && q.split === 'calibration' && (q.qrels ?? []).some((r) => r.role === 'direct'));
  if (!calibQ.length || maxDeg < 2) return honestK;
  const inDegAll = new Map(); for (const r of logical.relations) { if (r.type === 'supports') { const t = memId(r.dst); inDegAll.set(t, (inDegAll.get(t) ?? 0) + 1); } }
  let bestK = 2, bestScore = -1;
  for (let k = 2; k <= Math.min(maxDeg, 12); k++) {
    let sum = 0, n = 0;
    for (const q of calibQ) {
      const ans = (q.qrels ?? []).find((r) => r.role === 'direct'); if (!ans) continue;
      const deg = inDegAll.get(memId(ans.docId)) ?? 0;
      sum += deg >= k ? 1 : 0; n++; // proxy: fraction of calib answers the policy would boost
    }
    const sc = n ? sum / n : 0;
    if (sc > bestScore) { bestScore = sc; bestK = k; }
  }
  return bestK;
}

function hseed(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
const shuf = (arr) => arr.map((x) => [x, hseed(`${packSeed}:${x.id}`)]).sort((a, b) => a[1] - b[1]).map((p) => p[0]);
const evalQ = shuf(logical.queries.filter((q) => !q.abstain && (q.split ?? 'eval_hidden') === 'eval_hidden' && (q.qrels ?? []).some((r) => r.role === 'direct')));
const pack = evalQ.slice(0, packSize).map((q) => corpus.byId.get(q.id));
const logQById = new Map(logical.queries.map((q) => [q.id, q]));

const biEncoder = { modelId: BE.modelId, revision: BE.revision, layout: LAYOUT, async encode() { throw new Error('embeddings pre-baked'); } };
const RR = manifest.model.reranker;
const reranker = rerankerArg === 'gpu' || rerankerArg === 'cpu' ? streamReranker({ model: RR.modelId, revision: RR.revision, python: process.env.CORETEX_RERANKER_PYTHON ?? '/usr/bin/python3', allowCuda: rerankerArg === 'gpu' }) : rerankerArg === 'env' ? await rerankerFromEnv() : await createDeterministicReranker();
const V2_PROFILE = JSON.parse(readFileSync(resolve(repoRoot, flag('profile', 'release/bundle/evaluator-profile-v2-dgen1-deep-r1.json')), 'utf8'));
const baseOpts = { ...scoringOptionsFromProfile(V2_PROFILE, { biEncoder, reranker, biEncoderHash, retrievalKeyLayout: LAYOUT }),
  firstStageTopK: V2_PROFILE.firstStageTopK ?? 3200, rerankerInputTopK: rerankCap,
  categoryLensExpansionBudget: 0, temporalCurrentBoost: 0, temporalStaleSuppression: 0, anchorWeight: 0,
  ownerScopeMode: V2_PROFILE.ownerScopeMode ?? 'restrict', pipelineVersion: 'coretex-retrieval-v2-lens-r3' };
const offOpts = { ...baseOpts, evidencePolicyEnabled: false };
const onOpts = { ...baseOpts, evidencePolicyEnabled: true };
const mkPack = (evs) => ({ epochId: 0, evalSeedCommit: '0x' + (packSeed.length >= 2 ? packSeed.slice(0, 2) : 'a5').repeat(32), corpusRoot, events: evs });

function attribution(onScore, offScore) {
  const offByRec = new Map((offScore.perQuery ?? []).map((pq) => [pq.recordId, pq]));
  let n = 0, viaPolicy = 0; const junkArr = [];
  for (const on of onScore.perQuery ?? []) {
    const off = offByRec.get(on.recordId); if (!off) continue; n++;
    const lq = logQById.get(on.recordId); const ansDoc = (lq?.qrels ?? []).find((r) => r.role === 'direct')?.docId;
    const offRank = new Map((off.finalRankingTop20 ?? []).map((r) => [r.docId, r.rank])); const rankOff = (id) => offRank.get(id) ?? 999;
    const onTop = (on.finalRankingTop20 ?? []).filter((r) => r.rank <= 10);
    if (ansDoc && onTop.some((r) => r.docId === ansDoc) && rankOff(ansDoc) > 10) viaPolicy++;
    let junk = 0; for (const r of onTop) { if ((r.relevance ?? 0) === 0 && rankOff(r.docId) > 10) junk++; } junkArr.push(junk);
  }
  const sorted = [...junkArr].sort((a, b) => a - b); const pctl = (p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0;
  const mean = junkArr.length ? junkArr.reduce((a, b) => a + b, 0) / junkArr.length : 0;
  return { n, answerViaPolicy10Rate: n ? +(viaPolicy / n).toFixed(3) : null, policyJunkTop10Mean: +mean.toFixed(3), policyJunkTop10P95: pctl(0.95), policyJunkTop10Max: sorted.length ? sorted[sorted.length - 1] : 0 };
}

const W = Number(flag('weight-ppm', '300000')); // operator weight (bounded), like lensWeight
const offScore = await evaluateRetrievalBenchmarkState({ words: emptyWords() }, corpus, mkPack(pack), offOpts);
const banks = bankArg === 'all' ? ['high-density', 'random', 'hillclimb'] : bankArg.split(',').map((s) => s.trim());
const results = {};
for (const bank of banks) {
  let k;
  if (bank === 'high-density') k = honestK;
  else if (bank === 'hillclimb') k = hillclimbK(W);
  else { // random/naive control: a K a NON-skilled miner might pick — always != honestK so it
    // genuinely tests whether the SPECIFIC honest-K (from public stats) matters. Low K floods
    // incidental facts; high K misses answers. (Rigorous version = full K-sweep; this is the
    // single-draw control.)
    const r = rng(`randpolicy:${packSeed}`); do { k = 2 + Math.floor(r() * Math.max(1, maxDeg - 1)); } while (k === honestK && maxDeg > 2); }
  const onScore = await evaluateRetrievalBenchmarkState(policySubstrate(k, W), corpus, mkPack(pack), onOpts);
  const attr = attribution(onScore, offScore);
  results[bank] = { isControl: bank !== 'high-density', K: k, weightPpm: W,
    off: { nDCG10: offScore.nDCG10, recall10: offScore.recall10 }, on: { nDCG10: onScore.nDCG10, recall10: onScore.recall10 },
    deltaNDCG10: +((onScore.nDCG10 ?? 0) - (offScore.nDCG10 ?? 0)).toFixed(4), deltaRecall10: +((onScore.recall10 ?? 0) - (offScore.recall10 ?? 0)).toFixed(4), attribution: attr };
  console.error(`[evpolicy] bank=${bank} K=${k} dNDCG=${results[bank].deltaNDCG10} dRecall=${results[bank].deltaRecall10} viaPolicy=${attr.answerViaPolicy10Rate} junk(m/p95/max)=${attr.policyJunkTop10Mean}/${attr.policyJunkTop10P95}/${attr.policyJunkTop10Max}`);
}
const hd = results['high-density'];
const ctrl = banks.filter((b) => b !== 'high-density').map((b) => results[b]).filter(Boolean);
const maxCtrlLift = Math.max(0, ...ctrl.map((r) => Math.max(r.deltaNDCG10, r.deltaRecall10)));
const gate = hd ? { liftOK: (hd.deltaNDCG10 >= 0.02 || hd.deltaRecall10 >= 0.02), attributionOK: (hd.attribution.answerViaPolicy10Rate ?? 0) > 0,
  junkOK: (hd.attribution.policyJunkTop10Mean <= 1 && hd.attribution.policyJunkTop10P95 <= 3 && hd.attribution.policyJunkTop10Max <= 4), controlsOK: maxCtrlLift <= 0.01 } : null;
if (gate) gate.PASS = gate.liftOK && gate.attributionOK && gate.junkOK && gate.controlsOK;

const gitSha = (() => { try { return execSync('git rev-parse --short HEAD', { cwd: repoRoot }).toString().trim(); } catch { return 'unknown'; } })();
const distHash = (() => { try { return execSync('sha256sum packages/coretex/dist/eval/retrieval-benchmark.js', { cwd: repoRoot }).toString().trim().slice(0, 16); } catch { return 'unknown'; } })();
const report = { probe: 'dgen1-evidence-policy-high-density', runbook: 'Phase 2 §2 shape; EVIDENCE_POLICY_DESIGN.md',
  provenance: { specVersion: logical.specVersion, phase: logical.phase, corpusPath, embPath, corpusRoot, gitSha, distHashRetrievalBenchmark: distHash,
    reranker: rerankerArg === 'gpu' ? `Qwen/Qwen3-Reranker-0.6B@${RR.revision} (gpu)` : 'deterministic-stub', cap: rerankCap, packSize: pack.length, packSeed,
    publicSupportsInDegree: { distinctTargets: inDegPublic.size, maxInDegree: maxDeg, p90: pctile(0.9), honestK, weightPpm: W },
    isolation: { categoryLensExpansionBudget: 0, temporalOff: true, ownerScopeMode: baseOpts.ownerScopeMode } },
  offBaseline: { nDCG10: offScore.nDCG10, recall10: offScore.recall10 }, banks: results, gate, cost: { wallClockSec: +((Date.now() - START_T) / 1000).toFixed(1) } };
const suffix = rerankerArg === 'gpu' || rerankerArg === 'env' ? 'qwen' : 'det';
const phaseTag = (logical.phase || 'p').toLowerCase().replace(/[^a-z0-9]+/g, '');
writeFileSync(resolve(outDir, `EVPOLICY_${phaseTag}_${suffix}_${bankArg}_cap${rerankCap}_${packSeed}.json`), JSON.stringify(report, null, 2));
console.error(`[evpolicy] honestK=${honestK} maxInDeg=${maxDeg} (if maxInDeg<=1 → no corroboration structure → expected no lift)`);
console.log(JSON.stringify(report, null, 2));
if (typeof reranker.close === 'function') reranker.close();
