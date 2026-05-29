#!/usr/bin/env node
/**
 * Canonical miner patch examples  (Launch hardening — miner-facing examples).
 *
 * Emits + validates one minimal worked example per LAUNCH patch surface so miners do not guess
 * the wire format. Each example is built from PUBLIC structure only, encoded, decoded, type/range
 * validated, and applied onto its parent. The printed JSON is the canonical example embedded in
 * docs/miner-api-contract.md. Run as a gate: every example must round-trip + validate + apply.
 *
 * Surfaces: temporal/lifecycle, relation-typed routing, conflict_state, guarded abstention.
 *
 * Usage: node scripts/miner-patch-examples.mjs [--json]
 */
import { argv, exit } from 'node:process';
import { distIndex } from './_repo-root.mjs';

const m = await import(distIndex);
const {
  RANGES, PATCH_TYPE, encodePatch, decodePatch, validatePatchType, applyPatch, merkleizeState, bytesToHex,
  encodeMemoryIndexSlot, encodeTemporalRecord, encodeRelationCategoryLens, encodePolicyAtom, stableRecordIdFor,
  POLICY_SELECTOR, POLICY_EVIDENCE_FEATURE, POLICY_FLAG, POLICY_TARGET_NONE,
} = m;

const genesis = { words: new Array(1024).fill(0n) };
const parentRoot = merkleizeState(genesis);
const hex = (u8) => '0x' + Buffer.from(u8).toString('hex');
const examples = [];

