#!/usr/bin/env node
/**
 * BMU P5 lifecycle evidence runner.
 *
 * CPU-only. Uses the built @botcoin/coretex dist plus the P5 simulation
 * support modules; no Qwen/GPU and no production mutation.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import * as dist from '../packages/coretex/dist/index.js';
import {
  runTransitionBootstrap,
  runLongHorizon,
  SIM_PINS,
} from './lib/bmu-sim/lifecycle-sim.mjs';
import {
  createFamilyConcentrationAlarm,
} from './lib/bmu-sim/family-concentration-alarm.mjs';

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

const outDir = resolve(arg('out', '.ops/bmu-evidence/p5-sim'));
const workDir = resolve(arg('work-dir', '.tmp/bmu-p5-sim-work'));
const simSeed = arg('seed', 'bmu-p5-sim-runner-v1');
const evolves = asInt('evolves', 48);
const marginClustersPerFamily = asInt('margin-clusters-per-family', 3);
const armCount = asInt('arm-count', 430);

mkdirSync(outDir, { recursive: true });
mkdirSync(workDir, { recursive: true });

const exact = runTransitionBootstrap({
  dist,
  workDir: resolve(workDir, 'exact-nmin'),
  simSeed: `${simSeed}:exact-nmin`,
  armCount: 380,
  marginClustersPerFamily: 1,
});
const exactHorizon = runLongHorizon({
  world: exact.world,
  postState: exact.postState,
  evolves: 4,
  minerSolvesPerEpoch: 0,
  minerAttemptsPerEpoch: 2,
  armEpoch: 152,
  headroomMode: 'evolve',
});

const margin = runTransitionBootstrap({
  dist,
  workDir: resolve(workDir, `margin-${marginClustersPerFamily}-arm-${armCount}`),
  simSeed: `${simSeed}:margin`,
  armCount,
  marginClustersPerFamily,
});
const horizon = runLongHorizon({
  world: margin.world,
  postState: margin.postState,
  evolves,
  minerSolvesPerEpoch: 0,
  minerAttemptsPerEpoch: 2,
  armEpoch: 152,
  headroomMode: 'evolve',
});

const miner = runLongHorizon({
  world: margin.world,
  postState: margin.postState,
  evolves: 2,
  minerSolvesPerEpoch: 1,
  minerAttemptsPerEpoch: 2,
  armEpoch: 152,
  headroomMode: 'every-epoch',
});

const alarmPositive = createFamilyConcentrationAlarm();
for (let i = 0; i < 8; i++) {
  alarmPositive.observePack({ temporal: 60, conflict_lifecycle: 10, multi_hop_relation: 10, near_collision_abstention: 10 }, `positive-${i}`);
}

const marginVerdict = {
  exactNminBootRefuses: exactHorizon.horizon.bootCensusRefusals > 0,
  marginBootstrapGreen: Object.values(margin.record.verdict).every(Boolean),
  lifecycleGreen:
    horizon.horizon.rootDeltaAlwaysWithinBudget === true
    && horizon.horizon.packsAlwaysDerived === true
    && horizon.horizon.headroomNonzeroEveryEpoch === true
    && horizon.horizon.familyCollapseEvents === 0
    && horizon.horizon.bootCensusRefusals === 0
    && horizon.horizon.bmuRowRetirements > 0
    && horizon.horizon.concentrationAlarm.alarmsFired === 0
    && horizon.horizon.m1FinalCensusViolations === 0,
  concentrationAlarmPositiveControl: alarmPositive.state().alarmsFired === 1,
  exactClusterMinerDoesNotCheatConfirm: miner.horizon.minerAttemptEpochs > 0 && miner.horizon.minerStateAdvances === 0,
  blindMinerG10: 'OPEN: requires public-only blind miner harness plus sampled real-Qwen evidence on >=2 families',
  realQwenSampling: 'OPEN: temporal/near_collision P2 real-lane gaps and blind-miner G-B10 remain unsampled here',
};

const evidence = {
  schema: 'coretex.bmu.p5.lifecycle-sim.v1',
  generatedAt: new Date().toISOString(),
  runner: 'scripts/coretex-bmu-p5-sim.mjs',
  pins: SIM_PINS,
  args: { outDir, workDir, simSeed, evolves, marginClustersPerFamily, armCount },
  verdict: marginVerdict,
  exactNmin: {
    bootstrapVerdict: exact.record.verdict,
    bootCensusRefusals: exactHorizon.horizon.bootCensusRefusals,
    firstBootRefusal: exactHorizon.failures.find((f) => f.kind === 'boot-census-refused') ?? null,
  },
  marginRun: {
    bootstrap: margin.record,
    horizon: horizon.horizon,
    failureCounts: Object.fromEntries([...new Set(horizon.failures.map((f) => f.kind))].map((k) => [k, horizon.failures.filter((f) => f.kind === k).length])),
    perEvolve: horizon.perEvolve,
    perEpochCompact: horizon.perEpochCompact,
  },
  minerControl: {
    horizon: miner.horizon,
    firstAdvances: miner.minerAdvances.slice(0, 16),
    failures: miner.failures,
    note: 'This is an exact-cluster miner control: it solves public-selected clusters and should not advance because gate/confirm are held out. It is not G-B10.',
  },
  concentrationAlarmPositive: alarmPositive.state(),
};

const outPath = resolve(outDir, 'p5-lifecycle-sim.json');
writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify({
  outPath,
  verdict: evidence.verdict,
  horizon: evidence.marginRun.horizon,
}, null, 2));
