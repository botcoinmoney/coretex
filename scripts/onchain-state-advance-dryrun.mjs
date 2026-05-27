#!/usr/bin/env node
/**
 * On-chain state-advance dry-run  (Launch hardening L12).
 *
 * Produces onchain-state-advance-dryrun.json: the EXACT fields that go on-chain
 * when a patch becomes a state advance, plus the off-chain receipt the on-chain
 * artifactHash commits to, plus a field→replay-verifier-input map and exploit
 * checks. NO contract deployment — a dry-run manifest for Solidity/replay parity.
 *
 * Canonical CoreTexRegistry design (single wide state-advance event; CoreTex spelling):
 *   ON-CHAIN: CoreTexEpochStarted / CoreTexStateAdvanced(... evalReportHash, coreVersionHash,
 *     corpusRoot, activeFrontierRoot, improvementCredits, wordCount, compactPatchBytes) /
 *     CoreTexEpochFinalized.
 *   OFF-CHAIN (full receipt, served by coordinator/API; its keccak256 == evalReportHash):
 *     gate/confirm scores, hidden-pack commitment, baseline manifest, screener outcome,
 *     score breakdown, blockhash, patchReceivedNoticeHash. See ONCHAIN_STATE_COMPOSITION.md.
 *
 * The state advance is anchored to the REAL committed L4 vector
 * (mixed-relation-conflict) + the L1 launch corpusRoot + candidate bundleHash;
 * synthetic fields (miner, blockhash, epochSecret, scores) are flagged.
 *
 * Usage: node scripts/onchain-state-advance-dryrun.mjs [--emit]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { argv, exit } from 'node:process';
import { distIndex, repoRoot } from './_repo-root.mjs';
import { buildV2ProductionCorpus } from './lib/build-v2-production-corpus.mjs';

const m = await import(distIndex);
const { merkleizeState, bytesToHex, decodePatch, applyPatch, computePatchHash, keccak256, deriveQueryPack } = m;

const base = 'release/calibration/2026-05-21-memory-corpus-v2';
const OUT = resolve(repoRoot, `${base}/onchain-state-advance-dryrun.json`);
const emit = argv.includes('--emit');

const fx = JSON.parse(readFileSync(resolve(repoRoot, 'release/calibration/fixtures/state-root-vectors.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(resolve(repoRoot, 'release/bundle/bundle-manifest-v2-dgen1-policy-r5-candidate.json'), 'utf8'));
const profile = JSON.parse(readFileSync(resolve(repoRoot, 'release/bundle/evaluator-profile-v2-dgen1-policy-r5.json'), 'utf8'));
const { corpus } = buildV2ProductionCorpus({ corpusPath: `${base}/dgen1-r5-synth-corpus.json`, embPath: `${base}/dgen1-r5-synth-embeddings.json` });

const hexToBytes = (h) => { const s = h.replace(/^0x/, ''); const o = new Uint8Array(s.length / 2); for (let i = 0; i < o.length; i++) o[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16); return o; };
const kjson = (v) => bytesToHex(keccak256(new TextEncoder().encode(canonical(v))));
function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
}

// the real state advance: the mixed-relation-conflict L4 vector
const adv = fx.vectors.find((v) => v.name === 'mixed-relation-conflict');
const tmp = fx.vectors.find((v) => v.name === 'temporal-update');
// rebuild the parent state (= after temporal-update) to confirm continuity
let parent = { words: new Array(1024).fill(0n) };
parent = applyPatch(parent, decodePatch(hexToBytes(tmp.patchBytesHex))).state;
const patch = decodePatch(hexToBytes(adv.patchBytesHex));
const child = applyPatch(parent, patch);
if (!child.ok) throw new Error('dry-run: advance patch did not apply');

// public roots
const corpusRoot = corpus.corpusRoot;
const evalSeedHex = profile.baselineEvalSeedHex;
const pack = deriveQueryPack(0, evalSeedHex, corpus, { ...profile.hiddenPack, packSize: 64, quotas: [] });
const queryPackRoot = bytesToHex(keccak256(new TextEncoder().encode(pack.events.map((e) => e.id).sort().join('\n'))));
const baselineManifest = { parentStateRoot: adv.parentStateRoot, corpusRoot, queryPackRoot, parentScorePpm: profile.baselineParentScorePpm, variancePpm: profile.baselineVariancePpm, samples: 3, evalSeedHex };
const baselineManifestHash = kjson(baselineManifest);

// synthetic anti-pre-testing witnesses (flagged) — real values come from chain + reveal
const SYNTH = { minerAddress: '0x' + '11'.repeat(20), receivedAtBlock: 21_000_000, targetBlockOffset: 4, blockhash: '0x' + 'bb'.repeat(32), epochSecretCommitment: '0x' + 'ec'.repeat(32) };
const gateScorePpm = profile.baselineParentScorePpm + 5200;     // illustrative accepted delta (> threshold)
const confirmScorePpm = profile.baselineParentScorePpm + 4800;

// off-chain receipt (the on-chain artifactHash commits to this)
const receipt = {
  epochId: 0,
  parentStateRoot: adv.parentStateRoot,
  childStateRoot: adv.childStateRoot,
  patchBytesHash: adv.patchHash,         // domain-separated keccak (coretex-patch-hash-v1)
  minerAddress: SYNTH.minerAddress,
  bundleHash: manifest.bundleHash,
  corpusRoot,
  activeFrontierRoot: null,              // churn off at launch
  queryPackRoot,
  baselineManifestHash,
  minImprovementPpm: Number(profile.patchAcceptanceFloors.minImprovementPpm),
  replayTolerancePpm: profile.replayTolerancePpm,
  receivedAtBlock: SYNTH.receivedAtBlock,
  targetBlock: SYNTH.receivedAtBlock + SYNTH.targetBlockOffset,
  blockhash: SYNTH.blockhash,
  gateScorePpm,
  confirmScorePpm,
  patchReceivedNoticeHash: kjson({ epochId: 0, patchHash: adv.patchHash, receivedAtBlock: SYNTH.receivedAtBlock, miner: SYNTH.minerAddress }),
};
const artifactHash = kjson(receipt);     // == on-chain CoreTexStateAdvanced.evalReportHash
const receiptHash = artifactHash;        // CoretexPatchBytes.receiptHash references the same content

const dryrun = {
  schema: 'coretex-onchain-state-advance-dryrun-v1',
  note: 'Dry-run only — NO contract deployment. On-chain stores roots + content hashes; the full receipt is off-chain (served by coordinator/API) and its keccak256 == artifactHash.',
  onChain: {
    CoreTexEpochStarted: { sig: 'CoreTexEpochStarted(uint64,bytes32,bytes32,bytes32,bytes32,bytes32,bytes32)', epoch: 0, parentStateRoot: tmp.parentStateRoot, coreVersionHash: manifest.bundleHash, corpusRoot, activeFrontierRoot: receipt.activeFrontierRoot, baselineManifestHash, hiddenSeedCommit: SYNTH.epochSecretCommitment },
    CoreTexStateAdvanced: { sig: 'CoreTexStateAdvanced(uint64,uint64,address,bytes32,bytes32,bytes32,bytes32,bytes32,bytes32,bytes32,uint256,uint16,bytes)', epoch: 0, transitionIndex: 1, miner: SYNTH.minerAddress, parentStateRoot: adv.parentStateRoot, newStateRoot: adv.childStateRoot, patchHash: adv.patchHash, evalReportHash: artifactHash, coreVersionHash: manifest.bundleHash, corpusRoot, activeFrontierRoot: receipt.activeFrontierRoot, improvementCredits: receipt.gateScorePpm, wordCount: patch.wordCount, compactPatchBytesHex: adv.patchBytesHex },
    CoreTexEpochFinalized: { sig: 'CoreTexEpochFinalized(uint64,bytes32,bytes32,bytes32,bytes32,bytes32,bytes32,bytes32,bytes32)', epoch: 0, parentStateRoot: tmp.parentStateRoot, finalStateRoot: adv.childStateRoot, coreVersionHash: manifest.bundleHash, corpusRoot, activeFrontierRoot: receipt.activeFrontierRoot, patchSetRoot: kjson({ patches: [tmp.patchHash, adv.patchHash] }), scoreRoot: kjson({ scores: [receipt.gateScorePpm, receipt.confirmScorePpm] }), baselineManifestHash },
  },
  offChainReceipt: receipt,
  syntheticFields: ['minerAddress', 'receivedAtBlock', 'targetBlock', 'blockhash', 'gateScorePpm', 'confirmScorePpm', 'patchReceivedNoticeHash(epochSecret-derived parts)'],
  fieldToReplayInput: {
    'onChain.CoreTexStateAdvanced.parentStateRoot': 'replay: reconstruct/verify parent state continuity (must equal prior transition newStateRoot)',
    'onChain.CoreTexStateAdvanced.newStateRoot': 'replay: applyPatch(parent, patchBytes) must merkleize to this',
    'onChain.CoreTexStateAdvanced.patchHash': 'replay: computePatchHash(patchBytes) must equal this (domain-separated)',
    'onChain.CoreTexStateAdvanced.evalReportHash': 'replay: keccak256(canonical(offChainReceipt)) must equal this — binds the scoring context',
    'onChain.CoretexPatchBytes.patchBytes': 'replay: the wire bytes decoded + applied',
    'offChainReceipt.bundleHash': 'replay: pins scoring/controller/model behavior (verifyBundleManifest)',
    'offChainReceipt.corpusRoot': 'replay: pins the corpus the pack + scores were computed over',
    'offChainReceipt.queryPackRoot': 'replay: pins which hidden queries were scored (derived from blockhash+epochSecret)',
    'offChainReceipt.baselineManifestHash': 'replay: pins the baseline the delta was measured against (no stale baseline)',
    'offChainReceipt.blockhash': 'replay: must equal rpc.getBlockHash(targetBlock) — anti-forgery',
    'offChainReceipt.gateScorePpm/confirmScorePpm': 'replay: re-score both packs within replayTolerancePpm',
    'offChainReceipt.patchReceivedNoticeHash': 'replay: cross-check the anti-delay PatchReceivedNotice',
  },
  exploitChecks: {
    'no seed re-roll': 'seeds bind to (epochSecret, blockhash, epochId, patchHash, parentRoot, corpusRoot, bundleHash) — a resubmit collapses on the dedup cache; minerAddress is NOT a seed input',
    'no post-hoc pack selection': 'pack derived from a FUTURE blockhash (receivedAtBlock+offset) + epochSecret committed before reveal — coordinator cannot pick the pack after seeing the patch',
    'no fake blockhash': 'replay verifies blockhash == rpc.getBlockHash(targetBlock)',
    'no stale parent': 'parentStateRoot must equal the live root; applyPatch rejects E01 otherwise',
    'state-root continuity': 'transitionIndex ordering + parent==prior-newStateRoot enforced on replay',
    'no profile/bundle drift': 'bundleHash pins every scoring-affecting knob (bundle-attestation-smoke)',
    'no stale baseline': 'baselineManifestHash pins the comparison point (baseline-recalibration-e2e)',
  },
};

// integrity assertions
let pass = true; const log = [];
const check = (n, ok, d = '') => { log.push(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? ' — ' + d : ''}`); if (!ok) pass = false; };
check('parent continuity (temporal.child == advance.parent)', tmp.childStateRoot === adv.parentStateRoot, `${adv.parentStateRoot}`);
check('newStateRoot == applyPatch(parent, patchBytes)', bytesToHex(merkleizeState(child.state)) === adv.childStateRoot);
check('patchHash == computePatchHash(patchBytes)', computePatchHash(hexToBytes(adv.patchBytesHex)) === adv.patchHash);
check('evalReportHash recomputes from the off-chain receipt', kjson(receipt) === dryrun.onChain.CoreTexStateAdvanced.evalReportHash);
check('on-chain event carries roots + hashes + compact patch only (full state off-chain by root)', !('words' in dryrun.onChain.CoreTexStateAdvanced));

console.log(log.join('\n'));
console.log('────────────────────────────────────────────────────────');
console.log(`parentStateRoot ${adv.parentStateRoot}`);
console.log(`newStateRoot    ${adv.childStateRoot}`);
console.log(`patchHash       ${adv.patchHash}`);
console.log(`artifactHash    ${artifactHash}`);
console.log(`corpusRoot ${corpusRoot} | bundleHash ${manifest.bundleHash} | queryPackRoot ${queryPackRoot}`);
if (emit) { writeFileSync(OUT, JSON.stringify(dryrun, null, 2) + '\n'); console.log(`wrote ${OUT}`); }
console.log(pass ? 'RESULT: ALL PASS ✅' : 'RESULT: FAIL ❌');
exit(pass ? 0 : 1);
