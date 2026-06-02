#!/usr/bin/env node
/**
 * v15 CPU-only coreference selector redesign mini.
 *
 * This is not the previous direct relation-routing state mini. It is a bounded
 * public-selector oracle over the already reranked cap, used to decide whether a
 * canonical coreference substrate is worth redesigning before any A100 run.
 */
import { distIndex, repoRoot } from './_repo-root.mjs';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { inertBiEncoder } from './lib/build-v2-production-corpus.mjs';
import { loadV2CompatBundle } from './lib/load-materialized-corpus.mjs';
import { calibrationProvenance } from './lib/calibration-provenance.mjs';

const C = await import(distIndex);
const { scoringOptionsFromProfile, evaluateRetrievalBenchmarkState, createDeterministicReranker } = C;

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d;
};

const base = 'release/calibration/2026-05-21-memory-corpus-v2';
const corpusPath = flag('corpus', `${base}/dgen1-r5-synth-300k-v15-corpus.json`);
const embPath = flag('emb', `${base}/dgen1-r5-synth-300k-v15-embeddings.json`);
const profilePath = flag('profile', 'release/bundle/evaluator-profile-v2-dgen1-policy-r5-300k-calibration.json');
const bundlePath = flag('bundle');
if (!bundlePath) {
  console.error('HARD FAIL: --bundle <path> required');
  process.exit(1);
}
const seeds = flag('seeds', '11,17,23').split(',').map(Number).filter(Number.isFinite);
const targetFamilies = flag('target-fams', 'coreference_resolution').split(',').map((s) => s.trim()).filter(Boolean);
const offFamilies = flag('off-fams', 'temporal_update,conflict_lifecycle,aspect_constraint,abstention_missing')
  .split(',').map((s) => s.trim()).filter((f) => f && !targetFamilies.includes(f));
const targetPerFam = Number(flag('target-per-fam', '10'));
const offPerFam = Number(flag('off-per-fam', '4'));
const capPerQuery = Number(flag('cap-per-query', '1'));
const boost = Number(flag('boost', '1'));
const maxJunkPerQuery = Number(flag('max-junk-per-query', '1'));
const auditLimit = Number(flag('audit-limit', '12'));
const outPath = flag('out', `${base}/coreference-selector-redesign-v15-cpu-current.json`);

const rawCorpus = JSON.parse(readFileSync(resolve(repoRoot, corpusPath), 'utf8'));
const profile = JSON.parse(readFileSync(resolve(repoRoot, profilePath), 'utf8'));
const { corpus, queryEvents, LAYOUT, BE, RR, biEncoderHash, manifest } = loadV2CompatBundle(bundlePath, corpusPath, embPath);
const provenance = calibrationProvenance({ bundlePath, corpusPath, embPath, profilePath, manifest });
const reranker = await createDeterministicReranker();
const rt = { biEncoder: inertBiEncoder(BE, LAYOUT), reranker, biEncoderHash, retrievalKeyLayout: LAYOUT };
const opts = { ...scoringOptionsFromProfile(profile, rt), exposeFullRanking: true };

const GENERIC = new Set(['e_universe']);
const byFam = new Map();
for (const q of queryEvents) {
  const f = q.logicalFamily;
  if (!byFam.has(f)) byFam.set(f, []);
  byFam.get(f).push(q);
}
const docById = new Map(rawCorpus.docs.map((d) => [d.id, d]));
const eventByTruthDoc = new Map();
for (const ev of corpus.events) {
  if (ev.split === 'eval_hidden') continue;
  for (const td of ev.truthDocuments ?? []) {
    if (!eventByTruthDoc.has(td.id)) eventByTruthDoc.set(td.id, ev);
  }
}
const corefDocIdsBySubject = new Map();
for (const ev of corpus.events) {
  if (ev.split === 'eval_hidden') continue;
  if (!(ev.relations ?? []).some((r) => r.edgeType === 'coreference_of')) continue;
  const subj = (ev.entityIds ?? []).find((e) => !GENERIC.has(e));
  if (!subj) continue;
  const ids = corefDocIdsBySubject.get(subj) ?? [];
  for (const td of ev.truthDocuments ?? []) ids.push(td.id);
  corefDocIdsBySubject.set(subj, ids);
}

