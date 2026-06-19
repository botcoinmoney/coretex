#!/usr/bin/env node
import fs from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const requireFromTmp = createRequire(import.meta.url);
const packageDistRoot = process.env.CORETEX_DIST_ROOT || new URL("../packages/coretex/dist", import.meta.url).pathname;
const coordinatorPath = `${packageDistRoot}/coordinator.js`;
const core = await import(pathToFileURL(coordinatorPath).href);
const seeds = await import(pathToFileURL(`${packageDistRoot}/eval/seed-derivation.js`).href);
const { ethers } = await import(pathToFileURL(requireFromTmp.resolve("ethers", { paths: ["/root/q2-warm"] })).href);

const {
  RANGES,
  decodeSubstrate,
  unpack,
  hexToBytes,
  bytesToHex,
  merkleizeState,
  encodeMemoryIndexSlot,
  encodeTemporalRecord,
  encodePolicyAtom,
  encodeRelationCategoryLens,
  POLICY_SELECTOR,
  POLICY_EVIDENCE_FEATURE,
  buildPolicyEntityRegistry,
  scoreSubstrateAgainstQuery,
  scoringOptionsFromProfile,
  deriveQueryPack,
  loadProductionCorpus,
  createDeterministicBiEncoder,
  createStreamingQwen3Reranker,
  resolveRerankerScriptPath,
  stableRecordIdFor,
  parseQueryRelationIntent,
  parseQueryConflictIntent,
  parseQueryLifecycleIntent,
} = core;

process.env.HF_HUB_OFFLINE ??= "1";
process.env.TRANSFORMERS_OFFLINE ??= "1";
process.env.HF_HOME ??= "/var/lib/coretex/model-cache";
process.env.HF_HUB_CACHE ??= "/var/lib/coretex/model-cache";

const OUT_DIR = "/tmp/coretex-pack-tuning";
const CALIB = process.env.Q2_CALIB || "/root/q2-warm/calib";
const PROFILE_PATH = `${CALIB}/evaluator-profile-v2-dgen1-policy-r5-atom-v16-300k-enabled.json`;
const BUNDLE_PATH = `${CALIB}/bundle-manifest-v2-dgen1-policy-r5-atom-v16-300k-enabled.json`;
const STATE_PATH = process.env.RUNWAY_FINAL || "/root/q2-warm/warm_runway_final_state.json";
const CORPUS_PATH = process.env.CORETEX_CORPUS_PATH || "/root/q2-warm/production-corpus.json";
const EPOCH = Number(process.env.CORETEX_EPOCH || "118");
const MAX_QUERIES_PER_PACK = Number(process.env.MAX_QUERIES_PER_PACK || "64");
const CONTROL_FILTER = (process.env.CONTROL || "").trim();
const PACK_FILTER = (process.env.PACK || "").trim();
const DO_QWEN = process.env.GPUFREE !== "1";
const SCORE_TIMEOUT_MS = Number(process.env.SCORE_TIMEOUT_MS || "0");
const PACK_SEED_MODE = process.env.PACK_SEED_MODE || "canonical_synthetic";
const INCLUDE_CONTROL_QUERY = process.env.INCLUDE_CONTROL_QUERY === "1";
const RELATION_EDGE = process.env.RELATION_EDGE || "derived_from";
const TEMPORAL_ATTRIBUTE = (process.env.TEMPORAL_ATTRIBUTE || "").trim();
const MOTIF_HOOKS = process.env.MOTIF_HOOKS === "1";
const TEMPORAL_MOTIF_HOOKS = process.env.TEMPORAL_MOTIF_HOOKS === "1" || MOTIF_HOOKS;
const CONFLICT_MOTIF_HOOKS = process.env.CONFLICT_MOTIF_HOOKS === "1" || MOTIF_HOOKS;
const EVIDENCE_MOTIF_HOOKS = process.env.EVIDENCE_MOTIF_HOOKS === "1" || MOTIF_HOOKS;
const MOTIF_ADMISSION_MAX_DOCS = Number(process.env.MOTIF_ADMISSION_MAX_DOCS || "4");
const MOTIF_ADMISSION_TOPK = Number(process.env.MOTIF_ADMISSION_TOPK || "16");

const profile = JSON.parse(fs.readFileSync(PROFILE_PATH, "utf8"));
const bundle = JSON.parse(fs.readFileSync(BUNDLE_PATH, "utf8"));
const enc = new TextEncoder();

function cleanJson(value) {
  return JSON.parse(JSON.stringify(value, (_, v) => typeof v === "bigint" ? v.toString() : v));
}

function domainBit(v) {
  const h = BigInt(ethers.keccak256(ethers.toUtf8Bytes(`coretex:domainbit:${v}`)));
  return Number((h & ((1n << 64n) - 1n)) % 60n);
}

function domainBitsFor(ev) {
  const s = new Set();
  for (const v of [
    ev?.domain,
    ev?.family,
    ev?.validity?.subjectEntityId,
    ev?.validity?.attribute,
    ...(ev?.entityIds || []),
  ]) {
    if (v) s.add(String(v));
  }
  let b = 0n;
  for (const v of s) b |= 1n << BigInt(domainBit(v));
  return b || 1n;
}

function qrelDocId(qrel) {
  return typeof qrel === "string" ? qrel : (qrel?.documentId ?? qrel?.docId ?? qrel?.id ?? qrel?.doc ?? null);
}

function truthDocIds(q) {
  const out = new Set();
  for (const d of q?.truthDocuments || []) out.add(typeof d === "string" ? d : (d.id ?? d.documentId ?? d.docId));
  for (const d of q?.qrels || []) {
    const id = qrelDocId(d);
    if (id) out.add(id);
  }
  out.delete(undefined);
  out.delete(null);
  return [...out];
}

function bestTruthDocId(q) {
  let best = null;
  for (const r of q?.qrels || []) {
    const id = qrelDocId(r);
    if (!id) continue;
    const rel = Number(r.relevance ?? 1);
    if (!best || rel > best.rel) best = { id, rel };
  }
  if (best) return best.id;
  return truthDocIds(q)[0] ?? null;
}

