#!/usr/bin/env node
/**
 * Standalone CoreTex validator / replay client  (Launch hardening L9 + L11).
 *
 * A fresh checkout can run this with NO calibration scratch — it replays the
 * committed deterministic state-root vectors (release/calibration/fixtures/
 * state-root-vectors.json) and verifies a bundle manifest. Replay divergence
 * emits a `coretex_replay_divergence` flag artifact (local JSON) — NO chain
 * consequence, exactly per the L11 contract.
 *
 * Subcommands:
 *   replay-patch [--tamper] [--flag-out <path>]
 *       Replay each pinned patch from genesis; assert child root + domain-
 *       separated patchHash. --tamper flips one patch byte to demonstrate the
 *       divergence-flag path (verifier flags, does not crash).
 *   inspect-state [--vector <name>]
 *       Decode the resulting substrate (temporal / relations / policy atoms).
 *   verify-bundle --bundle <manifest.json>
 *       Run verifyBundleManifest; print the structured error list (empty = ok).
 *
 * Usage:
 *   node scripts/coretex-validator.mjs replay-patch
 *   node scripts/coretex-validator.mjs replay-patch --tamper
 *   node scripts/coretex-validator.mjs inspect-state --vector mixed-relation-conflict
 *   node scripts/coretex-validator.mjs verify-bundle --bundle release/bundle/bundle-manifest-v2-dgen1-policy-r5-candidate.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { argv, exit } from 'node:process';
import { distIndex, repoRoot } from './_repo-root.mjs';

const m = await import(distIndex);
const {
  merkleizeState, bytesToHex, decodePatch, applyPatch, computePatchHash,
  decodeSubstrate, decodePolicyAtomRegion, verifyBundleManifest,
} = m;

const args = argv.slice(2);
const cmd = args[0];
const opt = (name, fb) => { const i = args.indexOf(`--${name}`); return i >= 0 && i + 1 < args.length ? args[i + 1] : fb; };
const has = (name) => args.includes(`--${name}`);
const FIXTURE = resolve(repoRoot, 'release/calibration/fixtures/state-root-vectors.json');

function hexToBytes(hex) { const s = hex.replace(/^0x/, ''); const o = new Uint8Array(s.length / 2); for (let i = 0; i < o.length; i++) o[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16); return o; }
function genesis() { return { words: new Array(1024).fill(0n) }; }

function divergenceFlag({ vector, receiptResult, localResult, failureCode, inputsVerifiedIdentical }) {
  return {
    type: 'coretex_replay_divergence',
    receiptHash: vector?.patchHash ?? null,
    patchHash: vector?.patchHash ?? null,
    stateRoot: vector?.childStateRoot ?? null,
    bundleHash: null,
    localResult, receiptResult, failureCode,
    inputsVerifiedIdentical,
    createdAt: new Date().toISOString(),
  };
}

function replayPatch() {
  const fx = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  const patchVecs = fx.vectors.filter((v) => v.patchBytesHex);
  const tamper = has('tamper');
  const flagOut = opt('flag-out', resolve(repoRoot, 'release/calibration/2026-05-21-memory-corpus-v2/replay-divergence-flag.json'));
  let state = genesis();
  let ok = true; const lines = []; let flag = null;
  for (let vi = 0; vi < patchVecs.length; vi++) {
    const vec = patchVecs[vi];
    let wire = hexToBytes(vec.patchBytesHex);
    if (tamper && vi === patchVecs.length - 1) { wire = wire.slice(); wire[wire.length - 1] ^= 0x01; } // flip last byte of last patch
    // parent continuity
    const parentOk = bytesToHex(merkleizeState(state)) === vec.parentStateRoot;
    let childRoot = null, patchHash = null, applied = false, code = null;
    try {
      patchHash = computePatchHash(wire);
      const patch = decodePatch(wire);
      const res = applyPatch(state, patch);
      if (res.ok) { applied = true; childRoot = bytesToHex(merkleizeState(res.state)); state = res.state; }
      else code = `APPLY_${res.code}`;
    } catch (e) { code = 'DECODE_ERROR'; }
    const childMatch = childRoot === vec.childStateRoot;
    const hashMatch = patchHash === vec.patchHash;
    const vecOk = parentOk && applied && childMatch && hashMatch;
    lines.push(`${vecOk ? 'PASS' : 'FAIL'}  replay ${vec.name}: parent=${parentOk} patchHash=${hashMatch} child=${childMatch}${code ? ' code=' + code : ''}`);
    if (!vecOk) {
      ok = false;
      flag = divergenceFlag({
        vector: vec,
        receiptResult: vec.childStateRoot,
        localResult: childRoot ?? code ?? 'unapplied',
        failureCode: code ?? (!hashMatch ? 'PATCH_HASH_MISMATCH' : !childMatch ? 'CHILD_ROOT_MISMATCH' : 'PARENT_ROOT_MISMATCH'),
        inputsVerifiedIdentical: !tamper, // tamper changes the bytes → inputs differ; honest divergence would keep inputs identical
      });
      break; // stop the chain on first divergence (parent continuity broken)
    }
  }
  console.log(lines.join('\n'));
  if (flag) {
    writeFileSync(flagOut, JSON.stringify(flag, null, 2) + '\n');
    console.log(`\n⚑ replay divergence — wrote flag artifact (NO chain consequence): ${flagOut}`);
    console.log(JSON.stringify(flag, null, 2));
  }
  console.log(tamper
    ? (ok ? 'UNEXPECTED: tamper did not diverge ❌' : 'EXPECTED: tampered patch flagged divergence ✅ (no crash, no chain consequence)')
    : (ok ? 'RESULT: replay OK ✅ (all pinned roots reproduced)' : 'RESULT: replay FAILED ❌'));
  return tamper ? (ok ? 1 : 0) : (ok ? 0 : 1);
}

function inspectState() {
  const fx = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  const want = opt('vector', 'mixed-relation-conflict');
  let state = genesis();
  for (const vec of fx.vectors.filter((v) => v.patchBytesHex)) {
    const res = applyPatch(state, decodePatch(hexToBytes(vec.patchBytesHex)));
    if (res.ok) state = res.state;
    if (vec.name === want) break;
  }
  const sub = decodeSubstrate(state, { policyAtomsMode: true });
  const conf = decodePolicyAtomRegion(state, 'conflict_lifecycle');
  const abst = decodePolicyAtomRegion(state, 'abstention');
  console.log(`state @ vector=${want}`);
  console.log(`  stateRoot       ${bytesToHex(merkleizeState(state))}`);
  console.log(`  temporal records ${(sub.temporal ?? []).length}`);
  console.log(`  relation lenses  ${(sub.relations?.categoryLenses ?? sub.categoryLenses ?? []).length ?? 'n/a'}`);
  console.log(`  conflict atoms   ${conf.atoms.length} (failures ${conf.failures})`);
  console.log(`  abstention atoms ${abst.atoms.length} (failures ${abst.failures})`);
  return 0;
}

function verifyBundle() {
  const bundlePath = opt('bundle', 'release/bundle/bundle-manifest-v2-dgen1-policy-r5-candidate.json');
  const manifest = JSON.parse(readFileSync(resolve(repoRoot, bundlePath), 'utf8'));
  const errors = verifyBundleManifest(manifest, repoRoot);
  console.log(`bundle ${bundlePath}`);
  console.log(`bundleHash ${manifest.bundleHash}`);
  if (errors.length === 0) { console.log('RESULT: bundle verifies ✅ (0 errors)'); return 0; }
  console.log(`RESULT: ${errors.length} verification error(s):`);
  for (const e of errors) console.log(`  - ${e}`);
  return 1;
}

let rc = 0;
if (cmd === 'replay-patch') rc = replayPatch();
else if (cmd === 'inspect-state') rc = inspectState();
else if (cmd === 'verify-bundle') rc = verifyBundle();
else { console.error('usage: coretex-validator.mjs {replay-patch [--tamper]|inspect-state [--vector N]|verify-bundle --bundle P}'); rc = 2; }
exit(rc);
