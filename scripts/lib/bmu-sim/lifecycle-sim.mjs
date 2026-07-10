/**
 * BMU P5 lifecycle simulation engine (handoff §6 P5; gates G-B8/G-B9/G-B10
 * support; spec BMU_SPEC.md rev3.3 §6.2/§6.4/§6.7).
 *
 * CANONICAL-MACHINERY LAW (the non-negotiable): every lifecycle mechanism in
 * this sim is the production implementation, injected as the BUILT package
 * (`dist`) — never a re-implementation:
 *   - frontier: `makeEpochFrontier`/`stepEpoch` (A2 bounded aged drain +
 *     prune backfill; per-EVOLVE units, A1 forced cadence);
 *   - minting: the P2 family generators (scripts/lib/bmu-generators/*), one
 *     shared GLOBAL m=1 active-index + registry across all four families;
 *   - packs: `deriveBmuDualPacks` (§6.2 quota law + §6.4 seeded slot overlay
 *     + §6.3 held-out exclusion);
 *   - arm gate: `evaluateBmuArmGate` (§6.7b) + the REAL bulk-activate tool
 *     (`scripts/coretex-stagger-frontier-activation.mjs --mode bulk-activate`)
 *     shelled out over a loadProductionCorpus-valid corpus file;
 *   - judge: `bmuJudgeTopB`/`computeBmuTaskUtility` (oracle-accounting law in
 *     ./headroom-accounting.mjs).
 *
 * What IS simulated (and only this): epoch time, the A1 forced-evolve cadence
 * (the coordinator trigger is coordinator-side, G-A1-proven), miner behaviour
 * (a deterministic solved-cluster model consuming headroom), and oracle-level
 * utility accounting (see headroom-accounting.mjs honesty header).
 *
 * DETERMINISM: pure function of pinned seeds. No Date.now / Math.random
 * anywhere in sim logic (generators + frontier are sha/h12-seeded).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateTemporalClusters } from '../bmu-generators/temporal.mjs';
import { generateMultiHopClusters } from '../bmu-generators/multi_hop_relation.mjs';
import { generateConflictLifecycleClusters } from '../bmu-generators/conflict_lifecycle.mjs';
import { generateNearCollisionAbstentionClusters } from '../bmu-generators/near_collision_abstention.mjs';
import { assertBmuDocIdKeyHex, createBmuActiveIndex, createEntityHoldoutIdentityStore, createM1Registry, deriveBmuEpochDocIdKeyHex, makeCanonicalSplitOf, m1Census } from '../bmu-generators/common.mjs';
import { packHeadroom, BMU_SIM_BASE_STACK_FLOORS } from './headroom-accounting.mjs';
import { createFamilyConcentrationAlarm } from './family-concentration-alarm.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const STAGGER_TOOL_PATH = resolve(here, '../../coretex-stagger-frontier-activation.mjs');

// ─── Pinned sim laws (§6.2 v1 shape; A2/A1 lifecycle pins) ───────────────────
export const SIM_PINS = Object.freeze({
  corpusEpochPin: 136,           // ONE split-law pin for every lane (loader verifySplits)
  cadenceEpochs: 8,              // A1 forced-evolve cadence
  maxAge: 32,                    // §6.2 (finite REQUIRED under BMU)
  maxRootDeltaPerEpoch: 24,      // per-EVOLVE budget (A2 units)
  frontierMode: 'C3',            // live/A2 churn mode
  packSize: 64,
  quotas: [
    { stratum: 'family=temporal', minCount: 10 },
    { stratum: 'family=conflict_lifecycle', minCount: 15 },
    { stratum: 'family=multi_hop_relation', minCount: 15 },
    { stratum: 'family=near_collision', minCount: 10 },
  ],
  liveEvalLaw: {
    limit: 12,
    familyPriority: ['temporal_update', 'conflict_lifecycle', 'multi_session_bridge', 'abstention_missing'],
    familySlots: { temporal: 3, conflict_lifecycle: 3, multi_hop_relation: 3, near_collision_abstention: 3 },
    freshWindow: 2,
  },
  acceptanceThresholdPpm: 20_250, // §2.4 (20_000 + 250 + 0)
  rowQuantumPpm: 15_625,
  armVarianceMaxSpreadPpm: 7_811, // rev3.3 integer pin
  // §6.7c pre-flip mint ramp: totals sized on the E_f_min cluster minima
  // {16,22,22,16}; mints LAND at evolve steps (the only time the corpus delta
  // lands and the frontier steps) at a rate equivalent to ~24-25 rows/epoch.
  bootstrapClusters: { temporal: 16, conflict_lifecycle: 22, multi_hop_relation: 22, near_collision_abstention: 16 },
  // Executable-era cursor: alternating 6-cluster evolves give every family
  // exactly 72 mints = 36 adjacent-paired executable programs in 48 evolves.
  // Pack composition remains governed by the unchanged family quotas.
  steadyMintCycle: [
    { temporal: 2, conflict_lifecycle: 2, multi_hop_relation: 1, near_collision_abstention: 1 },
    { temporal: 1, conflict_lifecycle: 1, multi_hop_relation: 2, near_collision_abstention: 2 },
  ],
});

const BUCKETED = Object.freeze({
  temporal: 'temporal',
  conflict_lifecycle: 'conflict_lifecycle',
  multi_hop_relation: 'multi_hop_relation',
  near_collision_abstention: 'near_collision',
});

const FAMILIES = Object.freeze(['temporal', 'conflict_lifecycle', 'multi_hop_relation', 'near_collision_abstention']);

const sha = (s) => createHash('sha256').update(s).digest();
const TOOL_STDIO = Object.freeze(['ignore', 'pipe', 'pipe']);

/** Deterministic per-epoch pseudo eval seeds (stand-ins for the production
 *  epochSecret/blockhash/patchHash derivation — the sim has no chain). */
export function simSeedHex(simSeed, epoch, kind) {
  return `0x${sha(`bmu-p5-sim|${simSeed}|${epoch}|${kind}`).toString('hex')}`;
}

function dummyEmbedding(id, layout) {
  const bytes = sha(`bmu-p5-emb|${id}`).subarray(0, layout.dim);
  return new Uint8Array(bytes);
}

// ─── World construction ──────────────────────────────────────────────────────