function staleTruthDocId(q) {
  let stale = null;
  for (const r of q?.qrels || []) {
    const id = qrelDocId(r);
    if (!id) continue;
    const rel = Number(r.relevance ?? 0);
    if (rel > 0 && rel < 1 && (!stale || rel < stale.rel)) stale = { id, rel };
  }
  if (stale) return stale.id;
  const docs = truthDocIds(q);
  return docs.find((d) => d !== bestTruthDocId(q)) ?? null;
}

function eventForDoc(corpus, docId) {
  if (!docId) return null;
  return corpus.byId.get(`mem_${docId}`) ?? corpus.byId.get(docId) ?? null;
}

function temporalIntentForQuery(corpus, q) {
  const current = eventForDoc(corpus, bestTruthDocId(q));
  const stale = eventForDoc(corpus, staleTruthDocId(q));
  const ev = current?.validity ? current : stale;
  return {
    subjectEntityId: q?.publicIntent?.subjectEntityId ?? q?.subjectEntityId ?? ev?.validity?.subjectEntityId ?? null,
    attribute: q?.publicIntent?.attribute ?? ev?.validity?.attribute ?? null,
    lifecycle: parseQueryLifecycleIntent(q?.queryText ?? null),
    currentDoc: bestTruthDocId(q),
    staleDoc: staleTruthDocId(q),
  };
}

function relationIntentForQuery(q) {
  return [...parseQueryRelationIntent(q?.queryText ?? "")].sort();
}

function familyOf(q) {
  return q?.logicalFamily ?? q?.family ?? "unknown";
}

function dcg(rels) {
  let s = 0;
  rels.forEach((r, i) => { s += (Math.pow(2, r) - 1) / Math.log2(i + 2); });
  return s;
}

function ndcgAt(ranking, k = 10) {
  const rels = ranking.slice(0, k).map((x) => Math.max(0, Number(x.relevance ?? 0)));
  const ideal = ranking.map((x) => Math.max(0, Number(x.relevance ?? 0))).sort((a, b) => b - a).slice(0, k);
  const idcg = dcg(ideal);
  return idcg > 0 ? Number((dcg(rels) / idcg).toFixed(6)) : null;
}

function answerRank(ranking) {
  for (let i = 0; i < ranking.length; i += 1) {
    if (Number(ranking[i]?.relevance ?? 0) > 0) return i + 1;
  }
  return null;
}

function topDoc(ranking) {
  return ranking?.[0]?.docId ?? null;
}

function resultSummary(result, opts) {
  const finalTop20 = result?.finalRankingTop20 ?? [];
  const ranking = result?.finalRankingFull ?? finalTop20;
  const rerankerCandidates = result?.rerankerInputCandidates ?? [];
  const rendered = result?.renderedCandidatesTop20 ?? [];
  return {
    ndcg: ndcgAt(ranking, opts.rerankerTopK ?? 10),
    answerRank: answerRank(ranking),
    topDoc: topDoc(ranking),
    top1Score: result?.top1Score ?? null,
    cappedDocIds: result?.cappedDocIds ?? [],
    rerankerInputDocIds: rerankerCandidates.map((x) => x.docId).filter(Boolean),
    renderedDocIds: rendered.map((x) => x.docId).filter(Boolean),
    finalDocIdsTop20: ranking.slice(0, 20).map((x) => x.docId).filter(Boolean),
    temporalRecordDriven: !!result?.temporalRecordDriven,
    memoryIRDriven: !!result?.memoryIRDriven,
    policyTraceDriven: !!result?.policyTraceDriven,
    policyTraceCount: Array.isArray(result?.policyTraces) ? result.policyTraces.length : 0,
    categoryLensActive: finalTop20.some((x) => Number(x.categoryLensBonus ?? 0) !== 0 || (x.sources ?? []).some((s) => /lens/i.test(String(s)))),
    sourceTagsTop20: [...new Set(finalTop20.flatMap((x) => x.sources ?? []).map(String))].sort(),
    sourceTagsRerankerInput: [...new Set(rerankerCandidates.flatMap((x) => x.sources ?? []).map(String))].sort(),
  };
}

function containsAny(ids, targetIds) {
  const set = new Set(ids || []);
  return (targetIds || []).some((id) => set.has(id));
}

function firstRankOfTargets(result, targetIds) {
  const ranking = result?.finalRankingFull ?? result?.finalRankingTop20 ?? [];
  const targets = new Set(targetIds || []);
  for (let i = 0; i < ranking.length; i += 1) {
    if (targets.has(ranking[i]?.docId)) return i + 1;
  }
  return null;
}

function rankingEntry(result, docId) {
  if (!docId) return null;
  const ranking = result?.finalRankingFull ?? result?.finalRankingTop20 ?? [];
  return ranking.find((x) => x?.docId === docId) ?? null;
}

function finalTopEntry(result, docId) {
  if (!docId) return null;
  return (result?.finalRankingTop20 ?? []).find((x) => x?.docId === docId) ?? null;
}

function renderedEntry(result, docId) {
  if (!docId) return null;
  return [
    ...(result?.rerankerInputCandidates ?? []),
    ...(result?.renderedCandidatesTop20 ?? []),
  ].find((x) => x?.docId === docId) ?? null;
}

function scoreDelta(after, before) {
  if (typeof after !== "number" || typeof before !== "number") return null;
  return Number((after - before).toFixed(12));
}

