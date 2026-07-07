#!/usr/bin/env node
/**
 * A2 arming-time frontier-state rewrite (OFFLINE TOOL — never run against the
 * live /var/lib/coretex state; operates only on explicit --in/--out copies).
 *
 * Why: `stepEpoch` runs ONLY inside real evolves (scripts/coretex-epoch-evolve.mjs
 * makeFrontier; no-op epoch transitions carry the frontier forward unchanged),
 * so age-based retirement drains at most maxRootDeltaPerEpoch rows per EVOLVE,
 * not per epoch. The live frontier state has ~9300 active rows sharing
 * activation epoch 0 (genesis) with an EMPTY reserve: arming any finite maxAge
 * against it queues a backlog that drains for N/budget evolves — with
 * maxRootDeltaPerEpoch 24 and the A1 forced cadence of 8 epochs/evolve that is
 * ~388 evolves ~= 3,100 production epochs even at FULL budget, during which
 * older minted rows queue behind genesis and "retire within maxAge" is
 * meaningless. This tool rewrites the genesis cohort at arming time.
 *
 * Modes:
 *
 *   --mode retire-genesis   (RECOMMENDED)
 *     Move every active row whose activation epoch == --genesis-epoch (default
 *     0) into the retired set, deterministically (order[] position). The active
 *     set becomes the live tail (evolve-minted rows). Genesis rows are non-zz_e
 *     and therefore NEVER enter scored packs via the liveEvalPack overlay, and
 *     base broad packs sample ALL eval_hidden rows regardless of active status
 *     — so this changes only overlay bookkeeping + the pinned root. After the
 *     rewrite, steady-state aged retirement = mint rate (<= budget) and rows
 *     retire at exactly maxAge. MUST be applied as part of the atomic arming
 *     transition (the new activeFrontierRoot is repinned with the bundle
 *     transition + rebaseline, BEFORE the first post-arm evolve).
 *
 *   --mode bulk-activate   (BMU arming prerequisite — BMU_SPEC.md §6.7a
 *     prerequisite 2, §8.5 item 6)
 *     One-time arm-time BULK-ACTIVATION: activate reserve rows in PRECOMMITTED
 *     RESERVE ORDER (order[] from reservePtr, exactly `activateNext`'s walk)
 *     until at least --count (default 380 = BMU N_min) STAMPED rows (ids listed
 *     in the REQUIRED --stamped-ids file: a JSON array of ids, or an object
 *     with an `activeIds`/`ids` array — e.g. a generator-produced bmuTask-row
 *     id list) are active. Required because the in-code frontier pipe is
 *     REPLACEMENT-ONLY (activations strictly replace retirements; the active
 *     set never grows), so minted BMU rows only QUEUE in the reserve and the
 *     BMU arm-gate could never open without this operation. Unstamped reserve
 *     rows encountered in the walked prefix are activated too (the reserve
 *     pointer is a scalar — skipping rows would corrupt the precommitted-order
 *     invariant); counts of both are reported. All newly activated rows get
 *     activationEpoch = --arm-epoch (age 0 at arm — fresh-cohort eligible).
 *     MUST be applied as part of the atomic arming transition: the new
 *     activeFrontierRoot is repinned with the BMU bundle transition +
 *     rebaseline (variance certification runs AFTER this, over the
 *     post-activation active set), BEFORE the first post-arm evolve.
 *
 *   --mode stagger
 *     Rewrite genesis activation epochs into a deterministic uniform stagger so
 *     age-eligibility flows at a fixed per-evolve rate instead of arriving all
 *     at once: the i-th genesis row (sorted by order[] position) gets
 *       activationEpoch = armEpoch + 1 - maxAge + floor(i / perEvolve) * cadence
 *     where perEvolve = maxRootDelta - mintPerEvolve - pruneHeadroom. Every
 *     evolve then age-retires exactly perEvolve genesis rows (plus minted rows
 *     as they age) and stays within the root-delta budget INCLUDING prune
 *     headroom. THE HORIZON MATH DOES NOT CLOSE AT ANY maxAge: drain duration
 *     = ceil(N / perEvolve) evolves = N * cadence / perEvolve epochs
 *     (9300 rows, perEvolve 10, cadence 8 => 930 evolves ~= 7,440 epochs,
 *     ~20 years at daily epochs). maxAge only shifts WHEN the drain starts,
 *     never how long it takes — the budget is the binding constraint. Provided
 *     for completeness/audit; use retire-genesis unless the operator explicitly
 *     wants a slow bookkeeping drain.
 *
 * Deterministic: output is a pure function of (input state bytes, mode, flags).
 * Output keeps the exact coretex.epoch-frontier-state.v1 schema; a .meta.json
 * sibling records inputs, counts, and old/new activeFrontierRoot.
 *
 * Usage:
 *   node scripts/coretex-stagger-frontier-activation.mjs \
 *     --in <state-copy.json> --out <rewritten-state.json> \
 *     --mode retire-genesis|stagger --arm-epoch 137 --max-age 32 \
 *     [--cadence 8] [--mint-per-evolve 12] [--prune-headroom 2] \
 *     [--max-root-delta 24] [--genesis-epoch 0]
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { argv, exit } from 'node:process';

import { distIndex, repoRoot } from './_repo-root.mjs';

const { activeFrontierRootOf } = await import(distIndex);

function flag(name, fb) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fb;
}
const intFlag = (name, fb) => {
  const v = Number(flag(name, fb));
  if (!Number.isInteger(v)) { console.error(`--${name} must be an integer (got ${flag(name, fb)})`); exit(2); }
  return v;
};

const inPath = flag('in');
const outPath = flag('out');
const mode = flag('mode');
if (!inPath || !outPath || !['retire-genesis', 'stagger', 'bulk-activate'].includes(mode)) {
  console.error('usage: --in <state.json> --out <state.json> --mode retire-genesis|stagger|bulk-activate --arm-epoch N --max-age N [--cadence 8] [--mint-per-evolve 12] [--prune-headroom 2] [--max-root-delta 24] [--genesis-epoch 0] [--count 380 --stamped-ids <ids.json>  (bulk-activate)]');
  exit(2);
}
for (const p of [inPath, outPath]) {
  if (resolve(p).startsWith('/var/lib/')) {
    console.error(`refusing to touch ${p}: this tool operates on offline copies only, never live state under /var/lib/`);
    exit(2);
  }
}
if (resolve(inPath) === resolve(outPath)) {
  console.error('refusing in-place rewrite: --out must differ from --in');
  exit(2);
}

const armEpoch = intFlag('arm-epoch');
// maxAge parameterizes the two genesis-rewrite modes' summaries; bulk-activate
// does not consume it (the BMU bundle pins maxAge separately).
const maxAge = mode === 'bulk-activate' ? intFlag('max-age', '32') : intFlag('max-age');
const cadence = intFlag('cadence', '8');
const mintPerEvolve = intFlag('mint-per-evolve', '12');
const pruneHeadroom = intFlag('prune-headroom', '2');
const maxRootDelta = intFlag('max-root-delta', '24');
const genesisEpoch = intFlag('genesis-epoch', '0');
if (armEpoch < 1 || maxAge < 1 || cadence < 1 || maxRootDelta < 1 || mintPerEvolve < 0 || pruneHeadroom < 0) {
  console.error('arm-epoch/max-age/cadence/max-root-delta must be >= 1; mint-per-evolve/prune-headroom >= 0');
  exit(2);
}

const inBytes = readFileSync(inPath);
const state = JSON.parse(inBytes.toString('utf8'));
if (state.schemaVersion !== 'coretex.epoch-frontier-state.v1') {
  console.error(`unsupported state schema ${state.schemaVersion}`);
  exit(1);
}
const orderIdx = new Map(state.order.map((id, i) => [id, i]));
const oldRoot = activeFrontierRootOf(state.active.map(([id]) => id));

const genesis = mode === 'bulk-activate' ? [] : state.active
  .filter(([, ae]) => ae === genesisEpoch)
  .sort((a, b) => orderIdx.get(a[0]) - orderIdx.get(b[0]));
if (genesis.length === 0 && mode !== 'bulk-activate') {
  console.error(`no active rows with activation epoch ${genesisEpoch}; nothing to rewrite`);
  exit(1);
}

let next;
let summary;
if (mode === 'bulk-activate') {
  // BMU one-time arm-time bulk activation (BMU_SPEC.md §6.7a prerequisite 2).
  // Deterministic: pure function of (state bytes, stamped-id set, count,
  // arm-epoch). Mirrors `activateNext`'s precommitted reserve-order walk
  // exactly — the reserve pointer is a scalar, so the walked prefix activates
  // contiguously (unstamped rows in the prefix activate too; reported).
  const count = intFlag('count', '380');
  if (count < 1) { console.error('--count must be >= 1'); exit(2); }
  const stampedPath = flag('stamped-ids');
  if (!stampedPath) {
    console.error('--mode bulk-activate requires --stamped-ids <ids.json> (JSON array of bmuTask-stamped eval_hidden row ids, or an object with an activeIds/ids array) — fail-closed: without it stamped-row coverage cannot be verified');
    exit(2);
  }
  const stampedRaw = JSON.parse(readFileSync(stampedPath, 'utf8'));
  const stampedList = Array.isArray(stampedRaw) ? stampedRaw : (stampedRaw.activeIds ?? stampedRaw.ids);
  if (!Array.isArray(stampedList) || stampedList.length === 0 || stampedList.some((id) => typeof id !== 'string' || id.length === 0)) {
    console.error(`--stamped-ids ${stampedPath}: expected a non-empty JSON string array (or {activeIds|ids: [...]})`);
    exit(1);
  }
  const stamped = new Set(stampedList);
  const activeMap = new Map(state.active);
  const retired = new Set(state.retired);
  let stampedActive = 0;
  for (const [id] of state.active) if (stamped.has(id)) stampedActive++;
  let ptr = state.reservePtr;
  let activated = 0;
  let stampedActivated = 0;
  let unstampedActivated = 0;
  const activatedIds = [];
  while (stampedActive < count && ptr < state.order.length) {
    const id = state.order[ptr++];
    if (activeMap.has(id) || retired.has(id)) continue;
    activeMap.set(id, armEpoch);
    activatedIds.push(id);
    activated++;
    if (stamped.has(id)) { stampedActivated++; stampedActive++; } else { unstampedActivated++; }
  }
  if (stampedActive < count) {
    console.error(`bulk-activate: reserve exhausted at ${stampedActive}/${count} stamped-active rows (activated ${activated}, reservePtr ${state.reservePtr} -> ${ptr} of ${state.order.length}); mint more stamped rows before arming — refusing a partial activation`);
    exit(1);
  }
  next = {
    ...state,
    reservePtr: ptr,
    active: [...activeMap.entries()],
    cumulativeActivated: state.cumulativeActivated + activated,
  };
  summary = {
    mode,
    countRequired: count,
    stampedActiveBefore: stampedActive - stampedActivated,
    stampedActiveAfter: stampedActive,
    activated,
    stampedActivated,
    unstampedActivated,
    reservePtrBefore: state.reservePtr,
    reservePtrAfter: ptr,
    activeAfter: activeMap.size,
    activationEpoch: armEpoch,
    note: 'Repin the new activeFrontierRoot atomically with the BMU bundle transition + rebaseline (variance certification runs AFTER this rewrite) — BEFORE the first post-arm evolve.',
  };
} else if (mode === 'retire-genesis') {
  const genesisIds = new Set(genesis.map(([id]) => id));
  next = {
    ...state,
    active: state.active.filter(([id]) => !genesisIds.has(id)),
    retired: [...state.retired, ...genesis.map(([id]) => id)],
    cumulativeRetired: state.cumulativeRetired + genesis.length,
  };
  if (next.active.length === 0) {
    console.error('rewrite would empty the active set (loaders fail-closed on an empty set); refusing. Mint/activate live-tail rows before arming, or use --mode stagger.');
    exit(1);
  }
  summary = {
    mode,
    genesisRowsRetired: genesis.length,
    activeAfter: next.active.length,
    steadyState: {
      agedRetirementPerEvolve: `= mint rate (~${mintPerEvolve}) <= budget ${maxRootDelta - pruneHeadroom}`,
      rowsRetireAtEpochAge: maxAge,
      rowsRetireAtEvolveAge: Math.ceil(maxAge / cadence),
    },
  };
} else {
  const perEvolve = maxRootDelta - mintPerEvolve - pruneHeadroom;
  if (perEvolve < 1) {
    console.error(`stagger budget does not close: maxRootDelta ${maxRootDelta} - mintPerEvolve ${mintPerEvolve} - pruneHeadroom ${pruneHeadroom} = ${perEvolve} <= 0`);
    exit(1);
  }
  const staggered = new Map(genesis.map(([id], i) => [id, armEpoch + 1 - maxAge + Math.floor(i / perEvolve) * cadence]));
  next = {
    ...state,
    active: state.active.map(([id, ae]) => staggered.has(id) ? [id, staggered.get(id)] : [id, ae]),
  };
  const drainEvolves = Math.ceil(genesis.length / perEvolve);
  summary = {
    mode,
    genesisRowsStaggered: genesis.length,
    perEvolveGenesisBudget: perEvolve,
    budgetArithmetic: `${maxRootDelta} (maxRootDeltaPerEpoch, spent per EVOLVE) - ${mintPerEvolve} (steady-state minted-row aging) - ${pruneHeadroom} (prune headroom) = ${perEvolve}`,
    drainEvolves,
    drainProductionEpochs: drainEvolves * cadence,
    cadenceAssumptionEpochsPerEvolve: cadence,
    warning: 'horizon = N*cadence/perEvolve epochs regardless of maxAge; maxAge only shifts the start. Use retire-genesis unless a multi-year bookkeeping drain is explicitly wanted.',
  };
}

const newRoot = activeFrontierRootOf(next.active.map(([id]) => id));
const outJson = JSON.stringify(next, null, 2) + '\n';
writeFileSync(outPath, outJson);
const meta = {
  schema: 'coretex.a2.frontier-activation-rewrite-meta.v1',
  createdAt: new Date().toISOString(),
  tool: 'scripts/coretex-stagger-frontier-activation.mjs',
  inputs: { inPath, mode, armEpoch, maxAge, cadence, mintPerEvolve, pruneHeadroom, maxRootDelta, genesisEpoch },
  inSha256: createHash('sha256').update(inBytes).digest('hex'),
  outSha256: createHash('sha256').update(outJson).digest('hex'),
  oldActiveFrontierRoot: oldRoot,
  newActiveFrontierRoot: newRoot,
  activeBefore: state.active.length,
  activeAfter: next.active.length,
  note: 'Apply ONLY as part of the atomic arming transition: repin the new activeFrontierRoot with the bundle transition + rebaseline BEFORE the first post-arm evolve.',
  summary,
};
writeFileSync(`${outPath}.meta.json`, JSON.stringify(meta, null, 2) + '\n');
console.log(JSON.stringify(meta, null, 2));
