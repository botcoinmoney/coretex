#!/usr/bin/env node
/**
 * Deterministic state-root + patch wire vectors  (Launch hardening L3+L4).
 *
 * Produces a small, fully deterministic chain of CortexState transitions with
 * their canonical wire bytes and roots — the artifact a Solidity/on-chain
 * verifier (or a fresh standalone validator) replays for byte-exact parity:
 *
 *   v0  genesis            all-zero 1024-word state → genesis stateRoot
 *   v1  temporal update    2 MemoryIndex slots + 1 TemporalRecord (3 words)
 *   v2  mixed rel+conflict  1 relation category-lens + 1 conflict atom +
 *                           1 abstention atom (3 words), chained onto v1
 *
 * For each transition it pins: parentStateRoot, patch wire bytes (hex),
 * domain-separated patchHash, childStateRoot, and asserts the incremental
 * Merkle update equals a full rebuild.
 *
 * It ALSO runs the L3 "layout-agreement" decode + fail-closed battery on the
 * final state (temporal/relation/conflict/abstention all decode; reserved
 * word write rejected E02; r5 reserved region non-zero flagged; invalid policy
 * atom fails closed).
 *
 * Modes:
 *   (default / --check)  regenerate and assert byte-equality vs the committed
 *                        fixture; non-zero exit on any drift  (CI regression lock)
 *   --emit               (re)write the fixture file
 *
 * Fixture: release/calibration/fixtures/state-root-vectors.json
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { argv, exit } from 'node:process';
import { repoRoot, distIndex } from './_repo-root.mjs';

const m = await import(distIndex);
const {
  merkleizeState, bytesToHex, buildMerkleCache, updateMerkleCache,
  encodePatch, decodePatch, applyPatch,
  encodeMemoryIndexSlot, encodeTemporalRecord, encodeRelationCategoryLens, encodePolicyAtom,
  decodeMemoryIndex, decodeTemporal, decodeRelations, decodePolicyAtomRegion, policyReservedNonZeroWords,
  stableRecordIdFor, computePatchHash,
  POLICY_SELECTOR, POLICY_EVIDENCE_FEATURE, POLICY_FLAG, POLICY_TARGET_NONE,
  RANGES, PATCH_TYPE,
} = m;

const FIXTURE = resolve(repoRoot, 'release/calibration/fixtures/state-root-vectors.json');
const emit = argv.includes('--emit');

// ── helpers ───────────────────────────────────────────────────────────────────
const genesis = () => ({ words: new Array(1024).fill(0n) });
const hexRoot = (state) => bytesToHex(merkleizeState(state));
const hexBytes = (u8) => '0x' + Buffer.from(u8).toString('hex');
const wordsHex = (arr) => arr.map((w) => '0x' + w.toString(16));

function buildPatch(parentState, patchType, indices, newWords) {
  return {
    patchType, wordCount: indices.length, scoreDelta: 0n,
    parentStateRoot: merkleizeState(parentState), indices, newWords,
  };
}

/** Apply + cross-check incremental Merkle update == full rebuild, return transition record. */
function transition(name, description, parentState, patch) {
  const res = applyPatch(parentState, patch);
  if (!res.ok) throw new Error(`${name}: applyPatch rejected ${res.code} ${res.message}`);
  const childState = res.state;

  // incremental Merkle vs full rebuild parity
  const cache = buildMerkleCache(parentState);
  const updated = updateMerkleCache(cache, patch.indices.map((idx, i) => ({ index: idx, word: patch.newWords[i] })));
  const incRoot = bytesToHex(updated.root);
  const fullRoot = hexRoot(childState);
  if (incRoot !== fullRoot) throw new Error(`${name}: incremental Merkle ${incRoot} != full rebuild ${fullRoot}`);

  // wire round-trip
  const wire = encodePatch(patch);
  const decoded = decodePatch(wire);
  const reWire = encodePatch(decoded);
  if (hexBytes(wire) !== hexBytes(reWire)) throw new Error(`${name}: patch wire round-trip mismatch`);

  return {
    state: childState,
    record: {
      name, description,
      parentStateRoot: bytesToHex(patch.parentStateRoot),
      patch: {
        patchType: patch.patchType, wordCount: patch.wordCount,
        scoreDelta: patch.scoreDelta.toString(),
        indices: patch.indices, newWords: wordsHex(patch.newWords),
      },
      patchBytesHex: hexBytes(wire),
      patchHash: computePatchHash(wire),
      childStateRoot: fullRoot,
      incrementalMerkleMatchesFullRebuild: true,
    },
  };
}

// ── v0 genesis ──────────────────────────────────────────────────────────────
const g = genesis();
const v0 = { name: 'genesis', description: 'all-zero 1024-word CortexState', stateRoot: hexRoot(g) };

