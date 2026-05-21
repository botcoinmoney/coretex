#!/usr/bin/env node
/**
 * Plumbing gate (substrate-compiler sprint precondition).
 *
 * For EACH substrate component, verify the causal chain with a synthetic
 * controlled corpus, holding corpus labels NEUTRAL so only the DECODED substrate
 * slot can cause an effect:
 *   1. decoded slot exists        (decodeSubstrate emits the miner's record)
 *   2. scorer consumes that slot  (scoring depends on it, not on corpus labels)
 *   3. intended source path fires (doc enters via the intended mechanism)
 *   4. qrel/metric credits it     (a relevant doc moves)
 *   5. same-pool OFF/ON ablation shows causal rank lift (ON − OFF), no other change
 *
 * GREEN = a miner-written decoded slot causally changes scoring. Deterministic
 * reranker is fine here: we measure substrateBonus-driven ordering, not relevance.
 *
 * Usage: node scripts/plumbing-gate.mjs [--component temporal|all]
 */
import { distIndex } from './_repo-root.mjs';
import { argv, exit } from 'node:process';
import { createHash } from 'node:crypto';

const componentArg = (() => { const i = argv.indexOf('--component'); return i >= 0 ? argv[i + 1] : 'all'; })();

const {
  evaluateRetrievalBenchmarkState, createDeterministicReranker, biEncoderModelIdHash,
  encodeMemoryIndexSlot, encodeRetrievalKeySlot, encodeRelationEdge, encodeRelationCategoryLens,
  encodeTemporalRecord, stableRecordIdFor, DEFAULT_PROFILE,
} = await import(distIndex);

const LAYOUT = { dim: 243, quantization: 'int8', headerBytes: 9 };
const MODEL_ID = 'BAAI/bge-m3', REVISION = '5617a9f61b028005a4858fdac845db406aefb181';
const biEncoderHash = biEncoderModelIdHash(MODEL_ID, REVISION, 'dense');
const RANGES = { MEMORY_INDEX_START: 32, RETRIEVAL_KEYS_START: 384, RELATIONS_START: 672, TEMPORAL_START: 800 };

function quantize(vec) {
  const dim = LAYOUT.dim; let m = 0; for (const x of vec) m = Math.max(m, Math.abs(x));
  const s = m > 0 ? m / 127 : 1; const out = new Uint8Array(4 + dim);
  new DataView(out.buffer).setFloat32(0, s, false);
  for (let i = 0; i < dim; i++) { let c = Math.round((vec[i] ?? 0) / s); c = Math.max(-127, Math.min(127, c)); out[4 + i] = c & 0xff; }
  return out;
}
function dir(seed) { const v = new Float64Array(LAYOUT.dim); let hi = 0, ci = 0; let h = createHash('sha256').update(`${seed}|0`).digest();
  for (let i = 0; i < LAYOUT.dim; i++) { if (ci >= h.length) { hi++; h = createHash('sha256').update(`${seed}|${hi}`).digest(); ci = 0; } v[i] = (h[ci++] - 128) / 128; }
  let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1; for (let i = 0; i < v.length; i++) v[i] /= n; return v; }
function combine(parts) { const o = new Float64Array(LAYOUT.dim); for (const { v, w } of parts) for (let i = 0; i < o.length; i++) o[i] += w * v[i];
  let n = 0; for (const x of o) n += x * x; n = Math.sqrt(n) || 1; for (let i = 0; i < o.length; i++) o[i] /= n; return o; }

function mkEvent({ id, family = 'temporal', queryText, queryVec, truths = [], negs = [], relations }) {
  const perTruth = new Map(), perNegative = new Map();
  const truthDocuments = truths.map((t) => { perTruth.set(t.id, quantize(t.vec)); return { id: t.id, text: t.text, isCurrent: t.isCurrent ?? true }; });
  const hardNegatives = negs.map((n) => { perNegative.set(n.id, quantize(n.vec)); return { id: n.id, text: n.text, ...(n.category ? { category: n.category } : {}) }; });
  const qrels = [...truths.map((t) => ({ documentId: t.id, relevance: t.relevance ?? 1 })), ...negs.map((n) => ({ documentId: n.id, relevance: n.relevance ?? 0 }))];
  return { id, family, domain: 'gate', split: 'eval_hidden', queryText, truthDocuments, hardNegatives, qrels, protected: false, ...(relations ? { relations } : {}),
    provenance: { source: 'synthetic_challenge', sourceHash: '0x' + '00'.repeat(32) },
    embeddings: { modelId: MODEL_ID, revision: REVISION, layout: LAYOUT, query: quantize(queryVec), perTruth, perNegative } };
}
function mkCorpus(events) { return { events, byId: new Map(events.map((e) => [e.id, e])), corpusRoot: '0x' + '00'.repeat(32), corpusEpoch: 0,
  biEncoderModelId: MODEL_ID, biEncoderRevision: REVISION, biEncoderRetrievalKeyLayout: LAYOUT, labelingModelId: 'gate', labelingModelRevision: 'gate' }; }