// 1. temporal / lifecycle — supersede a stale doc with the current one (2 MemoryIndex slots + 1 TemporalRecord)
{
  const staleSlot = 0, curSlot = 1, rec = 0;
  const indices = [RANGES.MEMORY_INDEX_START + staleSlot, RANGES.MEMORY_INDEX_START + curSlot, RANGES.TEMPORAL_START + rec];
  const newWords = [
    encodeMemoryIndexSlot({ slotIndex: staleSlot, recordId: stableRecordIdFor('mem_doc_stale'), family: 'temporal', domainBits: 1n, valid: true, revoked: true, protected: false, retrievalSlot: 0, expiryEpoch: 0n })[0],
    encodeMemoryIndexSlot({ slotIndex: curSlot, recordId: stableRecordIdFor('mem_doc_current'), family: 'temporal', domainBits: 1n, valid: true, revoked: false, protected: false, retrievalSlot: 0, expiryEpoch: 0n })[0],
    encodeTemporalRecord({ recordIndex: rec, memorySlot: staleSlot, supersededBy: curSlot, validFromEpoch: 1n, validUntilEpoch: (2n ** 40n - 1n), currentStaleFlag: true })[0],
  ];
  examples.push({
    surface: 'temporal / lifecycle',
    publicDataSeen: 'corpus doc IDs + their temporal currency (which doc supersedes which); MemoryIndex slot layout',
    patchType: 'MIXED (0xFF)', wordCount: 3,
    intent: 'mark the stale doc revoked + the current doc valid, link them via a TemporalRecord so the scorer demotes the stale value on temporal queries',
    patch: { patchType: PATCH_TYPE.MIXED, wordCount: 3, scoreDelta: 0n, parentStateRoot: parentRoot, indices, newWords },
    forbidden: 'pointing the record at qrel/answer doc IDs; writing > 4 words; any reserved-range index',
    sourceAttributionIfFires: "temporalBonus on the current doc; the stale doc's nDCG credit is dropped (temporalStaleContrast) and tracked in temporalContrastRecall",
  });
}
// 2. relation-typed routing — one category-lens edge (supports)
{
  const idx = RANGES.RELATIONS_START + 127;
  const word = encodeRelationCategoryLens({ entryIndex: 127, edgeType: 'supports', weight: 0x8000 });
  examples.push({
    surface: 'relation-typed routing',
    publicDataSeen: "public relation graph (supports/causes/supersedes/… edges) + the query's parsed relation-intent",
    patchType: 'RELATION_UPDATE (0x04)', wordCount: 1,
    intent: 'compile a category-lens for the supports edge type so a query whose parsed relation-intent matches admits the anchor reach along supports edges',
    patch: { patchType: PATCH_TYPE.RELATION_UPDATE, wordCount: 1, scoreDelta: 0n, parentStateRoot: parentRoot, indices: [idx], newWords: [word] },
    forbidden: 'flooding all edge types; relying on the entity-only (untyped) selector; query→answer edges',
    sourceAttributionIfFires: 'categoryLensBFS admits the matched anchor reach; bounded by policyMaxBudgetEvidence (beta 0.25)',
  });
}
// 2b. evidence_bundle PolicyAtom (r5 384-511) — the REOPENED relation-routing slot a miner actually patches.
//     The atom's targetSlot points at a MemoryIndex anchor; on a relation-intent query whose subject matches
//     the anchor's public subject, the anchor's typed public-edge reach is admitted/bundled. THIS is the
//     miner-malleable r5 routing surface (the RELATION_UPDATE edge above is the public graph it routes along).
{
  const idx = RANGES.POLICY_EVIDENCE_START + 0;
  const word = encodePolicyAtom({ atomIndex: 0, family: 'evidence_bundle', selector: POLICY_SELECTOR.ANSWER_DENSITY, evidenceFeature: POLICY_EVIDENCE_FEATURE.SUPPORT_IN_DEGREE, action: 'bundle', scope: 'relation_path', targetSlot: 1, budget: 250, flags: 0, validFromEpoch: 0n, expiryEpoch: 0n });
  examples.push({
    surface: 'evidence_bundle PolicyAtom (r5 routing, words 384-511)',
    publicDataSeen: "the anchor MemoryIndex slot's PUBLIC subject + its public out-edges; the query's parsed relation-intent + public subject grounding",
    patchType: 'POLICY_UPDATE (0x07)', wordCount: 1,
    intent: 'write one evidence_bundle atom whose targetSlot anchors a subject-bearing memory; on a matching relation-intent + same-subject query, admit/bundle the anchor reach along its typed public edges',
    prerequisite: 'NOT a standalone recipe: targetSlot (here MemoryIndex slot 1) MUST reference a real anchor — a complete advance also writes that MemoryIndex slot (see the temporal/lifecycle example) for a subject-bearing memory whose PUBLIC subject the query resolves to, with public out-edges of the parsed relation-intent type. The atom fires (policyAdmitted) ONLY when anchor-subject == query-subject AND the edge type matches; otherwise it is inert.',
    patch: { patchType: PATCH_TYPE.POLICY_UPDATE, wordCount: 1, scoreDelta: 0n, parentStateRoot: parentRoot, indices: [idx], newWords: [word] },
    forbidden: 'anchoring a generic/owner entity; budget over policyMaxBudgetEvidence; firing off-intent or cross-subject; reading qrels',
    sourceAttributionIfFires: 'policyAdmitted via evidence_bundle atom; query-local, subject-scoped, bounded by policyMaxBudgetEvidence',
  });
}
// 3. conflict_state — one conflict_lifecycle atom (boost the resolving doc on conflict-intent queries)
{
  const idx = RANGES.POLICY_CONFLICT_START + 0;
  const word = encodePolicyAtom({ atomIndex: 0, family: 'conflict_lifecycle', selector: POLICY_SELECTOR.CONFLICT_SET_MEMBER, evidenceFeature: POLICY_EVIDENCE_FEATURE.CONTRADICTS_EDGE, action: 'boost', scope: 'conflict_set', targetSlot: 1, budget: 200, flags: 0, validFromEpoch: 0n, expiryEpoch: 0n });
  examples.push({
    surface: 'conflict_state (conflict_lifecycle)',
    publicDataSeen: 'public contradicts / scope_differs edge DIRECTION (src = resolving/asserting doc, dst = contradicted candidate); the anchor MemoryIndex slot',
    patchType: 'POLICY_UPDATE (0x07)', wordCount: 1,
    intent: 'boost the contradicts-SRC (resolved) doc on queries carrying a public conflict/scope intent (parseQueryConflictIntent gate); suppress the candidate with a second atom (action=suppress)',
    patch: { patchType: PATCH_TYPE.POLICY_UPDATE, wordCount: 1, scoreDelta: 0n, parentStateRoot: parentRoot, indices: [idx], newWords: [word] },
    forbidden: 'using the corpus lifecycleState label or qrels (selector reads PUBLIC edge direction only); firing on non-conflict queries (the conflict-INTENT gate prevents off-family damage); wrong-direction (boost candidate) — provably HURTS',
    sourceAttributionIfFires: 'conflict-atom trace: boost@contradicts-src / suppress@contradicts-dst, query-local (top-K gate), bounded ±budget/1000·spread',
  });
}
// 4. guarded abstention — one abstention atom (abstain when no public evidence path)
{
  const idx = RANGES.POLICY_ABSTENTION_START + 0;
  const word = encodePolicyAtom({ atomIndex: 0, family: 'abstention', selector: POLICY_SELECTOR.MISSING_EVIDENCE, evidenceFeature: POLICY_EVIDENCE_FEATURE.NO_PUBLIC_EVIDENCE_PATH, action: 'abstain', scope: 'entity', targetSlot: POLICY_TARGET_NONE, budget: 0, flags: POLICY_FLAG.REQUIRE_NO_EVIDENCE_PATH, validFromEpoch: 0n, expiryEpoch: 0n });
  examples.push({
    surface: 'guarded abstention',
    publicDataSeen: 'whether the query has ANY public evidence path (relation/support edge) to a candidate',
    patchType: 'POLICY_UPDATE (0x07)', wordCount: 1,
    intent: 'carry the no-evidence-path selector; the OPERATOR gates the actual abstain on top1 < 0.9995 AND top1-top2 margin < 0.0003 (miner cannot force abstention alone)',
    patch: { patchType: PATCH_TYPE.POLICY_UPDATE, wordCount: 1, scoreDelta: 0n, parentStateRoot: parentRoot, indices: [idx], newWords: [word] },
    forbidden: 'targetSlot pointing at a real anchor (abstention uses POLICY_TARGET_NONE); abstaining on answerable queries (operator margin gate prevents it)',
    sourceAttributionIfFires: 'abstention trace fires only when miner selector matches AND operator top1+margin gate trips',
  });
}

