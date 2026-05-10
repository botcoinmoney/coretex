#!/usr/bin/env node
/**
 * Estimate launch corpus capacity without running embedding or reranker
 * inference. This is intentionally fast enough for a coordinator/orchestrator
 * preflight and uses the same challenge-library expansion axes as
 * generate-coretex-retrieval-corpus.mjs.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { argv, exit, env } from 'node:process';
import { createHash } from 'node:crypto';

function flag(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  return fallback;
}

const challengeLibRoot = resolve(flag(
  'challenge-lib-root',
  env.CORETEX_CHALLENGE_LIB_ROOT ?? '/root/botcoin-coordinator-live/packages/challenges',
));
const domains = flag('domains', 'companies,quantum_physics,computational_biology,scrna_imputation')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const seedsPerDomain = Number(flag('seeds-per-domain', '512'));
const seedOffset = Number(flag('seed-offset', '0'));
const corpusEpoch = Number(flag('corpus-epoch', '0'));
const modifierCounts = flag('modifier-counts', '0,1,2,3')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isInteger(n) && n >= 0);
const constraintDifficulties = flag('constraint-difficulties', 'easy,medium,hard')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const trapCount = Math.max(0, Math.min(2, Number(flag('trap-count', '2'))));
const evalHiddenPct = Number(flag('eval-hidden-pct', '15'));
const packSize = Number(flag('pack-size', '128'));
const epochsPerDay = Number(flag('epochs-per-day', '1'));
const minMonths = Number(flag('min-months', '6'));
const outPath = flag('out');

if (!Number.isFinite(seedsPerDomain) || seedsPerDomain <= 0) {
  console.error('estimate-coretex-corpus-capacity: --seeds-per-domain must be positive');
  exit(1);
}
if (!Number.isFinite(packSize) || packSize <= 0) {
  console.error('estimate-coretex-corpus-capacity: --pack-size must be positive');
  exit(1);
}

const challengeIndex = resolve(challengeLibRoot, 'dist/index.js');
if (!existsSync(challengeIndex)) {
  console.error(`estimate-coretex-corpus-capacity: missing built challenge package at ${challengeIndex}`);
  exit(2);
}

const challengeLib = await import(pathToFileURL(challengeIndex).href);
if (typeof challengeLib.generateInterchangeableChallenge !== 'function') {
  console.error(`estimate-coretex-corpus-capacity: ${challengeIndex} does not export generateInterchangeableChallenge`);
  exit(2);
}

const counts = {
  totalEvents: 0,
  families: {
    near_collision: 0,
    temporal: 0,
    long_horizon: 0,
    multi_hop_relation: 0,
  },
  domains: Object.fromEntries(domains.map((d) => [d, 0])),
  challengeTuples: 0,
};

for (const domain of domains) {
  const questionMeta = loadDomainQuestionMetadata(domain);
  for (let s = seedOffset; s < seedOffset + seedsPerDomain; s++) {
    for (const modifierCount of modifierCounts) {
      for (const constraintDifficulty of constraintDifficulties) {
        const worldSeed = deriveWorldSeed(domain, s, modifierCount, constraintDifficulty);
        const challenge = challengeLib.generateInterchangeableChallenge(
          worldSeed,
          { trapCount, modifierCount, constraintDifficulty },
          domain,
        );
        const estimate = estimateChallenge(challenge, questionMeta);
        counts.challengeTuples++;
        counts.totalEvents += estimate.total;
        counts.domains[domain] += estimate.total;
        for (const [family, count] of Object.entries(estimate.families)) {
          counts.families[family] += count;
        }
      }
    }
  }
}

const evalHiddenEvents = Math.floor(counts.totalEvents * evalHiddenPct / 100);
const noRepeatEpochs = Math.floor(evalHiddenEvents / packSize);
const noRepeatDays = noRepeatEpochs / epochsPerDay;
const noRepeatMonths = noRepeatDays / 30;
const launchGate = noRepeatMonths >= minMonths ? 'pass' : 'fail';

const report = {
  schemaVersion: 'coretex.corpus-capacity-estimate.v1',
  generatedAt: new Date().toISOString(),
  challengeLibrary: challengeLibRoot,
  inputs: {
    domains,
    seedsPerDomain,
    seedOffset,
    corpusEpoch,
    modifierCounts,
    constraintDifficulties,
    trapCount,
    evalHiddenPct,
    packSize,
    epochsPerDay,
    minMonths,
  },
  counts,
  capacity: {
    evalHiddenEvents,
    noRepeatEpochs,
    noRepeatDays,
    noRepeatMonths: Number(noRepeatMonths.toFixed(2)),
    launchGate,
  },
};

console.log(JSON.stringify(report, null, 2));
if (outPath) {
  mkdirSync(dirname(resolve(outPath)), { recursive: true });
  writeFileSync(resolve(outPath), JSON.stringify(report, null, 2));
}
if (launchGate !== 'pass') exit(3);

function estimateChallenge(challenge, questionMeta) {
  const entities = extractEntityNames(challenge);
  const directIds = new Set(entities);
  const families = {
    near_collision: entities.length,
    temporal: (challenge.modifiers?.length ?? 0) + (challenge.silentTraps?.length ?? 0),
    long_horizon: 0,
    multi_hop_relation: 0,
  };

  for (const q of challenge.questions ?? []) {
    let family = classifyQuestion(q, questionMeta.get(q.id));
    if (family === 'multi_hop_relation' && !directIds.has(String(q.answer))) {
      family = 'long_horizon';
    }
    families[family]++;
  }

  return {
    total: families.near_collision + families.temporal + families.long_horizon + families.multi_hop_relation,
    families,
  };
}

function extractEntityNames(challenge) {
  const raw = challenge.world?.companies ?? challenge.world?.entities;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`challenge_world_has_no_entities:${challenge.challengeDomain}:${String(challenge.worldSeed)}`);
  }
  return raw.map((entity) => String(entity.name));
}

function classifyQuestion(question, meta) {
  if (question.id?.startsWith?.('conditional_') || meta?.isChain) return 'multi_hop_relation';
  if (meta?.hasFilter || /among|across|which|highest|lowest|largest|smallest|most|fewest|broadest/i.test(question.text)) {
    return 'long_horizon';
  }
  return 'near_collision';
}

function loadDomainQuestionMetadata(domain) {
  const out = new Map();
  const path = resolve(challengeLibRoot, 'domains', domain, 'domain_library.json');
  if (!existsSync(path)) return out;
  const library = JSON.parse(readFileSync(path, 'utf8'));
  for (const q of library.questions ?? []) {
    out.set(q.id, {
      isChain: Array.isArray(q.answer_logic?.chain) && q.answer_logic.chain.length > 1,
      hasFilter: Boolean(q.answer_logic?.filter),
    });
  }
  return out;
}

function deriveWorldSeed(domain, seed, modifierCount, constraintDifficulty) {
  const h = createHash('sha256')
    .update(`coretex-corpus-v1|${corpusEpoch}|${domain}|${seed}|${modifierCount}|${constraintDifficulty}`)
    .digest('hex');
  return BigInt(`0x${h.slice(0, 32)}`);
}