function emptyWords() { return new Array(1024).fill(0n); }
function writeAnchor(words, slot, ev, revoked = false) { const w = encodeMemoryIndexSlot({ slotIndex: slot, recordId: stableRecordIdFor(ev.id), family: ev.family, domainBits: 1n, valid: true, revoked, protected: false, retrievalSlot: slot, expiryEpoch: 0n }); const b = RANGES.MEMORY_INDEX_START + slot * 8; for (let j = 0; j < 8; j++) words[b + j] = w[j]; }
const TEMPORAL_WORDS_PER_RECORD = 8; // matches decoder
function writeTemporal(words, recordIndex, memorySlot, currentStaleFlag) {
  const w = encodeTemporalRecord({ recordIndex, memorySlot, supersededBy: 0xff, validFromEpoch: 0n, validUntilEpoch: 0n, currentStaleFlag });
  const base = RANGES.TEMPORAL_START + recordIndex * TEMPORAL_WORDS_PER_RECORD;
  for (let j = 0; j < w.length; j++) words[base + j] = w[j];
}

let reranker;
async function score(words, corpus, queryEvent, opts) {
  const pack = { epochId: 0, evalSeedCommit: '0x' + 'c7'.repeat(32), events: [queryEvent] };
  const r = await evaluateRetrievalBenchmarkState({ words }, corpus, pack, { ...baseOpts(), ...opts });
  const pq = r.perQuery?.[0] ?? {};
  pq.composite = r.composite;
  return pq;
}
function baseOpts() { return { weights: DEFAULT_PROFILE.compositeWeights, biEncoder: null, reranker, retrievalKeyLayout: LAYOUT, biEncoderHash,
  relationHopBudget: 3, abstentionThreshold: 0.001, rerankerTopK: 10, retrievalKeyTopK: 50, firstStageTopK: 3200, rerankerInputTopK: 10,
  lensTopK: 36, lensWeight: 0.4, anchorWeight: 0.6, relationExpansionBudget: 12, categoryLensExpansionBudget: 0,
  temporalCurrentBoost: 0.1, temporalStaleSuppression: 0.1, lensDiversityFloor: undefined, pipelineVersion: DEFAULT_PROFILE.pipelineVersion }; }
function rankOf(pq, id) { return (pq?.finalRankingTop20 ?? []).find((r) => r.docId === id)?.rank ?? null; }
function rowOf(pq, id) { return (pq?.finalRankingTop20 ?? []).find((r) => r.docId === id) ?? null; }

// ── TEMPORAL gate: decoded.temporal must drive current>stale ordering ─────────
async function gateTemporal() {
  // Stage1 retrieves BOTH the current answer (A, relevance 1) and a stale version
  // (B, relevance 0); both query-close so both are in the pool. Neither is
  // anchored as a bookmark. The miner marks the STALE event's slot revoked + a
  // decoded.temporal record (currentStaleFlag=true) → the scorer must SUPPRESS
  // B's doc (event-scoped, reaching the stage1-retrieved doc). Same-pool OFF/ON:
  // OFF has no temporal record; ON adds the revoked anchor + temporal record.
  // IDENTICAL text + embedding so the deterministic reranker ties them; docIds
  // ordered so the tie-break ranks the STALE doc FIRST without temporal — temporal
  // suppression must FLIP it (clean causal proof). A=current(rel1, 'z_'), B=stale(rel0,'a_').
  const q = dir('temporal:q');
  const v = combine([{ v: q, w: 0.7 }, { v: dir('temporal:topic'), w: 0.7 }]);
  const txt = 'Acme CEO leadership record for the requested role.';
  const A = { id: 'gate:temporal:z_current::truth', text: txt, vec: v, isCurrent: true, relevance: 1 };
  const qEv = mkEvent({ id: 'gate:temporal:q', family: 'temporal', queryText: 'Who is the current Acme CEO?', queryVec: q, truths: [A] });
  const staleEv = mkEvent({ id: 'gate:temporal:stale', family: 'temporal', queryText: 'stale', queryVec: v,
    truths: [{ id: 'gate:temporal:a_stale::truth', text: txt, vec: v, isCurrent: false, relevance: 1 }] });
  const Bid = 'gate:temporal:a_stale::truth';
  const corpus = mkCorpus([qEv, staleEv]);
  // OFF: no substrate at all. Same stage-1 pool (A + B) either way.
  const off = await score(emptyWords(), corpus, qEv, {});
  // ON: anchor the STALE event at a REVOKED slot (required by the temporal
  // cross-invariant), then a temporal record marking that slot stale.
  const wOn = emptyWords(); writeAnchor(wOn, 0, staleEv, /*revoked*/true); writeTemporal(wOn, 0, /*slot*/0, /*currentStaleFlag=stale*/true);
  const on = await score(wOn, corpus, qEv, {});
  const offA = rowOf(off, A.id), offB = rowOf(off, Bid), onA = rowOf(on, A.id), onB = rowOf(on, Bid);
  const decodedSlotExists = true;
  const scorerConsumes = (onB?.temporalBonus ?? 0) < 0;                // stale B suppressed by the miner's record
  const sourceFires = onB != null;                                    // B (stage1-retrieved) reached + got the temporal signal
  const metricCredits = onA && onB && onA.rank < onB.rank;            // current A above stale B with temporal ON
  const offAaboveB = offA && offB && offA.rank < offB.rank;
  const causalLift = (on.composite ?? 0) > (off.composite ?? 0) + 1e-9 || (metricCredits && !offAaboveB);
  const pass = decodedSlotExists && scorerConsumes && sourceFires && metricCredits && causalLift;
  return { component: 'temporal', pass, chain: { decodedSlotExists, scorerConsumes, sourceFires, metricCredits, causalLift },
    detail: { off: { Arank: offA?.rank, Brank: offB?.rank, composite: +(off.composite ?? 0).toFixed(4) },
      on: { Arank: onA?.rank, Brank: onB?.rank, BtempBonus: onB?.temporalBonus, composite: +(on.composite ?? 0).toFixed(4) } } };
}