// validate every example: round-trip + type/range + apply
let pass = true; const log = [];
for (const ex of examples) {
  const wire = encodePatch(ex.patch);
  const dec = decodePatch(wire);
  const vt = validatePatchType(dec.patchType, dec.indices);
  const applied = applyPatch(genesis, ex.patch);
  const ok = vt.ok && applied.ok && dec.wordCount === ex.patch.wordCount;
  ex.wireHex = hex(wire);
  ex.childStateRoot = applied.ok ? bytesToHex(merkleizeState(applied.state)) : null;
  log.push(`${ok ? 'PASS' : 'FAIL'}  ${ex.surface} — type=${ex.patchType} words=${ex.wordCount} ${vt.ok ? 'valid' : vt.reason} ${applied.ok ? 'applies' : applied.code}`);
  if (!ok) pass = false;
}

if (argv.includes('--json')) {
  console.log(JSON.stringify(examples.map((e) => ({ surface: e.surface, publicDataSeen: e.publicDataSeen, patchType: e.patchType, wordCount: e.wordCount, intent: e.intent, indices: e.patch.indices, newWords: e.patch.newWords.map((w) => '0x' + w.toString(16)), wireHex: e.wireHex, childStateRoot: e.childStateRoot, forbidden: e.forbidden, sourceAttributionIfFires: e.sourceAttributionIfFires })), null, 2));
} else {
  console.log(log.join('\n'));
  console.log(pass ? 'RESULT: ALL PASS ✅ (every launch patch surface has a valid worked example)' : 'RESULT: FAIL ❌');
}
exit(pass ? 0 : 1);
