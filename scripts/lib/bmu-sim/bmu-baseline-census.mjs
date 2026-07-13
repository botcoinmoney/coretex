/**
 * §17.48 SPIKE — reusable census runner for the four new public baselines
 * (reranker-reading compiler, exhaustive/minimal program search, raw-reranker,
 * indexer). Runs each baseline over a set of generic scoring tasks and tallies what
 * each CATCHES (credits with zero discovery), overall and per family.
 *
 * GENERAL BY DESIGN. `runBaselineBatteryCensus({ tasks })` takes any array of generic
 * `BmuBaselineTask`s ({ relations, seedId, goldId, requiredIds, forbiddenIds,
 * program? }), so the SIBLING LANE points it at its vertical-slice task shape with a
 * one-line adapter — no battery change. `censusFromEraCatalog({ dist, eras })` is the
 * current-corpus adapter: it builds the real 144-class catalog per era
 * (`buildClassCatalog`) and runs the battery, with the resident program's own
 * credited utility as the own-control sanity check.
 *
 * Run directly to print the current-corpus (era-1/2/3) table:
 *   node scripts/lib/bmu-sim/bmu-baseline-census.mjs
 * (imports the built @botcoin/coretex dist for the query-key law).
 *
 * STOP-LINE: pure/deterministic CPU; the DEFAULT judge is the credited-utility oracle
 * (§17.47-Part-B-faithful to real Qwen); no live scorer, no prod state, arms nothing.
 */
import {
  bmuBaselineTaskFromProgram,
  bmuBaselineJudgeProgram,
  rerankerReadingCompilerSolves,
  exhaustiveMinimalProgramSearch,
  rawRerankerBaselineSolves,
  indexerBaselineSolves,
} from './transferring-compiler-audit.mjs';
import { buildClassCatalog } from './era-transition-sim.mjs';
import { ERA_JOURNAL_FAMILIES } from './era-schedule.mjs';

export { bmuBaselineTaskFromProgram };

const FAMILIES = ERA_JOURNAL_FAMILIES ?? ['temporal', 'conflict_lifecycle', 'multi_hop_relation', 'near_collision_abstention'];

/**
 * Run all four §17.48 baselines over `tasks`. Each task may carry a `family` tag for
 * per-family tallies and a `program` for the own-control check. `opts.judge` /
 * `opts.rerankerScore` inject a live scorer (default: the deterministic oracle).
 */
export function runBaselineBatteryCensus({ tasks, opts = {} } = {}) {
  const strategies = ['rerankerReadingCompiler', 'exhaustiveProgramSearch', 'rawReranker', 'indexer'];
  const total = Object.fromEntries(strategies.map((s) => [s, 0]));
  const byFamily = Object.fromEntries(strategies.map((s) => [s, {}]));
  for (const s of strategies) for (const f of FAMILIES) byFamily[s][f] = 0;
  let ownControlFail = 0;
  const minimalStepSigs = new Set();

  for (const task of tasks) {
    const fam = task.family;
    if (task.program && bmuBaselineJudgeProgram(task.program, task).utility !== 1) ownControlFail += 1;
    const verdicts = {
      rerankerReadingCompiler: rerankerReadingCompilerSolves(task, opts).baselineSolvable,
      exhaustiveProgramSearch: (() => {
        const v = exhaustiveMinimalProgramSearch(task, opts);
        if (v.baselineSolvable && v.minimalStepSig) minimalStepSigs.add(v.minimalStepSig);
        return v.baselineSolvable;
      })(),
      rawReranker: rawRerankerBaselineSolves(task, opts).baselineSolvable,
      indexer: indexerBaselineSolves(task).baselineSolvable,
    };
    for (const s of strategies) {
      if (verdicts[s]) { total[s] += 1; if (fam && byFamily[s][fam] !== undefined) byFamily[s][fam] += 1; }
    }
  }
  return { count: tasks.length, ownControlFail, total, byFamily, minimalStepSigs: [...minimalStepSigs].sort() };
}

/** Current-corpus adapter: the real 144-class catalog for each era → generic tasks. */
export function censusFromEraCatalog({ dist, era }) {
  const catalog = buildClassCatalog({ eras: [era], queryKeyOf: dist.bmuOperationQueryKey });
  const tasks = [...catalog.values()].map((c) => ({
    relations: c.relations,
    seedId: c.seedId,
    goldId: [...c.requiredTerminals][0],
    trapId: c.trapId,
    requiredIds: [...c.requiredIds],
    forbiddenIds: [...c.forbiddenIds],
    program: c.program,
    family: c.family,
  }));
  return runBaselineBatteryCensus({ tasks });
}

async function main() {
  const dist = await import('@botcoin/coretex/full').catch(() => import('../../../packages/coretex/dist/index.js'));
  const rows = [];
  for (const era of [1, 2, 3]) {
    const r = censusFromEraCatalog({ dist, era });
    rows.push({ era, ...r });
    console.log(`\n=== ERA ${era}: ${r.count} clusters (ownControlFail=${r.ownControlFail}) ===`);
    for (const s of Object.keys(r.total)) {
      console.log(`  ${s.padEnd(24)} ${String(r.total[s]).padStart(3)}/${r.count}   byFamily=${JSON.stringify(r.byFamily[s])}`);
    }
  }
  console.log('\nLEGEND: reranker-reading + exhaustive DEFEAT the current corpus (it publishes its own');
  console.log('solution, §17.44 finding 3); raw-reranker + indexer are FLOORS (the memory op is load-bearing).');
  return rows;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
