/**
 * BMU P5 headroom accounting law (honesty-critical — handoff P5 task 3).
 *
 * "Achievable utility" per pack = ORACLE-JUDGE bound (qrels + the production
 * deterministic judge — computable without a reranker) MINUS the BASE-STACK
 * floor. The floor is the P2 certification calibration (no-substrate
 * BGE(+Qwen) u-rates per family) — NEVER the deterministic reranker, which is
 * BANNED for mineability claims (unstall-plan G0B lesson).
 *
 * The oracle bound is EXECUTED through the production judge
 * (`bmuJudgeTopB` + `computeBmuTaskUtility`, injected from the built
 * package): for each task we build the oracle final ordering — required
 * evidence ranked by the family's memory operation (descending qrel,
 * forbidden traps evicted below the fold) — and ask the real judge + real
 * utility law whether u = 1 is reachable at the task's budget. This mirrors
 * the P2 certification oracle (G-B2, measured rate 1.0 on all four family
 * banks).
 *
 * P2-CALIBRATED BASE-STACK FLOORS (u-rate per family; every cap logged):
 *   - multi_hop_relation: 0.0  — REAL LANE BGE+Qwen, 15/120 rows measured,
 *     u = 0 on all (p2-multi_hop_relation/certification.json realLaneCoverage
 *     + G-B1 row). CAP: 15-row subsample.
 *   - conflict_lifecycle: 0.0  — REAL LANE BGE-only, 10/120 rows measured,
 *     u = 0 (p2-conflict_lifecycle real-lane-scores.bge-only.json). CAP:
 *     BGE-only (Qwen reranker leg open in P2), 10-row subsample.
 *   - temporal: 0.0 — REAL LANE NOT RUN in P2 (rowsMeasured 0; open ledger
 *     item). Floor taken as 0 with the trivial-baseline ceiling logged:
 *     max trivial uRate 0.011 (randomK). CAP: unmeasured real lane —
 *     P5 leg-3 real-Qwen sampling is the closing evidence.
 *   - near_collision_abstention: 0.0 — REAL LANE NOT RUN in P2 (rowsMeasured
 *     0). Trivial-baseline ceiling: randomK judgeSuccessRate 0.022. CAP as
 *     temporal.
 *
 * All shares/ppm here are ORACLE-ACCOUNTING quantities for the lifecycle
 * simulation — they are NOT reranker scores and are never presented as
 * measured mineability (that is what the P5 real-Qwen legs sample).
 */

export const BMU_SIM_BASE_STACK_FLOORS = Object.freeze({
  temporal: {
    floorURate: 0,
    source: 'P2 real lane NOT RUN (rowsMeasured 0); trivial-baseline max uRate 0.011 (randomK)',
    caps: ['real-lane unmeasured in P2 — validated by P5 leg-3 real-Qwen sampling'],
  },
  conflict_lifecycle: {
    floorURate: 0,
    source: 'P2 real lane BGE-only 10/120 rows, u=0 on all measured',
    caps: ['BGE-only (P2 Qwen leg open)', '10-row subsample'],
  },
  multi_hop_relation: {
    floorURate: 0,
    source: 'P2 real lane BGE+Qwen 15/120 rows, u=0 on all measured',
    caps: ['15-row subsample'],
  },
  near_collision_abstention: {
    floorURate: 0,
    source: 'P2 real lane NOT RUN (rowsMeasured 0); trivial-baseline randomK judgeSuccessRate 0.022',
    caps: ['real-lane unmeasured in P2 — validated by P5 leg-3 real-Qwen sampling'],
  },
});

/**
 * Build the ORACLE final ordering for one task over its row's doc universe and
 * run the production judge. The oracle models the family's memory operation
 * performed perfectly: required evidence (answer included, §4.1) promoted in
 * descending qrel, every other doc — traps included — demoted below it. Scores
 * are placed on distinct judge-grid cells so the ordering is grid-stable.
 *
 * Returns { achievable: 0|1, failure? } via the REAL `computeBmuTaskUtility`.
 */