function rng(seed) {
  let s = (seed * 2654435761) >>> 0;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 1) >>> 0;
    return s / 4294967296;
  };
}
function sample(arr, n, rand) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, Math.min(n, a.length));
}
function buildPack(seed) {
  const rand = rng(seed);
  const events = [];
  for (const f of targetFamilies) events.push(...sample(byFam.get(f) ?? [], targetPerFam, rand));
  for (const f of offFamilies) events.push(...sample(byFam.get(f) ?? [], offPerFam, rand));
  return events;
}
function parseCorefIntent(text) {
  const m = String(text ?? '').match(/\bwhat\s+pet\s+does\s+(.+?)\s+the\s+(.+?)\s+have\??$/i);
  if (!m) return null;
  return { alias: m[1].trim().toLowerCase(), role: m[2].trim().toLowerCase() };
}
function docSubject(docId) {
  const d = docById.get(docId);
  return (d?.entityIds ?? []).find((e) => !GENERIC.has(e)) ?? null;
}
function hasCorefEdge(docId) {
  return (eventByTruthDoc.get(docId)?.relations ?? []).some((r) => r.edgeType === 'coreference_of');
}
function docText(docId) {
  return String(docById.get(docId)?.text ?? eventByTruthDoc.get(docId)?.truthDocuments?.find((t) => t.id === docId)?.text ?? '').toLowerCase();
}
function qrelMap(ev) {
  return new Map((ev.qrels ?? []).map((r) => [r.documentId ?? r.docId, r.relevance]));
}
function ndcg(docIds, qrels, k = 10) {
  const gains = docIds.slice(0, k).map((id) => Math.pow(2, qrels.get(id) ?? 0) - 1);
  const dcg = gains.reduce((a, g, i) => a + g / Math.log2(i + 2), 0);
  const ideal = [...qrels.values()].sort((a, b) => b - a).slice(0, k).map((r) => Math.pow(2, r) - 1)
    .reduce((a, g, i) => a + g / Math.log2(i + 2), 0);
  return ideal > 0 ? dcg / ideal : 0;
}
function top10Set(ranking) {
  return new Set(ranking.slice(0, 10).map((r) => r.docId));
}
function damage(before, after, qrels) {
  const b = top10Set(before), a = top10Set(after);
  const maxRel = Math.max(0, ...qrels.values());
  let answerDamage = 0, primaryGoldDamage = 0, junkMoved = 0;
  for (const [docId, rel] of qrels) {
    if (rel > 0 && b.has(docId) && !a.has(docId)) {
      answerDamage++;
      if (rel >= maxRel - 1e-9) primaryGoldDamage++;
    }
  }
  for (const r of after.slice(0, 10)) {
    if ((qrels.get(r.docId) ?? 0) <= 0 && !b.has(r.docId)) junkMoved++;
  }
  return { answerDamage, primaryGoldDamage, junkMoved };
}
function rerankWithBoost(pq, ev, boostDocIds) {
  const qrels = qrelMap(ev);
  const before = (pq.finalRankingFull?.length ? pq.finalRankingFull : pq.finalRankingTop20)
    .map((r, i) => ({ ...r, _i: i, _score: r.finalReorderingScore ?? r.rerankerScore ?? 0 }));
  const boosted = before.map((r) => ({ ...r, _score: r._score + (boostDocIds.has(r.docId) ? boost : 0) }))
    .sort((a, b) => b._score - a._score || a._i - b._i)
    .map((r, i) => ({ ...r, rank: i + 1 }));
  const d = damage(before, boosted, qrels);
  return {
    beforeNdcg: ndcg(before.map((r) => r.docId), qrels),
    afterNdcg: ndcg(boosted.map((r) => r.docId), qrels),
    ...d,
    selectedRelevantTop10: boosted.slice(0, 10).filter((r) => boostDocIds.has(r.docId) && (qrels.get(r.docId) ?? 0) > 0).length,
    selectedJunkTop10: boosted.slice(0, 10).filter((r) => boostDocIds.has(r.docId) && (qrels.get(r.docId) ?? 0) <= 0).length,
    selectedInCap: before.filter((r) => boostDocIds.has(r.docId)).length,
  };
}
function selectDocs(variant, ev, pq, seed) {
  const intent = parseCorefIntent(ev.queryText);
  if (!intent || !ev.subjectEntityId || GENERIC.has(ev.subjectEntityId)) return { docs: new Set(), evidence: { intent, reason: 'no_coref_intent_or_subject' } };
  const inCap = new Set((pq.finalRankingFull?.length ? pq.finalRankingFull : pq.finalRankingTop20).map((r) => r.docId));
  const subjectCoref = (corefDocIdsBySubject.get(ev.subjectEntityId) ?? []).filter((id) => inCap.has(id));
  let picked = [];
  if (variant === 'alias_anchor_exact') {
    const phrase = `${intent.alias} the ${intent.role}`;
    picked = subjectCoref.filter((id) => docText(id).includes(phrase) && hasCorefEdge(id));
  } else if (variant === 'canonical_subject_coref') {
    picked = subjectCoref.filter((id) => hasCorefEdge(id));
  } else if (variant === 'coreference_role_exact') {
    picked = subjectCoref.filter((id) => docText(id).includes(`the ${intent.role}`) && hasCorefEdge(id));
  } else if (variant === 'random_coref_control') {
    const pool = [...corefDocIdsBySubject.values()].flat().filter((id) => inCap.has(id) && docSubject(id) !== ev.subjectEntityId);
    const rand = rng(seed + ev.id.length);
    picked = sample(pool, capPerQuery, rand);
  }
  picked = picked
    .sort((a, b) => (docText(a) < docText(b) ? -1 : docText(a) > docText(b) ? 1 : 0))
    .slice(0, capPerQuery);
  return { docs: new Set(picked), evidence: { intent, selected: picked } };
}
function sliceStats(rows, fams, variant) {
  const rs = rows.filter((r) => fams.includes(r.family));
  const n = rs.length;
  const delta = rs.reduce((a, r) => a + r.variants[variant].deltaNdcg10, 0);
  return {
    n,
    meanDeltaNdcg: n ? +(delta / n).toFixed(4) : 0,
    answerDamage: rs.reduce((a, r) => a + r.variants[variant].answerDamage, 0),
    primaryGoldDamage: rs.reduce((a, r) => a + r.variants[variant].primaryGoldDamage, 0),
    junkMoved: rs.reduce((a, r) => a + r.variants[variant].junkMoved, 0),
    selectedInCap: rs.reduce((a, r) => a + r.variants[variant].selectedInCap, 0),
    selectedRelevantTop10: rs.reduce((a, r) => a + r.variants[variant].selectedRelevantTop10, 0),
    selectedJunkTop10: rs.reduce((a, r) => a + r.variants[variant].selectedJunkTop10, 0),
  };
}
const agg = (arr, sel) => {
  const vals = arr.map(sel);
  return { mean: +(vals.reduce((a, b) => a + b, 0) / Math.max(1, vals.length)).toFixed(4), min: +Math.min(...vals).toFixed(4), max: +Math.max(...vals).toFixed(4), perSeed: vals };
};

