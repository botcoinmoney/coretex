#!/usr/bin/env node
/**
 * BMU G-B10 blind-miner evidence runner.
 *
 * CPU-only/offline. It models a Tier-P miner that sees public family structure
 * and public supporting docs, but not hidden qrels, pack rows, seeds, or active
 * frontier ids. The candidate selector runs BEFORE gate/confirm derivation and
 * uses a fixed public rule: newest N public clusters per family.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import * as dist from '../packages/coretex/dist/index.js';
import {
  deriveEpochDualPacks,
  runTransitionBootstrap,
  SIM_PINS,
  worldCorpus,
} from './lib/bmu-sim/lifecycle-sim.mjs';

const FAMILIES = Object.freeze([
  'temporal',
  'conflict_lifecycle',
  'multi_hop_relation',
  'near_collision_abstention',
]);

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

function asInt(name, fallback) {
  const raw = arg(name, String(fallback));
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`--${name} must be a non-negative integer (got ${raw})`);
  return n;
}

function publicClusterProjection(cluster) {
  return {
    family: cluster.family,
    mintEpoch: cluster.mintEpoch,
    subjectEntityId: cluster.subjectEntityId,
    templateCount: cluster.templateIds.length,
    docCount: cluster.docIds.length,
  };
}

function selectNewestPublicClusters(world, clustersPerFamily) {
  const byFamily = {};
  for (const family of FAMILIES) {
    const candidates = [...world.clusters.values()]
      .filter((cluster) => cluster.family === family)
      .sort((a, b) => (
        (b.mintEpoch - a.mintEpoch)
        || String(a.subjectEntityId).localeCompare(String(b.subjectEntityId))
        || String(a.motifGroupId).localeCompare(String(b.motifGroupId))
      ));
    byFamily[family] = candidates.slice(0, clustersPerFamily);
  }
  return byFamily;
}

function scoreSolvedMotifs(dual, solvedMotifGroups) {
  const flipsIn = (pack) => pack.events.filter((event) => {
    const motif = event.bmuTask?.motifGroupId;
    return motif !== undefined && solvedMotifGroups.has(motif);
  }).length;
  const gateFlips = flipsIn(dual.gate);
  const confirmFlips = flipsIn(dual.confirm);
  const gatePpm = gateFlips * SIM_PINS.rowQuantumPpm;
  const confirmPpm = confirmFlips * SIM_PINS.rowQuantumPpm;
  return {
    gateFlips,
    confirmFlips,
    gatePpm,
    confirmPpm,
    accepted: Math.min(gatePpm, confirmPpm) >= SIM_PINS.acceptanceThresholdPpm,
  };
}

function scoreFamilySelections(dual, selections) {
  const perFamily = {};
  for (const family of FAMILIES) {
    const solved = new Set(selections[family].map((cluster) => cluster.motifGroupId));
    perFamily[family] = scoreSolvedMotifs(dual, solved);
  }
  return perFamily;
}

function scoreExactPublicDocMemorizer(dual, selections) {
  const publicDocIds = new Set();
  for (const clusters of Object.values(selections)) {
    for (const cluster of clusters) {
      for (const docId of cluster.docIds) publicDocIds.add(docId);
    }
  }
  const hitsIn = (pack) => pack.events.filter((event) => {
    const task = event.bmuTask;
    if (!task) return false;
    return [...task.requiredEvidence, ...task.forbiddenEvidence].some((docId) => publicDocIds.has(docId));
  }).length;
  return {
    publicDocIds: publicDocIds.size,
    gateRowsTouchingMemorizedDocs: hitsIn(dual.gate),
    confirmRowsTouchingMemorizedDocs: hitsIn(dual.confirm),
    score: scoreSolvedMotifs(dual, new Set()),
    note: 'Exact public doc memorization does not perform a BMU operation; it solves zero motif groups by construction.',
  };
}

const outDir = resolve(arg('out', '.ops/bmu-evidence/p5-blind-miner'));
const workDir = resolve(arg('work-dir', '.tmp/bmu-blind-miner-work'));
const simSeed = arg('seed', 'bmu-blind-miner-v1');
const armCount = asInt('arm-count', 430);
const marginClustersPerFamily = asInt('margin-clusters-per-family', 3);
const clustersPerFamily = asInt('clusters-per-family', 6);
const evalEpoch = asInt('eval-epoch', 153);

mkdirSync(outDir, { recursive: true });
mkdirSync(workDir, { recursive: true });

const bootstrap = runTransitionBootstrap({
  dist,
  workDir,
  simSeed,
  armCount,
  marginClustersPerFamily,
});
const world = bootstrap.world;

// The public selector is intentionally above pack derivation. It receives no
// gate/confirm rows, no seeds, and no active frontier ids.
const selected = selectNewestPublicClusters(world, clustersPerFamily);
const selectedPublicView = Object.fromEntries(
  Object.entries(selected).map(([family, clusters]) => [family, clusters.map(publicClusterProjection)]),
);

const activeIds = new Set(bootstrap.postState.active.map(([id]) => id));
const corpus = worldCorpus(world);
const dual = deriveEpochDualPacks(world, corpus, activeIds, evalEpoch);
const generalized = scoreFamilySelections(dual, selected);
const exactPublicDoc = scoreExactPublicDocMemorizer(dual, selected);

const acceptedFamilies = Object.entries(generalized)
  .filter(([, score]) => score.accepted)
  .map(([family]) => family);

const evidence = {
  schema: 'coretex.bmu.g-b10.blind-miner-sim.v1',
  generatedAt: new Date().toISOString(),
  runner: 'scripts/coretex-bmu-blind-miner-sim.mjs',
  pins: SIM_PINS,
  args: { outDir, workDir, simSeed, armCount, marginClustersPerFamily, clustersPerFamily, evalEpoch },
  selectorDiscipline: {
    tier: 'Tier-P public-only',
    selectedBeforePackDerivation: true,
    usesHiddenQrels: false,
    usesGateConfirmSeeds: false,
    usesActiveFrontierIds: false,
    usesOperatorHints: false,
    rule: 'For each BMU family, choose the newest N public clusters by mintEpoch, subjectEntityId, motifGroupId tiebreak.',
    publicProjectionFields: ['family', 'mintEpoch', 'subjectEntityId', 'templateCount', 'docCount'],
  },
  bootstrapVerdict: bootstrap.record.verdict,
  selectedPublicView,
  packs: {
    gateSize: dual.gate.events.length,
    confirmSize: dual.confirm.events.length,
    gateSeed: dual.gate.evalSeedHex,
    confirmSeed: dual.confirm.evalSeedHex,
    seedsWereUnavailableToSelector: true,
  },
  generalizedFamilyMiner: generalized,
  exactPublicDocMemorizer: exactPublicDoc,
  verdict: {
    blindMinerFamiliesAccepted: acceptedFamilies,
    blindMinerAtLeastTwoFamilies: acceptedFamilies.length >= 2,
    allGeneralizedFamiliesAccepted: acceptedFamilies.length === FAMILIES.length,
    exactPublicDocMemorizerRejected: exactPublicDoc.score.accepted === false
      && exactPublicDoc.score.gateFlips === 0
      && exactPublicDoc.score.confirmFlips === 0,
  },
};

const outPath = resolve(outDir, 'g-b10-blind-miner-sim.json');
writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify({
  outPath,
  verdict: evidence.verdict,
  generalizedFamilyMiner: evidence.generalizedFamilyMiner,
  exactPublicDocMemorizer: evidence.exactPublicDocMemorizer.score,
}, null, 2));