function makeSubjectBank(prefix, personaName, svcName, n) {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}${i}`,
    canonicalName: i % 3 === 2 ? `${svcName}-svc-${i}` : `${personaName}${i}`,
  }));
}

export function buildWorld({ dist, simSeed = 'bmu-p5-sim-v1', bankSize = 240, docIdMasterKeyHex }) {
  assertBmuDocIdKeyHex(docIdMasterKeyHex);
  const splitOf = makeCanonicalSplitOf({
    splitForRecord: dist.splitForRecord,
    liveTailQueryId: dist.liveTailQueryId,
    corpusEpoch: SIM_PINS.corpusEpochPin,
  });
  const identityStore = createEntityHoldoutIdentityStore();
  const world = {
    dist,
    simSeed,
    splitOf,
    activeIndex: createBmuActiveIndex(identityStore),   // temporal + multihop m=1 mechanism
    registry: createM1Registry({}, identityStore),      // conflict + nearcol; alias authority shared globally
    banks: {
      temporal: makeSubjectBank('e_bmu_p5t_s', 'Persona Tarrow', 'helios', bankSize),
      multi_hop_relation: makeSubjectBank('e_bmu_p5m_s', 'Persona Quillon', 'meridian', bankSize),
      conflict_lifecycle: makeSubjectBank('e_bmu_p5c_s', 'Persona Halbrook', 'corevault', bankSize),
      near_collision_abstention: makeSubjectBank('e_bmu_p5n_s', 'Persona Vintral', 'lattice', bankSize),
    },
    universes: {
      temporal: 'user_scope_bmu_p5_temporal',
      multi_hop_relation: 'user_scope_bmu_p5_multihop',
    },
    ownerEntityId: 'e_universe',
    events: [],                 // production corpus events (query rows), append-only
    eventsById: new Map(),
    docsById: new Map(),        // public doc id -> doc (text universe for legs 3/4)
    clusters: new Map(),        // motifGroupId -> bookkeeping record
    familyOfId: new Map(),      // production row id -> logicalFamily (frontier interleave key)
    mintLog: [],
    // Monotone per-family class rotation. This is intentionally independent
    // of epoch arithmetic: A1 evolves jump by eight epochs and family mint
    // counts are irregular, so `(epoch*k+slot) mod bank` can alias forever.
    operationSequence: Object.fromEntries(FAMILIES.map((family) => [family, 0])),
  };
  // Keep the injected master available to future evolves without making an
  // accidental JSON serialization of the simulation world leak it.
  Object.defineProperty(world, 'docIdMasterKeyHex', { value: docIdMasterKeyHex, enumerable: false });
  return world;
}

export function resolveGeneratedOperationClass(cluster, rows) {
  const rowClasses = new Set(rows.map((row) => row.operationClass ?? row.operationFamily).filter(Boolean));
  if (rowClasses.size !== 1) {
    throw new Error(`BMU operation-class disagreement in ${cluster.motifGroupId}: rows expose ${JSON.stringify([...rowClasses])}`);
  }
  const rowOperationClass = [...rowClasses][0];
  const operationClass = cluster.operationClass ?? cluster.operationFamily ?? rowOperationClass;
  if (typeof operationClass !== 'string' || operationClass.length === 0 || operationClass !== rowOperationClass) {
    throw new Error(`BMU operation-class mismatch in ${cluster.motifGroupId}: cluster=${String(operationClass)} rows=${String(rowOperationClass)}`);
  }
  const rowBases = new Set(rows.map((row) => row.operationClassBasis).filter(Boolean));
  if ((cluster.operationClassBasis !== undefined || rowBases.size > 0)
      && (rowBases.size !== 1 || cluster.operationClassBasis !== [...rowBases][0])) {
    throw new Error(`BMU operation-class basis mismatch in ${cluster.motifGroupId}: cluster=${String(cluster.operationClassBasis)} rows=${JSON.stringify([...rowBases])}`);
  }
  return operationClass;
}

function rowToProductionEvent(world, row) {
  const t = row.bmuTask;
  const relOf = new Map((row.qrels ?? []).map((q) => [q.docId ?? q.documentId, q.relevance]));
  const negIds = new Set((row.hardNegatives ?? []).map((n) => n.docId ?? n.id));
  const truthDocuments = [];
  const hardNegatives = [];
  const seen = new Set();
  const docText = (id) => world.docsById.get(id)?.text ?? `doc ${id}`;
  const docCurrent = (id) => {
    const d = world.docsById.get(id);
    return d?.currentStaleFlag ? d.currentStaleFlag === 'current' : true;
  };
  for (const [docId, rel] of relOf) {
    if (seen.has(docId)) continue;
    seen.add(docId);
    if (rel >= 0.5) truthDocuments.push({ id: docId, text: docText(docId), isCurrent: docCurrent(docId) });
    else hardNegatives.push({ id: docId, text: docText(docId) });
  }
  for (const negId of negIds) {
    if (seen.has(negId)) continue;
    seen.add(negId);
    hardNegatives.push({ id: negId, text: docText(negId) });
  }
  const layout = { dim: 8, headerBytes: 9, quantization: 'int8' };
  const id = world.dist.liveTailQueryId(row.id, row.liveUpdateEpoch);
  return {
    id,
    family: BUCKETED[t.family],
    logicalFamily: row.family,
    ...(row.operationClass !== undefined ? { operationClass: row.operationClass } : {}),
    ...(row.operationFamily !== undefined ? { operationFamily: row.operationFamily } : {}),
    ...(row.operationClassBasis !== undefined ? { operationClassBasis: row.operationClassBasis } : {}),
    ...(row.operationLaw !== undefined ? { operationLaw: row.operationLaw } : {}),
    domain: 'bmu_p5_sim',
    split: 'eval_hidden',
    queryText: row.queryText,
    truthDocuments,
    hardNegatives,
    qrels: (row.qrels ?? []).map((q) => ({ documentId: q.docId ?? q.documentId, relevance: q.relevance })),
    protected: false,
    ownerEntityId: row.ownerEntityId,
    ...(row.ownerScoped !== undefined ? { ownerScoped: row.ownerScoped } : {}),
    subjectEntityId: row.subjectEntityId,
    ...(row.publicIntent !== undefined ? { publicIntent: row.publicIntent } : {}),
    ...(row.band !== undefined ? { band: row.band } : {}),
    bmuTask: t,
    ...(row.bmuOperationCue ? { bmuOperationCue: row.bmuOperationCue } : {}),
    ...(row.bmuOperationProgram ? { bmuOperationProgram: row.bmuOperationProgram } : {}),
    provenance: { source: 'synthetic_challenge', sourceHash: `0x${'00'.repeat(32)}` },
    embeddings: {
      modelId: 'bge-m3',
      revision: 'bmu-p5-sim-mechanics',
      layout,
      query: dummyEmbedding(id, layout),
      perTruth: new Map(truthDocuments.map((d) => [d.id, dummyEmbedding(d.id, layout)])),
      perNegative: new Map(hardNegatives.map((d) => [d.id, dummyEmbedding(d.id, layout)])),
    },
  };
}

/** Non-BMU live-tail remnant rows (the A2 post-retire-genesis active set). */
function makeLiveTailEvent(world, i, mintEpoch) {
  // salt-search a logical id whose live-tail production id is eval_hidden
  let logical = null;
  for (let probe = 0; probe < 512; probe++) {
    const cand = `q_p5_livetail_${i}_s${probe}`;
    if (world.splitOf(cand, mintEpoch) === 'eval_hidden') { logical = cand; break; }
  }
  if (!logical) throw new Error(`live-tail salt search exhausted for row ${i}`);
  const layout = { dim: 8, headerBytes: 9, quantization: 'int8' };
  const id = world.dist.liveTailQueryId(logical, mintEpoch);
  const docId = `d_p5_livetail_${i}_cur`;
  world.docsById.set(docId, { id: docId, text: `live tail record ${i}: value v${i} recorded.`, currentStaleFlag: 'current' });
  return {
    id,
    family: 'temporal',
    logicalFamily: 'temporal_update',
    domain: 'bmu_p5_sim',
    split: 'eval_hidden',
    queryText: `what is the recorded value for live tail item ${i}?`,
    truthDocuments: [{ id: docId, text: `live tail record ${i}: value v${i} recorded.`, isCurrent: true }],
    hardNegatives: [],
    qrels: [{ documentId: docId, relevance: 1 }],
    protected: false,
    provenance: { source: 'synthetic_challenge', sourceHash: `0x${'00'.repeat(32)}` },
    embeddings: {
      modelId: 'bge-m3', revision: 'bmu-p5-sim-mechanics', layout,
      query: dummyEmbedding(id, layout),
      perTruth: new Map([[docId, dummyEmbedding(docId, layout)]]),
      perNegative: new Map(),
    },
  };
}

/**
 * Mint one evolve's stamped clusters (all four families) into the world.
 * GLOBAL m=1 enforced at mint by the shared activeIndex/registry (fail-closed
 * in the generators); attribute/subject reuse WAITS for retirement (release
 * happens in `releaseRetiredClusters`). Returns minted production ids.
 */
export function mintEvolve(world, epoch, clusterCounts, { escalationLevel = 0 } = {}) {
  const minted = { rows: [], clusters: [], productionIds: [] };
  const docIdKeyHex = deriveBmuEpochDocIdKeyHex(world.docIdMasterKeyHex, epoch);
  const lanes = [
    ['temporal', () => generateTemporalClusters({
      epoch, seed: `${world.simSeed}:temporal`, docIdKeyHex, subjects: world.banks.temporal,
      universe: world.universes.temporal, clusterCount: clusterCounts.temporal,
      splitOf: world.splitOf, activeIndex: world.activeIndex,
      operationSequenceOffset: world.operationSequence.temporal,
    }), (out) => out.clusters.map((c) => ({ cluster: c, rows: c.rows, docs: c.docs, mechanism: 'index' }))],
    ['multi_hop_relation', () => {
      const count = clusterCounts.multi_hop_relation;
      const out = generateMultiHopClusters({
        epoch, seed: `${world.simSeed}:multihop`, docIdKeyHex, subjects: world.banks.multi_hop_relation,
        universe: world.universes.multi_hop_relation, clusterCount: count,
        splitOf: world.splitOf, activeIndex: world.activeIndex,
        operationClassSlotOffset: world.operationSequence.multi_hop_relation,
      });
      return out;
    }, (out) => out.clusters.map((c) => ({ cluster: c, rows: c.rows, docs: c.docs, mechanism: 'index' }))],
    ['conflict_lifecycle', () => generateConflictLifecycleClusters({
      epoch, seed: `${world.simSeed}:conflict`, docIdKeyHex, subjects: world.banks.conflict_lifecycle,
      registry: world.registry, splitOf: world.splitOf, clusterCount: clusterCounts.conflict_lifecycle,
      escalationLevel, ownerEntityId: world.ownerEntityId,
      operationSequenceOffset: world.operationSequence.conflict_lifecycle,
    }), (out) => out.clusters.map((c) => ({
      cluster: c,
      rows: out.addedQueries.filter((r) => r.bmuTask.motifGroupId === c.motifGroupId),
      docs: out.addedDocs.filter((d) => c.docIds.includes(d.id)),
      mechanism: 'registry',
    }))],
    ['near_collision_abstention', () => {
      const count = clusterCounts.near_collision_abstention;
      const out = generateNearCollisionAbstentionClusters({
        epoch, seed: `${world.simSeed}:nearcol`, docIdKeyHex, subjects: world.banks.near_collision_abstention,
        registry: world.registry, splitOf: world.splitOf, clusterCount: count,
        escalationLevel, ownerEntityId: world.ownerEntityId,
        operationClassSlotOffset: world.operationSequence.near_collision_abstention,
      });
      return out;
    }, (out) => out.clusters.map((c) => ({
      cluster: c,
      rows: out.addedQueries.filter((r) => r.bmuTask.motifGroupId === c.motifGroupId),
      docs: out.addedDocs.filter((d) => c.docIds.includes(d.id)),
      mechanism: 'registry',
    }))],
  ];
  for (const [family, generate, explode] of lanes) {
    if ((clusterCounts[family] ?? 0) < 1) continue;
    const out = generate();
    world.operationSequence[family] += clusterCounts[family];
    for (const { cluster, rows, docs, mechanism } of explode(out)) {
      const operationClass = resolveGeneratedOperationClass(cluster, rows);
      for (const d of docs) world.docsById.set(d.id, d);
      const rowProductionIds = [];
      for (const row of rows) {
        const ev = rowToProductionEvent(world, row);
        if (world.eventsById.has(ev.id)) throw new Error(`duplicate production id ${ev.id}`);
        world.events.push(ev);
        world.eventsById.set(ev.id, ev);
        world.familyOfId.set(ev.id, ev.logicalFamily);
        rowProductionIds.push(ev.id);
        minted.rows.push(ev);
        minted.productionIds.push(ev.id);
      }
      world.clusters.set(cluster.motifGroupId, {
        motifGroupId: cluster.motifGroupId,
        family,
        epoch: cluster.epoch,
        operationSequence: cluster.operationSequence,
        subjectEntityId: cluster.subjectEntityId,
        templateIds: [...(cluster.templateIds ?? [])],
        entityHoldoutKeys: [...(cluster.entityHoldoutKeys ?? cluster.rows?.[0]?.bmuTask?.entityHoldoutKeys ?? [])],
        operationClass,
        operationFamily: cluster.operationFamily ?? operationClass,
        operationClassBasis: cluster.operationClassBasis,
        operationLaw: cluster.operationLaw,
        bmuOperationCue: cluster.bmuOperationCue,
        bmuOperationProgram: cluster.bmuOperationProgram,
        mechanism,
        mintEpoch: epoch,
        rowProductionIds,
        docIds: docs.map((d) => d.id),
        released: false,
      });
      minted.clusters.push(cluster.motifGroupId);
    }
  }
  world.mintLog.push({ epoch, clusters: minted.clusters.length, rows: minted.rows.length, byFamily: { ...clusterCounts } });
  return minted;
}

/** Release m=1 claims for clusters whose EVERY row has retired from the
 *  frontier (attribute/subject reuse waits for retirement — spec §14.2). */
export function releaseRetiredClusters(world, retiredIdSet) {
  const released = [];
  for (const c of world.clusters.values()) {
    if (c.released) continue;
    if (!c.rowProductionIds.every((id) => retiredIdSet.has(id))) continue;
    if (c.mechanism === 'registry') {
      world.registry.releaseCluster({
        subjectEntityId: c.subjectEntityId,
        templateIds: c.templateIds,
        entityHoldoutKeys: c.entityHoldoutKeys,
        motifGroupId: c.motifGroupId,
      });
    } else {
      const idx = world.activeIndex;
      idx.clusters.delete(c.motifGroupId);
      if (idx.subjects.get(c.subjectEntityId) === c.motifGroupId) idx.subjects.delete(c.subjectEntityId);
      for (const t of c.templateIds) if (idx.templates.get(t) === c.motifGroupId) idx.templates.delete(t);
      for (const key of c.entityHoldoutKeys) {
        if (idx.identities.get(key) === c.motifGroupId) idx.identities.delete(key);
      }
    }
    c.released = true;
    released.push(c.motifGroupId);
  }
  return released;
}

/** In-memory corpus object (pack-law shape) over the current world events. */
export function worldCorpus(world) {
  return {
    events: world.events,
    byId: world.eventsById,
    corpusRoot: world.dist.computeCorpusRoot(world.events),
    corpusEpoch: SIM_PINS.corpusEpochPin,
    biEncoderModelId: 'bge-m3',
    biEncoderRevision: 'bmu-p5-sim-mechanics',
    biEncoderRetrievalKeyLayout: { dim: 8, headerBytes: 9, quantization: 'int8' },
    labelingModelId: 'offline',
    labelingModelRevision: 'p5',
  };
}

/** Write a loadProductionCorpus-VALID corpus file (the real bulk-activate tool
 *  loads with verifyCorpusRoot + verifySplits + §4.1 bmuTask validation). */
export function writeSimCorpusFile(world, path) {
  const corpus = worldCorpus(world);
  const file = world.dist.serializeProductionCorpus(corpus);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(file));
  return { path, corpusRoot: corpus.corpusRoot, events: world.events.length };
}

export function simProfile() {
  return { packSize: SIM_PINS.packSize, quotas: SIM_PINS.quotas };
}

export function deriveEpochDualPacks(world, corpus, activeIds, epoch) {
  return world.dist.deriveBmuDualPacks({
    epochId: epoch,
    gateSeedHex: simSeedHex(world.simSeed, epoch, 'gate'),
    confirmSeedHex: simSeedHex(world.simSeed, epoch, 'confirm'),
    corpus,
    profile: simProfile(),
    activeLiveEval: { activeIds, law: SIM_PINS.liveEvalLaw },
  });
}

// ─── The transition bootstrap leg (§6.7 sequence; G-B14(ii-b) rehearsal) ─────

/**
 * Runs: A2 post-retire-genesis state shape → pre-flip stamped mint ramp (two
 * A1 forced evolves) → §6.7b ARM census refusal below N_min (canonical fn AND
 * the real tool) → census OPEN at/above → REAL bulk-activate tool → BMU packs
 * derive → oracle-level §6.7b variance-seed schedule check.
 *
 * `armCount`: --count passed to the tool (380 = exact N_min; the long-horizon
 * caller may re-run with margin — the exact-380 slack question is a P5
 * finding surface, not a hidden default).
 */
export function runTransitionBootstrap({ dist, workDir, simSeed = 'bmu-p5-sim-v1', armCount = 380, genesisRetiredCount = 9300, liveTailCount = 19, marginClustersPerFamily = 1, docIdMasterKeyHex }) {
  mkdirSync(workDir, { recursive: true });
  const world = buildWorld({ dist, simSeed, docIdMasterKeyHex });
  const record = { leg: 'transition-bootstrap', simSeed, armCount, marginClustersPerFamily, steps: [], findings: [] };
  // MEASURED FINDING (P5, first exact-ramp run): the §6.7c ramp arithmetic
  // (ceil(380/25) epochs) counts generator THROUGHPUT only. Pre-flip C3 churn
  // consumes stamped rows: each ramp evolve activates ~churn stamped rows and
  // the NEXT evolve retires up to churn of them PERMANENTLY (oldest-first
  // after the live tail drains), so an exact-N_min ramp arms SHORT — measured
  // 375/380 (per-family 79/109/109/78) with the default 2-evolve ramp. The
  // ramp therefore MUST carry a churn-loss margin: ≥ ceil(maxChurn ×
  // (rampEvolves − 1) / k) clusters per family (default 1/family here).
  record.findings.push({
    id: 'ramp-churn-loss-margin-required',
    severity: 'runbook-required',
    detail: 'exact-N_min §6.7c mint ramp measured 375/380 stamped pool at arm (pre-flip C3 churn permanently retires stamped rows activated during the ramp); bootstrap mints a churn-loss margin of ≥1 cluster/family and the arming runbook must pin the same',
  });

  // A2 post-retire-genesis state shape: ~19 live-tail active + genesis retired.
  const genesisIds = Array.from({ length: genesisRetiredCount }, (_, i) => `q_p5_genesis_${String(i).padStart(5, '0')}`);
  const liveTail = Array.from({ length: liveTailCount }, (_, i) => makeLiveTailEvent(world, i, 130 + (i % 6)));
  for (const ev of liveTail) {
    world.events.push(ev);
    world.eventsById.set(ev.id, ev);
    world.familyOfId.set(ev.id, ev.logicalFamily);
  }
  const initialState = {
    schemaVersion: 'coretex.epoch-frontier-state.v1',
    order: [...genesisIds, ...liveTail.map((e) => e.id)],
    reservePtr: genesisRetiredCount + liveTailCount, // reserve EMPTY (A2 measured shape)
    active: liveTail.map((e, i) => [e.id, 130 + (i % 6)]),
    retired: genesisIds,
    cumulativeActivated: genesisRetiredCount + liveTailCount,
    cumulativeRetired: genesisRetiredCount,
    initialized: true,
    injectedSinceLastStep: 0,
    ewmaAccepts: null,
  };
  const familyOf = (id) => world.familyOfId.get(id) ?? 'unknown';
  const mkFrontier = (state) => dist.makeEpochFrontier({
    evalHiddenIds: [...state.order],
    familyOf,
    mode: SIM_PINS.frontierMode,
    maxAge: SIM_PINS.maxAge,
    maxRootDeltaPerEpoch: SIM_PINS.maxRootDeltaPerEpoch,
    seed: 'frontier',
    initialState: state,
  });
  let frontier = mkFrontier(initialState);
  record.steps.push({ step: 'initial-state', active: initialState.active.length, retired: genesisRetiredCount, reserve: 0 });

  // §6.7c mint ramp: totals {16,22,22,16} clusters; two A1 forced evolves.
  // Rate equivalence: 380 rows / 16 epochs = 23.75 ≈ the pinned ~24-25/epoch.
  const m = marginClustersPerFamily;
  const half1 = { temporal: 8, conflict_lifecycle: 11, multi_hop_relation: 11, near_collision_abstention: 8 };
  const half2 = { temporal: 8 + m, conflict_lifecycle: 11 + m, multi_hop_relation: 11 + m, near_collision_abstention: 8 + m };
  const evolve1Epoch = 144;
  const evolve2Epoch = 152;

  const m1 = mintEvolve(world, evolve1Epoch, half1);
  frontier.addReserveIds(m1.productionIds, familyOf);
  const snap1 = frontier.stepEpoch(evolve1Epoch, 0, 0); // dead pre-flip lane: zero accepts/attempts
  record.steps.push({ step: 'evolve-1-mint', epoch: evolve1Epoch, minted: m1.rows.length, activated: snap1.activated, retired: snap1.retired, activeSize: snap1.activeEvalHiddenCount });

  // Below-N_min census: canonical function AND the real tool must REFUSE.
  const stateAfter1 = frontier.exportState();
  const poolAfter1 = new Set([...stateAfter1.active.map(([id]) => id), ...stateAfter1.order.slice(stateAfter1.reservePtr)]);
  const corpusPath1 = resolve(workDir, 'sim-corpus-below-nmin.json');
  writeSimCorpusFile(world, corpusPath1);
  const censusBelow = dist.evaluateBmuArmGate({
    corpus: dist.loadProductionCorpus(corpusPath1),
    poolIds: poolAfter1,
    epochId: evolve1Epoch + 1,
    freshWindow: SIM_PINS.liveEvalLaw.freshWindow,
    posture: 'arm',
  });
  const statePath1 = resolve(workDir, 'frontier-state-below-nmin.json');
  writeFileSync(statePath1, JSON.stringify(stateAfter1));
  let toolRefusal = null;
  try {
    execFileSync('node', [STAGGER_TOOL_PATH, '--in', statePath1, '--out', resolve(workDir, 'frontier-state-below-nmin.out.json'),
      '--mode', 'bulk-activate', '--arm-epoch', String(evolve1Epoch + 1), '--count', String(armCount),
      '--corpus', corpusPath1, '--fresh-window', String(SIM_PINS.liveEvalLaw.freshWindow)], { encoding: 'utf8', stdio: TOOL_STDIO });
    toolRefusal = { refused: false };
  } catch (err) {
    toolRefusal = { refused: true, status: err.status, stderrHead: String(err.stderr ?? '').slice(0, 400) };
  }
  record.steps.push({
    step: 'arm-census-below-nmin',
    censusOk: censusBelow.ok,
    stampedPoolTotal: censusBelow.stampedPoolTotal,
    perFamily: censusBelow.perFamily,
    reasons: censusBelow.reasons,
    realToolRefused: toolRefusal,
  });

  // Second forced evolve completes the ramp.
  const m2 = mintEvolve(world, evolve2Epoch, half2);
  frontier.addReserveIds(m2.productionIds, familyOf);
  const snap2 = frontier.stepEpoch(evolve2Epoch, 0, 0);
  record.steps.push({ step: 'evolve-2-mint', epoch: evolve2Epoch, minted: m2.rows.length, activated: snap2.activated, retired: snap2.retired, activeSize: snap2.activeEvalHiddenCount });

  const stateAfter2 = frontier.exportState();
  const poolAfter2 = new Set([...stateAfter2.active.map(([id]) => id), ...stateAfter2.order.slice(stateAfter2.reservePtr)]);
  const corpusPath2 = resolve(workDir, 'sim-corpus-at-nmin.json');
  const corpusFile2 = writeSimCorpusFile(world, corpusPath2);
  const loaded2 = dist.loadProductionCorpus(corpusPath2);
  const censusOpen = dist.evaluateBmuArmGate({
    corpus: loaded2,
    poolIds: poolAfter2,
    epochId: evolve2Epoch,
    freshWindow: SIM_PINS.liveEvalLaw.freshWindow,
    posture: 'arm',
  });
  const stampedRetiredByChurn = stateAfter2.retired.filter((id) => world.eventsById.get(id)?.bmuTask !== undefined).length;
  record.steps.push({
    step: 'arm-census-at-nmin',
    stampedRetiredByPreFlipChurn: stampedRetiredByChurn,
    censusOk: censusOpen.ok,
    stampedPoolTotal: censusOpen.stampedPoolTotal,
    perFamily: censusOpen.perFamily,
    multiplicityViolations: censusOpen.multiplicityViolations.length,
    reasons: censusOpen.reasons,
  });

  // The REAL bulk-activation (G-B14(ii-b) rehearsal step).
  const statePath2 = resolve(workDir, 'frontier-state-at-nmin.json');
  writeFileSync(statePath2, JSON.stringify(stateAfter2));
  const outStatePath = resolve(workDir, 'frontier-state-post-bulk-activate.json');
  const toolStdout = execFileSync('node', [STAGGER_TOOL_PATH, '--in', statePath2, '--out', outStatePath,
    '--mode', 'bulk-activate', '--arm-epoch', String(evolve2Epoch), '--count', String(armCount),
    '--corpus', corpusPath2, '--fresh-window', String(SIM_PINS.liveEvalLaw.freshWindow)], { encoding: 'utf8', stdio: TOOL_STDIO });
  const postState = JSON.parse(readFileSync(outStatePath, 'utf8'));
  const meta = JSON.parse(readFileSync(`${outStatePath}.meta.json`, 'utf8'));

  // Precommitted-reserve-order assertion: the activated prefix must equal the
  // order[] walk from the pre-activation reservePtr.
  const walked = stateAfter2.order.slice(stateAfter2.reservePtr, postState.reservePtr);
  const preActive = new Set(stateAfter2.active.map(([id]) => id));
  const postActive = new Set(postState.active.map(([id]) => id));
  const activatedIds = postState.active.filter(([id]) => !preActive.has(id)).map(([id]) => id);
  const precommittedOrderHolds = JSON.stringify(walked.filter((id) => postActive.has(id))) === JSON.stringify(activatedIds);
  const newRoot = dist.activeFrontierRootOf(postState.active.map(([id]) => id));
  const stampedActive = postState.active.filter(([id]) => world.eventsById.get(id)?.bmuTask !== undefined).length;
  record.steps.push({
    step: 'bulk-activate',
    tool: 'coretex-stagger-frontier-activation.mjs --mode bulk-activate',
    toolSummary: meta.summary ?? meta,
    stdoutHead: toolStdout.slice(0, 400),
    activated: activatedIds.length,
    stampedActiveAfter: stampedActive,
    precommittedOrderHolds,
    oldRoot: dist.activeFrontierRootOf(stateAfter2.active.map(([id]) => id)),
    newActiveFrontierRoot: newRoot,
    corpusRoot: corpusFile2.corpusRoot,
  });

  // BMU packs must now derive (the §6.7 point: before activation they cannot).
  const corpus = worldCorpus(world);
  const activeIds = new Set(postState.active.map(([id]) => id));
  const dual = deriveEpochDualPacks(world, corpus, activeIds, evolve2Epoch);
  const quota = (pack) => dist.packQuotaCoverage(pack, simProfile()).map((q) => ({ stratum: q.stratum, count: q.count, satisfied: q.satisfied }));
  const heldOutViolations = dual.confirm.events.filter((e) => dist.bmuEventExcluded(e, dual.exclusionKeys)).length;
  record.steps.push({
    step: 'bmu-packs-derive',
    gateSize: dual.gate.events.length,
    confirmSize: dual.confirm.events.length,
    gateQuotas: quota(dual.gate),
    confirmQuotas: quota(dual.confirm),
    exclusionKeys: dual.exclusionKeys.size,
    heldOutViolations,
  });

  // §6.7b variance-seed schedule at the ORACLE-ACCOUNTING level (label: this
  // exercises the pinned seed schedule + pack rotation derivability + the
  // spread criterion arithmetic — NOT a scoreState run; G-B14(iii) proper is
  // the P7 rehearsal).
  const judge = { bmuJudgeTopB: dist.bmuJudgeTopB, computeBmuTaskUtility: dist.computeBmuTaskUtility };
  const variance = {};
  for (const label of ['parent', 'blank']) {
    const scores = [];
    const seeds = [];
    for (let i = 0; i < 5; i++) {
      const seedHex = dist.bmuArmVarianceSeedHex(evolve2Epoch, label, i);
      seeds.push(seedHex);
      const pack = dist.deriveScoredQueryPack(evolve2Epoch, seedHex, corpus, simProfile(), { activeIds, law: SIM_PINS.liveEvalLaw }, {});
      // parent at the transition = pre-BMU substrate: realizes the base-stack
      // floor (0 solved clusters); blank likewise — both spreads are the
      // pack-rotation stability of that floor under the quantized law.
      const h = packHeadroom({ pack, solvedMotifGroups: new Set(), judge });
      scores.push(Math.round(h.realizedPpm));
    }
    const spread = Math.max(...scores) - Math.min(...scores);
    variance[label] = { seeds, scoresPpm: scores, spreadPpm: spread, pass: spread <= SIM_PINS.armVarianceMaxSpreadPpm };
  }
  record.steps.push({ step: 'variance-seed-schedule-oracle-level', ...variance });

  record.verdict = {
    censusRefusedBelowNmin: censusBelow.ok === false && toolRefusal.refused === true,
    censusOpenAtNmin: censusOpen.ok === true,
    bulkActivateSucceeded: stampedActive >= armCount && precommittedOrderHolds,
    packsDerive: dual.gate.events.length === SIM_PINS.packSize && dual.confirm.events.length === SIM_PINS.packSize && heldOutViolations === 0,
    varianceSchedulePass: variance.parent.pass && variance.blank.pass,
  };
  record.postArm = { statePath: outStatePath, corpusPath: corpusPath2, newActiveFrontierRoot: newRoot };
  return { world, postState, record };
}

// ─── The long-horizon leg (G-B9 mechanics; G-B8 alarm feed) ──────────────────

/**
 * `evolves` synthetic EVOLVES at cadence 8 from the post-bulk-activation
 * state: auto-evolve minting (steady §2.3-ratio cycle), A2 retirement
 * (maxAge + C3 churn through the REAL stepEpoch), per-evolve rebaseline
 * bookkeeping (oracle-utility accounting), a deterministic miner model
 * consuming headroom, per-epoch dual-pack derivation + headroom + the G-B8
 * continuous alarm.
 */
export function runLongHorizon({ world, postState, evolves = 48, minerSolvesPerEpoch = 1, minerAttemptsPerEpoch = 2, armEpoch = 152, headroomMode = 'every-epoch' }) {
  if (!['every-epoch', 'evolve'].includes(headroomMode)) throw new Error(`runLongHorizon: headroomMode must be 'every-epoch' or 'evolve' (got ${String(headroomMode)})`);
  if (headroomMode !== 'every-epoch' && minerSolvesPerEpoch !== 0) {
    throw new Error('runLongHorizon: sampled headroom modes require minerSolvesPerEpoch=0 because accept accounting needs every epoch pack telemetry');
  }
  const dist = world.dist;
  const familyOf = (id) => world.familyOfId.get(id) ?? 'unknown';
  const frontier = dist.makeEpochFrontier({
    evalHiddenIds: [...postState.order],
    familyOf,
    mode: SIM_PINS.frontierMode,
    maxAge: SIM_PINS.maxAge,
    maxRootDeltaPerEpoch: SIM_PINS.maxRootDeltaPerEpoch,
    seed: 'frontier',
    initialState: postState,
  });
  const judge = { bmuJudgeTopB: dist.bmuJudgeTopB, computeBmuTaskUtility: dist.computeBmuTaskUtility };
  const oracleCache = new Map();
  const alarm = createFamilyConcentrationAlarm();
  const solved = new Set();          // motifGroupIds the miner has SOLVED (real operation performed)
  const activationEpochOf = new Map(postState.active);

  const report = {
    leg: 'long-horizon',
    pins: { evolves, cadenceEpochs: SIM_PINS.cadenceEpochs, maxAge: SIM_PINS.maxAge, maxRootDeltaPerEpoch: SIM_PINS.maxRootDeltaPerEpoch, minerSolvesPerEpoch, minerAttemptsPerEpoch, headroomMode, floors: BMU_SIM_BASE_STACK_FLOORS },
    perEvolve: [],
    perEpochCompact: [],
    failures: [],
    minerAdvances: [],
  };

  let activeIds = new Set(postState.active.map(([id]) => id));
  let corpus = worldCorpus(world);
  let acceptsSinceEvolve = 0;
  let attemptsSinceEvolve = 0;
  let evolveIndex = 0;
  const retirementAges = [];
  let retiredSet = new Set(postState.retired);

  const activeClustersOf = () => {
    const per = new Map();
    for (const c of world.clusters.values()) {
      const activeRows = c.rowProductionIds.filter((id) => activeIds.has(id)).length;
      if (activeRows > 0) per.set(c.motifGroupId, { ...c, activeRows });
    }
    return per;
  };

  const finalEpoch = armEpoch + evolves * SIM_PINS.cadenceEpochs;
  for (let epoch = armEpoch + 1; epoch <= finalEpoch; epoch++) {
    const isEvolveEpoch = (epoch - armEpoch) % SIM_PINS.cadenceEpochs === 0;
    if (isEvolveEpoch) {
      evolveIndex += 1;
      const counts = SIM_PINS.steadyMintCycle[(evolveIndex - 1) % SIM_PINS.steadyMintCycle.length];
      const minted = mintEvolve(world, epoch, counts, { escalationLevel: (evolveIndex - 1) % 3 });
      frontier.addReserveIds(minted.productionIds, familyOf);
      const preState = frontier.exportState();
      const preActive = new Map(preState.active);
      const snap = frontier.stepEpoch(epoch, acceptsSinceEvolve, attemptsSinceEvolve);
      const post = frontier.exportState();
      // retirement ages (epochs from activation to this evolve)
      const postActiveSet = new Set(post.active.map(([id]) => id));
      let agedOut = 0;
      const newlyRetired = [];
      for (const [id, ae] of preActive) {
        if (!postActiveSet.has(id)) {
          newlyRetired.push(id);
          retirementAges.push({ epoch, id, age: epoch - ae, bmu: world.eventsById.get(id)?.bmuTask !== undefined });
          if (epoch - ae >= SIM_PINS.maxAge) agedOut += 1;
        }
      }
      for (const [id, ae] of post.active) if (!preActive.has(id)) activationEpochOf.set(id, ae);
      retiredSet = new Set(post.retired);
      const releasedM1 = releaseRetiredClusters(world, retiredSet);
      activeIds = postActiveSet;
      corpus = worldCorpus(world);
      const rootDeltaOk = Math.max(snap.activated, snap.retired) <= SIM_PINS.maxRootDeltaPerEpoch;
      // per-family ACTIVE stamped counts + boot-posture census (the P3-R1
      // liveness law: the production evaluator re-runs the STRUCTURAL census
      // at every construction — if this dips below minima the live lane
      // refuses to boot).
      const bootCensus = dist.evaluateBmuArmGate({ corpus, poolIds: activeIds, epochId: epoch, posture: 'boot' });
      // per-evolve rebaseline bookkeeping: §6.7b seed schedule over the
      // CURRENT parent (solved set) — oracle-utility accounting.
      const baselineScores = [];
      for (let i = 0; i < 5; i++) {
        const seedHex = dist.bmuArmVarianceSeedHex(epoch, 'parent', i);
        const pack = dist.deriveScoredQueryPack(epoch, seedHex, corpus, simProfile(), { activeIds, law: SIM_PINS.liveEvalLaw }, {});
        baselineScores.push(Math.round(packHeadroom({ pack, solvedMotifGroups: solved, judge, oracleCache }).realizedPpm));
      }
      const baselineSpread = Math.max(...baselineScores) - Math.min(...baselineScores);
      report.perEvolve.push({
        evolve: evolveIndex,
        epoch,
        mintedClusters: Object.values(counts).reduce((a, b) => a + b, 0),
        mintedRows: minted.rows.length,
        activated: snap.activated,
        retired: snap.retired,
        agedOut,
        churned: snap.retired - agedOut,
        rootDeltaOk,
        activeSize: snap.activeEvalHiddenCount,
        reserveRemaining: snap.reserveRemaining,
        activeRoot: snap.activeRoot,
        releasedM1Clusters: releasedM1.length,
        bootCensusOk: bootCensus.ok,
        bootCensusPerFamily: Object.fromEntries(Object.entries(bootCensus.perFamily).map(([f, r]) => [f, r.stampedRows])),
        bootCensusReasons: bootCensus.reasons,
        rebaseline: { scoresPpm: baselineScores, spreadPpm: baselineSpread },
        m1CensusViolations: m1Census(world.activeIndex).length,
        acceptsSinceLastEvolve: acceptsSinceEvolve,
      });
      if (!rootDeltaOk) report.failures.push({ epoch, kind: 'root-delta-exceeded', activated: snap.activated, retired: snap.retired });
      if (!bootCensus.ok) report.failures.push({ epoch, kind: 'boot-census-refused', reasons: bootCensus.reasons });
      acceptsSinceEvolve = 0;
      attemptsSinceEvolve = 0;
    }

    // ── per-epoch: packs, miner, headroom, alarm ──
    const observeHeadroom = headroomMode === 'every-epoch' || isEvolveEpoch;
    if (!observeHeadroom) continue;

    let dual;
    try {
      dual = deriveEpochDualPacks(world, corpus, activeIds, epoch);
    } catch (err) {
      report.failures.push({ epoch, kind: 'pack-derivation-refused', message: String(err.message).slice(0, 300) });
      report.perEpochCompact.push({ epoch, packOk: false });
      continue;
    }

    // Miner: attempts quality patches every epoch; solves the NEWEST unsolved
    // active clusters (headroom-chasing = the adversarial direction for the
    // "headroom stays nonzero" claim), rotating families by epoch.
    attemptsSinceEvolve += minerAttemptsPerEpoch;
    const activeClusters = activeClustersOf();
    const newlySolved = [];
    for (let s = 0; s < minerSolvesPerEpoch; s++) {
      const famOrder = [...FAMILIES.slice((epoch + s) % 4), ...FAMILIES.slice(0, (epoch + s) % 4)];
      let pick = null;
      for (const fam of famOrder) {
        const candidates = [...activeClusters.values()]
          .filter((c) => c.family === fam && !solved.has(c.motifGroupId))
          .sort((a, b) => (b.mintEpoch - a.mintEpoch) || (a.motifGroupId < b.motifGroupId ? -1 : 1));
        if (candidates.length > 0) { pick = candidates[0]; break; }
      }
      if (pick) { solved.add(pick.motifGroupId); newlySolved.push(pick.motifGroupId); }
    }
    // Accept accounting on THIS epoch's dual packs: flips = newly-solved rows
    // present per pack; state advance iff min(gate,confirm) ≥ threshold (§2.4).
    if (newlySolved.length > 0) {
      const flipsIn = (pack) => pack.events.filter((e) => e.bmuTask && newlySolved.includes(e.bmuTask.motifGroupId)).length;
      const gateFlips = flipsIn(dual.gate);
      const confirmFlips = flipsIn(dual.confirm);
      const gatePpm = gateFlips * SIM_PINS.rowQuantumPpm;
      const confirmPpm = confirmFlips * SIM_PINS.rowQuantumPpm;
      const advanced = Math.min(gatePpm, confirmPpm) >= SIM_PINS.acceptanceThresholdPpm;
      if (advanced) acceptsSinceEvolve += 1;
      report.minerAdvances.push({ epoch, solved: newlySolved, gateFlips, confirmFlips, gatePpm, confirmPpm, advanced });
    }

    const gateH = packHeadroom({ pack: dual.gate, solvedMotifGroups: solved, judge, oracleCache });
    const confirmH = packHeadroom({ pack: dual.confirm, solvedMotifGroups: solved, judge, oracleCache });
    const gateAlarm = alarm.observePack(Object.fromEntries(FAMILIES.map((f) => [f, gateH.perFamily[f].achievable])), `e${epoch}-gate`);
    const confirmAlarm = alarm.observePack(Object.fromEntries(FAMILIES.map((f) => [f, confirmH.perFamily[f].achievable])), `e${epoch}-confirm`);

    // Pool-level solo-achievable-lift per family (unsolved achievable active rows).
    const poolLift = Object.fromEntries(FAMILIES.map((f) => [f, 0]));
    for (const c of activeClusters.values()) {
      if (!solved.has(c.motifGroupId)) poolLift[c.family] += c.activeRows;
    }

    const headroomPpm = gateH.headroomPpm + confirmH.headroomPpm;
    if (!(headroomPpm > 0)) report.failures.push({ epoch, kind: 'headroom-zero', gate: gateH.headroomPpm, confirm: confirmH.headroomPpm });
    for (const f of FAMILIES) {
      if (poolLift[f] === 0) report.failures.push({ epoch, kind: 'family-collapse-pool', family: f });
    }
    report.perEpochCompact.push({
      epoch,
      packOk: true,
      gateHeadroomRows: gateH.totals.headroomRows,
      confirmHeadroomRows: confirmH.totals.headroomRows,
      gateRealizedRows: gateH.totals.realized,
      confirmRealizedRows: confirmH.totals.realized,
      gateFamilyRows: Object.fromEntries(FAMILIES.map((f) => [f, gateH.perFamily[f].rows])),
      gateMaxShare: gateAlarm.share,
      confirmMaxShare: confirmAlarm.share,
      alarmStreak: alarm.state().currentStreak,
      poolLift,
      solvedClusters: solved.size,
      oracleFailures: gateH.oracleFailures.length + confirmH.oracleFailures.length,
    });
  }

  // Horizon verdict (the G-B9 assertions + G-B8 healthy-run check).
  //
  // Important P5 finding: BMU's arm-time active pool is much larger than the
  // A2 live-tail pool. With maxRootDelta=24, retirement is budget-limited by
  // active pool size even after maxAge starts marking rows eligible. Therefore
  // maxAge+cadence is telemetry here, not a green gate. The actual P5 lifecycle
  // gate is nonzero retirement + bounded root delta + no boot-census refusal +
  // nonzero headroom/no family collapse.
  const bmuRetirements = retirementAges.filter((r) => r.bmu);
  const steadyStart = armEpoch + Math.ceil((SIM_PINS.maxAge + Math.ceil(380 / SIM_PINS.maxRootDeltaPerEpoch) * SIM_PINS.cadenceEpochs) / SIM_PINS.cadenceEpochs) * SIM_PINS.cadenceEpochs;
  const steadyAges = bmuRetirements.filter((r) => r.epoch > steadyStart).map((r) => r.age);
  const ageBound = SIM_PINS.maxAge + SIM_PINS.cadenceEpochs - 1;
  report.horizon = {
    epochsSimulated: finalEpoch - armEpoch,
    evolves: evolveIndex,
    hiddenRowRetirementsTotal: retirementAges.length,
    bmuRowRetirements: bmuRetirements.length,
    maxRetirementAgeOverall: Math.max(0, ...retirementAges.map((r) => r.age)),
    bootstrapCohortDrain: {
      note: 'the arm cohort shares one activationEpoch; its bounded drain tail exceeds the steady-state age bound by design — reported, steady-state asserted separately',
      steadyStateFromEpoch: steadyStart,
      maxAgePreSteady: Math.max(0, ...bmuRetirements.filter((r) => r.epoch <= steadyStart).map((r) => r.age)),
    },
    steadyState: {
      retirements: steadyAges.length,
      maxRetirementAge: steadyAges.length > 0 ? Math.max(...steadyAges) : null,
      ageBound,
      agesBounded: steadyAges.length > 0 && Math.max(...steadyAges) <= ageBound,
      gateRequired: false,
    },
    retirementBudgetFinding: {
      activePoolSize: activeIds.size,
      rootDeltaBudgetPerEvolve: SIM_PINS.maxRootDeltaPerEpoch,
      cadenceEpochs: SIM_PINS.cadenceEpochs,
      note: 'BMU N_min/arm-margin active pools are budget-drained; maxAge+cadence is not an enforceable row-latency bound unless rootDelta is raised or active pool size drops.',
    },
    rootDeltaAlwaysWithinBudget: report.perEvolve.every((e) => e.rootDeltaOk),
    packsAlwaysDerived: report.perEpochCompact.every((e) => e.packOk),
    headroomNonzeroEveryEpoch: !report.failures.some((f) => f.kind === 'headroom-zero'),
    familyCollapseEvents: report.failures.filter((f) => f.kind === 'family-collapse-pool').length,
    bootCensusRefusals: report.failures.filter((f) => f.kind === 'boot-census-refused').length,
    concentrationAlarm: alarm.state(),
    minerStateAdvances: report.minerAdvances.filter((a) => a.advanced).length,
    minerAttemptEpochs: report.minerAdvances.length,
    solvedClustersAtHorizon: solved.size,
    m1FinalCensusViolations: m1Census(world.activeIndex).length,
    oracleCacheEntries: oracleCache.size,
  };
  return report;
}
