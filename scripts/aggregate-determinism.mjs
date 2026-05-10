#!/usr/bin/env node
/**
 * Aggregate per-host determinism-check reports into a cross-host diff
 * distribution.
 *
 * Usage:
 *   node scripts/aggregate-determinism.mjs \
 *     --reports './reports/determinism-host-*.json' \
 *     --max-tolerance-ppm 250 \
 *     --out ./reports/determinism-aggregate.json
 *
 * Exit codes:
 *   0 → P99 |diff| <= MAX_TOLERANCE_PPM
 *   2 → P99 |diff| > MAX_TOLERANCE_PPM
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { argv, exit } from 'node:process';
import { globSync } from 'node:fs';

function flag(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  return fallback;
}

const reportsGlob = flag('reports', './reports/determinism-host-*.json');
const maxTolerancePpm = Number(flag('max-tolerance-ppm', '250'));
const outPath = flag('out', './reports/determinism-aggregate.json');

const files = globSync(reportsGlob);
if (files.length < 2) {
  console.error(`aggregate-determinism: need >= 2 host reports, got ${files.length}`);
  exit(1);
}

const reports = files.map((f) => JSON.parse(readFileSync(f, 'utf8')));
const baseHost = reports[0];
const baseScores = new Map(baseHost.perPair.map((p) => [p.pair_id, p.reranker_score]));

const diffsPpm = [];
for (let i = 1; i < reports.length; i++) {
  const r = reports[i];
  for (const p of r.perPair) {
    const baseScore = baseScores.get(p.pair_id);
    if (baseScore === undefined) continue;
    diffsPpm.push(Math.abs(p.reranker_score - baseScore) * 1_000_000);
  }
}
diffsPpm.sort((a, b) => a - b);

function quantile(arr, q) {
  if (arr.length === 0) return 0;
  const i = Math.floor(arr.length * q);
  return Math.ceil(arr[Math.min(i, arr.length - 1)]);
}

const p50 = quantile(diffsPpm, 0.5);
const p90 = quantile(diffsPpm, 0.9);
const p99 = quantile(diffsPpm, 0.99);
const max = diffsPpm.length === 0 ? 0 : Math.ceil(diffsPpm[diffsPpm.length - 1]);

const aggregate = {
  schemaVersion: 'coretex.determinism-aggregate.v1',
  generatedAt: new Date().toISOString(),
  reports: files,
  hostIds: reports.map((r) => r.hostId),
  pairCount: diffsPpm.length,
  p50PpmDiff: p50,
  p90PpmDiff: p90,
  p99PpmDiff: p99,
  maxPpmDiff: max,
  maxTolerancePpm,
};

mkdirSync(dirname(resolve(outPath)), { recursive: true });
writeFileSync(outPath, JSON.stringify(aggregate, null, 2));
console.log(JSON.stringify(aggregate, null, 2));

if (p99 > maxTolerancePpm) {
  console.error(`aggregate-determinism: P99 ${p99} > tolerance ${maxTolerancePpm}`);
  exit(2);
}
exit(0);
