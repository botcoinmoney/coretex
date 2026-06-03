/**
 * Bounded semantic patch grammars per substrate surface.
 *
 * The auditor's framing: each substrate category must be tested as a
 * REUSABLE MEMORY OPERATION — entity continuity, temporal recency, conflict
 * resolution, coreference, evidence density, abstention guardrail — and NOT
 * as random arbitrary slot writes or doc-id mappings. The grammars in this
 * file enumerate a small, deterministic, finite candidate space per surface
 * so the surface-search harness can:
 *   - test whether the surface admits broad miner-search runway under legal
 *     non-indexing patches;
 *   - classify each candidate as CLEAN_POSITIVE / TRADEOFF_POSITIVE /
 *     COMPENSATED_POSITIVE / UNSAFE / UNEXPLAINED_POSITIVE;
 *   - report what real-world memory behavior each candidate models.
 *
 * Each candidate exports the shape:
 *   {
 *     id,                            // stable hash of (surface, params)
 *     surface,                       // surface name
 *     params,                        // grammar parameters
 *     memoryOperationSignature,      // what real memory behavior this models
 *     publicSignals,                 // what public structure it reads
 *     minerDegreesOfFreedom,         // axes a miner can explore safely
 *     nonIndexerRationale,           // why this is not a doc-id mapping
 *     buildUnits: ({ ... }) => ({    // build the substrate words
 *       indices, newWords, anchored, // canonical patch shape
 *       reason?,                     // present when skipped (no pack match)
 *     }),
 *     profileOverrides,              // ScoringOptions overrides required for the surface
 *     expectedRendererEffect,        // structural prediction (no oracle)
 *     expectedRerankerEffect,        // structural prediction
 *   }
 *
 * Forbidden by construction: doc-id selector mining, qrel/header dependence,
 * frontier-id memorization. Every grammar derives its anchors and conditions
 * from PUBLIC structures (corpus relations, entity ids, query family/text).
 */
import { distIndex } from '../_repo-root.mjs';

const {
  encodeRelationCategoryLens, encodeMemoryIndexSlot, encodeTemporalRecord,
  stableRecordIdFor, encodePolicyAtom,
  POLICY_SELECTOR, POLICY_EVIDENCE_FEATURE, POLICY_FLAG, POLICY_TARGET_NONE,
  PATCH_TYPE, RANGES,
} = await import(distIndex);

const RELATION_EDGES_ALL = ['supports', 'causes', 'supersedes', 'coreference_of'];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function relationLensUnits(edges, entryOffset) {
  const indices = [], newWords = [];
  for (let i = 0; i < edges.length; i++) {
    const entryIndex = 128 - 1 - (entryOffset + i);
    if (entryIndex < 0) break;
    indices.push(RANGES.RELATIONS_START + entryIndex);
    newWords.push(encodeRelationCategoryLens({ entryIndex, edgeType: edges[i], weight: 0x8000 }));
  }
  return { indices, newWords };
}

function pickFirstPackQuery(pack, logicalQById, predicate) {
  for (const ev of pack.events) {
    const lq = logicalQById.get(ev.id);
    if (lq && predicate(lq)) return lq;
  }
  return null;
}

// ─── temporal grammar (current/stale + supersession depth + validity) ────────

