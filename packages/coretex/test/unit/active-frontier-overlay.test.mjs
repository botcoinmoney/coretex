/**
 * Active-frontier live-eval overlay — the scored-pack law wiring
 * (epochFrontier.liveEvalPack) that makes evolve-minted clustered eval_hidden
 * rows actually reachable by production scoring.
 *
 * Covers:
 *  - deriveScoredQueryPack: overlay-absent ⇒ byte-identical to deriveQueryPack
 *    (replay safety for every broad-only-law epoch); overlay-armed ⇒ admits the
 *    newest ACTIVE zz_e* rows deterministically while preserving quotas.
 *  - buildActiveFrontierIdsArtifact / loadActiveFrontierIds: self-verifying
 *    round trip; root mismatch, empty set, and malformed schema all FAIL CLOSED;
 *    the persisted frontier runtime-state shape is accepted.
 *  - checkScorerJobPins: activeFrontierRoot pairing refuses BOTH silent-drift
 *    directions (armed-scorer/unpinned-job and unpinned-scorer/pinned-job).
 *  - verifyScorerResult: stale-context refusal on job activeFrontierRoot
 *    mismatch in both directions.
 *  - dualPackProofFromPerPatchReceipt: proof echoes the active root only when
 *    armed (broad-law proof bytes unchanged).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  activeFrontierRootOf,
  admitActiveLiveEvalEvents,
  buildActiveFrontierIdsArtifact,
  deriveQueryPack,
  deriveScoredQueryPack,
  loadActiveFrontierIds,
} from '../../dist/index.js';
import { checkScorerJobPins } from '../../dist/scorer-server-cli.js';
import { verifyScorerResult } from '../../dist/coordinator/remote-scorer-verify.js';
import { dualPackProofFromPerPatchReceipt } from '../../dist/coordinator/per-patch-evaluator.js';

const B32 = (b) => '0x' + b.repeat(32);
const LAYOUT = { dim: 8, headerBytes: 9, quantization: 'int8' };

function ev(id, family) {
  return {
    id, family, domain: 'd', split: 'eval_hidden', queryText: `q ${id}`,
    truthDocuments: [{ id: `${id}-t`, text: 't', isCurrent: true }], hardNegatives: [],
    qrels: [{ documentId: `${id}-t`, relevance: 1 }], protected: false,
    provenance: { source: 'synthetic_challenge', sourceHash: B32('00') },
    embeddings: { modelId: 'm', revision: 'r', layout: LAYOUT, query: new Uint8Array(4 + 8), perTruth: new Map(), perNegative: new Map() },
  };
}

// Base broad universe + live-tail (evolve-minted, zz_e-prefixed) cluster rows.
const baseEvents = [];
for (let i = 0; i < 40; i++) baseEvents.push(ev(`tm${String(i).padStart(2, '0')}`, 'temporal'));
const liveRows = [];
for (let i = 0; i < 5; i++) liveRows.push(ev(`zz_e131_q_cluster_v${i}`, 'temporal_update'));
const events = [...baseEvents, ...liveRows];
const corpus = {
  events, byId: new Map(events.map((e) => [e.id, e])), corpusRoot: B32('00'), corpusEpoch: 0,
  biEncoderModelId: 'm', biEncoderRevision: 'r', biEncoderRetrievalKeyLayout: LAYOUT,
  labelingModelId: 'm', labelingModelRevision: 'r',
};
const PROFILE = { packSize: 16, quotas: [{ stratum: 'family=temporal', minCount: 4 }] };
const activeIds = new Set(liveRows.map((r) => r.id));
const LAW = { limit: 8 };
const SEED = '0x' + 'a5'.repeat(32);

describe('deriveScoredQueryPack (canonical scored-pack law)', () => {
  test('overlay absent ⇒ byte-identical to deriveQueryPack (broad-only replay safety)', () => {
    const broad = deriveQueryPack(7, SEED, corpus, PROFILE);
    const scored = deriveScoredQueryPack(7, SEED, corpus, PROFILE);
    assert.deepEqual(scored.events.map((e) => e.id), broad.events.map((e) => e.id));
  });

  test('limit<=0 law ⇒ also byte-identical', () => {
    const broad = deriveQueryPack(7, SEED, corpus, PROFILE);
    const scored = deriveScoredQueryPack(7, SEED, corpus, PROFILE, { activeIds, law: { limit: 0 } });
    assert.deepEqual(scored.events.map((e) => e.id), broad.events.map((e) => e.id));
  });

  test('armed overlay admits every ACTIVE live row into the pack, deterministically, quota preserved', () => {
    const scored = deriveScoredQueryPack(7, SEED, corpus, PROFILE, { activeIds, law: LAW });
    assert.equal(scored.events.length, PROFILE.packSize, 'pack size unchanged');
    const admitted = scored.events.filter((e) => activeIds.has(e.id));
    assert.equal(admitted.length, liveRows.length, 'all 5 active live rows admitted (limit 8 > 5)');
    const temporalCount = scored.events.filter((e) => e.family === 'temporal').length;
    assert.ok(temporalCount >= 4, `family=temporal quota preserved (${temporalCount} >= 4)`);
    const again = deriveScoredQueryPack(7, SEED, corpus, PROFILE, { activeIds, law: LAW });
    assert.deepEqual(again.events.map((e) => e.id), scored.events.map((e) => e.id), 'deterministic');
    // matches the raw two-step composition exactly
    const composed = admitActiveLiveEvalEvents(deriveQueryPack(7, SEED, corpus, PROFILE), corpus, {
      activeIds, limit: LAW.limit, profile: PROFILE,
    }).pack;
    assert.deepEqual(scored.events.map((e) => e.id), composed.events.map((e) => e.id));
  });

  test('dual packs (distinct seeds) BOTH contain the overlay rows — the acceptance-presence fix', () => {
    const gate = deriveScoredQueryPack(7, '0x' + 'c3'.repeat(32), corpus, PROFILE, { activeIds, law: LAW });
    const confirm = deriveScoredQueryPack(7, '0x' + 'd4'.repeat(32), corpus, PROFILE, { activeIds, law: LAW });
    for (const pack of [gate, confirm]) {
      assert.equal(pack.events.filter((e) => activeIds.has(e.id)).length, liveRows.length);
    }
  });
});

describe('active-frontier ids artifact (self-verifying set)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'coretex-afids-'));
  test('build → write → load round trip verifies the root', () => {
    const artifact = buildActiveFrontierIdsArtifact(131, activeIds);
    assert.equal(artifact.schema, 'coretex.active-frontier-ids.v1');
    assert.equal(artifact.activeFrontierRoot, activeFrontierRootOf(activeIds));
    const p = join(dir, 'ids.json');
    writeFileSync(p, JSON.stringify(artifact));
    const loaded = loadActiveFrontierIds(p, artifact.activeFrontierRoot);
    assert.deepEqual([...loaded].sort(), [...activeIds].sort());
  });

  test('root mismatch FAILS CLOSED', () => {
    const artifact = buildActiveFrontierIdsArtifact(131, activeIds);
    const p = join(dir, 'ids2.json');
    writeFileSync(p, JSON.stringify(artifact));
    assert.throws(() => loadActiveFrontierIds(p, B32('99')), /root mismatch/);
  });

  test('tampered id set FAILS CLOSED (root no longer matches)', () => {
    const artifact = buildActiveFrontierIdsArtifact(131, activeIds);
    const tampered = { ...artifact, activeIds: [...artifact.activeIds, 'zz_e131_q_injected'] };
    const p = join(dir, 'ids3.json');
    writeFileSync(p, JSON.stringify(tampered));
    assert.throws(() => loadActiveFrontierIds(p, artifact.activeFrontierRoot), /root mismatch/);
  });

  test('persisted frontier runtime-state shape is accepted (active tuples)', () => {
    const state = {
      schemaVersion: 'coretex.epoch-frontier-state.v1',
      order: [], reservePtr: 0,
      active: [...activeIds].map((id) => [id, 131]),
      retired: [], cumulativeActivated: 5, cumulativeRetired: 0,
      initialized: true, injectedSinceLastStep: 0, ewmaAccepts: null,
    };
    const p = join(dir, 'state.json');
    writeFileSync(p, JSON.stringify(state));
    const loaded = loadActiveFrontierIds(p, activeFrontierRootOf(activeIds));
    assert.deepEqual([...loaded].sort(), [...activeIds].sort());
  });

  test('empty set and malformed schema FAIL CLOSED', () => {
    const p1 = join(dir, 'empty.json');
    writeFileSync(p1, JSON.stringify({ schema: 'coretex.active-frontier-ids.v1', epochId: 1, activeFrontierRoot: B32('00'), activeIds: [] }));
    assert.throws(() => loadActiveFrontierIds(p1, B32('00')), /empty active set/);
    const p2 = join(dir, 'malformed.json');
    writeFileSync(p2, JSON.stringify({ nope: true }));
    assert.throws(() => loadActiveFrontierIds(p2, B32('00')), /unsupported schema/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('scorer job pin pairing (checkScorerJobPins)', () => {
  const MODEL = { modelId: 'm', revision: 'r', promptTemplateHash: B32('ab') };
  const basePins = { ...MODEL, bundleHash: B32('dd'), corpusRoot: B32('cc') };
  const baseJob = (pinsOver = {}) => ({
    jobId: 'j', epochId: 1, parentStateRoot: B32('01'), packedParentStateHex: '0x',
    patchHash: B32('02'), corpusRoot: B32('cc'), bundleHash: B32('dd'), coreVersionHash: B32('dd'),
    thresholdPpm: 150, policyHash: B32('ee'), compactPatchBytesHex: '0x', miner: '0x' + '11'.repeat(20),
    expectedScorerPins: { ...basePins, ...pinsOver },
  });
  const loadedBroad = { ...MODEL, bundleHash: B32('dd'), corpusRoot: B32('cc'), coreVersionHash: B32('dd') };
  const loadedOverlay = { ...loadedBroad, activeFrontierRoot: B32('5e') };

  test('overlay scorer + matching job pin ⇒ OK', () => {
    assert.equal(checkScorerJobPins(baseJob({ activeFrontierRoot: B32('5e') }), loadedOverlay), null);
  });
  test('overlay scorer refuses a job that does not pin the root', () => {
    assert.match(checkScorerJobPins(baseJob(), loadedOverlay), /activeFrontierRoot missing/);
  });
  test('overlay scorer refuses a mismatched root', () => {
    assert.match(checkScorerJobPins(baseJob({ activeFrontierRoot: B32('99') }), loadedOverlay), /activeFrontierRoot .* != loaded/);
  });
  test('broad scorer refuses a job pinning a root it never loaded', () => {
    assert.match(checkScorerJobPins(baseJob({ activeFrontierRoot: B32('5e') }), loadedBroad), /no active-frontier overlay/);
  });
  test('broad scorer + broad job unchanged ⇒ OK', () => {
    assert.equal(checkScorerJobPins(baseJob(), loadedBroad), null);
  });
});

describe('verifyScorerResult active-frontier stale-context refusal', () => {
  const minimalResult = {
    jobId: 'job-1', accepted: true, deltaPpm: 42_000, gateScorePpm: 45_000, confirmScorePpm: 42_000,
    thresholdPpmUsed: 1_000, policyHash: B32('ee'), pairTraceHash: B32('aa'), scoreArrayHash: B32('bb'),
    evalReportHash: B32('e1'), artifactHash: B32('a1'),
    scorerHealth: { modelId: 'm', revision: 'r', promptTemplateHash: B32('ab') },
  };
  const baseJob = (pins = {}) => ({
    jobId: 'job-1', epochId: 8, parentStateRoot: B32('01'), corpusRoot: B32('cc'), bundleHash: B32('dd'),
    coreVersionHash: B32('dd'), thresholdPpm: 1_000, policyHash: B32('ee'),
    expectedScorerPins: { modelId: 'm', revision: 'r', promptTemplateHash: B32('ab'), bundleHash: B32('dd'), corpusRoot: B32('cc'), ...pins },
  });
  const baseActive = { epochId: 8, parentStateRoot: B32('01'), corpusRoot: B32('cc'), bundleHash: B32('dd'), coreVersionHash: B32('dd'), workPolicyHash: B32('ee'), thresholdPpm: 1_000 };
  const expectedHealth = { modelId: 'm', revision: 'r', promptTemplateHash: B32('ab') };
  const verify = (job, active) => verifyScorerResult({ result: minimalResult, job, outstandingJobIds: new Set(['job-1']), active, expectedHealth });

  test('overlay-armed epoch refuses an unpinned job', () => {
    const v = verify(baseJob(), { ...baseActive, activeFrontierRoot: B32('5e') });
    assert.equal(v.ok, false);
    assert.equal(v.code, 'SCORER_STALE_CONTEXT');
    assert.match(v.reason, /activeFrontierRoot/);
  });
  test('overlay-armed epoch refuses a mismatched pin', () => {
    const v = verify(baseJob({ activeFrontierRoot: B32('99') }), { ...baseActive, activeFrontierRoot: B32('5e') });
    assert.equal(v.ok, false);
    assert.match(v.reason, /activeFrontierRoot/);
  });
  test('broad epoch refuses a job pinning a root', () => {
    const v = verify(baseJob({ activeFrontierRoot: B32('5e') }), baseActive);
    assert.equal(v.ok, false);
    assert.match(v.reason, /no live-eval overlay/);
  });
});

describe('dual-pack proof active-frontier echo', () => {
  const receipt = {
    epochId: 8, minerAddress: '0x' + '11'.repeat(20), parentRoot: B32('01'), patchHash: B32('02'),
    blockhash: B32('03'), receivedAtBlock: 1, targetBlock: 16,
    gateSeed: B32('04'), confirmSeed: B32('05'), gateScorePpm: 4000, confirmScorePpm: 3800,
    accepted: true,
  };
  const ctx = { corpusRoot: B32('cc'), coreVersionHash: B32('dd'), hiddenSeedCommit: B32('ee'), targetBlockOffset: 15 };

  test('broad-law proof carries NO activeFrontierRoot (bytes unchanged)', () => {
    const proof = dualPackProofFromPerPatchReceipt(receipt, ctx);
    assert.equal('activeFrontierRoot' in proof, false);
  });
  test('overlay-law proof echoes the root, lowercased', () => {
    const proof = dualPackProofFromPerPatchReceipt(receipt, { ...ctx, activeFrontierRoot: B32('5E').toUpperCase().replace('0X', '0x') });
    assert.equal(proof.activeFrontierRoot, B32('5e'));
  });
});
