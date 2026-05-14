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
 *   --daily-seeds-per-domain 2        planned routine expansion cadence
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
 *      and asserts the planned routine daily delta stays under
 *      0.50 × majorDeltaThreshold using empirical events/seed density from
 *      the reserve corpus (p50 expected and p90 conservative estimates).
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
const dailySeedsPerDomain = Number(flag('daily-seeds-per-domain', '2'));
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
if (!Number.isInteger(dailySeedsPerDomain) || dailySeedsPerDomain < 1) {
  console.error('calibrate-initial-active-size: --daily-seeds-per-domain must be a positive integer');
  exit(2);
}
if (candidates.length === 0) {
  console.error('calibrate-initial-active-size: --candidates must list ≥1 positive integers');
  exit(2);
}
if (!Number.isInteger(totalSeedsPerDomain) || totalSeedsPerDomain < 1) {
  console.error('calibrate-initial-active-size: --seeds-per-domain-total must be a positive integer');
  exit(2);
}
if (candidates.some((s) => s > totalSeedsPerDomain)) {
  console.error(
    `calibrate-initial-active-size: candidate exceeds --seeds-per-domain-total (${totalSeedsPerDomain}); candidates=${candidates.join(',')}`,
  );
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

function challengeMeta(challengeId) {
  // Supported shapes:
  //   "<domain>/<seed>"
  //   "<domain>/seed-<seed>/..."
  //   "coretex_v1:<domain>:s<seed>:..."
  let domain = null;
  for (const d of domains) {
    if (
      challengeId.startsWith(`${d}/`)
      || challengeId.includes(`:${d}:`)
      || challengeId.includes(`/${d}/`)
    ) {
      domain = d;
      break;
    }
  }
  const m = /\/seed-(\d+)|\/(\d+)|:s(\d+)(?::|$)/.exec(challengeId);
  if (!m) return { domain, seed: null };
  return { domain, seed: Number(m[1] ?? m[2] ?? m[3]) };
}

function quantile(values, q) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const i = Math.min(sorted.length - 1, Math.floor(sorted.length * q));
  return sorted[i];
}

const perCandidate = candidates.map((S) => ({
  S,
  evalHidden: 0,
  families: Object.create(null),
  totalEvents: 0,
  splits: Object.create(null),
}));
const perDomainSeedCounts = new Map(domains.map((d) => [d, new Map()]));

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
  const { domain, seed } = challengeMeta(ev.provenance?.challengeId ?? '');
  if (seed === null || !Number.isInteger(seed)) continue;
  if (domain && perDomainSeedCounts.has(domain)) {
    const seedMap = perDomainSeedCounts.get(domain);
    seedMap.set(seed, (seedMap.get(seed) ?? 0) + 1);
  }
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
const domainSeedStats = {};
for (const d of domains) {
  const seedMap = perDomainSeedCounts.get(d);
  const counts = [...seedMap.values()];
  if (counts.length === 0) {
    domainSeedStats[d] = {
      observedSeeds: 0,
      perSeedMin: 0,
      perSeedP50: 0,
      perSeedP90: 0,
      perSeedMax: 0,
      perSeedMean: 0,
    };
    continue;
  }
  const sum = counts.reduce((s, v) => s + v, 0);
  domainSeedStats[d] = {
    observedSeeds: counts.length,
    perSeedMin: Math.min(...counts),
    perSeedP50: quantile(counts, 0.50),
    perSeedP90: quantile(counts, 0.90),
    perSeedMax: Math.max(...counts),
    perSeedMean: sum / counts.length,
  };
}
const dailyDeltaEventsExpected = dailySeedsPerDomain
  * domains.reduce((s, d) => s + (domainSeedStats[d]?.perSeedP50 ?? 0), 0);
const dailyDeltaEventsConservative = dailySeedsPerDomain
  * domains.reduce((s, d) => s + (domainSeedStats[d]?.perSeedP90 ?? 0), 0);

const evaluated = perCandidate.map((c) => {
  const noRepeatMonths = (c.evalHidden / packSize) / epochsPerDay / 30;
  const runwayPass = noRepeatMonths * 30 >= runwayDays;

  const familyPass = requiredFamilies.every((f) => (c.families[f] ?? 0) >= minPerFamily);
  const familyMisses = requiredFamilies.filter((f) => (c.families[f] ?? 0) < minPerFamily);

  const majorDeltaThreshold = Math.max(100, Math.floor(c.evalHidden * 0.05));
  // Routine delta cap based on empirical reserve density rather than a fixed
  // hardcoded events/seed assumption.
  const halfMajor = majorDeltaThreshold * 0.50;
  const routineDeltaPass = dailyDeltaEventsConservative <= halfMajor;

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
      dailySeedsPerDomain,
      dailyDeltaEventsExpected,
      dailyDeltaEventsConservative,
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
  dailySeedsPerDomain,
  domains,
  domainSeedStats,
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
  `daily-delta(p90)=${passing.routineDelta.dailyDeltaEventsConservative}/${passing.routineDelta.majorDeltaThreshold} ` +
  `majorThreshold). Report: ${outPath}`,
);