function hasLifecycleIR(renderedText) {
  return /\[memory_ir[^\n]*\blifecycle=/.test(renderedText ?? "") || /^\[lifecycle=/.test(renderedText ?? "");
}

function temporalLayerDiagnostics(corpus, q, control, publicIntent, beforeRaw, afterRaw, delta) {
  if (control.surface !== "temporal_update" && familyOf(q) !== "temporal_update") return null;
  const currentDoc = bestTruthDocId(q);
  const staleDoc = staleTruthDocId(q);
  const currentEv = eventForDoc(corpus, currentDoc);
  const staleEv = eventForDoc(corpus, staleDoc);
  const motif = motifMatched(control, publicIntent);
  const finalIds = new Set((afterRaw?.finalRankingFull ?? afterRaw?.finalRankingTop20 ?? []).map((x) => x.docId));
  const capIds = new Set([
    ...(afterRaw?.cappedDocIds ?? []),
    ...(afterRaw?.rerankerInputCandidates ?? []).map((x) => x.docId),
  ]);
  const currentRendered = renderedEntry(afterRaw, currentDoc);
  const staleRendered = renderedEntry(afterRaw, staleDoc);
  const currentBefore = rankingEntry(beforeRaw, currentDoc);
  const currentAfter = rankingEntry(afterRaw, currentDoc);
  const staleBefore = rankingEntry(beforeRaw, staleDoc);
  const staleAfter = rankingEntry(afterRaw, staleDoc);
  const currentTop = finalTopEntry(afterRaw, currentDoc);
  const staleTop = finalTopEntry(afterRaw, staleDoc);
  const currentQwenDelta = scoreDelta(currentAfter?.rerankerScore, currentBefore?.rerankerScore);
  const staleQwenDelta = scoreDelta(staleAfter?.rerankerScore, staleBefore?.rerankerScore);
  const qwenMoved = Math.abs(currentQwenDelta ?? 0) > 1e-8 || Math.abs(staleQwenDelta ?? 0) > 1e-8;
  const staleCurrentContrastPresent = !!(
    currentEv?.validity
    && staleEv?.validity
    && currentEv.validity.subjectEntityId === staleEv.validity.subjectEntityId
    && currentEv.validity.attribute === staleEv.validity.attribute
    && currentEv.id !== staleEv.id
  );
  const currentInCandidatePool = finalIds.has(currentDoc);
  const staleInCandidatePool = finalIds.has(staleDoc);
  const currentInRerankerCap = capIds.has(currentDoc);
  const staleInRerankerCap = capIds.has(staleDoc);
  const lifecycleIRRendered = hasLifecycleIR(currentRendered?.renderedText) || hasLifecycleIR(staleRendered?.renderedText);
  let lowestFailingLayer = "metric_improves";
  if (!motif) lowestFailingLayer = "motif_match_absent";
  else if (!staleCurrentContrastPresent) lowestFailingLayer = "stale_current_contrast_absent";
  else if (!currentInCandidatePool && !staleInCandidatePool) lowestFailingLayer = "candidate_not_admitted";
  else if (!currentInRerankerCap && !staleInRerankerCap) lowestFailingLayer = "admitted_but_not_in_reranker_cap";
  else if (!lifecycleIRRendered) lowestFailingLayer = "rendered_without_lifecycle_ir";
  else if (!(typeof delta === "number" && delta > 0) && !qwenMoved) lowestFailingLayer = "lifecycle_ir_rendered_but_qwen_score_unchanged";
  else if (!(typeof delta === "number" && delta > 0)) lowestFailingLayer = "qwen_changes_but_metric_unchanged";
  return {
    lowestFailingLayer,
    currentDoc,
    staleDoc,
    staleCurrentContrastPresent,
    currentInCandidatePool,
    staleInCandidatePool,
    currentInRerankerCap,
    staleInRerankerCap,
    lifecycleIRRendered,
    currentQwenDelta,
    staleQwenDelta,
    currentTemporalBonus: currentTop?.temporalBonus ?? null,
    staleTemporalBonus: staleTop?.temporalBonus ?? null,
    currentFinalReorderingScore: currentTop?.finalReorderingScore ?? null,
    staleFinalReorderingScore: staleTop?.finalReorderingScore ?? null,
  };
}

function anchorWord(ev, slot, { revoked = false, policyAnchor = false, family = null, retrievalSlot = null } = {}) {
  return encodeMemoryIndexSlot({
    slotIndex: slot,
    recordId: stableRecordIdFor(ev.id),
    family: family ?? ev.family ?? "temporal",
    domainBits: domainBitsFor(ev),
    valid: true,
    revoked,
    protected: false,
    policyAnchor,
    retrievalSlot: retrievalSlot ?? (slot % 36),
    expiryEpoch: 0n,
  })[0];
}

function temporalRecordWord(idx, staleSlot, currentSlot) {
  return encodeTemporalRecord({
    recordIndex: idx,
    memorySlot: staleSlot,
    supersededBy: currentSlot,
    validFromEpoch: 1n,
    validUntilEpoch: (2n ** 40n) - 1n,
    currentStaleFlag: true,
  })[0];
}

function conflictAtomWord(idx, targetSlot) {
  return encodePolicyAtom({
    atomIndex: idx,
    family: "conflict_lifecycle",
    selector: POLICY_SELECTOR.CONFLICT_SET_MEMBER,
    evidenceFeature: POLICY_EVIDENCE_FEATURE.CONTRADICTS_EDGE,
    action: "boost",
    scope: "conflict_set",
    targetSlot,
    budget: 300,
    flags: 0,
    validFromEpoch: 0n,
    expiryEpoch: 0n,
  });
}

function evidenceAtomWord(idx, targetSlot) {
  return encodePolicyAtom({
    atomIndex: idx,
    family: "evidence_bundle",
    selector: POLICY_SELECTOR.RELATION_PATH_PRESENT,
    evidenceFeature: POLICY_EVIDENCE_FEATURE.SUPPORT_IN_DEGREE,
    action: "bundle",
    scope: "relation_path",
    targetSlot,
    budget: 250,
    flags: 0,
    validFromEpoch: 0n,
    expiryEpoch: 0n,
  });
}

function cloneState(state) {
  return { ...state, words: [...state.words] };
}

function usedWords(state, start, end) {
  const out = new Set();
  for (let i = start; i <= end; i += 1) if (state.words[i] !== 0n) out.add(i - start);
  return out;
}

function freeIndices(state, start, end, count = 1) {
  const used = usedWords(state, start, end);
  const out = [];
  for (let i = 0; i <= end - start && out.length < count; i += 1) {
    if (!used.has(i)) out.push(i);
  }
  if (out.length < count) throw new Error(`not enough free indices in ${start}..${end}`);
  return out;
}

function decode(state) {
  return decodeSubstrate(state, { policyAtomsMode: true });
}

function recordIdEventMap(corpus) {
  const map = new Map();
  for (const ev of corpus.events) map.set(String(stableRecordIdFor(ev.id)), ev);
  return map;
}

function atomResolved(control, decoded, recordMap) {
  if (control.surface === "relation_category_lens") {
    return (decoded.categoryLenses ?? []).some((l) => l.edgeType === control.edgeType && Number(l.weight) === control.weight);
  }
  if (control.surface === "temporal_update") {
    const rec = (decoded.temporal ?? []).find((t) => t.recordIndex === control.temporalIndex);
    if (!rec) return false;
    const staleSlot = decoded.memoryIndex?.[rec.memorySlot];
    const curSlot = decoded.memoryIndex?.[rec.supersededBy];
    return !!(staleSlot && curSlot && recordMap.get(String(staleSlot.recordId)) && recordMap.get(String(curSlot.recordId)));
  }
  if (control.surface === "conflict_lifecycle") {
    const atom = (decoded.conflictLifecycleAtoms ?? []).find((a) => a.atomIndex === control.atomIndex);
    if (!atom) return false;
    const slot = decoded.memoryIndex?.[atom.targetSlot];
    return !!(slot && recordMap.get(String(slot.recordId)));
  }
  if (control.surface === "evidence_bundle") {
    const atom = (decoded.evidenceBundleAtoms ?? []).find((a) => a.atomIndex === control.atomIndex);
    if (!atom) return false;
    const slot = decoded.memoryIndex?.[atom.targetSlot];
    return !!(slot && recordMap.get(String(slot.recordId)));
  }
  if (control.surface === "noop") return true;
  return false;
}

function inferPublicIntent(corpus, q, entityNames) {
  const temporal = temporalIntentForQuery(corpus, q);
  return {
    family: familyOf(q),
    band: q?.band ?? null,
    split: q?.split ?? null,
    subjectEntityId: q?.publicIntent?.subjectEntityId ?? q?.subjectEntityId ?? temporal.subjectEntityId ?? null,
    attribute: q?.publicIntent?.attribute ?? temporal.attribute ?? null,
    lifecycle: temporal.lifecycle,
    relationIntent: relationIntentForQuery(q),
    conflictIntent: parseQueryConflictIntent(q?.queryText ?? "", entityNames),
  };
}

function motifMatched(control, publicIntent) {
  if (control.surface === "temporal_update") {
    return publicIntent.family === "temporal_update" && publicIntent.attribute === control.attribute;
  }
  if (control.surface === "conflict_lifecycle") {
    return publicIntent.family === "conflict_lifecycle" && publicIntent.conflictIntent === true;
  }
  if (control.surface === "relation_category_lens") {
    return publicIntent.relationIntent.includes(control.edgeType);
  }
  if (control.surface === "evidence_bundle") {
    return publicIntent.relationIntent.includes(control.edgeType);
  }
  return false;
}

function exactTargetMatched(control, publicIntent) {
  if (!control.subjectEntityId || !publicIntent.subjectEntityId) return false;
  return control.subjectEntityId === publicIntent.subjectEntityId;
}

function buildScorerOptions(corpus) {
  if (!DO_QWEN) return null;
  const layout = bundle.model.biEncoder.retrievalKeyLayout;
  const reranker = createStreamingQwen3Reranker({
    model: bundle.model.reranker.modelId,
    revision: bundle.model.reranker.revision,
    pythonBin: process.env.QWEN_PYTHON || "/root/cortex/.venv/bin/python",
    scriptPath: resolveRerankerScriptPath(),
    cacheDir: "/var/lib/coretex/model-cache",
    localOnly: true,
    numThreads: Number(process.env.RERANK_THREADS || 16),
  });
  const biEncoder = createDeterministicBiEncoder({ retrievalKeyLayout: layout });
  const opts = scoringOptionsFromProfile(profile, {
    biEncoder,
    reranker,
    biEncoderHash: "0x" + "00".repeat(32),
    retrievalKeyLayout: layout,
  });
  opts.exposeFullRanking = true;
  opts.exposeRenderedCandidates = true;
  opts.policyEmitTraces = true;
  opts.temporalMotifAdmission = TEMPORAL_MOTIF_HOOKS;
  opts.conflictMotifAdmission = CONFLICT_MOTIF_HOOKS;
  opts.evidenceMotifAdmission = EVIDENCE_MOTIF_HOOKS;
  if (TEMPORAL_MOTIF_HOOKS || CONFLICT_MOTIF_HOOKS || EVIDENCE_MOTIF_HOOKS) {
    opts.motifAdmissionMaxDocs = MOTIF_ADMISSION_MAX_DOCS;
    opts.motifAdmissionTopK = MOTIF_ADMISSION_TOPK;
  }
  const reg = buildPolicyEntityRegistry(corpus);
  opts.policyEntityRegistry = reg.registry;
  opts.policyGenericEntityIds = reg.genericEntityIds;
  return { opts, reranker, entityNames: new Set(reg.registry.flatMap((e) => e.names)) };
}

async function scoreOne(decodedBefore, decodedAfter, q, corpus, opts, control, publicIntent) {
  const beforeRaw = await scoreSubstrateAgainstQuery(decodedBefore, q, corpus, opts);
  const afterRaw = await scoreSubstrateAgainstQuery(decodedAfter, q, corpus, opts);
  const before = resultSummary(beforeRaw, opts);
  const after = resultSummary(afterRaw, opts);
  const targetDocs = control.targetDocIds ?? [];
  const delta = before.ndcg === null || after.ndcg === null ? null : Number((after.ndcg - before.ndcg).toFixed(6));
  const temporalDiagnostics = temporalLayerDiagnostics(corpus, q, control, publicIntent, beforeRaw, afterRaw, delta);
  return {
    queryId: q.id,
    family: familyOf(q),
    publicIntent,
    motifMatched: motifMatched(control, publicIntent),
    exactTargetMatched: exactTargetMatched(control, publicIntent),
    atomResolved: control.atomResolved,
    candidatePoolHit: control.surface === "relation_category_lens"
      ? after.categoryLensActive
      : containsAny([...after.finalDocIdsTop20, ...after.renderedDocIds, ...after.rerankerInputDocIds, ...after.cappedDocIds], targetDocs),
    rerankerCapHit: control.surface === "relation_category_lens"
      ? after.categoryLensActive
      : containsAny([...after.rerankerInputDocIds, ...after.cappedDocIds], targetDocs),
    memoryIRDriven: after.memoryIRDriven,
    temporalRecordDriven: after.temporalRecordDriven,
    policyTraceDriven: after.policyTraceDriven,
    policyTraceCount: after.policyTraceCount,
    motifSourceHit: [...after.sourceTagsTop20, ...after.sourceTagsRerankerInput]
      .some((s) => /Motif$/.test(String(s))),
    beforeRank: before.answerRank,
    afterRank: after.answerRank,
    beforeTargetRank: firstRankOfTargets(beforeRaw, targetDocs),
    afterTargetRank: firstRankOfTargets(afterRaw, targetDocs),
    beforeTopDoc: before.topDoc,
    afterTopDoc: after.topDoc,
    delta,
    beforeNdcg: before.ndcg,
    afterNdcg: after.ndcg,
    ...(temporalDiagnostics ? { temporalDiagnostics } : {}),
    beforeSignals: {
      temporalRecordDriven: before.temporalRecordDriven,
      memoryIRDriven: before.memoryIRDriven,
      policyTraceDriven: before.policyTraceDriven,
      categoryLensActive: before.categoryLensActive,
      sourceTagsTop20: before.sourceTagsTop20,
      sourceTagsRerankerInput: before.sourceTagsRerankerInput,
    },
    afterSignals: {
      temporalRecordDriven: after.temporalRecordDriven,
      memoryIRDriven: after.memoryIRDriven,
      policyTraceDriven: after.policyTraceDriven,
      categoryLensActive: after.categoryLensActive,
      policyTraceCount: after.policyTraceCount,
      sourceTagsTop20: after.sourceTagsTop20,
      sourceTagsRerankerInput: after.sourceTagsRerankerInput,
    },
  };
}

function summarizeRows(rows) {
  const deltas = rows.map((r) => r.delta).filter((d) => typeof d === "number" && Number.isFinite(d)).sort((a, b) => a - b);
  const q = (p) => deltas.length ? deltas[Math.min(deltas.length - 1, Math.floor((deltas.length - 1) * p))] : null;
  const count = (fn) => rows.filter(fn).length;
  const temporalLayers = {};
  for (const row of rows) {
    const layer = row.temporalDiagnostics?.lowestFailingLayer;
    if (!layer) continue;
    temporalLayers[layer] = (temporalLayers[layer] ?? 0) + 1;
  }
  return {
    rows: rows.length,
    motifMatched: count((r) => r.motifMatched),
    exactTargetMatched: count((r) => r.exactTargetMatched),
    candidatePoolHit: count((r) => r.candidatePoolHit),
    rerankerCapHit: count((r) => r.rerankerCapHit),
    memoryIRDriven: count((r) => r.memoryIRDriven),
    temporalRecordDriven: count((r) => r.temporalRecordDriven),
    policyTraceDriven: count((r) => r.policyTraceDriven),
    motifSourceHit: count((r) => r.motifSourceHit),
    positiveDelta: count((r) => typeof r.delta === "number" && r.delta > 0),
    medianDelta: q(0.5),
    p90Delta: q(0.9),
    maxDelta: deltas.length ? deltas[deltas.length - 1] : null,
    ...(Object.keys(temporalLayers).length > 0 ? { temporalLayers } : {}),
  };
}

function makeSeedsForControl(controlName, parentRoot, corpusRoot) {
  if (PACK_SEED_MODE === "baseline_a5") {
    return {
      mode: "baseline_a5_gate_5a_confirm",
      patchHash: null,
      gateSeed: profile.baselineEvalSeedHex || "0x" + "a5".repeat(32),
      confirmSeed: "0x" + "5a".repeat(32),
    };
  }
  if (PACK_SEED_MODE === "baseline_a5_both") {
    return {
      mode: "baseline_a5_both",
      patchHash: null,
      gateSeed: profile.baselineEvalSeedHex || "0x" + "a5".repeat(32),
      confirmSeed: profile.baselineEvalSeedHex || "0x" + "a5".repeat(32),
    };
  }
  const patchHash = seeds.computePatchHash(enc.encode(`coretex-visibility-probe:${controlName}`));
  const input = {
    epochSecret: process.env.PROBE_EPOCH_SECRET || "0x" + "11".repeat(32),
    blockhash: process.env.PROBE_BLOCKHASH || "0x" + "22".repeat(32),
    epochId: EPOCH,
    patchHash,
    parentRoot,
    corpusRoot,
    bundleHash: bundle.bundleHash,
  };
  return {
    mode: "canonical_synthetic_nonzero_entropy",
    patchHash,
    gateSeed: seeds.deriveGateEvalSeed(input),
    confirmSeed: seeds.deriveConfirmEvalSeed(input),
  };
}

function packFor(seed, corpus) {
  const pack = deriveQueryPack(EPOCH, seed, corpus, profile.hiddenPack);
  return pack.queries ?? pack.events ?? pack;
}

function selectPublicTemporal(corpus) {
  for (const q of corpus.events) {
    if (q.split !== "train_visible" || familyOf(q) !== "temporal_update") continue;
    if (TEMPORAL_ATTRIBUTE && q.publicIntent?.attribute !== TEMPORAL_ATTRIBUTE) continue;
    const cur = eventForDoc(corpus, bestTruthDocId(q));
    const stale = eventForDoc(corpus, staleTruthDocId(q));
    if (cur?.validity && stale?.validity && cur.validity.subjectEntityId === stale.validity.subjectEntityId && cur.validity.attribute === stale.validity.attribute) {
      return { q, current: cur, stale };
    }
  }
  throw new Error("no visible temporal control found");
}

function selectPublicConflict(corpus) {
  for (const q of corpus.events) {
    if (q.split !== "train_visible" || familyOf(q) !== "conflict_lifecycle") continue;
    const target = eventForDoc(corpus, bestTruthDocId(q));
    if (target) return { q, target };
  }
  throw new Error("no visible conflict control found");
}

function selectPublicEvidence(corpus) {
  for (const q of corpus.events) {
    if (q.split !== "train_visible") continue;
    const intents = relationIntentForQuery(q).filter((edge) => edge === "supports" || edge === "causes" || edge === "derived_from");
    if (intents.length === 0) continue;
    const docs = [
      bestTruthDocId(q),
      staleTruthDocId(q),
      ...((q.truthDocuments ?? []).map((d) => typeof d === "string" ? d : (d.id ?? d.documentId ?? d.docId))),
      ...((q.hardNegatives ?? []).map((d) => typeof d === "string" ? d : (d.id ?? d.documentId ?? d.docId))),
    ].filter(Boolean);
    for (const docId of docs) {
      const ev = eventForDoc(corpus, docId);
      if (!ev) continue;
      const edge = intents.find((t) => (ev.relations ?? []).some((rel) => rel.edgeType === t));
      if (edge) return { q, anchor: ev, edgeType: edge };
    }
  }
  for (const ev of corpus.events) {
    if (ev.split !== "train_visible" || !(ev.relations ?? []).length) continue;
    const edge = (ev.relations ?? []).find((rel) => rel.edgeType === "supports" || rel.edgeType === "causes" || rel.edgeType === "derived_from");
    if (!edge) continue;
    const q = corpus.events.find((row) =>
      row.split === "train_visible" && relationIntentForQuery(row).includes(edge.edgeType));
    if (q) return { q, anchor: ev, edgeType: edge.edgeType };
  }
  throw new Error("no visible evidence control found");
}

function buildControls(parentState, corpus, recordMap) {
  const hiddenStale = corpus.byId.get("mem_d0131052");
  const hiddenCurrent = corpus.byId.get("mem_d0131055");
  const hiddenQuery = corpus.byId.get("q0027643");
  if (!hiddenStale || !hiddenCurrent || !hiddenQuery) throw new Error("missing hidden temporal control rows");
  const visibleTemporal = selectPublicTemporal(corpus);
  const visibleConflict = selectPublicConflict(corpus);
  const visibleEvidence = selectPublicEvidence(corpus);

  const memFree = freeIndices(parentState, RANGES.MEMORY_INDEX_START, RANGES.MEMORY_INDEX_END, 6);
  const temporalFree = freeIndices(parentState, RANGES.TEMPORAL_START, RANGES.TEMPORAL_END, 2);
  const evidenceFree = freeIndices(parentState, RANGES.POLICY_EVIDENCE_START, RANGES.POLICY_EVIDENCE_END, 1);
  const conflictFree = freeIndices(parentState, RANGES.POLICY_CONFLICT_START, RANGES.POLICY_CONFLICT_END, 1);
  const relationFree = freeIndices(parentState, RANGES.RELATIONS_START, RANGES.RELATIONS_END, 1);
  let m = 0;

  const makeTemporal = ({ name, description, stale, current, temporalIndex, controlQueryId }) => {
    const staleSlot = memFree[m++];
    const currentSlot = memFree[m++];
    const after = cloneState(parentState);
    after.words[RANGES.MEMORY_INDEX_START + staleSlot] = anchorWord(stale, staleSlot, { revoked: true });
    after.words[RANGES.MEMORY_INDEX_START + currentSlot] = anchorWord(current, currentSlot, { revoked: false });
    after.words[RANGES.TEMPORAL_START + temporalIndex] = temporalRecordWord(temporalIndex, staleSlot, currentSlot);
    const decoded = decode(after);
    return {
      name,
      surface: "temporal_update",
      description,
      before: parentState,
      after,
      staleSlot,
      currentSlot,
      temporalIndex,
      staleEventId: stale.id,
      currentEventId: current.id,
      controlQueryId,
      targetDocIds: [
        ...(stale.truthDocuments ?? []).map((d) => d.id ?? d.documentId).filter(Boolean),
        ...(current.truthDocuments ?? []).map((d) => d.id ?? d.documentId).filter(Boolean),
      ],
      subjectEntityId: current.validity?.subjectEntityId ?? stale.validity?.subjectEntityId ?? null,
      attribute: current.validity?.attribute ?? stale.validity?.attribute ?? null,
      atomResolved: atomResolved({ surface: "temporal_update", temporalIndex }, decoded, recordMap),
      decodedCounts: {
        temporal: decoded.temporal?.length ?? 0,
        memoryIndex: (decoded.memoryIndex ?? []).filter((x) => x?.recordId && x.recordId !== 0n).length,
        decodeFailures: decoded.decodeFailures ?? 0,
      },
    };
  };

  const hiddenTemporal = makeTemporal({
    name: "hidden_oracle_temporal_state_advance_control",
    description: "Hidden temporal control from prior live no-submit state-advance measurement: q0027643, d0131052 -> d0131055.",
    stale: hiddenStale,
    current: hiddenCurrent,
    temporalIndex: temporalFree[0],
    controlQueryId: "q0027643",
  });

  const publicTemporal = makeTemporal({
    name: "public_derived_temporal_pack_blind",
    description: `Visible temporal patch derived from ${visibleTemporal.q.id}; same lifecycle/attribute shape but no hidden target knowledge.`,
    stale: visibleTemporal.stale,
    current: visibleTemporal.current,
    temporalIndex: temporalFree[1],
    controlQueryId: visibleTemporal.q.id,
  });

  const conflictSlot = memFree[m++];
  const conflictIndex = conflictFree[0];
  const conflictAfter = cloneState(parentState);
  conflictAfter.words[RANGES.MEMORY_INDEX_START + conflictSlot] = anchorWord(visibleConflict.target, conflictSlot, {
    revoked: false,
    policyAnchor: true,
    family: "multi_hop_relation",
  });
  conflictAfter.words[RANGES.POLICY_CONFLICT_START + conflictIndex] = conflictAtomWord(conflictIndex, conflictSlot);
  const conflictDecoded = decode(conflictAfter);
  const publicConflict = {
    name: "public_derived_conflict_pack_blind",
    surface: "conflict_lifecycle",
    description: `Visible conflict patch derived from ${visibleConflict.q.id}; scoped-conflict atom on a public anchor.`,
    before: parentState,
    after: conflictAfter,
    targetSlot: conflictSlot,
    atomIndex: conflictIndex,
    targetEventId: visibleConflict.target.id,
    controlQueryId: visibleConflict.q.id,
    targetDocIds: (visibleConflict.target.truthDocuments ?? []).map((d) => d.id ?? d.documentId).filter(Boolean),
    subjectEntityId: visibleConflict.target.validity?.subjectEntityId ?? visibleConflict.q.subjectEntityId ?? null,
    attribute: null,
    atomResolved: atomResolved({ surface: "conflict_lifecycle", atomIndex: conflictIndex }, conflictDecoded, recordMap),
    decodedCounts: {
      conflictAtoms: conflictDecoded.conflictLifecycleAtoms?.length ?? 0,
      memoryIndex: (conflictDecoded.memoryIndex ?? []).filter((x) => x?.recordId && x.recordId !== 0n).length,
      decodeFailures: conflictDecoded.decodeFailures ?? 0,
    },
  };

  const evidenceSlot = memFree[m++];
  const evidenceIndex = evidenceFree[0];
  const evidenceAfter = cloneState(parentState);
  evidenceAfter.words[RANGES.MEMORY_INDEX_START + evidenceSlot] = anchorWord(visibleEvidence.anchor, evidenceSlot, {
    revoked: false,
    policyAnchor: true,
    family: "multi_hop_relation",
  });
  evidenceAfter.words[RANGES.POLICY_EVIDENCE_START + evidenceIndex] = evidenceAtomWord(evidenceIndex, evidenceSlot);
  const evidenceDecoded = decode(evidenceAfter);
  const publicEvidence = {
    name: "public_derived_evidence_pack_blind",
    surface: "evidence_bundle",
    description: `Visible evidence atom derived from ${visibleEvidence.q.id}; relation motif ${visibleEvidence.edgeType}, no hidden target knowledge.`,
    before: parentState,
    after: evidenceAfter,
    targetSlot: evidenceSlot,
    atomIndex: evidenceIndex,
    targetEventId: visibleEvidence.anchor.id,
    edgeType: visibleEvidence.edgeType,
    controlQueryId: visibleEvidence.q.id,
    targetDocIds: (visibleEvidence.anchor.truthDocuments ?? []).map((d) => d.id ?? d.documentId).filter(Boolean),
    subjectEntityId: visibleEvidence.anchor.validity?.subjectEntityId ?? visibleEvidence.q.subjectEntityId ?? null,
    attribute: null,
    atomResolved: atomResolved({ surface: "evidence_bundle", atomIndex: evidenceIndex }, evidenceDecoded, recordMap),
    decodedCounts: {
      evidenceAtoms: evidenceDecoded.evidenceBundleAtoms?.length ?? 0,
      memoryIndex: (evidenceDecoded.memoryIndex ?? []).filter((x) => x?.recordId && x.recordId !== 0n).length,
      decodeFailures: evidenceDecoded.decodeFailures ?? 0,
    },
  };

  const relationIndex = relationFree[0];
  const relationAfter = cloneState(parentState);
  relationAfter.words[RANGES.RELATIONS_START + relationIndex] = encodeRelationCategoryLens({
    entryIndex: relationIndex,
    edgeType: RELATION_EDGE,
    weight: 0xffff,
  });
  const relationDecoded = decode(relationAfter);
  const relationLens = {
    name: "relation_category_lens_derived_from_positive_control",
    surface: "relation_category_lens",
    description: `Generalized ${RELATION_EDGE} category lens; no document/slot target.`,
    before: parentState,
    after: relationAfter,
    relationIndex,
    edgeType: RELATION_EDGE,
    weight: 0xffff,
    controlQueryId: RELATION_EDGE === "causes" ? "q0000003" : RELATION_EDGE === "supports" ? "q0000001" : "q0000023",
    targetDocIds: [],
    subjectEntityId: null,
    attribute: null,
    atomResolved: atomResolved({ surface: "relation_category_lens", edgeType: RELATION_EDGE, weight: 0xffff }, relationDecoded, recordMap),
    decodedCounts: {
      categoryLenses: relationDecoded.categoryLenses?.length ?? 0,
      decodeFailures: relationDecoded.decodeFailures ?? 0,
    },
  };

  const noOp = {
    name: "no_op_identity_control",
    surface: "noop",
    description: "Identity control: candidate substrate equals parent substrate.",
    before: parentState,
    after: parentState,
    controlQueryId: null,
    targetDocIds: [],
    subjectEntityId: null,
    attribute: null,
    atomResolved: true,
    decodedCounts: {
      decodeFailures: decode(parentState).decodeFailures ?? 0,
    },
  };

  return [hiddenTemporal, publicTemporal, publicConflict, publicEvidence, relationLens, noOp];
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const corpus = loadProductionCorpus(CORPUS_PATH, { verifyCorpusRoot: false, verifySplits: false });
  const recordMap = recordIdEventMap(corpus);
  const stateSnap = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  const parentState = unpack(hexToBytes(stateSnap.packedHex));
  const parentRoot = bytesToHex(merkleizeState(parentState)).toLowerCase();
  const parentDecoded = decode(parentState);
  const scorer = buildScorerOptions(corpus);
  const entityNames = scorer?.entityNames ?? new Set();
  const opts = scorer?.opts;
  const controls = buildControls(parentState, corpus, recordMap)
    .filter((c) => !CONTROL_FILTER || c.name.includes(CONTROL_FILTER) || c.surface.includes(CONTROL_FILTER));

  const summary = {
    schema: "coretex.visibility-fallapart.v1",
    createdAt: new Date().toISOString(),
    epoch: EPOCH,
    parentRoot,
    corpusRoot: corpus.corpusRoot,
    bundleHash: bundle.bundleHash,
    profilePath: PROFILE_PATH,
    bundlePath: BUNDLE_PATH,
    maxQueriesPerPack: MAX_QUERIES_PER_PACK,
    packSeedMode: PACK_SEED_MODE,
    includeControlQuery: INCLUDE_CONTROL_QUERY,
    qwenEnabled: DO_QWEN,
    motifHooks: MOTIF_HOOKS,
    temporalMotifHooks: TEMPORAL_MOTIF_HOOKS,
    conflictMotifHooks: CONFLICT_MOTIF_HOOKS,
    evidenceMotifHooks: EVIDENCE_MOTIF_HOOKS,
    motifAdmissionMaxDocs: MOTIF_ADMISSION_MAX_DOCS,
    motifAdmissionTopK: MOTIF_ADMISSION_TOPK,
    parentCounts: {
      memoryIndex: (parentDecoded.memoryIndex ?? []).filter((x) => x?.recordId && x.recordId !== 0n).length,
      temporal: parentDecoded.temporal?.length ?? 0,
      conflictAtoms: parentDecoded.conflictLifecycleAtoms?.length ?? 0,
      evidenceAtoms: parentDecoded.evidenceBundleAtoms?.length ?? 0,
      categoryLenses: parentDecoded.categoryLenses?.length ?? 0,
      decodeFailures: parentDecoded.decodeFailures ?? 0,
    },
    controls: [],
  };

  try {
    for (const control of controls) {
      const seedInfo = makeSeedsForControl(control.name, parentRoot, corpus.corpusRoot);
      const decodedBefore = decode(control.before);
      const decodedAfter = decode(control.after);
      const packs = [
        { name: "gate", seed: seedInfo.gateSeed },
        { name: "confirm", seed: seedInfo.confirmSeed },
      ].filter((p) => !PACK_FILTER || p.name === PACK_FILTER);
      const controlOut = {
        ...cleanJson(Object.fromEntries(Object.entries(control).filter(([k]) => !["before", "after"].includes(k)))),
        seedInfo,
        packs: [],
      };
      console.error(`[control] ${control.name} atomResolved=${control.atomResolved}`);

      for (const packMeta of packs) {
        const packQueries = packFor(packMeta.seed, corpus).slice(0, MAX_QUERIES_PER_PACK);
        if (INCLUDE_CONTROL_QUERY && control.controlQueryId) {
          const cq = corpus.byId.get(control.controlQueryId);
          if (cq && !packQueries.some((q) => q.id === cq.id)) packQueries.push(cq);
        }
        const rows = [];
        console.error(`  [pack] ${packMeta.name} seed=${packMeta.seed} queries=${packQueries.length}`);
        if (DO_QWEN) {
          for (let i = 0; i < packQueries.length; i += 1) {
            const q = packQueries[i];
            const publicIntent = inferPublicIntent(corpus, q, entityNames);
            const row = await scoreOne(decodedBefore, decodedAfter, q, corpus, opts, control, publicIntent);
            rows.push(row);
            if ((i + 1) % 8 === 0 || i === packQueries.length - 1) {
              console.error(`    scored ${i + 1}/${packQueries.length}`);
            }
          }
        } else {
          for (const q of packQueries) {
            const publicIntent = inferPublicIntent(corpus, q, entityNames);
            rows.push({
              queryId: q.id,
              family: familyOf(q),
              publicIntent,
              motifMatched: motifMatched(control, publicIntent),
              exactTargetMatched: exactTargetMatched(control, publicIntent),
              atomResolved: control.atomResolved,
            });
          }
        }
        controlOut.packs.push({
          name: packMeta.name,
          seed: packMeta.seed,
          familyCounts: packQueries.reduce((acc, q) => {
            acc[familyOf(q)] = (acc[familyOf(q)] ?? 0) + 1;
            return acc;
          }, {}),
          summary: summarizeRows(rows),
          rows,
        });
      }
      summary.controls.push(controlOut);
    }
  } finally {
    try { scorer?.reranker?.close?.(); } catch {}
  }

  const suffix = (TEMPORAL_MOTIF_HOOKS || CONFLICT_MOTIF_HOOKS || EVIDENCE_MOTIF_HOOKS) ? "motif_hooks_on" : "motif_hooks_off";
  const jsonPath = `${OUT_DIR}/visibility_fallapart_${suffix}.json`;
  const mdPath = `${OUT_DIR}/visibility_fallapart_${suffix}.md`;
  fs.writeFileSync(jsonPath, JSON.stringify(cleanJson(summary), null, 2));
  fs.writeFileSync(mdPath, renderMarkdown(summary));
  console.log(JSON.stringify({ jsonPath, mdPath, controls: summary.controls.map((c) => c.name) }, null, 2));
}

function renderMarkdown(summary) {
  const lines = [];
  lines.push("# CoreTex Visibility Fall-Apart Probe");
  lines.push("");
  lines.push(`- epoch: ${summary.epoch}`);
  lines.push(`- parentRoot: \`${summary.parentRoot}\``);
  lines.push(`- qwenEnabled: ${summary.qwenEnabled}`);
  lines.push(`- maxQueriesPerPack: ${summary.maxQueriesPerPack}`);
  lines.push(`- packSeedMode: ${summary.packSeedMode}`);
  lines.push(`- includeControlQuery: ${summary.includeControlQuery}`);
  lines.push(`- motifHooks: ${summary.motifHooks}`);
  lines.push(`- temporalMotifHooks: ${summary.temporalMotifHooks}`);
  lines.push(`- conflictMotifHooks: ${summary.conflictMotifHooks}`);
  lines.push(`- evidenceMotifHooks: ${summary.evidenceMotifHooks}`);
  lines.push(`- motifAdmissionMaxDocs: ${summary.motifAdmissionMaxDocs}`);
  lines.push(`- motifAdmissionTopK: ${summary.motifAdmissionTopK}`);
  lines.push(`- parent counts: ${JSON.stringify(summary.parentCounts)}`);
  lines.push("");
  lines.push("## Control Summary");
  lines.push("");
  lines.push("| control | surface | atomResolved | pack | motifs | exact | cap hit | motif src | render flags | positive delta | max delta |");
  lines.push("|---|---|---:|---|---:|---:|---:|---:|---|---:|---:|");
  for (const c of summary.controls) {
    for (const p of c.packs) {
      const s = p.summary;
      lines.push(`| ${c.name} | ${c.surface} | ${c.atomResolved} | ${p.name} | ${s.motifMatched}/${s.rows} | ${s.exactTargetMatched}/${s.rows} | ${s.rerankerCapHit}/${s.rows} | ${s.motifSourceHit}/${s.rows} | MIR ${s.memoryIRDriven}, temporal ${s.temporalRecordDriven}, policy ${s.policyTraceDriven} | ${s.positiveDelta}/${s.rows} | ${s.maxDelta ?? ""} |`);
    }
  }
  lines.push("");
  lines.push("## Interpretation Notes");
  lines.push("");
  lines.push("- `motifs` is coarse public motif coverage, not hidden document overlap.");
  lines.push("- `exact` is exact subject/entity overlap with the control anchor and should be near-zero for pack-blind public controls.");
  lines.push("- `cap hit` means the control target document reached the exposed reranker/capped candidate set; for relation lens it means a category-lens signal was active.");
  lines.push("- Render flags are the scorer's exposed `memoryIRDriven`, `temporalRecordDriven`, and `policyTraceDriven` booleans after the patch.");
  lines.push("");
  return lines.join("\n");
}

if (SCORE_TIMEOUT_MS > 0) {
  setTimeout(() => {
    console.error(`timeout after ${SCORE_TIMEOUT_MS}ms`);
    process.exit(124);
  }, SCORE_TIMEOUT_MS).unref();
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
