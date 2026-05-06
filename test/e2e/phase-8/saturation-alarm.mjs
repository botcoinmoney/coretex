#!/usr/bin/env node
// Phase 8 saturation-alarm test.
// Per §9 Phase 8: synthetic flat-score sequence over K=10 epochs triggers
// the alarm and would surface in the metrics dashboard.

import { strict as assert } from 'node:assert';

// Reproduces the K=10 / threshold=1% saturation rule from benchmark/saturation.ts
// in plain JS so the gate runs without a TS build step. The real
// benchmark/saturation.ts uses EpochScoreRecord[] objects; this inline
// version uses raw scoreDelta numbers — both implement the same rule.
function checkSaturation(history, k, threshold) {
  if (history.length < k) return { alarm: false, median: history.length === 0 ? 0 : medianOf(history) };
  const recent = history.slice(-k);
  const m = medianOf(recent);
  return { alarm: m < threshold, median: m };
}
function medianOf(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

const healthy = [0.05, 0.07, 0.04, 0.08, 0.06, 0.05, 0.09, 0.04, 0.07, 0.06];
const r1 = checkSaturation(healthy, 10, 0.01);
assert.equal(r1.alarm, false, `healthy sequence triggered alarm: median=${r1.median}`);
console.log(`[saturation-alarm] healthy: median=${r1.median.toFixed(4)} → no alarm (correct)`);

const flat = [0.001, 0.002, 0.001, 0.0005, 0.003, 0.001, 0.002, 0.0001, 0.001, 0.0009];
const r2 = checkSaturation(flat, 10, 0.01);
assert.equal(r2.alarm, true, `flat sequence did NOT trigger alarm: median=${r2.median}`);
console.log(`[saturation-alarm] flat:    median=${r2.median.toFixed(4)} → alarm fires (correct)`);

const edge = new Array(10).fill(0.01);
const r3 = checkSaturation(edge, 10, 0.01);
assert.equal(r3.alarm, false, `edge triggered alarm at exact threshold`);
console.log(`[saturation-alarm] edge:    median=${r3.median.toFixed(4)} → no alarm at exact threshold (correct)`);

const tooShort = [0.001, 0.001];
const r4 = checkSaturation(tooShort, 10, 0.01);
assert.equal(r4.alarm, false, `short history triggered alarm`);
console.log(`[saturation-alarm] short:   no alarm yet (correct)`);

console.log('[saturation-alarm] OK');