const variants = ['alias_anchor_exact', 'canonical_subject_coref', 'coreference_role_exact', 'random_coref_control'];
const eligible = Object.fromEntries([...targetFamilies, ...offFamilies].map((f) => [f, (byFam.get(f) ?? []).length]));
const perSeed = [];
for (const seed of seeds) {
  const packEvents = buildPack(seed);
  const pack = { events: packEvents, corpusRoot: corpus.corpusRoot, epochId: seed, evalSeedHex: '0x' + seed.toString(16).padStart(64, '0') };
  const B = await evaluateRetrievalBenchmarkState({ words: new Array(1024).fill(0n) }, corpus, pack, opts);
  const byId = new Map(B.perQuery.map((q) => [q.recordId, q]));
  const rows = [];
  for (const ev of packEvents) {
    const pq = byId.get(ev.id);
    if (!pq) continue;
    const row = { id: ev.id, family: ev.logicalFamily, subjectEntityId: ev.subjectEntityId ?? null, queryText: ev.queryText, variants: {} };
    for (const v of variants) {
      const sel = selectDocs(v, ev, pq, seed);
      const r = rerankWithBoost(pq, ev, sel.docs);
      row.variants[v] = { ...r, deltaNdcg10: +(r.afterNdcg - r.beforeNdcg).toFixed(4), selectedDocIds: [...sel.docs], evidence: sel.evidence };
    }
    rows.push(row);
  }
  const variantStats = Object.fromEntries(variants.map((v) => [v, { target: sliceStats(rows, targetFamilies, v), off: sliceStats(rows, offFamilies, v) }]));
  perSeed.push({
    seed,
    packSize: packEvents.length,
    packFamilyCounts: Object.fromEntries([...new Set(packEvents.map((e) => e.logicalFamily))].map((f) => [f, packEvents.filter((e) => e.logicalFamily === f).length])),
    variantStats,
    audit: rows.filter((r) => targetFamilies.includes(r.family)).slice(0, auditLimit),
  });
  console.error(`[coref-redesign] seed=${seed} aliasΔ=${variantStats.alias_anchor_exact.target.meanDeltaNdcg} subjΔ=${variantStats.canonical_subject_coref.target.meanDeltaNdcg} roleΔ=${variantStats.coreference_role_exact.target.meanDeltaNdcg} randomΔ=${variantStats.random_coref_control.target.meanDeltaNdcg}`);
}

