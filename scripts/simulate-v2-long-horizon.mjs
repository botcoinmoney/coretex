#!/usr/bin/env node
/**
 * V2 owner-scoped REAL-SCORING long-horizon (Layer 9, increment 2) — bounded
 * anti-cheat + plateau EVIDENCE (not launch proof).
 *
 * Per epoch, over an owner-growth trajectory on the owner-scoped V2 corpus:
 *   1. Build an owner-scoped eval_hidden pack (active owners by growth fraction).
 *   2. Baseline-score (empty substrate) with the production owner-scoped opts.
 *   3. POSITIVE CONTROL: a category-lens substrate patch (the relation lever) —
 *      should be ACCEPTED (real advance) under score-inheritance.
 *   4. RANDOM-PATCH PROBES: N random substrate patches — should be REJECTED
 *      (anti-cheat: a miner cannot game the threshold by random mutation).
 *   5. Feed REAL observed-advance counts into nextMinImprovementPpm; track the
 *      threshold trajectory + clamp behavior under real growth.
 *
 * Reports: random-patch acceptance rate, positive-control acceptance, threshold
 * trajectory, clamp behavior, Qwen-pair counts, wall-clock + full provenance.
 *
 * CPU smoke (mechanics only — deterministic reranker can't reward routing):
 *   node scripts/simulate-v2-long-horizon.mjs --corpus <p1> --emb <p1emb> \
 *     --reranker deterministic --epochs 3 --probes 5 --pack-size 8
 * A100 real signal:
 *   HF_HUB_CACHE=... CORETEX_RERANKER_PYTHON=/usr/bin/python3 \
 *   node scripts/simulate-v2-long-horizon.mjs --corpus <p1> --emb <p1emb> \
 *     --reranker gpu --epochs 15 --probes 30 --pack-size 12 --alpha 0.3 --out <dir>
 */
import { distIndex, repoRoot } from './_repo-root.mjs';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const {
  evaluateBaseline, evaluateRetrievalBenchmarkPatch, applyPatch, merkleizeState,
  nextMinImprovementPpm, isMajorDelta, computeCorpusRoot, createDeterministicReranker, rerankerFromEnv,
  biEncoderModelIdHash, encodeRelationCategoryLens, encodeTemporalRecord, encodeMemoryIndexSlot, stableRecordIdFor,
  PATCH_TYPE, RANGES, RESERVED_MASKS, DEFAULT_COMPOSITE_WEIGHTS, MIN_IMPROVEMENT_PPM, MAX_IMPROVEMENT_PPM,
} = await import(distIndex);

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const corpusPath = flag('corpus', 'release/calibration/2026-05-21-memory-corpus-v2/p1-corpus.json');
const embPath = flag('emb', 'release/calibration/2026-05-21-memory-corpus-v2/p1-embeddings.json');
const epochs = Number(flag('epochs', '15'));
const probes = Number(flag('probes', '30'));
const packSize = Number(flag('pack-size', '12'));
const alpha = Number(flag('alpha', '0.3'));
const targetAdvances = Number(flag('target-advances', '2'));
const rerankerArg = flag('reranker', 'deterministic');
const masterSeed = flag('seed', 'v2-lh-2026-05-22');
const ownerFractions = String(flag('owner-fractions', '0.34,0.67,1.0')).split(',').map(Number);
const epochsPerFraction = Number(flag('epochs-per-fraction', String(Math.ceil(epochs / 3))));
const outDir = flag('out', 'release/calibration/2026-05-21-memory-corpus-v2');
const START_T = Date.now();

const manifest = JSON.parse(readFileSync(resolve(repoRoot, 'release/bundle/bundle-manifest-launch-v3.json'), 'utf8'));
const BE = manifest.model.biEncoder, RR = manifest.model.reranker;
const LAYOUT = { dim: BE.retrievalKeyLayout.dim, quantization: BE.retrievalKeyLayout.quantization, headerBytes: BE.retrievalKeyLayout.headerBytes };
const biEncoderHash = biEncoderModelIdHash(BE.modelId, BE.revision, 'dense');