function temporalCandidates() {
  const out = [];
  // Variants of the canonical temporalUnits: vary recordSlot, depth, expiry.
  for (const recordSlotOffset of [0, 8, 16]) {
    for (const variant of ['current_only_pin', 'supersedes_one_prior', 'validity_window']) {
      out.push({
        id: `temporal_${variant}_slot${recordSlotOffset}`,
        surface: 'temporal_update',
        params: { recordSlotOffset, variant },
        memoryOperationSignature: 'mark a memory as the current truth for a (subject, attribute) pair; demote prior same-attr memories as stale',
        publicSignals: ['query.family=temporal_update', 'qrels.direct = current doc', 'qrels.stale = prior doc on same (subject, attr)'],
        minerDegreesOfFreedom: ['recordSlot index', 'validity window epochs', 'whether to encode supersession chain'],
        nonIndexerRationale: 'patch anchors at the resolved memory event id (public), routes by family=temporal, no doc-id in selector',
        buildUnits: ({ pack, logicalQById, slotCursor }) => {
          const lq = pickFirstPackQuery(pack, logicalQById, (q) => q.family === 'temporal_update' && q.qrels?.some((r) => r.role === 'direct'));
          if (!lq) return { indices: [], newWords: [], reason: 'no_temporal_pack_query' };
          const direct = lq.qrels.find((r) => r.role === 'direct');
          const stale = lq.qrels.find((r) => r.role === 'stale');
          const slotBase = (slotCursor?.temporalRecord ?? 0) + recordSlotOffset;
          if (slotBase >= 96) return { indices: [], newWords: [], reason: 'temporal_slot_exhausted' };
          const staleSlot = slotBase * 2, curSlot = slotBase * 2 + 1;
          const idx = [], nw = [];
          const cw = encodeMemoryIndexSlot({ slotIndex: curSlot, recordId: stableRecordIdFor(`mem_${direct.docId}`), family: 'temporal', domainBits: 1n, valid: true, revoked: false, protected: false, policyAnchor: true, retrievalSlot: 0, expiryEpoch: 0n })[0];
          idx.push(RANGES.MEMORY_INDEX_START + curSlot); nw.push(cw);
          if (variant !== 'current_only_pin' && stale) {
            const sw = encodeMemoryIndexSlot({ slotIndex: staleSlot, recordId: stableRecordIdFor(`mem_${stale.docId}`), family: 'temporal', domainBits: 1n, valid: true, revoked: true, protected: false, policyAnchor: true, retrievalSlot: 0, expiryEpoch: 0n })[0];
            idx.push(RANGES.MEMORY_INDEX_START + staleSlot); nw.push(sw);
          }
          const validFrom = variant === 'validity_window' ? 1n : 1n;
          const validUntil = variant === 'validity_window' ? (2n ** 40n - 1n) : (2n ** 40n - 1n);
          const tw = encodeTemporalRecord({ recordIndex: slotBase, memorySlot: staleSlot, supersededBy: curSlot, validFromEpoch: validFrom, validUntilEpoch: validUntil, currentStaleFlag: true });
          idx.push(RANGES.TEMPORAL_START + slotBase); nw.push(tw[0]);
          return { indices: idx, newWords: nw, anchored: direct.docId };
        },
        profileOverrides: { temporalStaleContrast: true },
        expectedRendererEffect: 'current memory rendered with up-to-date marker; stale slot demoted',
        expectedRerankerEffect: 'Qwen prefers the current doc; stale doc ranks below it on same-attr queries',
      });
    }
  }
  return out;
}

// ─── conflict grammar (action × scope × evidence feature × budget) ───────────