const summary = {};
const armPass = {};
for (const v of variants) {
  const targetMean = agg(perSeed, (s) => s.variantStats[v].target.meanDeltaNdcg);
  const offMean = agg(perSeed, (s) => s.variantStats[v].off.meanDeltaNdcg);
  const targetAnswerDamage = perSeed.reduce((a, s) => a + s.variantStats[v].target.answerDamage, 0);
  const targetPrimaryGoldDamage = perSeed.reduce((a, s) => a + s.variantStats[v].target.primaryGoldDamage, 0);
  const targetJunkMoved = perSeed.reduce((a, s) => a + s.variantStats[v].target.junkMoved, 0);
  const targetN = perSeed.reduce((a, s) => a + s.variantStats[v].target.n, 0);
  const offAnswerDamage = perSeed.reduce((a, s) => a + s.variantStats[v].off.answerDamage, 0);
  const offPrimaryGoldDamage = perSeed.reduce((a, s) => a + s.variantStats[v].off.primaryGoldDamage, 0);
  summary[v] = { targetMean, offMean, targetAnswerDamage, targetPrimaryGoldDamage, targetJunkMoved, offAnswerDamage, offPrimaryGoldDamage };
  armPass[v] = v !== 'random_coref_control'
    && perSeed.every((s) => s.variantStats[v].target.meanDeltaNdcg > 0 && s.variantStats[v].off.meanDeltaNdcg === 0)
    && targetAnswerDamage === 0
    && targetPrimaryGoldDamage === 0
    && targetJunkMoved <= maxJunkPerQuery * Math.max(1, targetN)
    && offAnswerDamage === 0
    && offPrimaryGoldDamage === 0;
}
const pass = Object.values(armPass).some(Boolean);
const verdict = {
  pass,
  promote: Object.entries(armPass).filter(([, ok]) => ok).map(([arm]) => arm),
  doNotPromote: Object.entries(armPass).filter(([, ok]) => !ok).map(([arm]) => arm),
  needsFollowup: pass ? ['canonical_substrate_design_required_before_a100'] : ['selector_or_knob_redesign'],
  reasons: [
    pass ? 'at least one public coreference selector shape has positive target lift with clean CPU safety controls' : 'no public coreference selector shape is clean under CPU safety controls',
    `junk cap=${maxJunkPerQuery}/query`,
    'CPU deterministic selector oracle only; no canonical substrate state written and no Qwen gate',
  ],
};
const report = {
  schema: 'coretex.calibration.coreference-selector-redesign-mini.v1',
  probe: 'CPU-only bounded public coreference selector redesign mini',
  targetSurface: 'coreference_selector_redesign',
  generatedAt: new Date().toISOString(),
  ...provenance,
  commandArgs: process.argv.slice(2),
  reranker: { mode: 'deterministic', modelId: RR.modelId, revision: RR.revision },
  targetFamilies,
  offFamilies,
  seeds,
  knobs: { targetPerFam, offPerFam, capPerQuery, boost, maxJunkPerQuery, auditLimit },
  variants,
  lowerLayerGateSummary: {
    eligible,
    allSeedsHaveTargetPack: perSeed.every((s) => targetFamilies.every((f) => (s.packFamilyCounts[f] ?? 0) > 0)),
    allSeedsHaveCorefSelectorCandidates: perSeed.every((s) => s.variantStats.alias_anchor_exact.target.selectedInCap > 0),
    qwenRankCheck: 'not_applicable_deterministic_reranker',
    canonicalStateWritten: false,
  },
  verdict,
  passFailSummary: pass ? 'PASS CPU selector oracle; canonical substrate design required before A100.' : 'FAIL CPU selector oracle; keep coreference sandboxed.',
  summary,
  perSeed,
};
mkdirSync(dirname(resolve(repoRoot, outPath)), { recursive: true });
writeFileSync(resolve(repoRoot, outPath), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ verdict, summary }, null, 2));
if (typeof reranker.close === 'function') reranker.close();