// ── persistent stream reranker (GPU/CPU), same client as the bridge ──
function streamReranker({ python, allowCuda }) {
  const env = { ...process.env, CORETEX_RERANKER_STREAM_MODEL_ID: RR.modelId, CORETEX_RERANKER_STREAM_REVISION: RR.revision,
    HF_HUB_CACHE: process.env.HF_HUB_CACHE ?? '/var/lib/coretex/model-cache', HF_HUB_OFFLINE: process.env.HF_HUB_OFFLINE ?? '1' };
  if (allowCuda) { env.CORETEX_RERANKER_ALLOW_CUDA = '1'; delete env.CUDA_VISIBLE_DEVICES; } else { env.CUDA_VISIBLE_DEVICES = ''; }
  const proc = spawn(python, [resolve(repoRoot, 'scripts/reranker_runner.py'), '--stream'], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = '', nextId = 0; const pending = new Map(); let readyR; const readyP = new Promise((r) => { readyR = r; });
  proc.stdout.on('data', (d) => { buf += d.toString(); let nl; while ((nl = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, nl); buf = buf.slice(nl + 1); if (!line.trim()) continue; let m; try { m = JSON.parse(line); } catch { continue; } if (m.ready) { readyR(); continue; } if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } });
  proc.on('exit', (c) => { for (const [, r] of pending) r({ error: `reranker exited ${c}` }); });
  return { async score(pairs) { if (!pairs?.length) return []; await readyP; const id = nextId++; const p = new Promise((res) => pending.set(id, res)); proc.stdin.write(JSON.stringify({ id, pairs: pairs.map((x) => ({ query: x.query, document: x.document })) }) + '\n'); const m = await p; if (m.error) throw new Error(m.error); return m.scores; }, close() { try { proc.stdin.end(); } catch { /* */ } } };
}

// ── build owner-scoped V2 ProductionCorpus (bridge mapping, no-query/leak-free) ──
const logical = JSON.parse(readFileSync(resolve(corpusPath), 'utf8'));
const cache = JSON.parse(readFileSync(resolve(embPath), 'utf8'));
const b64ToVec = (b) => { const buf = Buffer.from(b, 'base64'); return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4); };
function int8Bytes(vec) { let m = 0; for (const v of vec) m = Math.max(m, Math.abs(v)); const s = m > 0 ? m / 127 : 1; const o = new Uint8Array(4 + LAYOUT.dim); new DataView(o.buffer).setFloat32(0, s, false); for (let i = 0; i < LAYOUT.dim; i++) { let c = Math.round((vec[i] ?? 0) / s); c = Math.max(-127, Math.min(127, c)); o[4 + i] = c & 0xff; } return o; }
const docEmb = new Map(logical.docs.map((d) => [d.id, int8Bytes(b64ToVec(cache.docs[d.id]))]));
const qEmb = new Map(logical.queries.map((q) => [q.id, int8Bytes(b64ToVec(cache.queries[q.id]))]));
const docById = new Map(logical.docs.map((d) => [d.id, d]));
const memId = (id) => `mem_${id}`;
const PROV = { source: 'synthetic_challenge', sourceHash: '0x' + '00'.repeat(32) };
const mkEmb = (q, pt, pn) => ({ modelId: BE.modelId, revision: BE.revision, layout: LAYOUT, query: q, perTruth: new Map(pt), perNegative: new Map(pn) });
const bucket = (f) => f === 'temporal_update' ? 'temporal' : (f === 'multi_session_bridge' || f === 'causal_memory_chain' || f === 'decision_provenance') ? 'multi_hop_relation' : 'near_collision';
const relBySrc = new Map();
for (const r of logical.relations) { if (!relBySrc.has(r.src)) relBySrc.set(r.src, []); relBySrc.get(r.src).push(r); }
const events = [];
for (const d of logical.docs) { const e = docEmb.get(d.id); events.push({ id: memId(d.id), family: 'near_collision', domain: d.lane, split: 'train_visible', queryText: d.text, truthDocuments: [{ id: d.id, text: d.text, isCurrent: d.currentStaleFlag === false ? false : true }], hardNegatives: [], qrels: [{ documentId: d.id, relevance: 1.0 }], protected: false, relations: (relBySrc.get(d.id) ?? []).map((r) => ({ other_id: memId(r.dst), edgeType: r.type })), ...(Array.isArray(d.entityIds) && d.entityIds.length ? { entityIds: d.entityIds } : {}), provenance: PROV, embeddings: mkEmb(e, [[d.id, e]], []) }); }
const queryEvents = [];
for (const q of logical.queries) {
  if (q.abstain) continue;
  const truths = (q.qrels ?? []).filter((r) => r.relevance > 0).map((r) => ({ id: r.docId, text: docById.get(r.docId).text, isCurrent: docById.get(r.docId).currentStaleFlag === false ? false : true }));
  const negs = (q.hardNegatives ?? []).map((n) => ({ id: n.docId, text: docById.get(n.docId).text, category: n.category }));
  const ev = { id: q.id, family: bucket(q.family), logicalFamily: q.family, domain: q.lane, split: q.split ?? 'eval_hidden', queryText: q.queryText, truthDocuments: truths, hardNegatives: negs, qrels: (q.qrels ?? []).map((r) => ({ documentId: r.docId, relevance: r.relevance })), protected: false, relations: [], ...(q.ownerEntityId !== undefined ? { ownerEntityId: q.ownerEntityId, ownerScoped: q.ownerScoped !== false } : {}), provenance: PROV, embeddings: mkEmb(qEmb.get(q.id), truths.map((t) => [t.id, docEmb.get(t.id)]), negs.map((n) => [n.id, docEmb.get(n.id)])) };
  if (ev.family === 'temporal') ev.temporal = { validFromEpoch: 1, validUntilEpoch: Number.MAX_SAFE_INTEGER, currentStaleFlag: false };
  events.push(ev); queryEvents.push(ev);
}
const corpusRoot = computeCorpusRoot(events);
const corpus = { events, byId: new Map(events.map((e) => [e.id, e])), corpusRoot, corpusEpoch: 0, entities: (logical.entities ?? []).map((e) => ({ id: e.id, canonicalName: e.canonicalName, aliases: e.aliases ?? [] })), biEncoderModelId: BE.modelId, biEncoderRevision: BE.revision, biEncoderRetrievalKeyLayout: LAYOUT, labelingModelId: RR.modelId, labelingModelRevision: RR.revision };