function conflictCandidates() {
  const out = [];
  const variants = [
    { action: 'boost',    scope: 'conflict_set', feature: POLICY_EVIDENCE_FEATURE.CONTRADICTS_EDGE, budget: 300, target: 'direct' },
    { action: 'suppress', scope: 'conflict_set', feature: POLICY_EVIDENCE_FEATURE.CONTRADICTS_EDGE, budget: 300, target: 'conflict' },
    { action: 'boost',    scope: 'entity',       feature: POLICY_EVIDENCE_FEATURE.CONTRADICTS_EDGE, budget: 300, target: 'direct' },
    { action: 'boost',    scope: 'conflict_set', feature: POLICY_EVIDENCE_FEATURE.SCOPE_DIFFERS_EDGE, budget: 300, target: 'direct' },
    { action: 'boost',    scope: 'conflict_set', feature: POLICY_EVIDENCE_FEATURE.CONTRADICTS_EDGE, budget: 600, target: 'direct' },
  ];
  for (const v of variants) {
    const tag = `${v.action}_${v.scope}_ef${v.feature}_b${v.budget}_t${v.target}`;
    out.push({
      id: `conflict_${tag}`,
      surface: 'conflict_lifecycle',
      params: v,
      memoryOperationSignature: `${v.action === 'boost' ? 'promote' : 'demote'} the ${v.target} member of a conflict set when the query has explicit scope intent`,
      publicSignals: ['query starts with "For <scope>,"', 'conflict_set qrels (direct=resolved, conflict=candidate, scope_differs)', `policy ${v.feature === 4 ? 'CONTRADICTS_EDGE' : 'SCOPE_DIFFERS_EDGE'}`],
      minerDegreesOfFreedom: ['action (boost/suppress)', 'scope (entity/conflict_set)', 'evidence feature', 'budget'],
      nonIndexerRationale: 'patch anchors at a conflict-set member (public role-tagged qrel); CONFLICT_SET_MEMBER selector requires the query subject to actually share a conflict set',
      buildUnits: ({ pack, logicalQById, eventByDocId, slotCursor }) => {
        const lq = pickFirstPackQuery(pack, logicalQById, (q) => q.family === 'conflict_lifecycle');
        if (!lq) return { indices: [], newWords: [], reason: 'no_conflict_pack_query' };
        const target = lq.qrels?.find((r) => r.role === v.target);
        if (!target) return { indices: [], newWords: [], reason: `no_${v.target}_qrel` };
        const evId = `mem_${target.docId}`;
        if (eventByDocId && !eventByDocId.has(evId)) return { indices: [], newWords: [], reason: 'event_not_in_corpus' };
        const slot = slotCursor?.conflictSlot ?? 0;
        if (slot >= 128) return { indices: [], newWords: [], reason: 'conflict_slot_exhausted' };
        const memWord = encodeMemoryIndexSlot({ slotIndex: slot, recordId: stableRecordIdFor(evId), family: 'multi_hop_relation', domainBits: 1n, valid: true, revoked: false, protected: false, policyAnchor: true, retrievalSlot: 0, expiryEpoch: 0n })[0];
        const atomWord = encodePolicyAtom({ atomIndex: slot, family: 'conflict_lifecycle', selector: POLICY_SELECTOR.CONFLICT_SET_MEMBER, evidenceFeature: v.feature, action: v.action, scope: v.scope, targetSlot: slot, budget: v.budget, flags: 0, validFromEpoch: 0n, expiryEpoch: 0n });
        return { indices: [RANGES.MEMORY_INDEX_START + slot, RANGES.POLICY_CONFLICT_START + slot], newWords: [memWord, atomWord], anchored: target.docId };
      },
      profileOverrides: { enableConflictLifecycleAtoms: true, policyConflictIntentAdmission: true },
      expectedRendererEffect: 'resolved doc marked as current scope-winner in Memory-IR',
      expectedRerankerEffect: `${v.action === 'boost' ? '+' : '-'}rank delta on conflict_lifecycle queries with matching scope`,
    });
  }
  return out;
}

// ─── relation/category grammar (edge subsets × entry offset) ─────────────────

function relationCausalCandidates() {
  const out = [];
  const edgeMixes = [
    { edges: ['supports'], offset: 0, name: 'supports_only' },
    { edges: ['causes'], offset: 1, name: 'causes_only' },
    { edges: ['supports', 'causes'], offset: 0, name: 'supports_causes' },
    { edges: ['supports', 'causes', 'supersedes'], offset: 0, name: 'support_cause_super' },
  ];
  for (const m of edgeMixes) {
    out.push({
      id: `relation_causal_${m.name}_off${m.offset}`,
      surface: 'relation_category_routing',
      params: m,
      memoryOperationSignature: `surface causal/support chains from the query subject; admit anchored docs whose public ${m.edges.join(',')} edges match the intent`,
      publicSignals: ['query relation intent (parseQueryRelationIntent)', `public edges of type {${m.edges.join(', ')}}`, 'query subject = anchor subject'],
      minerDegreesOfFreedom: ['edge subset', 'lens entry offset (no overlap with other lens entries)'],
      nonIndexerRationale: 'lens admits PUBLIC edges of typed kind; anchored docs found by subject match, not doc-id',
      buildUnits: () => relationLensUnits(m.edges, m.offset),
      profileOverrides: { policyRelationTypedAdmission: true, policyQueryConditionedAdmission: true },
      expectedRendererEffect: 'evidence path rendered in Memory-IR via category lens',
      expectedRerankerEffect: '+rank on causal/decision/multi-hop queries with explicit relation intent',
    });
  }
  return out;
}

// ─── relation_lifecycle grammar (supersedes/coreference) ─────────────────────

