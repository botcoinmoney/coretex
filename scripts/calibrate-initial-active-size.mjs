#!/usr/bin/env node
/**
 * Pick the smallest `initialActiveSeedsPerDomain` (S) that satisfies
 * every existing launch gate. Implements the selection law described
 * in `docs/CORETEX_V4_ONCHAIN_RANDOMNESS_PLAN.md` §"Staged Active Root".
 *
 * Inputs:
 *   --reserve-corpus <path>           full reserve corpus generated up-front
 *   --bundle-manifest <path>          template / pre-baseline bundle
 *   --candidates 64,96,128,192,256    S values to try (ascending)
 *   --runway-days 60                  minimum hidden-pack runway target
 *   --epochs-per-day 1                hidden-pack consumption rate
 *   --pack-size <N>                   override; otherwise reads from bundle
 *   --domains-csv companies,...       active domains list (matches reserve)
 *   --seeds-per-domain-total 512      reserve's seeds-per-domain (sanity)
 *   --out reports/initial-active-size.json
 *
 * The script does NOT run model work. For each candidate S it:
 *   1. Computes the prefix slice: events whose challengeId is
 *      `<domain>/<seed>` with seed ∈ [0, S).
 *   2. Counts the resulting eval_hidden population per the corpus's
 *      existing `split` field (no re-splitting).
 *   3. Runs the capacity gate: noRepeatMonths = floor(evalHidden / packSize) / epochsPerDay / 30.
 *      Pass if noRepeatMonths × 30 ≥ runwayDays.
 *   4. Runs `validate-retrieval-corpus` quotas in-memory: every
 *      family present with ≥ min-per-family events.
 *   5. Computes majorDeltaThreshold = max(100, floor(evalHidden * 0.05))
 *      and asserts a 2-seed daily delta (~2 × ~155 events = ~310 events
 *      per domain × N domains) stays under 0.50 × majorDeltaThreshold.
 *
 * Outputs the smallest S that passes all gates, plus the per-candidate
 * gate report. Picks the policy `initialActiveSeedsPerDomain = S`,
 * `routineDeltaMaxMajorFraction = 0.50`, `initialActiveRunwayDays = runwayDays`.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve, dirname } from 'node:path';
import { argv, exit } from 'node:process';

function flag(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  return fallback;
}

const reservePath = flag('reserve-corpus');
const bundlePath = flag('bundle-manifest');
const candidates = String(flag('candidates', '64,96,128,192,256'))
  .split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0)
  .sort((a, b) => a - b);
const runwayDays = Number(flag('runway-days', '60'));
const epochsPerDay = Number(flag('epochs-per-day', '1'));
const packSizeOverride = flag('pack-size');
const domainsCsv = flag('domains-csv', 'companies,quantum_physics,computational_biology,scrna_imputation');
const totalSeedsPerDomain = Number(flag('seeds-per-domain-total', '512'));
const outPath = flag('out', '/var/lib/coretex/reports/initial-active-size.json');
const minPerFamily = Number(flag('min-per-family', '50'));

if (!reservePath || !bundlePath) {
  console.error('calibrate-initial-active-size: --reserve-corpus and --bundle-manifest are required');
  exit(2);
}
if (!Number.isInteger(runwayDays) || runwayDays < 1) {
  console.error('calibrate-initial-active-size: --runway-days must be a positive integer');
  exit(2);
}
if (candidates.length === 0) {
  console.error('calibrate-initial-active-size: --candidates must list ≥1 positive integers');
  exit(2);
}

const bundle = JSON.parse(readFileSync(resolve(bundlePath), 'utf8'));
const packSize = Number(packSizeOverride ?? bundle.evaluator?.profile?.hiddenPack?.packSize ?? 128);
if (!Number.isInteger(packSize) || packSize < 1) {
  console.error(`calibrate-initial-active-size: invalid packSize ${packSize}`);
  exit(2);
}
const domains = domainsCsv.split(',').map((s) => s.trim()).filter(Boolean);

// Pass 1 — stream the reserve corpus and bucket events by (domain, seed)
// + family + split. We avoid loading the entire JSON corpus into memory
// (it's the launch-scale reserve) by reading the NDJSON shadow if it
// exists; otherwise fall back to a streaming JSON parse via a regex
// pattern — but the streaming refactor writes NDJSON alongside, so
// prefer that.
const ndjsonShadow = `${resolve(reservePath)}.events.ndjson`;
let useNdjson = false;
if (existsSync(ndjsonShadow)) useNdjson = true;

function challengeIdSeed(challengeId) {
  // challengeId format from the generator: "<domain>/<seed>" or
  // "<domain>/seed-<seed>/...". Both shapes are deterministic; extract
  // the integer seed.
  const m = /\/seed-(\d+)|\/(\d+)/.exec(challengeId);
  if (!m) return null;
  return Number(m[1] ?? m[2]);
}

const perCandidate = candidates.map((S) => ({
  S,
  evalHidden: 0,
  families: Object.create(null),
  totalEvents: 0,
  splits: Object.create(null),
}));

async function* eventsFromNdjson() {
  const rl = createInterface({ input: createReadStream(ndjsonShadow), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    yield JSON.parse(line);
  }
}

async function* eventsFromJson() {
  const raw = JSON.parse(readFileSync(resolve(reservePath), 'utf8'));
  for (const ev of raw.events) yield ev;
}

const source = useNdjson ? eventsFromNdjson() : eventsFromJson();
for await (const ev of source) {
  const seed = challengeIdSeed(ev.provenance?.challengeId ?? '');
  if (seed === null || !Number.isInteger(seed)) continue;
  for (const c of perCandidate) {
    if (seed >= c.S) continue;
    c.totalEvents++;
    c.families[ev.family] = (c.families[ev.family] ?? 0) + 1;
    c.splits[ev.split] = (c.splits[ev.split] ?? 0) + 1;
    if (ev.split === 'eval_hidden') c.evalHidden++;
  }
}

// Per-candidate gate evaluation.
const requiredFamilies = ['near_collision', 'temporal', 'long_horizon', 'multi_hop_relation'];

const evaluated = perCandidate.map((c) => {
  const noRepeatMonths = (c.evalHidden / packSize) / epochsPerDay / 30;
  const runwayPass = noRepeatMonths * 30 >= runwayDays;

  const familyPass = requiredFamilies.every((f) => (c.families[f] ?? 0) >= minPerFamily);
  const familyMisses = requiredFamilies.filter((f) => (c.families[f] ?? 0) < minPerFamily);

  const majorDeltaThreshold = Math.max(100, Math.floor(c.evalHidden * 0.05));
  // Routine delta cap = 2 seeds/domain × ~155 events/seed × N domains
  const ESTIMATED_EVENTS_PER_SEED = 155;
  const dailyDeltaEvents = 2 * ESTIMATED_EVENTS_PER_SEED * domains.length;
  const halfMajor = majorDeltaThreshold * 0.50;
  const routineDeltaPass = dailyDeltaEvents <= halfMajor;

  const pass = runwayPass && familyPass && routineDeltaPass;
  return {
    S: c.S,
    pass,
    totalEvents: c.totalEvents,
    evalHidden: c.evalHidden,
    splits: c.splits,
    families: c.families,
    capacity: { noRepeatMonths, runwayDaysTarget: runwayDays, pass: runwayPass },
    familyCoverage: { minPerFamily, requiredFamilies, missing: familyMisses, pass: familyPass },
    routineDelta: {
      majorDeltaThreshold,
      dailyDeltaEvents,
      halfMajor,
      pass: routineDeltaPass,
    },
  };
});

const passing = evaluated.find((e) => e.pass);

const report = {
  schemaVersion: 'coretex.initial-active-size.v1',
  generatedAt: new Date().toISOString(),
  reservePath,
  bundlePath,
  packSize,
  runwayDays,
  epochsPerDay,
  domains,
  totalSeedsPerDomain,
  recommendedS: passing?.S ?? null,
  candidates: evaluated,
  recommendedPolicy: passing
    ? {
        initialActiveSeedsPerDomain: passing.S,
        routineDeltaMaxMajorFraction: 0.50,
        initialActiveRunwayDays: runwayDays,
      }
    : null,
};
mkdirSync(dirname(resolve(outPath)), { recursive: true });
writeFileSync(resolve(outPath), JSON.stringify(report, null, 2));

if (!passing) {
  console.error(
    `calibrate-initial-active-size: NO candidate passed all gates. ` +
    `Smallest tried = ${candidates[0]}, largest = ${candidates[candidates.length - 1]}. ` +
    `Report: ${outPath}`,
  );
  exit(1);
}

console.log(
  `calibrate-initial-active-size: smallest passing S=${passing.S} ` +
  `(evalHidden=${passing.evalHidden}, runway=${passing.capacity.noRepeatMonths.toFixed(1)}mo, ` +
  `daily-delta=${passing.routineDelta.dailyDeltaEvents}/${passing.routineDelta.majorDeltaThreshold} ` +
  `majorThreshold). Report: ${outPath}`,
);