// owner-scoped eval_hidden RELATION query-events (the substrate-relevant lever family)
const relQ = queryEvents.filter((e) => e.split === 'eval_hidden' && e.ownerScoped === true && (e.family === 'multi_hop_relation' || e.family === 'temporal'));
const owners = [...new Set(relQ.map((e) => e.ownerEntityId))];
function hseed(s) { let h = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h; }
const ownerOrder = [...owners].map((o) => [o, hseed(`${masterSeed}:${o}`)]).sort((a, b) => a[1] - b[1]).map((p) => p[0]);

// ── substrate states ──
const empty = () => ({ words: new Array(1024).fill(0n) });
// Positive control = the relation lever: category-lens entries for the public edge types.
function positiveControlState() {
  const words = new Array(1024).fill(0n);
  ['supports', 'causes', 'supersedes', 'coreference_of'].forEach((et, i) => { words[RANGES.RELATIONS_START + (128 - 1 - i)] = encodeRelationCategoryLens({ entryIndex: 128 - 1 - i, edgeType: et, weight: 0x8000 }); });
  return { words };
}
function mulberry32(seed) { let t = seed >>> 0; return () => { t += 0x6D2B79F5; let x = Math.imul(t ^ (t >>> 15), 1 | t); x ^= x + Math.imul(x ^ (x >>> 7), 61 | x); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; }; }
function randomWord(rand, mask) { let v = 0n; for (let i = 0; i < 4; i++) v = (v << 64n) | (BigInt(Math.floor(rand() * 0x100000000)) << 32n) | BigInt(Math.floor(rand() * 0x100000000)); return v & (~mask); }
function randomPatch(state, rand) { const n = 1 + Math.floor(rand() * 4); const used = new Set(); const indices = [], newWords = []; while (indices.length < n) { const idx = Math.floor(rand() * RANGES.WORD_COUNT); if (used.has(idx)) continue; used.add(idx); const mask = RESERVED_MASKS[idx] ?? 0n; let w = randomWord(rand, mask); if (w === (state.words[idx] ?? 0n)) w = (w + 1n) & (~mask); indices.push(idx); newWords.push(w); } return { patchType: PATCH_TYPE.MIXED, wordCount: n, scoreDelta: 0n, parentStateRoot: merkleizeState(state), indices, newWords }; }
// Positive-control patch from EMPTY: install up-to-4 category-lens entries.
function positiveControlPatch(state) { const indices = [], newWords = []; ['supports', 'causes', 'supersedes', 'coreference_of'].forEach((et, i) => { indices.push(RANGES.RELATIONS_START + (128 - 1 - i)); newWords.push(encodeRelationCategoryLens({ entryIndex: 128 - 1 - i, edgeType: et, weight: 0x8000 })); }); return { patchType: PATCH_TYPE.MIXED, wordCount: 4, scoreDelta: 0n, parentStateRoot: merkleizeState(state), indices, newWords }; }