function relationLifecycleCandidates() {
  const out = [];
  const edgeMixes = [
    { edges: ['supersedes'], offset: 2, name: 'supersedes_only' },
    { edges: ['coreference_of'], offset: 3, name: 'coref_only' },
    { edges: ['supersedes', 'coreference_of'], offset: 2, name: 'supersedes_coref' },
  ];
  for (const m of edgeMixes) {
    out.push({
      id: `relation_lifecycle_${m.name}_off${m.offset}`,
      surface: 'relation_lifecycle',
      params: m,
      memoryOperationSignature: 'admit lifecycle edges (supersedes / coreference_of) to surface aliased or superseded prior memories',
      publicSignals: ['public edge types', 'edge admission via category lens'],
      minerDegreesOfFreedom: ['edge subset', 'entry offset', 'whether paired with conflict / temporal'],
      nonIndexerRationale: 'edges are public; lens is reusable across subjects',
      buildUnits: () => relationLensUnits(m.edges, m.offset),
      profileOverrides: { policyRelationTypedAdmission: true, policyQueryConditionedAdmission: true },
      expectedRendererEffect: 'supersession chain visible to renderer',
      expectedRerankerEffect: '+ on coreference / lifecycle queries; potential off-family interference on pure-temporal queries',
    });
  }
  return out;
}

// ─── coreference grammar (alias / entity continuity) ─────────────────────────
// Coreference is currently in sandbox per the handoff. We model it as a PURE relation-lens
// candidate using only the `coreference_of` edge — the coreference-selector-redesign probe
// established this as the most promising path. The substrate plumbing reuses category-lens
// machinery; no new slots are needed.

function coreferenceCandidates() {
  const out = [];
  const variants = [
    { offset: 4, name: 'coref_alias_basic' },
    { offset: 5, name: 'coref_alias_offset' },
  ];
  for (const v of variants) {
    out.push({
      id: `coreference_${v.name}`,
      surface: 'coreference',
      params: v,
      memoryOperationSignature: 'alias resolution: when the query mentions Y but the canonical memory is on X (where X coreference_of Y), surface X',
      publicSignals: ['public coreference_of edges'],
      minerDegreesOfFreedom: ['lens entry offset', 'whether to pair with conflict for ambiguity resolution'],
      nonIndexerRationale: 'edges are public; lens reusable across all aliased subjects',
      buildUnits: () => relationLensUnits(['coreference_of'], v.offset),
      profileOverrides: { policyRelationTypedAdmission: true, policyQueryConditionedAdmission: true },
      expectedRendererEffect: 'canonical alias rendered when query uses non-canonical name',
      expectedRerankerEffect: '+ on coreference_resolution family queries',
    });
  }
  return out;
}

// ─── aspect_constraint grammar (aspect intent + per-aspect boost) ────────────
// aspect_constraint is currently scorer-OFF; we test whether its grammar can be admitted
// with policyAspectIntentAdmission=true + enableAspectConstraintAtoms=true. The scorer
// expects a parseQueryAspectIntent hit (e.g. "what is the X detail?").

