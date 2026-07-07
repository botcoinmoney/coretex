/**
 * P3-R1 BLOCKER-1 — boot ARM-GATE liveness through the REAL production
 * evaluator constructor: a BMU bundle whose stamped active pool has its
 * NEWEST MINT OLDER THAN freshWindow (post-arm steady state — mints happen
 * only at real evolves) MUST construct (boot census is STRUCTURAL only),
 * while a pool below the per-family minima MUST refuse. Also exercises the
 * bulk-activate tool's executable ARM census (MINOR: corpus-derived stamping
 * + --stamped-ids cross-check + ARM-posture refusal on stale cohorts).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_PROFILE,
  buildBundleManifest,
  bgeM3DenseManifest,
  qwen3Reranker06BManifest,
  memRerankerManifest,
  createProductionCoreTexEvaluator,
  createInMemoryDedupStore,
  serializeProductionCorpus,
  computeCorpusRoot,
  expectedSplitForRecord,
  activeFrontierRootOf,
  buildActiveFrontierIdsArtifact,
} from '../../dist/index.js';

const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url));
const B32 = (b) => '0x' + b.repeat(32);
const LAYOUT = { dim: 8, quantization: 'int8', headerBytes: 9 };
const PIN = { modelId: 'Qwen/Qwen3-Reranker-0.6B', revision: 'e61197ed45024b0ed8a2d74b80b4d909f1255473' };

const FAMS = [
  { bmu: 'temporal', bucketed: 'temporal', logical: 'temporal_update', min: 80 },
  { bmu: 'conflict_lifecycle', bucketed: 'conflict_lifecycle', logical: 'conflict_lifecycle', min: 110 },
  { bmu: 'multi_hop_relation', bucketed: 'multi_hop_relation', logical: 'multi_session_bridge', min: 110 },
  { bmu: 'near_collision_abstention', bucketed: 'near_collision', logical: 'abstention_missing', min: 80 },
];

/** Grind an id (zz_e-prefixed, MINT epoch embedded) until the deterministic
 *  split lands eval_hidden — the same obligation the real minter carries. */
function grindEvalHiddenId(fam, mintEpoch, i) {
  const base = `zz_e${String(mintEpoch).padStart(12, '0')}_q_${fam}_${i}`;
  for (let g = 0; g < 512; g++) {
    const id = `${base}_g${g}`;
    if (expectedSplitForRecord(id, 0) === 'eval_hidden') return id;
  }
  throw new Error(`grind failed for ${base}`);
}

function stampedEvent(fam, id) {
  const truthId = `${id}-t`;
  return {
    id,
    family: fam.bucketed,
    domain: 'companies',
    split: 'eval_hidden',
    queryText: `q ${id}`,
    truthDocuments: [{ id: truthId, text: `truth ${id}`, isCurrent: true }],
    hardNegatives: [],
    qrels: [{ documentId: truthId, relevance: 1 }],
    protected: false,
    logicalFamily: fam.logical,
    subjectEntityId: `ent-${id}`,
    bmuTask: {
      family: fam.bmu, budgetB: 3, requiredEvidence: [truthId], forbiddenEvidence: [],
      answer: { id: truthId }, motifGroupId: `mg-${id}`, templateId: `tt-${id}`,
    },
    provenance: { source: 'synthetic_challenge', sourceHash: '0x' + 'aa'.repeat(32) },
    embeddings: {
      modelId: 'BAAI/bge-m3', revision: 'a'.repeat(40), layout: LAYOUT,
      query: new Uint8Array(LAYOUT.dim + 4),
      perTruth: new Map([[truthId, new Uint8Array(LAYOUT.dim + 4)]]),
      perNegative: new Map(),
    },
  };
}

/** Stale-mint stamped corpus: every mint epoch is 100 — age 37 at boot epoch
 *  137 with freshWindow 2 (the post-arm steady state BLOCKER-1 protects). */