const reranker = rerankerArg === 'gpu' || rerankerArg === 'cpu'
  ? streamReranker({ python: process.env.CORETEX_RERANKER_PYTHON ?? '/usr/bin/python3', allowCuda: rerankerArg === 'gpu' })
  : await createDeterministicReranker();
const opts = {
  weights: DEFAULT_COMPOSITE_WEIGHTS, biEncoder: { modelId: BE.modelId, revision: BE.revision, layout: LAYOUT, async encode() { throw new Error('unused'); } },
  reranker, retrievalKeyLayout: LAYOUT, biEncoderHash, relationHopBudget: 3, abstentionThreshold: 0.001, rerankerTopK: 10, retrievalKeyTopK: 50,
  firstStageTopK: 3200, rerankerInputTopK: 64, lensTopK: 36, lensWeight: 0.4, anchorWeight: 0.6,
  relationExpansionBudget: 12, categoryLensExpansionBudget: 50, categoryLensTraversalDirection: 'bidirectional',
  categoryLensFinalBonusWeight: 0, categoryLensScoreInheritance: alpha, ownerScopeMode: 'restrict',
  temporalCurrentBoost: 0.1, temporalStaleSuppression: 0.1, pipelineVersion: 'coretex-retrieval-v2-lens-r3',
};
const floorsBase = { structuralFloor: 0, protectedRegressionFloor: -50000, familyCatastrophicFloor: -100000 };

const mkPack = (evs, epoch) => ({ epochId: epoch, evalSeedCommit: '0x' + (createHash('sha256').update(`${masterSeed}:${epoch}`).digest('hex')), corpusRoot, events: evs });