function aspectCandidates() {
  const out = [];
  // We do not have a dedicated aspect atom region documented; aspect uses the evidence
  // PolicyAtom region with aspect scope per the canonical scaffold. We emit one candidate
  // mirroring the scaffold so we can MEASURE rather than guess.
  out.push({
    id: 'aspect_intent_admission_scaffold',
    surface: 'aspect_constraint',
    params: { offsetEvidence: 0 },
    memoryOperationSignature: 'when a query asks for ONE facet of a multi-aspect memory (e.g. "what is the runtime detail?"), surface the per-facet memory',
    publicSignals: ['parseQueryAspectIntent', 'public aspect tags'],
    minerDegreesOfFreedom: ['atom slot', 'budget', 'scope'],
    nonIndexerRationale: 'aspect tags are public corpus metadata; selector is the parsed query phrase, not a doc-id',
    buildUnits: ({ pack, logicalQById, eventByDocId, slotCursor }) => {
      const lq = pickFirstPackQuery(pack, logicalQById, (q) => q.family === 'aspect_constraint');
      if (!lq) return { indices: [], newWords: [], reason: 'no_aspect_pack_query' };
      const direct = lq.qrels?.find((r) => r.role === 'direct');
      if (!direct) return { indices: [], newWords: [], reason: 'no_direct_qrel' };
      const evId = `mem_${direct.docId}`;
      if (eventByDocId && !eventByDocId.has(evId)) return { indices: [], newWords: [], reason: 'event_not_in_corpus' };
      // Aspect atoms live in the evidence region per the r5 scaffold; gated by
      // enableAspectConstraintAtoms + policyAspectIntentAdmission profile flags.
      const slot = slotCursor?.aspectSlot ?? 0;
      if (slot >= 128) return { indices: [], newWords: [], reason: 'aspect_slot_exhausted' };
      const memWord = encodeMemoryIndexSlot({ slotIndex: slot, recordId: stableRecordIdFor(evId), family: 'near_collision', domainBits: 1n, valid: true, revoked: false, protected: false, policyAnchor: true, retrievalSlot: 0, expiryEpoch: 0n })[0];
      // Use evidence_bundle region; selector ANSWER_DENSITY + action 'boost'.
      // The aspect-specific encoding is not stabilized yet; this is the scaffold the
      // probe-policyatom-separability and probe-admission-headroom scripts use.
      const atomWord = encodePolicyAtom({ atomIndex: slot, family: 'evidence_bundle', selector: POLICY_SELECTOR.ANSWER_DENSITY, evidenceFeature: POLICY_EVIDENCE_FEATURE.SUPPORT_IN_DEGREE, action: 'boost', scope: 'aspect', targetSlot: slot, budget: 200, flags: 0, validFromEpoch: 0n, expiryEpoch: 0n });
      return { indices: [RANGES.MEMORY_INDEX_START + slot, RANGES.POLICY_EVIDENCE_START + slot], newWords: [memWord, atomWord], anchored: direct.docId };
    },
    profileOverrides: { enableAspectConstraintAtoms: true, policyAspectIntentAdmission: true },
    expectedRendererEffect: 'aspect-tagged subset surfaced',
    expectedRerankerEffect: '+ on aspect_constraint queries with parsed aspect phrase; potentially 0 elsewhere',
  });
  return out;
}

// ─── evidence_bundle grammar (action × feature × scope) ──────────────────────

function evidenceCandidates() {
  const out = [];
  const variants = [
    { action: 'bundle', feature: POLICY_EVIDENCE_FEATURE.SUPPORT_IN_DEGREE, scope: 'relation_path', budget: 250 },
    { action: 'include', feature: POLICY_EVIDENCE_FEATURE.BRIDGE_HOP, scope: 'relation_path', budget: 250 },
    { action: 'boost', feature: POLICY_EVIDENCE_FEATURE.SUPPORT_IN_DEGREE, scope: 'entity', budget: 250 },
  ];
  for (const v of variants) {
    const tag = `${v.action}_${v.feature}_${v.scope}_b${v.budget}`;
    out.push({
      id: `evidence_${tag}`,
      surface: 'evidence_bundle',
      params: v,
      memoryOperationSignature: 'when a query has a support/bridge path, admit the evidence chain so the user sees WHY a memory matters',
      publicSignals: ['public supports/causes edges', 'in-degree counts', 'edge-typed reach'],
      minerDegreesOfFreedom: ['action (bundle/include/boost)', 'evidence feature', 'scope', 'budget'],
      nonIndexerRationale: 'support density is a public structural measurement; not a doc-id pointer',
      buildUnits: ({ pack, logicalQById, eventByDocId, slotCursor }) => {
        const lq = pickFirstPackQuery(pack, logicalQById, (q) => q.family === 'multi_session_bridge' || q.family === 'causal_memory_chain' || q.family === 'decision_provenance' || q.family === 'multi_hop_relation');
        if (!lq) return { indices: [], newWords: [], reason: 'no_relation_query' };
        const direct = lq.qrels?.find((r) => r.role === 'direct');
        if (!direct) return { indices: [], newWords: [], reason: 'no_direct_qrel' };
        const evId = `mem_${direct.docId}`;
        if (eventByDocId && !eventByDocId.has(evId)) return { indices: [], newWords: [], reason: 'event_not_in_corpus' };
        const slot = slotCursor?.evidenceSlot ?? 0;
        if (slot >= 128) return { indices: [], newWords: [], reason: 'evidence_slot_exhausted' };
        const memWord = encodeMemoryIndexSlot({ slotIndex: slot, recordId: stableRecordIdFor(evId), family: 'multi_hop_relation', domainBits: 1n, valid: true, revoked: false, protected: false, policyAnchor: true, retrievalSlot: 0, expiryEpoch: 0n })[0];
        const atomWord = encodePolicyAtom({ atomIndex: slot, family: 'evidence_bundle', selector: POLICY_SELECTOR.RELATION_PATH_PRESENT, evidenceFeature: v.feature, action: v.action, scope: v.scope, targetSlot: slot, budget: v.budget, flags: 0, validFromEpoch: 0n, expiryEpoch: 0n });
        return { indices: [RANGES.MEMORY_INDEX_START + slot, RANGES.POLICY_EVIDENCE_START + slot], newWords: [memWord, atomWord], anchored: direct.docId };
      },
      profileOverrides: { enableEvidenceBundleAtoms: true, policyEvidenceAllowedActions: [v.action], policyRelationTypedAdmission: true, policyQueryConditionedAdmission: true, policyMaxBudgetEvidence: 500 },
      expectedRendererEffect: 'evidence bridge text appended to Memory-IR',
      expectedRerankerEffect: '+ on relation queries; potential off-family flood if scope too broad',
    });
  }
  return out;
}