export function oracleTaskUtility({ event, judge }) {
  const { bmuJudgeTopB, computeBmuTaskUtility } = judge;
  const task = event.bmuTask;
  if (!task) throw new Error(`oracleTaskUtility: event ${event.id} has no bmuTask`);
  const relOf = new Map((event.qrels ?? []).map((q) => [q.documentId ?? q.docId, q.relevance]));
  const docIds = new Set([
    ...(event.truthDocuments ?? []).map((d) => d.id),
    ...(event.hardNegatives ?? []).map((d) => d.id),
    ...task.requiredEvidence,
    ...task.forbiddenEvidence,
  ]);
  const required = new Set(task.requiredEvidence);
  const forbidden = new Set(task.forbiddenEvidence);
  const grid = 1e-3; // BMU_JUDGE_SCORE_GRID_DEFAULT (bundle pin)
  // The oracle's memory operation: promote required evidence, EVICT the
  // forbidden traps below everything (trap eviction IS the operation — §2.2;
  // without explicit demotion the traps out-rank honestly by construction and
  // the bound degenerates to the base-stack floor).
  const tier = (id) => (required.has(id) ? 2 : forbidden.has(id) ? 0 : 1);
  const sorted = [...docIds].sort((a, b) => {
    const tA = tier(a);
    const tB = tier(b);
    if (tA !== tB) return tB - tA;
    const relA = relOf.get(a) ?? 0;
    const relB = relOf.get(b) ?? 0;
    if (relA !== relB) return relB - relA;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const nonForbidden = sorted.filter((id) => !forbidden.has(id)).length;
  const fillerNeeded = Math.max(0, task.budgetB - nonForbidden);
  for (let i = 0; i < fillerNeeded; i++) {
    sorted.splice(nonForbidden + i, 0, `__bmu_oracle_neutral_${event.id}_${i}`);
  }
  // Distinct grid cells, descending: cell i gets score (N - i) * grid * 2.
  const entries = sorted.map((docId, i) => ({
    docId,
    rerankerScore: (sorted.length - i) * grid * 2,
    finalReorderingScore: (sorted.length - i) * grid * 2,
  }));
  const topB = bmuJudgeTopB(entries, task.budgetB, grid);
  // Oracle abstention behaviour is the CORRECT policy decision per task.
  const u = computeBmuTaskUtility({ task, topB, abstainSignal: task.abstain === true });
  return { achievable: u.utility, ...(u.failure !== undefined ? { failure: u.failure } : {}) };
}

/**
 * Per-pack headroom accounting.
 *   achievable(f) = Σ oracle-achievable rows of family f (bound; u ∈ {0,1})
 *   floor(f)      = floorURate_f × family row count (P2-calibrated base stack)
 *   realized(f)   = rows whose motifGroup the simulated miner has SOLVED
 *                   (solved = the real memory operation performed; realizes
 *                   the oracle bound on those rows)
 *   headroom(f)   = achievable − floor − realized   (unconsumed real headroom)
 *
 * Returns row counts + ppm (row-flip quanta over the ACTUAL pack size).
 */
export function packHeadroom({ pack, solvedMotifGroups, judge, floors = BMU_SIM_BASE_STACK_FLOORS, oracleCache = null }) {
  const families = ['temporal', 'conflict_lifecycle', 'multi_hop_relation', 'near_collision_abstention'];
  const per = {};
  for (const f of families) per[f] = { rows: 0, achievable: 0, floorRows: 0, realized: 0, headroomRows: 0 };
  const oracleFailures = [];
  for (const event of pack.events) {
    const task = event.bmuTask;
    if (!task) continue; // non-BMU row (pre-flip live-tail remnant) — no BMU headroom
    const fam = task.family;
    per[fam].rows += 1;
    let o = oracleCache?.get(event.id);
    if (!o) {
      o = oracleTaskUtility({ event, judge });
      oracleCache?.set(event.id, o);
    }
    per[fam].achievable += o.achievable;
    if (o.achievable !== 1) oracleFailures.push({ id: event.id, failure: o.failure ?? null });
    if (solvedMotifGroups.has(task.motifGroupId)) per[fam].realized += o.achievable;
  }
  const packSize = pack.events.length;
  const quantumPpm = 1_000_000 / packSize;
  let totals = { rows: 0, achievable: 0, floorRows: 0, realized: 0, headroomRows: 0 };
  for (const f of families) {
    per[f].floorRows = per[f].rows * (floors[f]?.floorURate ?? 0);
    per[f].headroomRows = per[f].achievable - per[f].floorRows - per[f].realized;
    for (const k of Object.keys(totals)) totals[k] += per[f][k];
  }
  return {
    packSize,
    quantumPpm,
    perFamily: per,
    totals,
    headroomPpm: totals.headroomRows * quantumPpm,
    realizedPpm: totals.realized * quantumPpm,
    achievablePpm: totals.achievable * quantumPpm,
    oracleFailures,
  };
}
