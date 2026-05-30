#!/usr/bin/env node
/**
 * CPU smoke for makeEpochFrontier.addReserveIds — the new package-level API that injects
 * live-update eval_hidden ids into a persisted frontier's reserve so live churn rotates
 * NEW evals (not just the genesis reserve).
 *
 * Hard-fails if any of:
 *   - addReserveIds returns 0 for fresh ids (failed to inject)
 *   - reserveRemaining doesn't grow by the injected count
 *   - injected ids don't reach active set after enough rotation
 *   - state across epochs looks like re-genesis (cumulativeRetired doesn't grow)
 */
import { exit } from 'node:process';
import { distIndex } from './_repo-root.mjs';

const C = await import(distIndex);
const { makeLaunchFrontier } = C;

function fail(m) { console.error(`SMOKE FAIL: ${m}`); exit(1); }
function pass(m) { console.log(`SMOKE PASS: ${m}`); }

// Synthetic mini corpus: ~64 eval_hidden across 3 families, activeWindow 16 → reserve 48.
const synthIds = (n, prefix, fam) => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i.toString().padStart(3, '0')}`, family: fam, logicalFamily: fam }));
const genesisEvents = [
  ...synthIds(24, 'q_t_', 'temporal_update'),
  ...synthIds(24, 'q_r_', 'multi_session_bridge'),
  ...synthIds(16, 'q_c_', 'conflict_lifecycle'),
].map((e) => ({ ...e, split: 'eval_hidden' }));
const profile = {
  epochFrontier: { mode: 'C3', activeWindow: 16, seed: 'smoke-frontier',
    baselineRecompute: 'activeRootChanged', majorDeltaPolicy: 'corpusRootChanged',
    minChurn: 2, maxChurn: 8, headroomLowWatermark: 1, headroomHighWatermark: 3,
    ewmaHalfLife: 3, targetAccepts: 2, expectedYieldPerUnit: 0.17, maxRootDeltaPerEpoch: 24, maxAge: null },
};
const corpus = { events: genesisEvents };
const frontier = makeLaunchFrontier(profile, corpus);
if (!frontier) fail('makeLaunchFrontier returned null on a profile with epochFrontier set');
if (typeof frontier.addReserveIds !== 'function') fail('frontier.addReserveIds is not a function — package-level API not exported');
pass(`frontier built — totalUnits=${frontier.totalUnits} K=${frontier.K}`);

const fr0 = frontier.stepEpoch(0, null, null);
const reserve0 = fr0.reserveRemaining;
pass(`genesis stepEpoch: activeWindow=${fr0.activeEvalHiddenCount} reserveRemaining=${reserve0} activated=${fr0.activated} retired=${fr0.retired}`);
if (fr0.activeEvalHiddenCount !== 16) fail(`genesis active size expected 16, got ${fr0.activeEvalHiddenCount}`);
if (reserve0 !== 48) fail(`genesis reserveRemaining expected 48, got ${reserve0}`);

// Inject 8 new live-update eval_hidden ids (3 temporal + 3 conflict + 2 multi_hop).
const newIds = [
  ...synthIds(3, 'q_live_t_', 'temporal_update'),
  ...synthIds(3, 'q_live_c_', 'conflict_lifecycle'),
  ...synthIds(2, 'q_live_r_', 'multi_session_bridge'),
];
const famOf = (id) => {
  if (id.startsWith('q_live_t_') || id.startsWith('q_t_')) return 'temporal_update';
  if (id.startsWith('q_live_c_') || id.startsWith('q_c_')) return 'conflict_lifecycle';
  if (id.startsWith('q_live_r_') || id.startsWith('q_r_')) return 'multi_session_bridge';
  return 'unknown';
};
const added = frontier.addReserveIds(newIds.map((e) => e.id), famOf);
if (added !== 8) fail(`addReserveIds returned ${added}, expected 8`);
pass(`addReserveIds injected ${added} new eval ids`);

// Idempotent: re-injecting the same ids returns 0.
const reAdded = frontier.addReserveIds(newIds.map((e) => e.id), famOf);
if (reAdded !== 0) fail(`addReserveIds re-inject expected 0, got ${reAdded}`);
pass(`addReserveIds idempotent on re-inject (returned 0)`);

// Step epoch 1 with enough churn to pull from reserve — under C3 with prevAccepts=0 the first
// non-genesis step pulls minChurn=2 from reserve (priority: extra-injected segment first).
const fr1 = frontier.stepEpoch(1, 0, 3);
const reserve1 = fr1.reserveRemaining;
if (reserve1 !== reserve0 + 8 - fr1.activated) fail(`reserveRemaining accounting wrong: ${reserve1} vs ${reserve0}+8-${fr1.activated}`);
pass(`epoch 1: activated=${fr1.activated} retired=${fr1.retired} churnRate=${fr1.churnRate} reserveRemaining=${reserve1} (was ${reserve0}+8 injected, drained by ${fr1.activated})`);
if (fr1.activated === 0) fail(`epoch 1 activated 0 from reserve — C3 rotation not pulling`);
if (fr1.cumulativeRetired === 0) fail(`epoch 1 cumulativeRetired still 0 — rotation not retiring active`);

// Check at least ONE of the live-injected ids made it into the active set after 1 rotation.
const activeAfter1 = fr1.activeIds;
const liveActive = newIds.filter((e) => activeAfter1.has(e.id)).length;
if (liveActive === 0) fail(`no live-injected ids made it into active set after epoch 1; activated=${fr1.activated} but pulled from genesis`);
pass(`epoch 1: ${liveActive}/${newIds.length} live-injected ids reached active set`);

// Multiple epochs to prove state persists, not re-genesis.
const fr2 = frontier.stepEpoch(2, 1, 3);
const fr3 = frontier.stepEpoch(3, 0, 3);
if (!(fr2.cumulativeRetired >= fr1.cumulativeRetired && fr3.cumulativeRetired >= fr2.cumulativeRetired)) fail('cumulativeRetired not monotonically non-decreasing');
if (!(fr2.cumulativeActivated >= fr1.cumulativeActivated && fr3.cumulativeActivated >= fr2.cumulativeActivated)) fail('cumulativeActivated not monotonically non-decreasing');
pass(`3-epoch rotation: cumulativeActivated ${fr0.cumulativeActivated}→${fr1.cumulativeActivated}→${fr2.cumulativeActivated}→${fr3.cumulativeActivated}`);
pass(`3-epoch rotation: cumulativeRetired ${fr0.cumulativeRetired}→${fr1.cumulativeRetired}→${fr2.cumulativeRetired}→${fr3.cumulativeRetired}`);

// Final live-active count after 3 epochs
const finalLiveActive = newIds.filter((e) => fr3.activeIds.has(e.id)).length;
pass(`after 3 epochs: ${finalLiveActive}/${newIds.length} live-injected ids in active set`);

console.log('SMOKE: ALL PASS ✅ — frontier.addReserveIds API confirmed: new evals enter reserve and rotate into active');
exit(0);
