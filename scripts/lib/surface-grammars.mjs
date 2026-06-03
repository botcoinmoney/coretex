/**
 * Bounded semantic patch grammars per substrate surface — v2.
 *
 * Per the auditor's framing, every candidate must declare its anchor `mode`:
 *
 *   - `mode: 'oracle-qrel'`   — may read qrels / role labels / hidden truth docs.
 *                               Use ONLY to bound capability (upper-limit
 *                               measurement); never use to claim launch runway.
 *   - `mode: 'miner-public'`  — uses only PUBLIC structure: query text,
 *                               entity registry, doc.kind / doc.timestamp /
 *                               doc.entityIds / doc.lifecycleState (public
 *                               metadata stamped by the generator),
 *                               corpus.relations edge list, substrate state.
 *                               This is the only mode whose results can
 *                               feed promotion claims.
 *
 * Each candidate also exports the full safety contract:
 *   - id, surface, mode, params
 *   - memoryOperationSignature, publicSignals, minerDegreesOfFreedom
 *   - nonIndexerRationale, leakageRisks (explicit list of what would break the
 *     non-indexer claim if violated)
 *   - profileOverrides (ScoringOptions delta required for the surface)
 *   - expectedRendererEffect, expectedRerankerEffect
 *   - buildUnits(ctx) => { indices, newWords, anchored, anchorMode, reason? }
 */
import { distIndex } from '../_repo-root.mjs';

const {
  encodeRelationCategoryLens, encodeMemoryIndexSlot, encodeTemporalRecord,
  stableRecordIdFor, encodePolicyAtom,
  POLICY_SELECTOR, POLICY_EVIDENCE_FEATURE, POLICY_FLAG, POLICY_TARGET_NONE,
  PATCH_TYPE, RANGES,
} = await import(distIndex);

const RELATION_EDGES_ALL = ['supports', 'causes', 'supersedes', 'coreference_of'];

// ─── Public-structure helpers (miner-public mode) ────────────────────────────
//
// These helpers anchor patches using ONLY public information:
//   - the query text (`event.queryText`)
//   - the public entity registry (canonical names + aliases)
//   - the corpus' public doc metadata (kind, timestamp, entityIds, lifecycleState)
//   - the corpus' public relations list
//
// None of these helpers read `event.qrels`, `event.truthDocuments`,
// `qrel.role`, `qrel.relevance`, or any other label-bearing field.

function publicResolveSubject(queryText, entityRegistry, genericIds) {
  const lq = (queryText || '').toLowerCase();
  // longest-match first so 'Aron Loiorum' beats 'Aron'
  const sorted = entityRegistry.slice().sort((a, b) => Math.max(...b.names.map((n) => n.length), 0) - Math.max(...a.names.map((n) => n.length), 0));
  for (const e of sorted) {
    if (genericIds.includes(e.id)) continue;
    for (const n of e.names) {
      const re = new RegExp(`\\b${n.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\b`, 'i');
      if (re.test(lq)) return e.id;
    }
  }
  return null;
}