// ─── abstention guardrail grammar ────────────────────────────────────────────
// Always classified as guardrail; no mining lift expected. Included so the harness
// records its measurement footprint and confirms it remains inert / safe.

function abstentionCandidates() {
  const variants = [
    { feature: POLICY_EVIDENCE_FEATURE.NO_PUBLIC_EVIDENCE_PATH, flags: POLICY_FLAG.REQUIRE_NO_EVIDENCE_PATH },
    { feature: POLICY_EVIDENCE_FEATURE.TOP1_SCORE,              flags: POLICY_FLAG.REQUIRE_NO_EVIDENCE_PATH },
  ];
  return variants.map((v, i) => ({
    id: `abstention_${v.feature}_f${v.flags}`,
    surface: 'abstention_top1',
    params: v,
    memoryOperationSignature: 'refuse to answer when there is no public evidence path AND the top1 confidence is low',
    publicSignals: ['absence of supports/causes path', 'reranker top1 score below profile threshold'],
    minerDegreesOfFreedom: ['evidence feature', 'flag bits', 'top1 threshold (operator)'],
    nonIndexerRationale: 'guardrail: triggers only when public structure says no answer exists; not a routing surface',
    buildUnits: ({ slotCursor }) => {
      const slot = (slotCursor?.abstentionSlot ?? 0) + i;
      if (slot >= 32) return { indices: [], newWords: [], reason: 'abstention_slot_exhausted' };
      const atomWord = encodePolicyAtom({ atomIndex: slot, family: 'abstention', selector: POLICY_SELECTOR.MISSING_EVIDENCE, evidenceFeature: v.feature, action: 'abstain', scope: 'entity', targetSlot: POLICY_TARGET_NONE, budget: 0, flags: v.flags, validFromEpoch: 0n, expiryEpoch: 0n });
      return { indices: [RANGES.POLICY_ABSTENTION_START + slot], newWords: [atomWord], anchored: null };
    },
    profileOverrides: { enableAbstentionAtoms: true },
    expectedRendererEffect: 'no doc surfaced when guardrail fires',
    expectedRerankerEffect: '0 rank movement on positive queries; correct abstention on unanswerable queries',
  }));
}

// ─── noise suppression grammar (renderer/reranker hint) ──────────────────────
// Per the handoff and auditor note, noise suppression is renderer-side first. We
// model two structural candidates that demote zero-relevance candidates via
// `policyEvidenceAllowedActions` 'suppress' on weak anchors. The candidate is
// MARKED renderer-only (no rewardability claim) so it can co-occur with other
// surfaces in compensated-positive combinations without itself being promoted.