function makeStaleMintCorpus({ shortFamily } = {}) {
  const events = [];
  for (const fam of FAMS) {
    const n = shortFamily === fam.bmu ? fam.min - 1 : fam.min;
    for (let i = 0; i < n; i++) events.push(stampedEvent(fam, grindEvalHiddenId(fam.bmu, 100, i)));
  }
  return {
    events, byId: new Map(events.map((e) => [e.id, e])),
    corpusRoot: computeCorpusRoot(events), corpusEpoch: 0,
    biEncoderModelId: 'BAAI/bge-m3', biEncoderRevision: 'a'.repeat(40), biEncoderRetrievalKeyLayout: LAYOUT,
    labelingModelId: 'memreranker/4B', labelingModelRevision: 'b'.repeat(40),
  };
}

const BMU_PROFILE_FIELDS = {
  pipelineVersion: 'coretex-bmu-v1-r5state',
  hiddenPack: {
    packSize: 64,
    quotas: [
      { stratum: 'family=temporal', minCount: 10 },
      { stratum: 'family=conflict_lifecycle', minCount: 15 },
      { stratum: 'family=multi_hop_relation', minCount: 15 },
      { stratum: 'family=near_collision', minCount: 10 },
    ],
  },
  patchAcceptanceFloors: { ...DEFAULT_PROFILE.patchAcceptanceFloors, minImprovementPpm: 20_000 },
  baselineVarianceSource: 'unavailable',
  baselineParentScorePpm: 100_000,
  baselineSamples: 1,
  baselineEvalSeedHex: B32('a5'),
  enableEvidenceBundleAtoms: true,
  enableConflictLifecycleAtoms: true,
  policyConflictIntentAdmission: true,
  enableAbstentionAtoms: true,
  policyMaxBudgetEvidence: 300,
  policyMaxBudgetConflict: 300,
  epochFrontier: {
    mode: 'C3', activeWindow: 9639, seed: 'frontier-precommit',
    baselineRecompute: 'activeRootChanged', majorDeltaPolicy: 'corpusRootChanged',
    maxRootDeltaPerEpoch: 24, maxAge: 32,
    liveEvalPack: {
      limit: 12,
      familyPriority: ['temporal_update', 'conflict_lifecycle', 'multi_session_bridge', 'abstention_missing'],
      familySlots: { temporal: 3, conflict_lifecycle: 3, multi_hop_relation: 3, near_collision_abstention: 3 },
      freshWindow: 2,
    },
  },
};

function writeFixtures(corpus) {
  const dir = mkdtempSync(join(tmpdir(), 'coretex-bmu-liveness-'));
  const corpusPath = join(dir, 'corpus.json');
  const shape = serializeProductionCorpus(corpus);
  writeFileSync(corpusPath, JSON.stringify({ ...shape, corpusRoot: corpus.corpusRoot }));
  const manifest = buildBundleManifest({
    repoRoot,
    corpusRoot: corpus.corpusRoot,
    corpusFiles: [],
    biEncoder: bgeM3DenseManifest({ revision: '0123456789abcdef0123456789abcdef01234567', files: [{ path: 'model.safetensors', sha256: 'a'.repeat(64), bytes: 1 }] }),
    reranker: qwen3Reranker06BManifest({ revision: PIN.revision, files: [{ path: 'model.safetensors', sha256: 'b'.repeat(64), bytes: 1 }] }),
    labelingReranker: memRerankerManifest({ modelId: 'memreranker/4B', revision: 'cafebabedeadbeefcafebabedeadbeefcafebabe', files: [{ path: 'model.safetensors', sha256: 'c'.repeat(64), bytes: 1 }] }),
    evaluatorProfile: BMU_PROFILE_FIELDS,
  });
  const bundlePath = join(dir, 'bundle.json');
  writeFileSync(bundlePath, JSON.stringify(manifest));
  const activeIds = corpus.events.map((e) => e.id);
  const artifact = buildActiveFrontierIdsArtifact(137, activeIds);
  const idsPath = join(dir, 'active-ids.json');
  writeFileSync(idsPath, JSON.stringify(artifact));
  return { dir, corpusPath, bundlePath, idsPath, expectedRoot: artifact.activeFrontierRoot };
}