let current = BigInt(5000);
let prevEH = 0, clampHits = 0, maxClampWhileAdvancing = 0;
const rows = [];
console.error(`[v2-lh] corpus=${events.length} evt, relOwners=${owners.length}, reranker=${rerankerArg}, alpha=${alpha}, epochs=${epochs}, probes=${probes}`);
for (let epoch = 1; epoch <= epochs; epoch++) {
  const fracIdx = Math.min(ownerFractions.length - 1, Math.floor((epoch - 1) / Math.max(1, epochsPerFraction)));
  const frac = ownerFractions[fracIdx] ?? 1;
  const activeOwners = new Set(ownerOrder.slice(0, Math.max(1, Math.floor(ownerOrder.length * frac))));
  const activeRelQ = relQ.filter((e) => activeOwners.has(e.ownerEntityId));
  const activeEH = activeRelQ.length;
  const majorDeltaActive = isMajorDelta(activeEH, prevEH, 0.1); prevEH = activeEH;
  // owner-scoped pack: shuffle active relation queries by epoch seed, take packSize
  const pack = mkPack(activeRelQ.map((e) => [e, hseed(`${masterSeed}:${epoch}:${e.id}`)]).sort((a, b) => a[1] - b[1]).slice(0, packSize).map((p) => p[0]), epoch);
  const floors = { ...floorsBase, minImprovementPpm: Number(current), acceptanceThresholdPpm: Number(current) };

  // POSITIVE CONTROL: the relation lever from empty — should be ACCEPTED.
  const pc = await evaluateRetrievalBenchmarkPatch(empty(), positiveControlPatch(empty()), corpus, pack, opts, floors);

  // RANDOM-PATCH PROBES from empty — should be REJECTED (anti-cheat).
  const rand = mulberry32(hseed(`${masterSeed}:probe:${epoch}`));
  let accepted = 0, posBelow = 0; const deltas = [];
  for (let i = 0; i < probes; i++) {
    const r = await evaluateRetrievalBenchmarkPatch(empty(), randomPatch(empty(), rand), corpus, pack, opts, floors);
    deltas.push(r.deltaPpm); if (r.accepted) accepted++; else if (r.deltaPpm > 0) posBelow++;
  }
  const observedAdvances = accepted; const qualityAttempts = accepted + posBelow;
  const d = nextMinImprovementPpm({ current, observedAdvances, targetAdvances, qualityAttempts, majorDeltaActive });
  if (d.clamped) clampHits++;
  if (Number(d.next) === Number(MAX_IMPROVEMENT_PPM) && observedAdvances > targetAdvances) maxClampWhileAdvancing++;
  rows.push({ epoch, ownerFraction: frac, activeEvalHidden: activeEH, majorDeltaActive, packN: pack.events.length,
    positiveControlAccepted: pc.accepted, positiveControlDeltaPpm: pc.deltaPpm,
    randomAccepted: accepted, randomProbes: probes, randomAcceptanceRate: +(accepted / probes).toFixed(4),
    randomDeltaPpmMax: Math.max(...deltas), randomDeltaPpmMin: Math.min(...deltas),
    minImprBefore: Number(current), minImprAfter: Number(d.next), reason: d.reason });
  current = d.next;
  console.error(`[v2-lh] epoch ${epoch}/${epochs} frac=${frac} packN=${pack.events.length} | posControl=${pc.accepted}(Δ${pc.deltaPpm}) randAcc=${accepted}/${probes} | minImpr ${rows.at(-1).minImprBefore}→${rows.at(-1).minImprAfter} [${d.reason}]`);
}
const gitSha = (() => { try { return execSync('git rev-parse --short HEAD', { cwd: repoRoot }).toString().trim(); } catch { return 'unknown'; } })();
const distHash = (() => { try { return execSync('sha256sum packages/cortex/dist/eval/retrieval-benchmark.js', { cwd: repoRoot }).toString().trim().slice(0, 16); } catch { return 'unknown'; } })();
const dirtyTree = (() => { try { return execSync('git status --porcelain', { cwd: repoRoot }).toString().trim().length > 0; } catch { return null; } })();
const meanRandAcc = rows.reduce((s, r) => s + r.randomAcceptanceRate, 0) / rows.length;
const out = {
  generatedAt: new Date().toISOString(),
  provenance: { corpus: corpusPath, corpusRoot, gitSha, distHashRetrievalBenchmark: distHash, dirtyTree,
    reranker: rerankerArg === 'gpu' || rerankerArg === 'cpu' ? `Qwen/Qwen3-Reranker-0.6B@${RR.revision} (${rerankerArg})` : 'deterministic-stub',
    biEncoder: BE.modelId, seed: masterSeed, alpha, ownerScopeMode: 'restrict', cap: opts.rerankerInputTopK,
    clampBounds: { minPpm: Number(MIN_IMPROVEMENT_PPM), maxPpm: Number(MAX_IMPROVEMENT_PPM) } },
  summary: {
    epochs, probesPerEpoch: probes, relOwners: owners.length,
    meanRandomAcceptanceRate: +meanRandAcc.toFixed(4),
    maxRandomAcceptanceRate: Math.max(...rows.map((r) => r.randomAcceptanceRate)),
    positiveControlAcceptedEpochs: rows.filter((r) => r.positiveControlAccepted).length,
    clampHits, plateauRiskAtMax: maxClampWhileAdvancing,
    minImprFirst: rows[0]?.minImprBefore, minImprLast: rows.at(-1)?.minImprAfter,
    approxQwenPairs: rows.reduce((s, r) => s + (r.packN * opts.rerankerInputTopK * 2 * (1 + probes)), 0),
    wallClockSec: +((Date.now() - START_T) / 1000).toFixed(1),
    // EVIDENCE assessment (not launch proof): anti-cheat = near-zero random acceptance;
    // positive control present = a real advance signal exists; plateau = MAX-clamp-while-advancing.
    antiCheatClean: meanRandAcc <= 0.01,
    advanceSignalPresent: rows.some((r) => r.positiveControlAccepted),
  },
  epochs: rows,
};
const suffix = rerankerArg === 'gpu' || rerankerArg === 'cpu' ? 'qwen' : 'det';
mkdirSync(resolve(outDir), { recursive: true });
const path = resolve(outDir, `V2_LONG_HORIZON_${(logical.phase || 'p').toLowerCase()}_${suffix}.json`);
writeFileSync(path, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out.summary, null, 2));
console.log(`wrote ${path}`);
if (typeof reranker.close === 'function') reranker.close();
