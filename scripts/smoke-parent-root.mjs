#!/usr/bin/env node
/**
 * CPU unit smoke: a trivial valid patch on the genesis state MUST NOT fail E01
 * (WRONG_PARENT_ROOT). Catches regressions where a harness uses literal zero bytes
 * for parentStateRoot instead of merkleizeState(state).
 *
 * Hard-fails on any of:
 *   - apply rejects with E01
 *   - merkleizeState(genesis) equals 32 zero bytes (would mean the canonical helper drifted)
 */
import { exit } from 'node:process';
import { distIndex } from './_repo-root.mjs';

const C = await import(distIndex);
const { RANGES, PATCH_TYPE, merkleizeState, applyPatch, encodePolicyAtom, POLICY_SELECTOR, POLICY_EVIDENCE_FEATURE } = C;

function fail(m) { console.error(`SMOKE FAIL: ${m}`); exit(1); }
function pass(m) { console.log(`SMOKE PASS: ${m}`); }

const genesis = { words: new Array(1024).fill(0n) };
const parentRoot = merkleizeState(genesis);
if (!(parentRoot instanceof Uint8Array) || parentRoot.length !== 32) fail(`merkleizeState returned bad shape: ${typeof parentRoot} len=${parentRoot?.length}`);
const allZero = parentRoot.every((b) => b === 0);
if (allZero) fail(`merkleizeState(genesis) returned 32 zero bytes — canonical helper drifted (was the safety the smoke is supposed to catch)`);
pass(`merkleizeState(genesis) is a real keccak hash (first 4 bytes: ${[...parentRoot.slice(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join('')}…)`);

const word = encodePolicyAtom({
  atomIndex: 0, family: 'evidence_bundle', selector: POLICY_SELECTOR.ANSWER_DENSITY,
  evidenceFeature: POLICY_EVIDENCE_FEATURE.SUPPORT_IN_DEGREE, action: 'bundle', scope: 'relation_path',
  targetSlot: 5, budget: 250, flags: 0, validFromEpoch: 0n, expiryEpoch: 0n,
});
const validPatch = {
  patchType: PATCH_TYPE.POLICY_UPDATE, wordCount: 1, scoreDelta: 0,
  parentStateRoot: parentRoot, indices: [RANGES.POLICY_EVIDENCE_START], newWords: [word],
};

const r1 = applyPatch(genesis, validPatch, true);
if (!r1.ok) fail(`canonical-parentRoot valid patch rejected: code=${r1.code}`);
pass(`canonical-parentRoot valid patch applies (no E01) — newState.words[POLICY_EVIDENCE_START]=0x${r1.state.words[RANGES.POLICY_EVIDENCE_START].toString(16)}`);

// Negative control: zero-bytes parentStateRoot MUST hard-fail E01.
const wrongPatch = { ...validPatch, parentStateRoot: new Uint8Array(32) };
const r2 = applyPatch(genesis, wrongPatch, true);
if (r2.ok) fail(`zero-bytes parentStateRoot was accepted — applyPatch parent-root check is BROKEN`);
if (r2.code !== 'E01') fail(`zero-bytes parentStateRoot rejected with WRONG code: expected E01, got ${r2.code}`);
pass(`zero-bytes parentStateRoot correctly rejected with E01 (negative control)`);

console.log('SMOKE: ALL PASS ✅ — parent-root contract verified');
exit(0);
