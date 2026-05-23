#!/usr/bin/env node
/**
 * DGEN-1 seed-capture diagnostic: for relation queries (multi_session_bridge /
 * causal_memory_chain / decision_provenance), where does the public BRIDGE SEED
 * (qrels role 'bridge') rank in owner-scoped stage-1 (dense cosine)? If the bridge
 * seed is below `categoryLensSeedTopK`, precise admission can never route from it →
 * relation cannot lift (the 300k symptom: ON==OFF). Also reports the direct-answer
 * rank for context. CPU only.
 *
 * Usage: node --max-old-space-size=16384 scripts/diag-dgen1-bridge-rank.mjs \
 *   release/.../dgen1-corpus.json --emb release/.../dgen1-embeddings.json --sample 200
 */
import { readFileSync } from 'node:fs';
const args = process.argv.slice(2);
const corpusPath = args[0];
const embPath = (() => { const i = args.indexOf('--emb'); return i >= 0 ? args[i + 1] : null; })();
const sample = (() => { const i = args.indexOf('--sample'); return i >= 0 ? Number(args[i + 1]) : 200; })();
const REL_FAMS = new Set(['multi_session_bridge', 'causal_memory_chain', 'decision_provenance']);

const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'));
const cache = JSON.parse(readFileSync(embPath, 'utf8'));
const b64 = (b) => { const buf = Buffer.from(b, 'base64'); return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4); };
// owner-scope: doc is in scope if its entityIds includes the query's ownerEntityId.
// DGEN-1 unified universe → every doc tagged e_universe → scope = all docs.
const docs = corpus.docs;
const docVec = new Map(docs.map((d) => [d.id, b64(cache.docs[d.id])]));
const ownerDocs = new Map(); // ownerEntityId -> docId[]
for (const d of docs) for (const e of (d.entityIds ?? [])) { if (!ownerDocs.has(e)) ownerDocs.set(e, []); ownerDocs.get(e).push(d.id); }

function cos(a, b) { let dot = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return na && nb ? dot / Math.sqrt(na * nb) : 0; }
function hs(s) { let h = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h; }

const relQ = corpus.queries.filter((q) => REL_FAMS.has(q.family) && (q.split ?? 'eval_hidden') !== 'canary'
  && (q.qrels ?? []).some((r) => r.role === 'bridge'));
const sampled = [...relQ].sort((a, b) => hs('s:' + a.id) - hs('s:' + b.id)).slice(0, sample);

const bridgeRanks = [], answerRanks = [], bridgeSubjRanks = [];
for (const q of sampled) {
  const qv = b64(cache.queries[q.id]);
  const scope = ownerDocs.get(q.ownerEntityId) ?? [];
  const bridgeId = (q.qrels.find((r) => r.role === 'bridge') || {}).docId;
  const ansId = (q.qrels.find((r) => r.role === 'direct') || {}).docId;
  // rank of bridge + answer among the (owner-scoped) corpus by cosine
  let bridgeBetter = 0, ansBetter = 0;
  const bridgeScore = bridgeId ? cos(qv, docVec.get(bridgeId)) : -1;
  const ansScore = ansId ? cos(qv, docVec.get(ansId)) : -1;
  // also rank the bridge seed AMONG ONLY this subject's docs (entityIds includes the subject entity)
  const subjEntity = (corpus.docs.find((d) => d.id === bridgeId)?.entityIds ?? []).find((e) => e !== q.ownerEntityId);
  const subjDocs = subjEntity ? (ownerDocs.get(subjEntity) ?? []) : [];
  let bridgeSubjBetter = 0;
  for (const did of scope) { const sc = cos(qv, docVec.get(did)); if (sc > bridgeScore) bridgeBetter++; if (sc > ansScore) ansBetter++; }
  for (const did of subjDocs) { if (cos(qv, docVec.get(did)) > bridgeScore) bridgeSubjBetter++; }
  bridgeRanks.push(bridgeBetter + 1); answerRanks.push(ansBetter + 1); bridgeSubjRanks.push(bridgeSubjBetter + 1);
}
const stat = (a) => { const s = [...a].sort((x, y) => x - y); const p = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))]; return { min: s[0], p50: p(0.5), p90: p(0.9), max: s[s.length - 1], leK: (k) => +(a.filter((r) => r <= k).length / a.length).toFixed(3) }; };
const br = stat(bridgeRanks), ar = stat(answerRanks), bsr = stat(bridgeSubjRanks);
console.log(JSON.stringify({
  corpus: corpusPath, phase: corpus.phase, sampledRelationQueries: sampled.length, scopeSize: (ownerDocs.get(sampled[0]?.ownerEntityId) ?? []).length,
  bridgeSeedRank_ownerScoped: { min: br.min, p50: br.p50, p90: br.p90, max: br.max, fracTop2: br.leK(2), fracTop4: br.leK(4), fracTop8: br.leK(8), fracTop64: br.leK(64), fracTop3200: br.leK(3200) },
  bridgeSeedRank_amongSubjectDocs: { p50: bsr.p50, p90: bsr.p90, max: bsr.max, fracTop2: bsr.leK(2), fracTop8: bsr.leK(8) },
  directAnswerRank_ownerScoped: { p50: ar.p50, p90: ar.p90, max: ar.max, fracTop3200: ar.leK(3200) },
}, null, 2));