// ── v1 temporal update (recordSlot 0: stale slot 0, current slot 1) ──────────
const staleSlot = 0, curSlot = 1, recordSlot = 0;
const tIdx = [], tWords = [];
tIdx.push(RANGES.MEMORY_INDEX_START + staleSlot);
tWords.push(encodeMemoryIndexSlot({ slotIndex: staleSlot, recordId: stableRecordIdFor('mem_doc_stale'), family: 'temporal', domainBits: 1n, valid: true, revoked: true, protected: false, retrievalSlot: 0, expiryEpoch: 0n })[0]);
tIdx.push(RANGES.MEMORY_INDEX_START + curSlot);
tWords.push(encodeMemoryIndexSlot({ slotIndex: curSlot, recordId: stableRecordIdFor('mem_doc_current'), family: 'temporal', domainBits: 1n, valid: true, revoked: false, protected: false, retrievalSlot: 0, expiryEpoch: 0n })[0]);
tIdx.push(RANGES.TEMPORAL_START + recordSlot);
tWords.push(encodeTemporalRecord({ recordIndex: recordSlot, memorySlot: staleSlot, supersededBy: curSlot, validFromEpoch: 1n, validUntilEpoch: (2n ** 40n - 1n), currentStaleFlag: true })[0]);
const t1 = transition('temporal-update', 'one current/stale temporal pair: 2 MemoryIndex slots + 1 TemporalRecord', g, buildPatch(g, PATCH_TYPE.MIXED, tIdx, tWords));

// ── v2 mixed relation + conflict + abstention, chained onto v1 ───────────────
const mIdx = [], mWords = [];
// relation category-lens (supports) at the top of the RELATIONS region
mIdx.push(RANGES.RELATIONS_START + 127);
mWords.push(encodeRelationCategoryLens({ entryIndex: 127, edgeType: 'supports', weight: 0x8000 }));
// conflict_lifecycle atom: boost the current doc anchor (slot 1) when query subject is in a public conflict set
mIdx.push(RANGES.POLICY_CONFLICT_START + 0);
mWords.push(encodePolicyAtom({
  atomIndex: 0, family: 'conflict_lifecycle',
  selector: POLICY_SELECTOR.CONFLICT_SET_MEMBER, evidenceFeature: POLICY_EVIDENCE_FEATURE.CONTRADICTS_EDGE,
  action: 'boost', scope: 'conflict_set', targetSlot: curSlot, budget: 200, flags: 0, validFromEpoch: 0n, expiryEpoch: 0n,
}));
// abstention atom: abstain when no public evidence path (anchor = none)
mIdx.push(RANGES.POLICY_ABSTENTION_START + 0);
mWords.push(encodePolicyAtom({
  atomIndex: 0, family: 'abstention',
  selector: POLICY_SELECTOR.MISSING_EVIDENCE, evidenceFeature: POLICY_EVIDENCE_FEATURE.NO_PUBLIC_EVIDENCE_PATH,
  action: 'abstain', scope: 'entity', targetSlot: POLICY_TARGET_NONE, budget: 0, flags: POLICY_FLAG.REQUIRE_NO_EVIDENCE_PATH, validFromEpoch: 0n, expiryEpoch: 0n,
}));
const t2 = transition('mixed-relation-conflict', 'relation category-lens + conflict_lifecycle atom + abstention atom (chained onto temporal)', t1.state, buildPatch(t1.state, PATCH_TYPE.MIXED, mIdx, mWords));

// ── L3 layout-agreement decode + fail-closed battery on the final state ──────
const finalState = t2.state;
const battery = {};

// temporal record present
const tmp = decodeTemporal(finalState);
battery.temporalRecordDecoded = (tmp.records?.length ?? 0) >= 1 && tmp.records.some((r) => r && r.currentStaleFlag === true);
// relation lens present
const rel = decodeRelations(finalState);
battery.relationLensDecoded = (rel.categoryLenses?.length ?? 0) >= 1;
// conflict atom present
const conf = decodePolicyAtomRegion(finalState, 'conflict_lifecycle');
battery.conflictAtomDecoded = conf.atoms.length === 1 && conf.failures === 0 && conf.atoms[0].action === 'boost';
// abstention atom present
const abst = decodePolicyAtomRegion(finalState, 'abstention');
battery.abstentionAtomDecoded = abst.atoms.length === 1 && abst.failures === 0 && abst.atoms[0].action === 'abstain';
// reserved r5 policy region (896–991) is zero
battery.r5ReservedRegionZero = policyReservedNonZeroWords(finalState) === 0;

// fail-closed: writing the reserved range (992) is rejected E02
const reservedPatch = buildPatch(finalState, PATCH_TYPE.MIXED, [RANGES.RESERVED_START], [1n]);
const reservedRes = applyPatch(finalState, reservedPatch);
battery.reservedWordWriteRejected = !reservedRes.ok && reservedRes.code === 'E02';

// fail-closed: a non-zero r5 reserved word is flagged invalid-for-reward
const dirty = { words: [...finalState.words] };
dirty.words[RANGES.POLICY_RESERVED_START] = 1n;
battery.r5ReservedNonZeroFlagged = policyReservedNonZeroWords(dirty) === 1;