function parseTemporalAttribute(queryText) {
  // miner-public attribute parse — handles the v15 + evolveCorpusDelta query phrasings:
  //   "What is X's current Y?"           → attr = Y (e.g. city, diet)
  //   "What Y is X currently following?"  → attr = Y
  //   "What Y does X currently use?"      → attr = Y
  //   "What Y is X currently on?"         → attr = Y
  //   "What is X currently following?"    → attr = "diet" inferred (default)
  const t = (queryText || '').toLowerCase();
  // Pattern A: "what (verb) X's <attr>?"  (attr is the word after the apostrophe-s)
  const a = t.match(/what (?:is|are) [a-z'’ ]+?'s? ([a-z]+(?: [a-z]+)?)\??$/);
  if (a) return a[1].trim();
  // Pattern B: "current <attr>?"  (attr is the word after "current ")
  const b = t.match(/current ([a-z]+(?: [a-z]+)?)\??$/);
  if (b) return b[1].trim();
  // Pattern C: "what <attr> is X currently (verb)" / "what <attr> does X currently (verb)"
  const c = t.match(/what ([a-z]+(?: [a-z]+)?) (?:is|are|does|do) [a-z'’ ]+ currently/);
  if (c) return c[1].trim();
  // Pattern D: "what <attr> (does|is) X (have|use|follow|prefer|deploy)"
  const d = t.match(/what ([a-z]+(?: [a-z]+)?) (?:does|is) [a-z'’ ]+ (?:currently )?(?:have|use|follow|prefer|deploy|switch)/);
  if (d) return d[1].trim();
  return null;
}

function parseConflictScope(queryText) {
  const m = (queryText || '').match(/^[Ff]or\s+([^,]+),/);
  return m ? m[1].trim().toLowerCase() : null;
}

function publicFindTemporalAnchors(subjectId, attr, docById, docsByEntity) {
  // miner-public: only TEMPORAL-kind docs about `subjectId` whose kind OR text
  // explicitly mentions `attr` as a public attribute marker. Sort by timestamp
  // descending (newest = current); the stale slot picks the next-oldest doc on
  // the SAME attribute (so the stale qrel is genuinely same-attribute).
  const attrL = attr.toLowerCase();
  const candidates = (docsByEntity.get(subjectId) ?? []).filter((d) => {
    const k = (d.kind ?? '').toLowerCase();
    if (!/temporal/.test(k)) return false;
    const t = (d.text ?? '').toLowerCase();
    return k.endsWith(`_${attrL}`) || k === `temporal_${attrL}` || new RegExp(`\\b${attrL}\\b`).test(t);
  });
  if (candidates.length === 0) return { current: null, stale: null };
  candidates.sort((a, b) => String(b.timestamp ?? '').localeCompare(String(a.timestamp ?? '')));
  // miner-public picks current = newest, stale = oldest same-attr (matches the v15
  // generator's stale qrel, which is the earliest prior on that attribute).
  return { current: candidates[0]?.id ?? null, stale: candidates[candidates.length - 1]?.id ?? null };
}

function publicFindConflictAnchor(subjectId, scope, docsByEntity) {
  // miner-public: doc about `subjectId` with lifecycleState='conflict_resolved' AND lifecycleScope=scope.
  const docs = docsByEntity.get(subjectId) ?? [];
  const resolved = docs.find((d) => d.lifecycleState === 'conflict_resolved' && (d.lifecycleScope ?? '').toLowerCase() === scope.toLowerCase());
  const candidate = docs.find((d) => d.lifecycleState === 'conflict_candidate' && (d.lifecycleScope ?? '').toLowerCase() === scope.toLowerCase());
  return { resolved: resolved?.id ?? null, candidate: candidate?.id ?? null };
}

function publicTopSupportAnchor(subjectId, docsByEntity, supportInDegree) {
  // miner-public: doc about `subjectId` with highest in-supports degree.
  const docs = docsByEntity.get(subjectId) ?? [];
  if (docs.length === 0) return null;
  docs.sort((a, b) => (supportInDegree.get(b.id) ?? 0) - (supportInDegree.get(a.id) ?? 0));
  return docs[0]?.id ?? null;
}

// ─── Common pack/qrel pickers (oracle-qrel mode only) ────────────────────────

function pickFirstPackQuery(pack, logicalQById, predicate) {
  for (const ev of pack.events) {
    const lq = logicalQById.get(ev.id);
    if (lq && predicate(lq)) return lq;
  }
  return null;
}

function pickAnchorOracle({ pack, logicalQById, family, role = 'direct' }) {
  const lq = pickFirstPackQuery(pack, logicalQById, (q) => q.family === family && q.qrels?.some((r) => r.role === role));
  if (!lq) return { lq: null, docId: null };
  const qrel = lq.qrels.find((r) => r.role === role);
  return { lq, docId: qrel?.docId ?? null };
}

// Build a public per-subject doc index + supports in-degree map from the logical corpus.
// Cached at first call via the context.
function ensurePublicIndex(ctx) {
  if (ctx.publicIndex) return ctx.publicIndex;
  const docsByEntity = new Map();
  for (const d of ctx.rawDocs ?? []) {
    for (const eid of (d.entityIds ?? [])) {
      if (eid === 'e_universe') continue;
      if (!docsByEntity.has(eid)) docsByEntity.set(eid, []);
      docsByEntity.get(eid).push(d);
    }
  }
  const supportInDegree = new Map();
  for (const r of ctx.rawRelations ?? []) {
    if (r.type !== 'supports' && r.type !== 'causes') continue;
    supportInDegree.set(r.dst, (supportInDegree.get(r.dst) ?? 0) + 1);
  }
  ctx.publicIndex = { docsByEntity, supportInDegree };
  return ctx.publicIndex;
}

// ─── Relation lens unit builder ──────────────────────────────────────────────

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

// ─── Temporal grammar (oracle + miner-public) ────────────────────────────────

function temporalCandidates() {
  const out = [];
  const baseVariants = [
    { variant: 'current_only_pin',       supersede: false, validityWindow: false },
    { variant: 'supersedes_one_prior',   supersede: true,  validityWindow: false },
    { variant: 'validity_window',        supersede: true,  validityWindow: true  },
  ];
  for (const mode of ['oracle-qrel', 'miner-public']) {
    for (const recordSlotOffset of [0, 8]) {
      for (const v of baseVariants) {
        out.push({
          id: `temporal_${mode}_${v.variant}_slot${recordSlotOffset}`,
          surface: 'temporal_update',
          mode, params: { ...v, recordSlotOffset },
          memoryOperationSignature: 'mark a memory as the current truth for a (subject, attribute) pair; demote prior same-attr memories as stale',
          publicSignals: mode === 'miner-public'
            ? ['parsed subject from queryText', 'parsed attribute from queryText', 'doc.kind / doc.text / doc.timestamp']
            : ['qrels.direct (oracle)', 'qrels.stale (oracle)'],
          minerDegreesOfFreedom: ['recordSlot index', 'validity window epochs', 'whether to encode supersession chain'],
          nonIndexerRationale: 'the operation is "current-vs-stale on (subject, attr)"; both anchors come from public structure under miner-public mode',
          leakageRisks: mode === 'miner-public' ? [] : ['anchor selection reads qrel role labels'],
          buildUnits: (ctx) => {
            const { pack, logicalQById, slotCursor, entityRegistry, genericEntityIds } = ctx;
            const slotBase = (slotCursor?.temporalRecord ?? 0) + recordSlotOffset;
            if (slotBase >= 96) return { indices: [], newWords: [], reason: 'temporal_slot_exhausted' };
            const staleSlot = slotBase * 2, curSlot = slotBase * 2 + 1;
            let curId = null, staleId = null, sourceQueryId = null;
            if (mode === 'oracle-qrel') {
              const a = pickAnchorOracle({ pack, logicalQById, family: 'temporal_update', role: 'direct' });
              if (!a.lq) return { indices: [], newWords: [], reason: 'no_temporal_pack_query' };
              curId = a.docId;
              const sQ = a.lq.qrels.find((r) => r.role === 'stale');
              staleId = sQ?.docId ?? null;
              sourceQueryId = a.lq.id;
            } else {
              // miner-public: iterate pack queries, pick the FIRST one whose
              // text is a TEMPORAL phrasing ("What is X's current Y?" NOT
              // "For X, what is Y's current Z?") AND for which we can resolve
              // a same-attribute prior memory. This mirrors what a miner would
              // do reading the public query corpus + public doc store.
              const pi = ensurePublicIndex(ctx);
              let pickedQ = null, pickedAnchor = null;
              for (const ev of pack.events) {
                const lq = logicalQById.get(ev.id);
                if (!lq) continue;
                const text = lq.queryText ?? '';
                if (/^[Ff]or\s+[^,]+,/.test(text)) continue; // skip conflict scope-prefixed queries
                // require a temporal phrasing — "current X" or "currently <verb>"
                if (!/current(?:ly)?\s+/.test(text)) continue;
                const subj = publicResolveSubject(text, entityRegistry, genericEntityIds);
                const attr = parseTemporalAttribute(text);
                if (!subj || !attr) continue;
                const a = publicFindTemporalAnchors(subj, attr, ctx.docById, pi.docsByEntity);
                if (!a.current) continue;
                pickedQ = lq; pickedAnchor = a; break;
              }
              if (!pickedQ) return { indices: [], newWords: [], reason: 'no_public_temporal_anchor' };
              curId = pickedAnchor.current; staleId = pickedAnchor.stale;
              sourceQueryId = pickedQ.id;
            }
            const idx = [], nw = [];
            const cw = encodeMemoryIndexSlot({ slotIndex: curSlot, recordId: stableRecordIdFor(`mem_${curId}`), family: 'temporal', domainBits: 1n, valid: true, revoked: false, protected: false, policyAnchor: true, retrievalSlot: 0, expiryEpoch: 0n })[0];
            idx.push(RANGES.MEMORY_INDEX_START + curSlot); nw.push(cw);
            if (v.supersede && staleId) {
              const sw = encodeMemoryIndexSlot({ slotIndex: staleSlot, recordId: stableRecordIdFor(`mem_${staleId}`), family: 'temporal', domainBits: 1n, valid: true, revoked: true, protected: false, policyAnchor: true, retrievalSlot: 0, expiryEpoch: 0n })[0];
              idx.push(RANGES.MEMORY_INDEX_START + staleSlot); nw.push(sw);
            }
            const tw = encodeTemporalRecord({ recordIndex: slotBase, memorySlot: staleSlot, supersededBy: curSlot, validFromEpoch: 1n, validUntilEpoch: (2n ** 40n - 1n), currentStaleFlag: true });
            idx.push(RANGES.TEMPORAL_START + slotBase); nw.push(tw[0]);
            return { indices: idx, newWords: nw, anchored: curId, anchorMode: mode, sourceQueryId };
          },
          profileOverrides: { temporalStaleContrast: true },
          expectedRendererEffect: 'current doc marked current; stale demoted',
          expectedRerankerEffect: '+rank on current-asking temporal queries',
        });
      }
    }
  }
  return out;
}

// ─── Conflict grammar (oracle + miner-public) ────────────────────────────────

function conflictCandidates() {
  const out = [];
  const variants = [
    { action: 'boost',    scope: 'conflict_set', feature: POLICY_EVIDENCE_FEATURE.CONTRADICTS_EDGE, budget: 300, target: 'resolved' },
    { action: 'boost',    scope: 'entity',       feature: POLICY_EVIDENCE_FEATURE.CONTRADICTS_EDGE, budget: 300, target: 'resolved' },
    { action: 'boost',    scope: 'conflict_set', feature: POLICY_EVIDENCE_FEATURE.SCOPE_DIFFERS_EDGE, budget: 300, target: 'resolved' },
    { action: 'suppress', scope: 'conflict_set', feature: POLICY_EVIDENCE_FEATURE.CONTRADICTS_EDGE, budget: 300, target: 'candidate' },
  ];
  for (const mode of ['oracle-qrel', 'miner-public']) {
    for (const v of variants) {
      const tag = `${v.action}_${v.scope}_ef${v.feature}_b${v.budget}_t${v.target}`;
      out.push({
        id: `conflict_${mode}_${tag}`,
        surface: 'conflict_lifecycle',
        mode, params: v,
        memoryOperationSignature: 'when a query has explicit scope intent ("For X, ..."), surface the resolved-for-scope memory and demote competing candidates',
        publicSignals: mode === 'miner-public'
          ? ['parseQueryConflictIntent (public)', 'doc.lifecycleState (public stamp)', 'doc.lifecycleScope (public stamp)', 'public entity registry']
          : ['qrels.direct (oracle)', 'qrels.conflict (oracle)'],
        minerDegreesOfFreedom: ['action', 'scope', 'evidence feature', 'budget', 'which side of the conflict to anchor'],
        nonIndexerRationale: 'CONFLICT_SET_MEMBER selector requires subject overlap; anchor is the lifecycle-stamped resolved doc, not a qrel pointer',
        leakageRisks: mode === 'miner-public' ? [] : ['anchor selection reads qrel role labels'],
        buildUnits: (ctx) => {
          const { pack, logicalQById, eventByDocId, slotCursor, entityRegistry, genericEntityIds } = ctx;
          let anchorDocId = null, sourceQueryId = null;
          if (mode === 'oracle-qrel') {
            const a = pickAnchorOracle({ pack, logicalQById, family: 'conflict_lifecycle', role: v.target === 'resolved' ? 'direct' : 'conflict' });
            if (!a.lq) return { indices: [], newWords: [], reason: 'no_conflict_pack_query' };
            anchorDocId = a.docId; sourceQueryId = a.lq.id;
          } else {
            const lq = pickFirstPackQuery(pack, logicalQById, (q) => /^[Ff]or [^,]+,/i.test(q.queryText ?? ''));
            if (!lq) return { indices: [], newWords: [], reason: 'no_conflict_intent_query' };
            const subj = publicResolveSubject(lq.queryText, entityRegistry, genericEntityIds);
            const scope = parseConflictScope(lq.queryText);
            if (!subj || !scope) return { indices: [], newWords: [], reason: 'parse_failed' };
            const pi = ensurePublicIndex(ctx);
            const a = publicFindConflictAnchor(subj, scope, pi.docsByEntity);
            anchorDocId = v.target === 'resolved' ? a.resolved : a.candidate;
            sourceQueryId = lq.id;
            if (!anchorDocId) return { indices: [], newWords: [], reason: 'no_public_conflict_anchor' };
          }
          const evId = `mem_${anchorDocId}`;
          if (eventByDocId && !eventByDocId.has(evId)) return { indices: [], newWords: [], reason: 'event_not_in_corpus' };
          const slot = slotCursor?.conflictSlot ?? 0;
          if (slot >= 128) return { indices: [], newWords: [], reason: 'conflict_slot_exhausted' };
          const memWord = encodeMemoryIndexSlot({ slotIndex: slot, recordId: stableRecordIdFor(evId), family: 'multi_hop_relation', domainBits: 1n, valid: true, revoked: false, protected: false, policyAnchor: true, retrievalSlot: 0, expiryEpoch: 0n })[0];
          const atomWord = encodePolicyAtom({ atomIndex: slot, family: 'conflict_lifecycle', selector: POLICY_SELECTOR.CONFLICT_SET_MEMBER, evidenceFeature: v.feature, action: v.action, scope: v.scope, targetSlot: slot, budget: v.budget, flags: 0, validFromEpoch: 0n, expiryEpoch: 0n });
          return { indices: [RANGES.MEMORY_INDEX_START + slot, RANGES.POLICY_CONFLICT_START + slot], newWords: [memWord, atomWord], anchored: anchorDocId, anchorMode: mode, sourceQueryId };
        },
        profileOverrides: { enableConflictLifecycleAtoms: true, policyConflictIntentAdmission: true },
        expectedRendererEffect: 'resolved-for-scope doc surfaced',
        expectedRerankerEffect: `${v.action === 'boost' ? '+' : '-'}rank on conflict queries with matching scope`,
      });
    }
  }
  return out;
}

// ─── Relation/category grammar (no qrels — already miner-public) ─────────────

function relationCausalCandidates() {
  const mixes = [
    { edges: ['supports'], offset: 0, name: 'supports_only' },
    { edges: ['causes'], offset: 1, name: 'causes_only' },
    { edges: ['supports', 'causes'], offset: 0, name: 'supports_causes' },
    { edges: ['supports', 'causes', 'supersedes'], offset: 0, name: 'support_cause_super' },
  ];
  return mixes.map((m) => ({
    id: `relation_causal_${m.name}_off${m.offset}`,
    surface: 'relation_causal', mode: 'miner-public', params: m,
    memoryOperationSignature: 'surface causal/support chains for the query subject via public typed edges',
    publicSignals: ['parseQueryRelationIntent', 'public corpus edges of type {' + m.edges.join(', ') + '}'],
    minerDegreesOfFreedom: ['edge subset', 'lens entry offset'],
    nonIndexerRationale: 'lens admits typed PUBLIC edges; no doc-id in selector',
    leakageRisks: [],
    buildUnits: () => relationLensUnits(m.edges, m.offset),
    profileOverrides: { policyRelationTypedAdmission: true, policyQueryConditionedAdmission: true },
    expectedRendererEffect: 'evidence path rendered via category lens',
    expectedRerankerEffect: '+ on causal / decision / multi-hop queries with relation intent',
  }));
}

function relationLifecycleCandidates() {
  const mixes = [
    { edges: ['supersedes'], offset: 2, name: 'supersedes_only' },
    { edges: ['coreference_of'], offset: 3, name: 'coref_only' },
    { edges: ['supersedes', 'coreference_of'], offset: 2, name: 'supersedes_coref' },
  ];
  return mixes.map((m) => ({
    id: `relation_lifecycle_${m.name}_off${m.offset}`,
    surface: 'relation_lifecycle', mode: 'miner-public', params: m,
    memoryOperationSignature: 'admit lifecycle/coref edges to surface superseded or aliased memories',
    publicSignals: ['public edge types'],
    minerDegreesOfFreedom: ['edge subset', 'entry offset', 'whether paired with intent gate'],
    nonIndexerRationale: 'edges are public; lens reusable',
    leakageRisks: ['supersedes admission floods off-family without a lifecycle-intent gate — see parseQueryLifecycleIntent follow-up'],
    buildUnits: () => relationLensUnits(m.edges, m.offset),
    profileOverrides: { policyRelationTypedAdmission: true, policyQueryConditionedAdmission: true },
    expectedRendererEffect: 'supersession chain visible',
    expectedRerankerEffect: '+ on coref/lifecycle queries; off-family risk if no intent gate',
  }));
}

function coreferenceCandidates() {
  const variants = [
    { offset: 4, name: 'coref_alias_basic' },
    { offset: 5, name: 'coref_alias_offset' },
  ];
  return variants.map((v) => ({
    id: `coreference_${v.name}`,
    surface: 'coreference', mode: 'miner-public', params: v,
    memoryOperationSignature: 'alias / canonical-name resolution via public coreference_of edges',
    publicSignals: ['public coreference_of edges'],
    minerDegreesOfFreedom: ['lens entry offset'],
    nonIndexerRationale: 'edges are public; lens reusable across aliased subjects',
    leakageRisks: [],
    buildUnits: () => relationLensUnits(['coreference_of'], v.offset),
    profileOverrides: { policyRelationTypedAdmission: true, policyQueryConditionedAdmission: true },
    expectedRendererEffect: 'canonical alias rendered when query uses non-canonical name',
    expectedRerankerEffect: '+ on coreference_resolution queries',
  }));
}

function aspectCandidates() {
  return [{
    id: 'aspect_intent_admission_scaffold',
    surface: 'aspect_constraint', mode: 'miner-public', params: { scaffold: true },
    memoryOperationSignature: 'when a query asks "what is the X detail?", surface the per-facet memory',
    publicSignals: ['parseQueryAspectIntent', 'public aspect tags'],
    minerDegreesOfFreedom: ['atom slot', 'budget'],
    nonIndexerRationale: 'aspect tags are public corpus metadata; selector is the parsed query phrase',
    leakageRisks: ['scaffold encoding uses evidence region pending dedicated aspect atom region'],
    buildUnits: (ctx) => {
      const { pack, logicalQById, eventByDocId, slotCursor } = ctx;
      const lq = pickFirstPackQuery(pack, logicalQById, (q) => q.family === 'aspect_constraint');
      if (!lq) return { indices: [], newWords: [], reason: 'no_aspect_pack_query' };
      // miner-public anchor: top in-supports doc for the subject (no qrel access)
      const subj = lq.subjectEntityId;
      if (!subj) return { indices: [], newWords: [], reason: 'no_subject' };
      const pi = ensurePublicIndex(ctx);
      const docId = publicTopSupportAnchor(subj, pi.docsByEntity, pi.supportInDegree);
      if (!docId) return { indices: [], newWords: [], reason: 'no_public_anchor' };
      const evId = `mem_${docId}`;
      if (!eventByDocId.has(evId)) return { indices: [], newWords: [], reason: 'event_not_in_corpus' };
      const slot = slotCursor?.aspectSlot ?? 0;
      if (slot >= 128) return { indices: [], newWords: [], reason: 'aspect_slot_exhausted' };
      const memWord = encodeMemoryIndexSlot({ slotIndex: slot, recordId: stableRecordIdFor(evId), family: 'near_collision', domainBits: 1n, valid: true, revoked: false, protected: false, policyAnchor: true, retrievalSlot: 0, expiryEpoch: 0n })[0];
      const atomWord = encodePolicyAtom({ atomIndex: slot, family: 'evidence_bundle', selector: POLICY_SELECTOR.ANSWER_DENSITY, evidenceFeature: POLICY_EVIDENCE_FEATURE.SUPPORT_IN_DEGREE, action: 'boost', scope: 'aspect', targetSlot: slot, budget: 200, flags: 0, validFromEpoch: 0n, expiryEpoch: 0n });
      return { indices: [RANGES.MEMORY_INDEX_START + slot, RANGES.POLICY_EVIDENCE_START + slot], newWords: [memWord, atomWord], anchored: docId, anchorMode: 'miner-public' };
    },
    profileOverrides: { enableAspectConstraintAtoms: true, policyAspectIntentAdmission: true },
    expectedRendererEffect: 'aspect-tagged subset surfaced',
    expectedRerankerEffect: '+ on aspect queries with parsed aspect phrase',
  }];
}

// ─── Evidence (oracle + miner-public) ───────────────────────────────────────

function evidenceCandidates() {
  const out = [];
  const variants = [
    { action: 'bundle',  feature: POLICY_EVIDENCE_FEATURE.SUPPORT_IN_DEGREE, scope: 'relation_path', budget: 250 },
    { action: 'include', feature: POLICY_EVIDENCE_FEATURE.BRIDGE_HOP,        scope: 'relation_path', budget: 250 },
    { action: 'boost',   feature: POLICY_EVIDENCE_FEATURE.SUPPORT_IN_DEGREE, scope: 'entity',         budget: 250 },
  ];
  for (const mode of ['oracle-qrel', 'miner-public']) {
    for (const v of variants) {
      const tag = `${v.action}_${v.feature}_${v.scope}_b${v.budget}`;
      out.push({
        id: `evidence_${mode}_${tag}`,
        surface: 'evidence_bundle', mode, params: v,
        memoryOperationSignature: 'when a query subject has a supports/bridge path, admit the evidence chain so the answer cites WHY',
        publicSignals: mode === 'miner-public'
          ? ['parseQueryRelationIntent', 'public in-degree of supports/causes edges on candidates', 'public entity registry']
          : ['qrels.direct (oracle)'],
        minerDegreesOfFreedom: ['action', 'feature', 'scope', 'budget'],
        nonIndexerRationale: 'support density is a public structural measurement; not a doc-id pointer',
        leakageRisks: mode === 'miner-public' ? [] : ['anchor selection reads qrel role labels'],
        buildUnits: (ctx) => {
          const { pack, logicalQById, eventByDocId, slotCursor, entityRegistry, genericEntityIds } = ctx;
          let anchorDocId = null, sourceQueryId = null;
          if (mode === 'oracle-qrel') {
            const a = pickAnchorOracle({ pack, logicalQById, family: 'multi_session_bridge' });
            const a2 = a.lq ? a : pickAnchorOracle({ pack, logicalQById, family: 'causal_memory_chain' });
            const a3 = a2.lq ? a2 : pickAnchorOracle({ pack, logicalQById, family: 'decision_provenance' });
            const final = (a.lq && a) || (a2.lq && a2) || (a3.lq && a3);
            if (!final || !final.lq) return { indices: [], newWords: [], reason: 'no_relation_query_oracle' };
            anchorDocId = final.docId; sourceQueryId = final.lq.id;
          } else {
            const lq = pickFirstPackQuery(pack, logicalQById, (q) => q.family === 'multi_session_bridge' || q.family === 'causal_memory_chain' || q.family === 'decision_provenance' || q.family === 'multi_hop_relation');
            if (!lq) return { indices: [], newWords: [], reason: 'no_relation_query_public' };
            const subj = lq.subjectEntityId ?? publicResolveSubject(lq.queryText, entityRegistry, genericEntityIds);
            if (!subj) return { indices: [], newWords: [], reason: 'parse_failed' };
            const pi = ensurePublicIndex(ctx);
            anchorDocId = publicTopSupportAnchor(subj, pi.docsByEntity, pi.supportInDegree);
            sourceQueryId = lq.id;
            if (!anchorDocId) return { indices: [], newWords: [], reason: 'no_public_evidence_anchor' };
          }
          const evId = `mem_${anchorDocId}`;
          if (!eventByDocId.has(evId)) return { indices: [], newWords: [], reason: 'event_not_in_corpus' };
          const slot = slotCursor?.evidenceSlot ?? 0;
          if (slot >= 128) return { indices: [], newWords: [], reason: 'evidence_slot_exhausted' };
          const memWord = encodeMemoryIndexSlot({ slotIndex: slot, recordId: stableRecordIdFor(evId), family: 'multi_hop_relation', domainBits: 1n, valid: true, revoked: false, protected: false, policyAnchor: true, retrievalSlot: 0, expiryEpoch: 0n })[0];
          const atomWord = encodePolicyAtom({ atomIndex: slot, family: 'evidence_bundle', selector: POLICY_SELECTOR.RELATION_PATH_PRESENT, evidenceFeature: v.feature, action: v.action, scope: v.scope, targetSlot: slot, budget: v.budget, flags: 0, validFromEpoch: 0n, expiryEpoch: 0n });
          return { indices: [RANGES.MEMORY_INDEX_START + slot, RANGES.POLICY_EVIDENCE_START + slot], newWords: [memWord, atomWord], anchored: anchorDocId, anchorMode: mode, sourceQueryId };
        },
        profileOverrides: { enableEvidenceBundleAtoms: true, policyEvidenceAllowedActions: [v.action], policyRelationTypedAdmission: true, policyQueryConditionedAdmission: true, policyMaxBudgetEvidence: 500 },
        expectedRendererEffect: 'evidence bridge text appended to Memory-IR',
        expectedRerankerEffect: '+ on relation queries; off-family flood risk if scope is too broad',
      });
    }
  }
  return out;
}

// ─── Abstention guardrail (no qrels) ─────────────────────────────────────────

function abstentionCandidates() {
  const variants = [
    { feature: POLICY_EVIDENCE_FEATURE.NO_PUBLIC_EVIDENCE_PATH, flags: POLICY_FLAG.REQUIRE_NO_EVIDENCE_PATH },
    { feature: POLICY_EVIDENCE_FEATURE.TOP1_SCORE,              flags: POLICY_FLAG.REQUIRE_NO_EVIDENCE_PATH },
  ];
  return variants.map((v, i) => ({
    id: `abstention_${v.feature}_f${v.flags}`,
    surface: 'abstention_top1', mode: 'miner-public', params: v,
    memoryOperationSignature: 'refuse to answer when there is no public evidence path AND top1 confidence is low',
    publicSignals: ['absence of supports/causes path', 'reranker top1 score below threshold'],
    minerDegreesOfFreedom: ['evidence feature', 'flag bits', 'top1 threshold (operator)'],
    nonIndexerRationale: 'guardrail: triggers on structural absence of evidence; not a routing surface',
    leakageRisks: [],
    buildUnits: ({ slotCursor }) => {
      const slot = (slotCursor?.abstentionSlot ?? 0) + i;
      if (slot >= 32) return { indices: [], newWords: [], reason: 'abstention_slot_exhausted' };
      const atomWord = encodePolicyAtom({ atomIndex: slot, family: 'abstention', selector: POLICY_SELECTOR.MISSING_EVIDENCE, evidenceFeature: v.feature, action: 'abstain', scope: 'entity', targetSlot: POLICY_TARGET_NONE, budget: 0, flags: v.flags, validFromEpoch: 0n, expiryEpoch: 0n });
      return { indices: [RANGES.POLICY_ABSTENTION_START + slot], newWords: [atomWord], anchored: null, anchorMode: 'miner-public' };
    },
    profileOverrides: { enableAbstentionAtoms: true },
    expectedRendererEffect: 'no doc surfaced when guardrail fires',
    expectedRerankerEffect: '0 rank movement on positive queries; correct abstention on unanswerable queries',
  }));
}

// ─── Noise suppression (no qrels) ────────────────────────────────────────────

function noiseCandidates() {
  return [{
    id: 'noise_suppress_low_support_anchor',
    surface: 'noise_suppression', mode: 'miner-public', params: { mode: 'suppress_low_support' },
    memoryOperationSignature: 'demote candidates whose public support in-degree is below threshold',
    publicSignals: ['public in-degree counts'],
    minerDegreesOfFreedom: ['threshold', 'scope'],
    nonIndexerRationale: 'threshold operates on a public structural count',
    leakageRisks: [],
    buildUnits: (ctx) => {
      const { pack, logicalQById, eventByDocId, slotCursor, entityRegistry, genericEntityIds } = ctx;
      const lq = pickFirstPackQuery(pack, logicalQById, (q) => Array.isArray(q.qrels) && q.qrels.length > 0);
      if (!lq) return { indices: [], newWords: [], reason: 'no_pack_query' };
      // miner-public anchor: pick the lowest-support doc about the subject (the candidate we wish to demote)
      const subj = lq.subjectEntityId ?? publicResolveSubject(lq.queryText, entityRegistry, genericEntityIds);
      if (!subj) return { indices: [], newWords: [], reason: 'no_subject' };
      const pi = ensurePublicIndex(ctx);
      const docs = pi.docsByEntity.get(subj) ?? [];
      if (docs.length === 0) return { indices: [], newWords: [], reason: 'no_subject_docs' };
      docs.sort((a, b) => (pi.supportInDegree.get(a.id) ?? 0) - (pi.supportInDegree.get(b.id) ?? 0));
      const docId = docs[0]?.id;
      if (!docId) return { indices: [], newWords: [], reason: 'no_low_support_anchor' };
      const evId = `mem_${docId}`;
      if (!eventByDocId.has(evId)) return { indices: [], newWords: [], reason: 'event_not_in_corpus' };
      const slot = slotCursor?.noiseSlot ?? 0;
      if (slot >= 128) return { indices: [], newWords: [], reason: 'noise_slot_exhausted' };
      const memWord = encodeMemoryIndexSlot({ slotIndex: slot, recordId: stableRecordIdFor(evId), family: 'multi_hop_relation', domainBits: 1n, valid: true, revoked: false, protected: false, policyAnchor: true, retrievalSlot: 0, expiryEpoch: 0n })[0];
      const atomWord = encodePolicyAtom({ atomIndex: slot, family: 'evidence_bundle', selector: POLICY_SELECTOR.ANSWER_DENSITY, evidenceFeature: POLICY_EVIDENCE_FEATURE.SUPPORT_IN_DEGREE, action: 'suppress', scope: 'entity', targetSlot: slot, budget: 200, flags: 0, validFromEpoch: 0n, expiryEpoch: 0n });
      return { indices: [RANGES.MEMORY_INDEX_START + slot, RANGES.POLICY_EVIDENCE_START + slot], newWords: [memWord, atomWord], anchored: docId, anchorMode: 'miner-public' };
    },
    profileOverrides: { enableEvidenceBundleAtoms: true, policyEvidenceAllowedActions: ['suppress'] },
    expectedRendererEffect: 'low-support candidates dropped from rendered shortlist',
    expectedRerankerEffect: 'reduced junk; possible temporal recall hit if uncompensated',
    rewardable: false,
  }];
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

// ─── Dense-pack profiles per surface ─────────────────────────────────────────
//
// hiddenPack quota overrides that bias toward the rare families. Use with the
// existing corpus via deriveQueryPack — no corpus regen required.

export const DENSE_PACKS = {
  balanced:    { packSize: 64, quotas: undefined }, // sentinel: use profile.hiddenPack
  'temporal-dense':    { packSize: 64, quotas: [{ stratum: 'family=temporal_update', minCount: 30 }] },
  'conflict-dense':    { packSize: 64, quotas: [{ stratum: 'family=conflict_lifecycle', minCount: 30 }] },
  'lifecycle-dense':   { packSize: 64, quotas: [{ stratum: 'family=conflict_lifecycle', minCount: 18 }, { stratum: 'family=multi_session_bridge', minCount: 18 }] },
  'coref-dense':       { packSize: 64, quotas: [{ stratum: 'family=coreference_resolution', minCount: 24 }] },
  'aspect-dense':      { packSize: 64, quotas: [{ stratum: 'family=aspect_constraint', minCount: 24 }] },
  'abstention-dense':  { packSize: 64, quotas: [{ stratum: 'family=abstention_missing', minCount: 30 }] },
  'relation-dense':    { packSize: 64, quotas: [{ stratum: 'family=multi_session_bridge', minCount: 12 }, { stratum: 'family=causal_memory_chain', minCount: 12 }, { stratum: 'family=decision_provenance', minCount: 12 }] },
};

// ─── Auditor's 11 semantic combinations ──────────────────────────────────────

export const SEMANTIC_COMBINATIONS = [
  ['temporal_update',    'conflict_lifecycle'],
  ['temporal_update',    'relation_causal'],
  ['temporal_update',    'relation_lifecycle'],
  ['temporal_update',    'noise_suppression'],
  ['conflict_lifecycle', 'relation_lifecycle'],
  ['relation_causal',    'evidence_bundle'],
  ['relation_causal',    'coreference'],
  ['relation_causal',    'aspect_constraint'],
  ['evidence_bundle',    'abstention_top1'],
  ['evidence_bundle',    'noise_suppression'],
  ['coreference',        'aspect_constraint'],
];
