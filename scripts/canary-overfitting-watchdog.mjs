#!/usr/bin/env node
/**
 * Canary overfitting watchdog.
 *
 * Per `docs/CORETEX_V4_ONCHAIN_RANDOMNESS_PLAN.md §Canary Overfitting
 * Watchdog`. Detection-only — does not reject patches, never touches
 * chain state. Reads accepted-patch eval receipts from
 * `--receipts-dir`, tracks aggregate canary-score drift against the
 * bundle's pinned baseline, and alarms when the rolling mean drifts
 * more than `--sigma-threshold` standard deviations above baseline.
 *
 * What this catches:
 *   - Miners overfitting their substrate to eval_hidden in a way that
 *     also lifts canary scores (since substrate is shared between
 *     the two splits)
 *   - Coordinator misconfiguration that drifts the scoring
 *     distribution across an epoch
 *   - Reranker non-determinism on a specific host (canary mean drifts
 *     because reranker scores drift)
 *
 * What this does NOT catch:
 *   - Single-patch outliers (rolling mean smooths these out)
 *   - Adversarial submitters who carefully avoid canary correlation
 *
 * Usage (cron, every ~5 min):
 *   node scripts/canary-overfitting-watchdog.mjs \
 *     --receipts-dir /var/lib/coretex/eval-reports \
 *     --bundle-manifest /etc/coretex/bundle-manifest.json \
 *     --window-receipts 100 \
 *     --sigma-threshold 3 \
 *     --out /var/lib/coretex/reports/canary-watchdog.json \
 *     --alarms-log /var/lib/coretex/reports/canary-alarms.log
 *
 * Exit codes:
 *   0   no alarm
 *   1   alarm fired (drift detected) — caller pages operator
 *   2   bad config / unreadable inputs
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync, appendFileSync, existsSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { argv, exit } from 'node:process';

function flag(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  return fallback;
}

const receiptsDir = resolve(flag('receipts-dir', '/var/lib/coretex/eval-reports'));
const bundlePath = flag('bundle-manifest');
const windowReceipts = Number(flag('window-receipts', '100'));
const sigmaThreshold = Number(flag('sigma-threshold', '3'));
const outPath = resolve(flag('out', '/var/lib/coretex/reports/canary-watchdog.json'));
const alarmsLogPath = resolve(flag('alarms-log', '/var/lib/coretex/reports/canary-alarms.log'));

if (!bundlePath) {
  console.error('canary-watchdog: --bundle-manifest is required');
  exit(2);
}
if (!Number.isInteger(windowReceipts) || windowReceipts < 5) {
  console.error('canary-watchdog: --window-receipts must be ≥ 5');
  exit(2);
}
if (!Number.isFinite(sigmaThreshold) || sigmaThreshold < 1) {
  console.error('canary-watchdog: --sigma-threshold must be ≥ 1');
  exit(2);
}
if (!existsSync(receiptsDir)) {
  console.error(`canary-watchdog: receipts dir not found: ${receiptsDir}`);
  exit(2);
}

const bundle = JSON.parse(readFileSync(resolve(bundlePath), 'utf8'));
const baselinePpm = bundle.evaluator?.profile?.baselineParentScorePpm;
const fixedPackRepeatabilityPpm = bundle.evaluator?.profile?.fixedPackRepeatabilityPpm
  ?? (bundle.evaluator?.profile?.baselineVarianceSource ? undefined : bundle.evaluator?.profile?.baselineVariancePpm);
if (typeof baselinePpm !== 'number') {
  console.error('canary-watchdog: bundle.evaluator.profile.baselineParentScorePpm is required');
  exit(2);
}
const baselineStdDev = Math.max(1, Math.sqrt(Math.max(0, fixedPackRepeatabilityPpm ?? 0)));

// ─── Read receipts ──────────────────────────────────────────────────

const allReceiptFiles = readdirSync(receiptsDir)
  .filter((name) => name.endsWith('.json'))
  // Most-recent-first by name (receipts named with patchHash; if your
  // host names them with a timestamp prefix, this also works).
  .sort()
  .reverse();
const window = allReceiptFiles.slice(0, windowReceipts);

const canaryScores = []; // per-receipt canary-score in ppm
const gateConfirmGaps = []; // per-receipt |gate - confirm| in ppm
const minerCounts = Object.create(null);

for (const file of window) {
  try {
    const r = JSON.parse(readFileSync(resolve(receiptsDir, file), 'utf8'));
    // Per-patch on-chain randomness receipts carry both gate and
    // confirm scores; either may be missing on older receipts.
    if (typeof r.gateScorePpm === 'number' && typeof r.confirmScorePpm === 'number') {
      gateConfirmGaps.push(Math.abs(r.gateScorePpm - r.confirmScorePpm));
    }
    // Canary score is optional — receipts produced before the canary-
    // score field was added simply contribute nothing. Watchdog stays
    // silent until enough canary-bearing receipts accumulate.
    if (typeof r.canaryScorePpm === 'number') {
      canaryScores.push(r.canaryScorePpm);
    }
    const miner = typeof r.minerAddress === 'string' ? r.minerAddress.toLowerCase() : '_unknown';
    minerCounts[miner] = (minerCounts[miner] ?? 0) + 1;
  } catch (e) {
    // Skip unreadable receipts but don't abort — a corrupted one-off
    // shouldn't silence the watchdog.
    console.error(`canary-watchdog: skipping unreadable receipt ${file}: ${e.message}`);
  }
}

// ─── Compute aggregate statistics ───────────────────────────────────

function mean(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}
function stddev(arr, m) {
  if (arr.length < 2) return 0;
  const variance = arr.reduce((acc, x) => acc + (x - m) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

const canaryMean = mean(canaryScores);
const canaryStd = stddev(canaryScores, canaryMean);
const driftPpm = canaryMean - baselinePpm;
const driftSigma = baselineStdDev > 0 ? driftPpm / baselineStdDev : 0;

const gateConfirmGapMean = mean(gateConfirmGaps);
const gateConfirmGapStd = stddev(gateConfirmGaps, gateConfirmGapMean);

const alarms = [];
if (canaryScores.length >= 10 && driftSigma > sigmaThreshold) {
  alarms.push({
    kind: 'canary-drift',
    sigma: driftSigma,
    driftPpm,
    canaryMean,
    canaryStdDev: canaryStd,
    baselinePpm,
    baselineStdDev,
    receiptsInWindow: canaryScores.length,
    threshold: sigmaThreshold,
  });
}

// Future hook: alarm on per-miner concentration (e.g., one miner
// holding > 80% of admissions in window) — disabled until we have
// receipts to calibrate the threshold against.

// ─── Write report ───────────────────────────────────────────────────

mkdirSync(dirname(outPath), { recursive: true });
const report = {
  schemaVersion: 'coretex.canary-watchdog.v1',
  generatedAt: new Date().toISOString(),
  receiptsDir,
  windowReceipts,
  observedReceipts: window.length,
  sigmaThreshold,
  baseline: { ppm: baselinePpm, stdDev: baselineStdDev },
  canary: { count: canaryScores.length, mean: canaryMean, stdDev: canaryStd },
  drift: { ppm: driftPpm, sigma: driftSigma },
  gateConfirmGap: {
    count: gateConfirmGaps.length,
    mean: gateConfirmGapMean,
    stdDev: gateConfirmGapStd,
  },
  miners: minerCounts,
  alarms,
};
writeFileSync(outPath, JSON.stringify(report, null, 2));

if (alarms.length > 0) {
  mkdirSync(dirname(alarmsLogPath), { recursive: true });
  for (const a of alarms) {
    appendFileSync(alarmsLogPath, `${report.generatedAt} ${a.kind} ${JSON.stringify(a)}\n`);
  }
  console.error(`canary-watchdog: ALARM ${alarms.length} fired — see ${alarmsLogPath}`);
  exit(1);
}

console.log(
  `canary-watchdog: OK observed=${window.length} canary=${canaryScores.length} ` +
  `drift=${driftPpm.toFixed(1)}ppm sigma=${driftSigma.toFixed(2)} (threshold=${sigmaThreshold})`,
);