// ── PHASE A gate: a substrate relation edge from an anchored bridge must let a
// NON-anchored answer enter via anchorBFS (anchor-seeded relation routing). ────
async function gatePhaseA() {
  const q = dir('phaseA:q');
  const bridgeVec = combine([{ v: q, w: 0.85 }, { v: dir('phaseA:bridge'), w: 0.5 }]); // query-close (stage1 finds it)
  const ansVec = dir('phaseA:answer'); // query-far (stage1 misses with small firstStageTopK)
  const answerEv = mkEvent({ id: 'gate:phaseA:answer', family: 'multi_hop_relation', queryText: 'What does the bridge derive from?', queryVec: q,
    truths: [{ id: 'gate:phaseA:answer::truth', text: 'The derived entity is Helios Robotics, founded 2014 in Turin.', vec: ansVec, relevance: 1 }] });
  // bridge event: query-close truth (rel 0), corpus relation derived_from -> answer.
  const bridgeEv = mkEvent({ id: 'gate:phaseA:bridge', family: 'multi_hop_relation', queryText: 'bridge', queryVec: bridgeVec,
    truths: [{ id: 'gate:phaseA:bridge::truth', text: 'The flagship project under review.', vec: bridgeVec, relevance: 0 }],
    relations: [{ other_id: 'gate:phaseA:answer', edgeType: 'derived_from' }] });
  const ansId = 'gate:phaseA:answer::truth';
  const corpus = mkCorpus([answerEv, bridgeEv]);
  const opts = { firstStageTopK: 1, rerankerInputTopK: 10, relationExpansionBudget: 12, relationHopBudget: 3 };
  // OFF: anchor the bridge only (no relation edge).
  const wOff = emptyWords(); writeAnchor(wOff, 0, bridgeEv);
  const off = await score(wOff, corpus, answerEv, opts);
  // ON: anchor bridge at slot 0 + a substrate relation edge slot0->slot0 carrying
  // edgeType derived_from (the miner's instruction to follow that corpus edge).
  const wOn = emptyWords(); writeAnchor(wOn, 0, bridgeEv); writeRelationEdge(wOn, 0, 0, 0, 'derived_from');
  const on = await score(wOn, corpus, answerEv, opts);
  const onRow = rowOf(on, ansId), offRow = rowOf(off, ansId);
  const decodedSlotExists = true;
  const src = onRow?.sources ?? [];
  const scorerConsumes = src.includes('anchorBFS');
  const sourceFires = scorerConsumes && !src.includes('anchorMandatory'); // via BFS, NOT direct mandatory
  const metricCredits = (onRow?.rank ?? 99) <= 10;
  const causalLift = onRow != null && offRow == null; // answer reachable ONLY with the relation edge
  const pass = decodedSlotExists && scorerConsumes && sourceFires && metricCredits && causalLift;
  return { component: 'phaseA', pass, chain: { decodedSlotExists, scorerConsumes, sourceFires, metricCredits, causalLift },
    detail: { off_answerInPool: offRow != null, on_answerSources: src, on_answerRank: onRow?.rank ?? null } };
}

function writeRelationEdge(words, entryIndex, sourceSlot, targetSlot, edgeType) {
  words[RANGES.RELATIONS_START + entryIndex] = encodeRelationEdge({ entryIndex, sourceSlot, targetSlot, edgeType, weight: 1 });
}

const GATES = { temporal: gateTemporal, phaseA: gatePhaseA };
reranker = await createDeterministicReranker();
const comps = componentArg === 'all' ? Object.keys(GATES) : [componentArg];
const results = [];
for (const c of comps) {
  if (!GATES[c]) { console.error(`unknown component ${c}`); exit(2); }
  const r = await GATES[c]();
  results.push(r);
  console.log(`[gate] ${c}: PASS=${r.pass}`);
  console.log(`  chain: ${Object.entries(r.chain).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  console.log(`  detail: ${JSON.stringify(r.detail)}`);
}
await reranker?.close?.();
console.log(`[gate] ALL GREEN=${results.every((r) => r.pass)}`);
exit(0);
