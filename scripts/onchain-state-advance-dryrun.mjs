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
import { createHash } from 'node:crypto';
import { argv, exit } from 'node:process';
import { distIndex, repoRoot } from './_repo-root.mjs';
import { makeLaunchFrontier } from './lib/epoch-frontier.mjs';

const m = await import(distIndex);
const { merkleizeState, bytesToHex, decodePatch, applyPatch, computePatchHash, keccak256, deriveQueryPack, splitForRecord } = m;

const opt = (n, fb) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fb; };
const DEFAULT_ARTIFACT_MANIFEST = 'release/calibration/2026-06-04-memory-atom-v16/coretex-launch-v16-artifacts.json';
const artifactManifestPath = opt('manifest', DEFAULT_ARTIFACT_MANIFEST);
const artifactManifest = JSON.parse(readFileSync(resolve(repoRoot, artifactManifestPath), 'utf8'));
const payloadPath = (role) => artifactManifest.payloads?.find((p) => p.role === role)?.path;
const base = 'release/calibration/2026-06-04-memory-atom-v16';
const OUT = resolve(repoRoot, opt('out', `${base}/onchain-state-advance-dryrun.json`));
const emit = argv.includes('--emit');

const fx = JSON.parse(readFileSync(resolve(repoRoot, 'release/calibration/fixtures/state-root-vectors.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(resolve(repoRoot, opt('bundle', artifactManifest.bundlePath)), 'utf8'));
const profile = JSON.parse(readFileSync(resolve(repoRoot, opt('profile', artifactManifest.profilePath)), 'utf8'));
const corpusPath = opt('corpus', payloadPath('corpus'));
const embPath = opt('emb', payloadPath('embeddings'));
if (!corpusPath || !embPath) throw new Error(`dry-run: ${artifactManifestPath} does not define corpus/embeddings payloads`);
if (artifactManifest.bundleHash && manifest.bundleHash !== artifactManifest.bundleHash) {
  throw new Error(`dry-run: bundleHash drift ${manifest.bundleHash} != artifact manifest ${artifactManifest.bundleHash}`);
}
const logicalCorpus = JSON.parse(readFileSync(resolve(repoRoot, corpusPath), 'utf8'));
const bucket = (f) => f === 'temporal_update' ? 'temporal'
  : (f === 'multi_session_bridge' || f === 'causal_memory_chain' || f === 'decision_provenance') ? 'multi_hop_relation'
  : f === 'conflict_lifecycle' ? 'conflict_lifecycle'
  : f === 'aspect_constraint' ? 'aspect_constraint'
  : f === 'coreference_resolution' ? 'coreference'
  : 'near_collision';
const corpusRootFromManifest = manifest.corpus?.root ?? artifactManifest.corpusRoot;
const corpus = {
  corpusRoot: corpusRootFromManifest,
  events: (logicalCorpus.queries ?? []).map((q) => ({
    id: q.id,
    family: bucket(q.family),
    logicalFamily: q.family,
    split: splitForRecord(q.id, 0),
    queryText: q.queryText ?? '',
    truthDocuments: [],
    hardNegatives: [],
    qrels: [],
    protected: false,
    relations: [],
    ...(q.band ? { band: q.band } : {}),
  })),
};

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
if (artifactManifest.corpusRoot && artifactManifest.corpusRoot.toLowerCase() !== corpusRoot.toLowerCase()) {
  throw new Error(`dry-run: corpusRoot drift ${corpusRoot} != artifact manifest ${artifactManifest.corpusRoot}`);
}
// C3 churn is launch-required → derive the genesis activeFrontierRoot (V4 rejects bytes32(0)).
const activeFrontierRoot = makeLaunchFrontier(profile, corpus)?.stepEpoch(0, null, null).activeRoot ?? null;
if (!activeFrontierRoot || /^0x0+$/.test(activeFrontierRoot)) throw new Error('dry-run: activeFrontierRoot missing/zero');
const evalSeedHex = profile.baselineEvalSeedHex;
const pack = deriveQueryPack(0, evalSeedHex, corpus, { ...profile.hiddenPack, packSize: 64, quotas: [] });
const queryPackRoot = bytesToHex(keccak256(new TextEncoder().encode(pack.events.map((e) => e.id).sort().join('\n'))));
const profileHash = '0x' + createHash('sha256').update(canonical(profile)).digest('hex');
const artifactManifestHash = '0x' + createHash('sha256').update(readFileSync(resolve(repoRoot, artifactManifestPath))).digest('hex');
const rerankerRevision = manifest.model?.reranker?.revision ?? null;
const baselineManifest = {
  parentStateRoot: adv.parentStateRoot,
  corpusRoot,
  activeFrontierRoot,
  bundleHash: manifest.bundleHash,
  profileHash,
  rerankerRevision,
  queryPackRoot,
  parentScorePpm: profile.baselineParentScorePpm,
  variancePpm: profile.baselineVariancePpm,
  samples: profile.baselineSamples ?? 3,
  replayTolerancePpm: profile.replayTolerancePpm,
};
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
  artifactManifestHash,
  profileHash,
  rerankerRevision,
  corpusRoot,
  activeFrontierRoot,                    // C3 launch-required: derived genesis frontier root (non-zero)
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
    'offChainReceipt.artifactManifestHash/profileHash/rerankerRevision': 'replay: rejects stale validator/client scoring context before accepting the receipt envelope',
    'offChainReceipt.corpusRoot': 'replay: pins the corpus the pack + scores were computed over',
    'offChainReceipt.activeFrontierRoot': 'replay: must equal the epoch activeFrontierRoot pinned in CoreTexRegistry',
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
    'no profile/bundle drift': 'bundleHash + profileHash + artifactManifestHash pin every scoring-affecting knob (bundle-attestation-smoke)',
    'no stale baseline': 'baselineManifestHash pins the comparison point, active frontier, profile, reranker, and bundle',
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