// fail-closed: an invalid policy atom (reserved low bits set) fails decode
const badAtomState = { words: [...finalState.words] };
const goodAtom = encodePolicyAtom({ atomIndex: 1, family: 'conflict_lifecycle', selector: POLICY_SELECTOR.CONFLICT_SET_MEMBER, evidenceFeature: POLICY_EVIDENCE_FEATURE.CONTRADICTS_EDGE, action: 'suppress', scope: 'conflict_set', targetSlot: curSlot, budget: 100, flags: 0, validFromEpoch: 0n, expiryEpoch: 0n });
badAtomState.words[RANGES.POLICY_CONFLICT_START + 1] = goodAtom | 1n; // set a reserved low bit (bits 0..111 MUST be zero)
const badDecode = decodePolicyAtomRegion(badAtomState, 'conflict_lifecycle');
battery.invalidPolicyAtomFailsClosed = badDecode.failures >= 1 && badDecode.atoms.length === 1; // the good atom still decodes; the bad one is dropped

// fail-closed: an action not allowed for the region (abstain in conflict region) fails
const wrongActionState = { words: [...finalState.words] };
wrongActionState.words[RANGES.POLICY_CONFLICT_START + 2] = encodePolicyAtom({ atomIndex: 2, family: 'abstention', selector: POLICY_SELECTOR.MISSING_EVIDENCE, evidenceFeature: POLICY_EVIDENCE_FEATURE.NO_PUBLIC_EVIDENCE_PATH, action: 'abstain', scope: 'entity', targetSlot: POLICY_TARGET_NONE, budget: 0, flags: 0, validFromEpoch: 0n, expiryEpoch: 0n });
const wrongActionDecode = decodePolicyAtomRegion(wrongActionState, 'conflict_lifecycle');
battery.regionDisallowedActionFailsClosed = wrongActionDecode.failures >= 1;

const generated = {
  schema: 'coretex-state-root-vectors-v1',
  generatedBy: 'scripts/state-root-vectors.mjs',
  note: 'Deterministic CortexState transition vectors for on-chain/standalone replay parity. Roots are keccak256 binary-Merkle over 1024 big-endian uint256 leaves; patchHash is domain-separated (coretex-patch-hash-v1).',
  vectors: [v0, t1.record, t2.record],
  layoutAgreement: battery,
};

// ── emit or check ───────────────────────────────────────────────────────────
const allBatteryPass = Object.values(battery).every((v) => v === true);

if (emit) {
  mkdirSync(dirname(FIXTURE), { recursive: true });
  writeFileSync(FIXTURE, JSON.stringify(generated, null, 2) + '\n');
  console.log(`[emit] wrote ${FIXTURE}`);
  for (const [k, v] of Object.entries(battery)) console.log(`  layout ${k}: ${v ? 'PASS' : 'FAIL'}`);
  console.log(`  genesisRoot   ${v0.stateRoot}`);
  console.log(`  temporalRoot  ${t1.record.childStateRoot}  patchHash ${t1.record.patchHash}`);
  console.log(`  mixedRoot     ${t2.record.childStateRoot}  patchHash ${t2.record.patchHash}`);
  if (!allBatteryPass) { console.error('REFUSING-CLEAN-EXIT: layout battery has FAILs'); exit(1); }
  exit(0);
}

// check mode
if (!existsSync(FIXTURE)) { console.error(`[check] fixture missing: ${FIXTURE}\nrun: node scripts/state-root-vectors.mjs --emit`); exit(1); }
const pinned = JSON.parse(readFileSync(FIXTURE, 'utf8'));
const a = JSON.stringify(pinned.vectors);
const b = JSON.stringify(generated.vectors);
let ok = true;
if (a !== b) {
  ok = false;
  console.error('[check] VECTOR DRIFT — regenerated vectors differ from committed fixture');
  for (let i = 0; i < generated.vectors.length; i++) {
    const ja = JSON.stringify(pinned.vectors[i]); const jb = JSON.stringify(generated.vectors[i]);
    if (ja !== jb) console.error(`  vector[${i}] ${generated.vectors[i].name}: DRIFT\n    pinned=${ja}\n    now   =${jb}`);
  }
}
for (const [k, v] of Object.entries(battery)) {
  const status = v === true ? 'PASS' : 'FAIL';
  console.log(`layout ${k}: ${status}`);
  if (v !== true) ok = false;
}
console.log(`genesisRoot   ${v0.stateRoot}`);
console.log(`temporalRoot  ${t1.record.childStateRoot}  patchHash ${t1.record.patchHash}`);
console.log(`mixedRoot     ${t2.record.childStateRoot}  patchHash ${t2.record.patchHash}`);
console.log(ok ? 'RESULT: ALL PASS ✅ (vectors stable + layout agreement)' : 'RESULT: FAIL ❌');
exit(ok ? 0 : 1);