async function construct(corpus, optionsOver = {}) {
  const controlled = ['CORTEX_REAL_EVAL', 'CORETEX_RERANKER_PRODUCTION', 'CORETEX_RERANKER', 'CORETEX_BIENCODER'];
  const saved = new Map(controlled.map((k) => [k, process.env[k]]));
  process.env['CORTEX_REAL_EVAL'] = '1';
  process.env['CORETEX_RERANKER_PRODUCTION'] = '1';
  process.env['CORETEX_RERANKER'] = 'qwen3';
  // default 'pinned' bi-encoder: construction is lazy (nothing encodes at
  // boot), and the deterministic encoder refuses under production env.
  delete process.env['CORETEX_BIENCODER'];
  const fx = writeFixtures(corpus);
  try {
    return await createProductionCoreTexEvaluator({
      epochId: 137,
      epochSecret: B32('01'),
      corpusPath: fx.corpusPath,
      corpusRootLeafCachePath: false,
      bundleManifestPath: fx.bundlePath,
      parentStateLoader: () => { throw new Error('unused'); },
      dedupStore: createInMemoryDedupStore(),
      perMinerCap: 50,
      rpcClient: { getLatestBlockNumber: async () => 1, getBlockHash: async () => B32('ab'), waitForBlock: async () => ({ number: 1, blockhash: B32('ab'), timestamp: 0 }) },
      rerankerFactory: (plan) => ({ model: `${plan.modelId}@${plan.revision}`, async score(pairs) { return pairs.map(() => 0); } }),
      activeFrontier: { idsPath: fx.idsPath, expectedRoot: fx.expectedRoot },
      ...optionsOver,
    });
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe('BLOCKER-1: BMU evaluator boot census is STRUCTURAL — stale mints stay live', () => {
  test('constructs on a pool whose newest mint is far older than freshWindow (post-arm steady state)', async () => {
    const evaluator = await construct(makeStaleMintCorpus());
    assert.ok(evaluator.bootAttestation, 'evaluator did not construct');
    assert.equal(typeof evaluator.scoreState, 'function');
    await evaluator.close?.();
  });

  test('REFUSES construction when a family is below its structural minimum', async () => {
    await assert.rejects(
      construct(makeStaleMintCorpus({ shortFamily: 'conflict_lifecycle' })),
      /BMU boot census refused.*conflict_lifecycle.*109 < required 110/s,
    );
  });
});

describe('MINOR: bulk-activate executable ARM census (corpus-derived, cross-checked)', () => {
  const toolPath = join(repoRoot, 'scripts/coretex-stagger-frontier-activation.mjs');

  function frontierState(corpus, { activeCount = 4 } = {}) {
    const ids = corpus.events.map((e) => e.id);
    return {
      schemaVersion: 'coretex.epoch-frontier-state.v1',
      order: ids,
      reservePtr: activeCount,
      active: ids.slice(0, activeCount).map((id) => [id, 100]),
      retired: [],
      cumulativeActivated: activeCount,
      cumulativeRetired: 0,
      initialized: true,
      injectedSinceLastStep: 0,
      ewmaAccepts: null,
    };
  }

  function runTool(args) {
    try {
      const out = execFileSync('node', [toolPath, ...args], { encoding: 'utf8' });
      return { status: 0, out };
    } catch (e) {
      return { status: e.status, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
    }
  }

  test('ARM census runs BEFORE activation and refuses a stale-mint pool (fresh-cohort law binds at arm)', () => {
    const corpus = makeStaleMintCorpus();
    const dir = mkdtempSync(join(tmpdir(), 'coretex-bulk-activate-'));
    const corpusPath = join(dir, 'corpus.json');
    writeFileSync(corpusPath, JSON.stringify({ ...serializeProductionCorpus(corpus), corpusRoot: corpus.corpusRoot }));
    const statePath = join(dir, 'state.json');
    writeFileSync(statePath, JSON.stringify(frontierState(corpus)));
    const res = runTool(['--in', statePath, '--out', join(dir, 'out.json'), '--mode', 'bulk-activate', '--arm-epoch', '137', '--corpus', corpusPath, '--count', '380']);
    assert.notEqual(res.status, 0);
    assert.match(res.out, /ARM census REFUSED/);
    assert.match(res.out, /fresh clusters/);
  });

  test('fresh-mint pool passes the census, activates in reserve order, and cross-checks --stamped-ids', () => {
    // Fresh mints: epoch 137 == arm epoch → age 0 ≤ freshWindow.
    const events = [];
    for (const fam of FAMS) {
      for (let i = 0; i < fam.min; i++) events.push(stampedEvent(fam, grindEvalHiddenId(fam.bmu, 137, i)));
    }
    const corpus = {
      events, byId: new Map(events.map((e) => [e.id, e])),
      corpusRoot: computeCorpusRoot(events), corpusEpoch: 0,
      biEncoderModelId: 'BAAI/bge-m3', biEncoderRevision: 'a'.repeat(40), biEncoderRetrievalKeyLayout: LAYOUT,
      labelingModelId: 'memreranker/4B', labelingModelRevision: 'b'.repeat(40),
    };
    const dir = mkdtempSync(join(tmpdir(), 'coretex-bulk-activate-'));
    const corpusPath = join(dir, 'corpus.json');
    writeFileSync(corpusPath, JSON.stringify({ ...serializeProductionCorpus(corpus), corpusRoot: corpus.corpusRoot }));
    const statePath = join(dir, 'state.json');
    writeFileSync(statePath, JSON.stringify(frontierState(corpus)));
    const outPath = join(dir, 'out.json');

    // Diverging --stamped-ids is refused.
    const badIdsPath = join(dir, 'bad-ids.json');
    writeFileSync(badIdsPath, JSON.stringify([corpus.events[0].id, 'ghost-row']));
    const bad = runTool(['--in', statePath, '--out', outPath, '--mode', 'bulk-activate', '--arm-epoch', '137', '--corpus', corpusPath, '--count', '380', '--stamped-ids', badIdsPath]);
    assert.notEqual(bad.status, 0);
    assert.match(bad.out, /diverges from the corpus-derived stamped set/);

    // Honest run: census passes, ≥380 stamped rows end active, meta records census.
    const goodIdsPath = join(dir, 'good-ids.json');
    writeFileSync(goodIdsPath, JSON.stringify(corpus.events.map((e) => e.id)));
    const good = runTool(['--in', statePath, '--out', outPath, '--mode', 'bulk-activate', '--arm-epoch', '137', '--corpus', corpusPath, '--count', '380', '--stamped-ids', goodIdsPath]);
    assert.equal(good.status, 0, good.out);
    const next = JSON.parse(readFileSync(outPath, 'utf8'));
    const activeIds = new Set(next.active.map(([id]) => id));
    const stampedActive = corpus.events.filter((e) => activeIds.has(e.id)).length;
    assert.ok(stampedActive >= 380, `stamped active ${stampedActive} < 380`);
    // precommitted reserve order: the walked prefix is contiguous
    assert.equal(next.reservePtr, 380);
    const meta = JSON.parse(readFileSync(`${outPath}.meta.json`, 'utf8'));
    assert.equal(meta.summary.armCensus.ok, true);
    assert.equal(meta.summary.armCensus.posture, 'arm');
    assert.equal(meta.newActiveFrontierRoot, activeFrontierRootOf([...activeIds]));
  });
});