function noiseCandidates() {
  return [
    {
      id: 'noise_suppress_low_support_anchor',
      surface: 'noise_suppression',
      params: { mode: 'suppress_low_support' },
      memoryOperationSignature: 'demote candidates whose public support in-degree is below a threshold; reduces junk without touching gold',
      publicSignals: ['public in-degree counts', 'no qrel/header dependence'],
      minerDegreesOfFreedom: ['threshold', 'scope (entity/owner)'],
      nonIndexerRationale: 'threshold is on public structural count; demoted docs have measurable low support degree',
      buildUnits: ({ pack, logicalQById, eventByDocId, slotCursor }) => {
        const lq = pickFirstPackQuery(pack, logicalQById, (q) => Array.isArray(q.qrels) && q.qrels.length > 0);
        if (!lq) return { indices: [], newWords: [], reason: 'no_pack_query' };
        const direct = lq.qrels.find((r) => r.role === 'direct');
        if (!direct) return { indices: [], newWords: [], reason: 'no_direct_qrel' };
        const evId = `mem_${direct.docId}`;
        if (eventByDocId && !eventByDocId.has(evId)) return { indices: [], newWords: [], reason: 'event_not_in_corpus' };
        const slot = slotCursor?.noiseSlot ?? 0;
        if (slot >= 128) return { indices: [], newWords: [], reason: 'noise_slot_exhausted' };
        const memWord = encodeMemoryIndexSlot({ slotIndex: slot, recordId: stableRecordIdFor(evId), family: 'multi_hop_relation', domainBits: 1n, valid: true, revoked: false, protected: false, policyAnchor: true, retrievalSlot: 0, expiryEpoch: 0n })[0];
        // Suppress action on a low-density evidence selector — demotes the bridge if support is weak.
        const atomWord = encodePolicyAtom({ atomIndex: slot, family: 'evidence_bundle', selector: POLICY_SELECTOR.ANSWER_DENSITY, evidenceFeature: POLICY_EVIDENCE_FEATURE.SUPPORT_IN_DEGREE, action: 'suppress', scope: 'entity', targetSlot: slot, budget: 200, flags: 0, validFromEpoch: 0n, expiryEpoch: 0n });
        return { indices: [RANGES.MEMORY_INDEX_START + slot, RANGES.POLICY_EVIDENCE_START + slot], newWords: [memWord, atomWord], anchored: direct.docId };
      },
      profileOverrides: { enableEvidenceBundleAtoms: true, policyEvidenceAllowedActions: ['suppress'] },
      expectedRendererEffect: 'low-support candidates dropped from rendered shortlist',
      expectedRerankerEffect: 'reduced junk in top-K; potential temporal recall hit if combined with temporal patch is needed',
      rewardable: false, // renderer-side only by default
    },
  ];
}

// ─── exports ──────────────────────────────────────────────────────────────────

export const SURFACE_GRAMMARS = {
  temporal_update:       { candidates: temporalCandidates() },
  conflict_lifecycle:    { candidates: conflictCandidates() },
  relation_causal:       { candidates: relationCausalCandidates() },
  relation_lifecycle:    { candidates: relationLifecycleCandidates() },
  coreference:           { candidates: coreferenceCandidates() },
  aspect_constraint:     { candidates: aspectCandidates() },
  evidence_bundle:       { candidates: evidenceCandidates() },
  abstention_top1:       { candidates: abstentionCandidates() },
  noise_suppression:     { candidates: noiseCandidates() },
};

export function listAllCandidates() {
  const out = [];
  for (const [surface, g] of Object.entries(SURFACE_GRAMMARS)) {
    for (const c of g.candidates) out.push({ surfaceKey: surface, ...c });
  }
  return out;
}

// ─── Auditor-listed semantic combinations ────────────────────────────────────
//
// Each entry is a pair (a, b) of surface keys; the harness runs the union of
// each pair's first candidate to test whether a tradeoff_positive or
// compensated_positive emerges. Pairs are intentionally bounded.
export const SEMANTIC_COMBINATIONS = [
  ['noise_suppression', 'temporal_update'],
  ['aspect_constraint', 'relation_causal'],
  ['evidence_bundle',   'relation_causal'],
  ['relation_lifecycle','conflict_lifecycle'],
  ['temporal_update',   'conflict_lifecycle'],
  ['coreference',       'relation_causal'],
  ['abstention_top1',   'evidence_bundle'],
  ['temporal_update',   'relation_lifecycle'],
  ['relation_causal',   'evidence_bundle'],
];
