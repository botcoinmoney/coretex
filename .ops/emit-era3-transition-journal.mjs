#!/usr/bin/env node
/**
 * §17.32 — emit the era-2 → era-3 transition journal in the canonical
 * BMU_ERA_TRANSITION_JOURNAL schema (P5_V2_SCHEMA superset). Deterministic CPU.
 * STOP-LINE: arms nothing, mutates no production state — pure sim + serialize.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as dist from '../packages/coretex/dist/index.js';
import { runEraTransition, crossEraTransferAudit } from '../scripts/lib/bmu-sim/era-transition-sim.mjs';
import { ERA_TRANSITION_JOURNAL_FIELDS } from '../scripts/lib/bmu-sim/era-schedule.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha = (t) => createHash('sha256').update(t).digest('hex');
const commit = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

const rotating = runEraTransition({ arm: 'rotating', dist, fromEra: 2, toEra: 3, evolves: 48 });
const staticCtl = runEraTransition({ arm: 'static', dist, fromEra: 2, toEra: 3, evolves: 48 });
const transfer = crossEraTransferAudit({ dist, fromEra: 2, toEra: 3 });

const artifact = {
  schema: 'coretex.bmu.era-transition-journal.v1',
  spec: 'specs/BMU_ERA_TRANSITION_JOURNAL.md',
  journalFields: ERA_TRANSITION_JOURNAL_FIELDS.perEvolve,
  createdAt: new Date().toISOString(),
  sourceCommit: commit,
  fromEra: 2,
  toEra: 3,
  transitionEpoch: rotating.transitionEpoch,
  transition: rotating.transition,
  pins: rotating.pins,
  rotating: {
    summary: rotating.summary,
    checks: rotating.checks,
    perEvolveJournal: rotating.perEvolveJournal,
    retirementEvents: rotating.retirementEvents,
  },
  staticControl: {
    summary: staticCtl.summary,
    checks: staticCtl.checks,
  },
  transferAudit: transfer,
  verdicts: {
    netPositiveAfterTransition: rotating.checks.netPositiveAfterTransition,
    sustainedNetAfterCapacity: rotating.checks.sustainedNetAfterCapacity,
    retirementCostless: rotating.summary.totalCostlyEvictions === 0,
    operationsAllCorrect: rotating.summary.operationsAllCorrect,
    staticNetRateCollapsesToZero: staticCtl.checks.staticNetRateCollapsesToZero,
    transferHonestBothDirections: transfer.honestBothDirections,
  },
};
artifact.overallGreen = Object.values(artifact.verdicts).every(Boolean);

const outDir = resolve(repo.replace('/coretex-bmu-v2-wire', '/botcoin-coordinator-bmu-v2-harness'), `.ops/bmu-evidence/era3-transition-journal-${commit.slice(0, 7)}`);
if (existsSync(outDir)) throw new Error(`refuses to overwrite ${outDir}`);
mkdirSync(outDir, { recursive: true });
const p = resolve(outDir, 'era2-to-era3-transition-journal.json');
writeFileSync(p, `${JSON.stringify(artifact, null, 1)}\n`);
writeFileSync(resolve(outDir, 'SHA256SUMS'), `${sha(readFileSync(p))}  era2-to-era3-transition-journal.json\n`);
console.log(JSON.stringify({ outDir, verdicts: artifact.verdicts, overallGreen: artifact.overallGreen, evolves: artifact.rotating.perEvolveJournal.length }, null, 2));
if (!artifact.overallGreen) process.exitCode = 1;
