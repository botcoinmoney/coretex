/**
 * §18 ERA-1 → ERA-2 GRAMMAR-TRANSITION simulator (era-2 iteration — this lane).
 *
 * Proves, end-to-end and deterministically (no Qwen, no Date.now/Math.random),
 * that the §18 grammar-era rotation machinery works:
 *
 *   1. era-2 mints 36 FRESH liftable classes per family, disjoint from era-1;
 *   2. era-1 retirement makes prior-era residents COSTLESSLY evictable;
 *   3. MINER TRANSFER stays honest — a miner's era-1 programs do NOT auto-solve
 *      era-2 clusters (they must re-discover, capped by the cross-family census);
 *   4. costly-eviction NET stays > 0 across the rotation (ROTATING arm) while a
 *      STATIC frontier drives net → 0 (control arm) — the §17.26 contrast.
 *
 * FIDELITY: this operates on REAL APPLIED BOUNDED STATES, not oracle motif
 * accounting. The miner's resident program set is encoded into an actual
 * CortexState (words 384–511, ≤32 four-word quads — the honest resident
 * capacity) via `encodeBmuPublicPathProgramWords`, decoded via
 * `decodeBmuPublicPathPrograms`, and each cluster is SOLVED by executing the
 * decoded program over the cluster's canonical deep-terminal topology
 * (`buildProgramPathTopology` + `executeProgramOverRelations` — the CPU
 * reference walker that mirrors the compiled scorer byte-law). A resident that
 * covers no active (non-retired) motif contributes ZERO to utility BY
 * CONSTRUCTION, so its eviction costs zero — the exact mechanism the runway
 * verdict rests on.
 *
 * COUNTERFACTUAL per accept-with-eviction: ΔU = U(candidateState) −
 * U(parentState) on the active workload, both computed from applied bounded
 * states. The eviction-cost component = U lost on the evicted program's
 * still-active clusters. Emitted per eviction in the transition journal (v3).
 *
 * STOP-LINE: build+test+prove; arms nothing; mutates no production state.
 */
import { createHash } from 'node:crypto';
import {
  programBankForEra,
  executableOperationForFamilySlot,
  buildProgramPathTopology,
  executeProgramOverRelations,
  eraSpec,
} from '../bmu-generators/operation-program.mjs';
import {
  makeEraSchedule,
  genesisEraSchedule,
  activeEraForEpoch,
  eraTransitionAt,
  eraFrontierId,
  inCoexistenceWindow,
  retirementEligiblePriorEra,
  buildEraJournalEvolveRecord,
  emptyFamilyCounts,
  ERA_JOURNAL_FAMILIES as FAMILIES,
} from './era-schedule.mjs';

const CAPACITY = 32;              // (511-384+1)/4 honest resident program quads
const CLASSES_PER_FAMILY = 36;

/** Cue-agnostic program step-signature (the transfer/dedup census key). */
export function stepSigOf(program) {
  return `${program.steps.map((s) => `${s.direction}:${s.edgeType}${s.suppress ? ':sup' : ''}${s.offPathSuppress ? ':off' : ''}`).join('/')}|b${program.branchLimit}`;
}

/**
 * §17.35 — the family SEED ROLE, derived from the program's flags. A program that
 * carries `suppress` evicts on-route lineage, so its family's SEED is a FORBIDDEN
 * query-similar trap that MUST be evicted. A program that carries only
 * `offPathSuppress` spares on-route lineage, so its family's on-route SEED/bridge
 * is REQUIRED. (A pure-promote program is treated as required-seed.)
 */
export function seedRoleOf(program) {
  return program.steps.some((s) => s.suppress) ? 'forbidden' : 'required';
}

/**
 * §17.35 CREDITED UTILITY — the ONLY thing the scorer credits:
 * u = 1 iff required ⊆ topB ∧ forbidden ∩ topB = ∅ (set membership;
 * `computeBmuTaskUtility` does NOT read the promote/demote signature).
 *
 * We model topB the way the real judge would rank the credited-relevant pool:
 * every query-similar FORBIDDEN doc (the trap + a forbidden seed) is a strong
 * stage-1 competitor (baseline 3 — it LOOKS most relevant, that is the trap);
 * REQUIRED docs are retrievable (baseline 1); the operation then PROMOTES (+1) or
 * DEMOTES (−3, enough to drop a query-similar competitor below a required doc) via
 * its real executed promote/demote sets. topB = the top `|required|` by
 * (score desc, docId asc). A wrong-family operation that fails to demote a
 * forbidden doc (wrong seed-role flag) or demotes a required one (wrong seed-role
 * flag) or leaves a forbidden trap at the wrong depth undemoted → fails credited.
 */
export function creditedUtility({ exec, requiredIds, forbiddenIds }) {
  const promoted = new Set([...exec.promoteTerminalIds, ...exec.promotePathNodeIds]);
  const demoted = new Set([...exec.suppressTerminalIds, ...exec.suppressLineageIds, ...exec.offPathSuppressedIds]);
  const req = [...requiredIds];
  const forb = [...forbiddenIds];
  const baseline = (id) => (forbiddenIds.has(id) ? 3 : requiredIds.has(id) ? 1 : 0);
  const score = (id) => baseline(id) + (promoted.has(id) ? 1 : 0) + (demoted.has(id) ? -3 : 0);
  const pool = [...new Set([...req, ...forb])];
  const budgetB = req.length;
  const topB = new Set(pool
    .map((id) => ({ id, s: score(id) }))
    .sort((a, b) => (b.s - a.s) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, budgetB)
    .map((x) => x.id));
  for (const f of forb) if (topB.has(f)) return { utility: 0, failure: 'forbidden_admitted', topB: [...topB] };
  for (const r of req) if (!topB.has(r)) return { utility: 0, failure: 'missing_required', topB: [...topB] };
  return { utility: 1, topB: [...topB] };
}

/**
 * The full per-era, per-family class catalog: 36 executable operations per
 * (family, era). Each carries the canonical operationClass, cue, program (with
 * the family suppress overlay), queryKey, cue-agnostic stepSig, and a
 * deterministic canonical deep-terminal topology whose executed terminals equal
 * its single required-answer terminal.
 */
export function buildClassCatalog({ eras, queryKeyOf }) {
  const catalog = new Map(); // classKey "e<era>:<family>:<ordinal>" -> record
  for (const era of eras) {
    const bank = programBankForEra(era);
    // §17.32: for an era with a per-family operation plan (era-3), the family's
    // forbidden trap sits at the family's suppress DEPTH so the (depth,flag)
    // correctly evicts it. Otherwise the trap is a depth-1 dead end (era-1/2).
    const spec = eraSpec(era);
    const trapDepthOf = (family) => spec.familyOperationPlan?.[family]?.step ?? 1;
    for (const family of FAMILIES) {
      const decoyDepth = trapDepthOf(family);
      for (let ordinal = 0; ordinal < bank.length; ordinal++) {
        const op = executableOperationForFamilySlot(family, ordinal * 2, { era });
        const program = { branchLimit: op.operationProgram.branchLimit, steps: op.operationProgram.steps };
        const queryKey = queryKeyOf(op.operationCue);
        const classKey = `e${era}:${family}:${ordinal}`;
        const mg = `mg_${classKey}`;
        const trapId = `${mg}_trap`;
        const topology = buildProgramPathTopology({
          program,
          seedId: `${mg}_seed`,
          sinkIds: [`${mg}_sink`],
          goldIds: [`${mg}_gold`],
          decoyIds: [trapId],
          midIdFor: (level) => `${mg}_mid${level}`,
          decoyDepth,
        });
        // Correctness of the family operation (verified by REAL execution): the
        // (depth,flag) program must DEMOTE the trap at its depth and PROMOTE the
        // gold terminal — no assertion, actual walk over the relations.
        const exec = executeProgramOverRelations({ program, relations: topology.relations, seedIds: [`${mg}_seed`], branchLimit: program.branchLimit });
        const demoted = new Set([...exec.suppressLineageIds, ...exec.suppressTerminalIds, ...exec.offPathSuppressedIds]);
        const trapDemoted = demoted.has(trapId);
        const goldPromoted = exec.promoteTerminalIds.includes(`${mg}_gold`);
        // §17.35 REAL SEED ROLE (the verifier's correction): the seed is NOT a
        // neutral relay. For a forbidden-seed family the seed is a query-similar
        // FORBIDDEN doc that must be evicted; for a required-seed family the seed is
        // REQUIRED evidence. Own-control is now the CREDITED predicate on the REAL
        // seed, not "trap demoted on a neutral seed".
        const seedId = `${mg}_seed`;
        const goldId = `${mg}_gold`;
        const seedRole = seedRoleOf(program);
        const requiredIds = new Set(seedRole === 'required' ? [goldId, seedId] : [goldId]);
        const forbiddenIds = new Set(seedRole === 'forbidden' ? [trapId, seedId] : [trapId]);
        const credited = creditedUtility({ exec, requiredIds, forbiddenIds });
        catalog.set(classKey, Object.freeze({
          classKey, era, family, ordinal, decoyDepth, trapId,
          operationClass: op.operationClass,
          operationClassBasis: op.operationClassBasis,
          cue: op.operationCue,
          program: Object.freeze(program),
          queryKey,
          stepSig: stepSigOf(program),
          relations: topology.relations,
          seedId,
          seedRole,
          requiredIds: Object.freeze([...requiredIds]),
          forbiddenIds: Object.freeze([...forbiddenIds]),
          requiredTerminals: new Set(topology.terminalIds),
          trapDemoted, goldPromoted,
          // legacy signature-level flag (kept for back-compat / dist-identity)
          operationCorrect: trapDemoted && goldPromoted,
          // §17.35 THE credited-metric own-control (required⊆topB ∧ forbidden∩topB=∅)
          creditedUtility: credited.utility,
          creditedCorrect: credited.utility === 1,
          creditedFailure: credited.failure ?? null,
          demotionSig: JSON.stringify([[...exec.suppressLineageIds].sort(), [...exec.offPathSuppressedIds].sort()]),
        }));
      }
    }
  }
  return catalog;
}

/**
 * §17.35 CREDITED cross-family transfer census — the CORRECTED transfer metric.
 * The old A5 metric asked "does a wrong-family program reproduce the full
 * promote/demote SIGNATURE?" — a quantity the scorer never reads. This asks the
 * quantity the scorer credits: does family g's program achieve CREDITED UTILITY
 * (required⊆topB ∧ forbidden∩topB=∅) on family f's cluster (f≠g)? Real execution
 * of g's program over f's cluster relations + the credited predicate on f's REAL
 * seed role. Returns own-control per family + the true credited transfer count.
 */
export function creditedCrossFamilyTransferCensus({ era, queryKeyOf }) {
  const catalog = buildClassCatalog({ eras: [era], queryKeyOf });
  const clusters = [...catalog.values()];
  const byFamily = {};
  for (const c of clusters) (byFamily[c.family] ??= []).push(c);
  const families = Object.keys(byFamily);
  const creditedOn = (program, cluster) => {
    let exec;
    try {
      exec = executeProgramOverRelations({ program, relations: cluster.relations, seedIds: [cluster.seedId], branchLimit: program.branchLimit });
    } catch { return { utility: 0, failure: 'fail_closed' }; }
    return creditedUtility({ exec, requiredIds: new Set(cluster.requiredIds), forbiddenIds: new Set(cluster.forbiddenIds) });
  };
  const ownControlByFamily = {};
  for (const f of families) ownControlByFamily[f] = byFamily[f].filter((c) => creditedOn(c.program, c).utility === 1).length;
  let creditedTransfers = 0;
  const transferPairs = {};
  for (const f of families) {
    for (const cluster of byFamily[f]) {
      for (const g of families) {
        if (g === f) continue;
        for (const other of byFamily[g]) {
          if (other.ordinal !== cluster.ordinal) continue; // ordinal-matched program
          if (creditedOn(other.program, cluster).utility === 1) {
            creditedTransfers += 1;
            const key = `${g}->${f}`;
            transferPairs[key] = (transferPairs[key] ?? 0) + 1;
          }
        }
      }
    }
  }
  const perFamilyCount = Object.fromEntries(families.map((f) => [f, byFamily[f].length]));
  return {
    era,
    families,
    clustersPerFamily: perFamilyCount,
    ownControlByFamily,
    ownControlAllPass: families.every((f) => ownControlByFamily[f] === byFamily[f].length),
    creditedCrossFamilyTransfers: creditedTransfers,
    transferPairs,
    // distinct credited operation-classes = distinct (seedRole, demoted-trap-depth)
    creditedOperationClasses: [...new Set(clusters.map((c) => `${c.seedRole}@${c.decoyDepth}`))].sort(),
  };
}

/**
 * Does an APPLIED resident program solve a cluster? Real execution: run the
 * resident program over the cluster's canonical relations from its public seed;
 * solved iff the routed terminal set equals the cluster's required terminals.
 * A cross-class / wrong-era program routes empty or wrong terminals → not
 * solved. (Programs are matched to clusters by queryKey — a resident quad must
 * carry the cluster's queryKey to be a candidate at all.)
 */
function programSolvesCluster(program, cluster) {
  let out;
  try {
    out = executeProgramOverRelations({
      program,
      relations: cluster.relations,
      seedIds: [cluster.seedId],
      branchLimit: program.branchLimit,
    });
  } catch {
    return false; // ambiguous-lineage / fail-closed ⇒ unsolved
  }
  const got = new Set(out.terminalIds);
  if (got.size !== cluster.requiredTerminals.size) return false;
  for (const t of cluster.requiredTerminals) if (!got.has(t)) return false;
  return true;
}

/**
 * A bounded (≤32 quad) miner resident store backed by a REAL CortexState.
 * Residency key = queryKey (a resident quad must carry the cluster's queryKey).
 * First-DISCOVERY is keyed on stepSig (cue-agnostic bytecode): re-learning a
 * queryKey whose stepSig is already resident/known is a rekey/solver-equivalent
 * move with NO first-discovery credit — this is exactly the cross-family
 * dedup collapse expressed dynamically.
 */
function createBoundedResidentStore({ encodeWords, decodeState, wordCount }) {
  const residents = []; // FIFO: [{ queryKey, program, family, cue, operationClass, stepSig, era, learnedEpoch }]
  const evictedQueryKeys = new Set();
  const discoveredStepSigs = new Set();
  const applyState = () => {
    const words = new Array(Number(wordCount)).fill(0n);
    residents.forEach((r, i) => {
      const quad = encodeWords({ branchLimit: r.program.branchLimit, queryKey: r.queryKey, validFromEpoch: 0n, expiryEpoch: 0n, steps: r.program.steps });
      for (let w = 0; w < 4; w++) words[384 + i * 4 + w] = quad[w];
    });
    return { words };
  };
  return {
    residents,
    size: () => residents.length,
    isFull: () => residents.length >= CAPACITY,
    hasQueryKey: (qk) => residents.some((r) => r.queryKey === qk),
    hasStepSig: (sig) => residents.some((r) => r.stepSig === sig),
    wasEvicted: (qk) => evictedQueryKeys.has(qk),
    wasDiscovered: (sig) => discoveredStepSigs.has(sig),
    peekEviction: () => (residents.length >= CAPACITY ? residents[0] : null),
    /** Verify the applied bounded state decodes to exactly the resident set. */
    verifyAppliedState: () => {
      if (residents.length > CAPACITY) throw new Error(`resident store overflow ${residents.length} > ${CAPACITY}`);
      const decoded = decodeState(applyState());
      const decodedKeys = new Set(decoded.programs.map((p) => p.queryKey));
      const residentKeys = new Set(residents.map((r) => r.queryKey));
      if (decoded.programs.length !== residents.length) return false;
      for (const k of residentKeys) if (!decodedKeys.has(k)) return false;
      return decoded.failures === 0;
    },
    learn: (record, epoch) => {
      let evicted = null;
      if (residents.length >= CAPACITY) {
        evicted = residents.shift();
        evictedQueryKeys.add(evicted.queryKey);
      }
      residents.push({ ...record, learnedEpoch: epoch });
      discoveredStepSigs.add(record.stepSig);
      return { evicted };
    },
    appliedState: applyState,
  };
}

// ─── the world: mint → frontier(retirement) → miner accept/evict/journal ─────

/**
 * §17.39 item-4 — the 2×2 isolation of the two runway mechanisms (grammar era
 * ROTATION × workload RETIREMENT) the operator asked for, replacing the prior
 * two-arm rotating/static design that only tested them COUPLED. Retirement is now
 * ERA-AWARE (schedule-driven), not the old era-blind age-TTL sweep that
 * "manufactured free churn" (every eviction costless because the workload aged out
 * in lockstep with the retirement cadence):
 *
 *   | arm                | rotation | retirement            |
 *   |--------------------|----------|-----------------------|
 *   | static             | no       | none                  | net→0  (no renewal)
 *   | retire-only        | no       | age-TTL (OLD defect)  | net>0 but FREE CHURN — the isolated gimmick
 *   | rotate-no-retire   | yes      | none                  | net→0  (fresh classes alone don't free slots)
 *   | rotating           | yes      | era-aware             | net>0 GENUINE (prior-era retirement frees slots)
 *
 * `retire-only` retains the OLD era-blind age-TTL sweep ON PURPOSE: it EXPOSES that
 * age-TTL alone reproduces the "sustainable" number with ZERO genuine rotation —
 * proving the pre-fix coupled sim's net>0 was the retirement mechanism (free churn),
 * not the rotation. The diagnostic is `retiredCurrentEra` vs `retiredPriorEra`:
 * retire-only retires 100% CURRENT-era live workload (unjustified — a real scorer
 * still queries those motifs); rotating retires 100% PRIOR-era workload the grammar
 * has genuinely rotated past (obsolete). era-aware costlessness is therefore only
 * legitimate BECAUSE it is tied to the honest disjoint-grammar rotation
 * (crossEraTransferAudit) — it is not a bare unit awarded per eviction.
 *
 * @param {object} opts
 * @param {'rotating'|'static'|'retire-only'|'rotate-no-retire'} opts.arm
 * @param {'net-positive'|'frontier-chase'} opts.admissionPolicy — net-positive is
 *   the greedy miner that breaks when no candidate has positive net (never makes a
 *   costly eviction by construction); frontier-chase models a miner that chases the
 *   freshest workload and admits the newest class with any live instance even at
 *   net≤0, FORCING a FIFO eviction of a still-covered CURRENT-era resident — the
 *   §17.39 item-4 "current-era eviction must be recorded COSTLY" control.
 * @param {object} opts.dist — built @botcoin/coretex (encode/decode/queryKey).
 * @param {number} opts.transitionEpoch — epoch toEra activates (rotating arms).
 */
const ARM_CONFIG = Object.freeze({
  rotating: { rotates: true, retirementMode: 'era-aware' },
  static: { rotates: false, retirementMode: 'none' },
  'retire-only': { rotates: false, retirementMode: 'age-ttl' },
  'rotate-no-retire': { rotates: true, retirementMode: 'none' },
});
export function runEraTransition({
  arm = 'rotating',
  admissionPolicy = 'net-positive',
  dist,
  fromEra = 1,
  toEra = 2,
  evolves = 48,
  cadenceEpochs = 8,
  armEpoch = 152,
  maxAgeEpochs = 32,
  transitionEpoch = 152 + 24 * 8, // mid-horizon by default
  mintPerFamilyPerEvolve = 2,
}) {
  const armConfig = ARM_CONFIG[arm];
  if (!armConfig) throw new Error(`runEraTransition: bad arm ${arm}`);
  if (!['net-positive', 'frontier-chase'].includes(admissionPolicy)) {
    throw new Error(`runEraTransition: bad admissionPolicy ${admissionPolicy}`);
  }
  const { rotates, retirementMode } = armConfig;
  const schedule = rotates
    ? makeEraSchedule([
      { era: fromEra, activationEpoch: -Infinity },
      { era: toEra, activationEpoch: transitionEpoch, coexistenceWindowEpochs: maxAgeEpochs, retireGraceEpochs: 0 },
    ])
    : genesisEraSchedule(fromEra);

  const catalog = buildClassCatalog({ eras: [fromEra, toEra], queryKeyOf: dist.bmuOperationQueryKey });
  const byEraFamOrdinal = (era, family, ordinal) => catalog.get(`e${era}:${family}:${ordinal % CLASSES_PER_FAMILY}`);
  // operation-correctness gate: every minted era's family operation must evict
  // its trap and promote its gold (real execution, computed in buildClassCatalog).
  const operationsAllCorrect = [...catalog.values()].every((c) => c.operationCorrect);

  const store = createBoundedResidentStore({
    encodeWords: dist.encodeBmuPublicPathProgramWords,
    decodeState: dist.decodeBmuPublicPathPrograms,
    wordCount: dist.WORD_COUNT_VALUE ?? 1024n,
  });

  // Active workload = live cluster INSTANCES (motif instances of a class). Each
  // mint appends instances; ERA-AWARE retirement drops only genuinely-obsolete
  // prior-era instances (rotating); age-TTL drops any aged instance (retire-only);
  // static / rotate-no-retire never retire.
  let activeInstances = []; // [{ classKey, mintEpoch, instanceId }]
  const retirementEvents = [];
  const perEvolveJournal = [];
  const acceptJournal = [];
  const mintCursor = Object.fromEntries(FAMILIES.map((f) => [f, 0]));

  // per-family running counters (P5-schema names)
  const netAcceptedByFamily = emptyFamilyCounts();
  const netAcceptedAfterTransitionByFamily = emptyFamilyCounts();
  const netAcceptedAfterCapacityByFamily = emptyFamilyCounts();
  // §17.39 item-4 honest headroom accounting after the store saturates:
  //   costlyAfterCapacity — accepts that FIFO-evicted a still-covered resident;
  //   costlessFirstDiscoveryAfterCapacity — genuine first-discoveries whose eviction
  //     was costless (the real sustained-headroom feedstock).
  const costlyAfterCapacityByFamily = emptyFamilyCounts();
  const costlessFirstDiscoveryAfterCapacityByFamily = emptyFamilyCounts();
  const grossWouldAcceptByFamily = emptyFamilyCounts();
  const firstDiscoveryStepSigs = new Set();
  const firstDiscoveryByEra = { [fromEra]: new Set(), [toEra]: new Set() };
  const reloadCount = emptyFamilyCounts();
  const rekeyCount = emptyFamilyCounts();
  let globalCapacityReachedEpoch = null;

  const rowQuantum = 1; // one solved active instance = one utility unit
  // U(state, workload): count active instances solved by an APPLIED resident.
  const utilityOf = (residentSet) => {
    const residentByQueryKey = new Map(residentSet.map((r) => [r.queryKey, r]));
    let u = 0;
    for (const inst of activeInstances) {
      const cluster = catalog.get(inst.classKey);
      const r = residentByQueryKey.get(cluster.queryKey);
      if (r && programSolvesCluster(r.program, cluster)) u += 1;
    }
    return u;
  };
  const activeInstancesForQueryKey = (queryKey) =>
    activeInstances.filter((inst) => catalog.get(inst.classKey).queryKey === queryKey).length;

  const finalEpoch = armEpoch + evolves * cadenceEpochs;
  let evolveIndex = 0;
  let instanceSeq = 0;

  for (let epoch = armEpoch + 1; epoch <= finalEpoch; epoch++) {
    const isEvolve = (epoch - armEpoch) % cadenceEpochs === 0;
    if (!isEvolve) continue;
    evolveIndex += 1;
    const era = activeEraForEpoch(schedule, epoch);

    // ── mint: mintPerFamilyPerEvolve instances per family of the active era ──
    const mintedThisEvolve = [];
    for (const family of FAMILIES) {
      for (let k = 0; k < mintPerFamilyPerEvolve; k++) {
        const ordinal = Math.floor(mintCursor[family] / 2) % CLASSES_PER_FAMILY;
        mintCursor[family] += 1;
        const cluster = byEraFamOrdinal(era, family, ordinal);
        const inst = { classKey: cluster.classKey, mintEpoch: epoch, instanceId: `inst_${instanceSeq++}` };
        activeInstances.push(inst);
        mintedThisEvolve.push(inst);
      }
    }

    // ── frontier retirement — ERA-AWARE (§17.39 item-4 fix) ──────────────────
    // The prior era-blind `epoch - mintEpoch >= maxAge` sweep retired CURRENT-era
    // residents too, shrinking the live workload in lockstep with the retirement
    // cadence so every eviction came out costless ("manufactured free churn").
    // Now:
    //   era-aware  — retire ONLY instances of the schedule's retirement-eligible
    //                PRIOR era, and only once the coexistence window has closed
    //                (genuinely obsolete: the grammar rotated past them). A
    //                current-era instance is NEVER age-expired.
    //   age-TTL    — the OLD defect, retained ONLY on the `retire-only` control to
    //                isolate/expose the gimmick (era-blind age sweep, no rotation).
    //   none       — no retirement (static / rotate-no-retire).
    const retirementsByFamily = emptyFamilyCounts();
    const activeEraNow = activeEraForEpoch(schedule, epoch);
    if (retirementMode === 'era-aware') {
      const eligiblePriorEra = retirementEligiblePriorEra(schedule, epoch); // era id or null
      const coexisting = inCoexistenceWindow(schedule, epoch);
      if (eligiblePriorEra !== null && !coexisting) {
        const survivors = [];
        for (const inst of activeInstances) {
          const cluster = catalog.get(inst.classKey);
          // Only genuinely-obsolete PRIOR-era instances retire. Recomputed from
          // the ACTUAL active-instance catalog era, not an age assumption.
          if (cluster.era === eligiblePriorEra && cluster.era < activeEraNow) {
            retirementsByFamily[cluster.family] += 1;
            retirementEvents.push({ epoch, instanceId: inst.instanceId, classKey: inst.classKey, era: cluster.era, family: cluster.family, ageEpochs: epoch - inst.mintEpoch, reason: 'prior-era-obsolete', currentEraAtRetire: false });
          } else {
            survivors.push(inst);
          }
        }
        activeInstances = survivors;
      }
    } else if (retirementMode === 'age-ttl') {
      // OLD era-blind mechanism (isolated on `retire-only`): retire ANY instance
      // past maxAge, current-era included — this is the free-churn gimmick.
      const survivors = [];
      for (const inst of activeInstances) {
        if (epoch - inst.mintEpoch >= maxAgeEpochs) {
          const cluster = catalog.get(inst.classKey);
          retirementsByFamily[cluster.family] += 1;
          retirementEvents.push({ epoch, instanceId: inst.instanceId, classKey: inst.classKey, era: cluster.era, family: cluster.family, ageEpochs: epoch - inst.mintEpoch, reason: 'age-ttl', currentEraAtRetire: cluster.era === activeEraNow });
        } else {
          survivors.push(inst);
        }
      }
      activeInstances = survivors;
    }

    // ── miner: greedy-new-class over the active workload (one attempt/family) ──
    // rotation order rotates families by evolve for balance.
    const rotation = [...FAMILIES.slice(evolveIndex % FAMILIES.length), ...FAMILIES.slice(0, evolveIndex % FAMILIES.length)];
    const acceptedByFamily = emptyFamilyCounts();
    const gateConfirmAcceptedByFamily = emptyFamilyCounts();
    const evictionDetail = [];

    // candidate = an active class whose queryKey is NOT resident (unsolved),
    // preferring the freshest era. Solve as many as the store can net-admit
    // this evolve (bounded by mintPerFamilyPerEvolve attempts/family).
    for (const family of rotation) {
      for (let attempt = 0; attempt < mintPerFamilyPerEvolve; attempt++) {
        // pick the newest active unsolved class of this family
        const candidateInst = [...activeInstances]
          .filter((inst) => {
            const c = catalog.get(inst.classKey);
            return c.family === family && !store.hasQueryKey(c.queryKey);
          })
          .sort((a, b) => (b.mintEpoch - a.mintEpoch))[0];
        if (!candidateInst) break;
        const cluster = catalog.get(candidateInst.classKey);

        // GROSS: would this add utility ignoring eviction? (active instances of
        // this queryKey it would solve)
        const grossGain = activeInstancesForQueryKey(cluster.queryKey);
        if (grossGain > 0) grossWouldAcceptByFamily[family] += 1;

        // COUNTERFACTUAL via real applied bounded states.
        const parentResidents = store.residents;
        const parentU = utilityOf(parentResidents);
        const evict = store.peekEviction();
        const learnedRecord = {
          queryKey: cluster.queryKey, program: cluster.program, family, cue: cluster.cue,
          operationClass: cluster.operationClass, stepSig: cluster.stepSig, era: cluster.era,
        };
        // candidate resident set = parent + new − FIFO-evicted (if full)
        const candidateResidents = store.isFull()
          ? [...parentResidents.slice(1), learnedRecord]
          : [...parentResidents, learnedRecord];
        const candidateU = utilityOf(candidateResidents);
        const netDeltaU = candidateU - parentU;

        // eviction cost = U lost on the evicted program's still-active clusters,
        // RECOMPUTED from the ACTUAL (post-retirement) active-instance catalog — a
        // resident whose class still has ≥1 active instance is genuinely costly.
        const evictCost = evict ? activeInstancesForQueryKey(evict.queryKey) : 0;
        const evictStillCoversActive = evict ? evictCost > 0 : false;

        // ADMISSION POLICY:
        //   net-positive — the greedy miner only admits when net advances; it will
        //     NOT make a costly eviction (it stalls instead). costly count == 0.
        //   frontier-chase — chase the freshest workload: admit the newest class
        //     with any live instance (grossGain>0) even at net≤0, FORCING a FIFO
        //     eviction of a still-covered current-era resident. This is the §17.39
        //     item-4 control that makes a genuine COSTLY eviction happen.
        const netAdvanced = netDeltaU > 0;
        const admit = admissionPolicy === 'frontier-chase' ? grossGain > 0 : netAdvanced;
        if (!admit) break; // this family has no admissible candidate this evolve

        // reload / rekey (solver-equivalence) flags — first-discovery credit gate
        const isReload = store.wasEvicted(cluster.queryKey);
        const isRekey = !isReload && (store.hasStepSig(cluster.stepSig) || store.wasDiscovered(cluster.stepSig));
        const firstDiscovery = !isReload && !isRekey;

        // Capture BEFORE learn (peekEviction returned a victim ⇒ store was full).
        const wasFullBeforeLearn = evict !== null;
        const { evicted } = store.learn(learnedRecord, epoch);
        if (!store.verifyAppliedState()) throw new Error(`applied bounded state failed to round-trip at epoch ${epoch}`);
        if (store.size() === CAPACITY && globalCapacityReachedEpoch === null) globalCapacityReachedEpoch = epoch;

        acceptedByFamily[family] += 1;
        gateConfirmAcceptedByFamily[family] += 1;
        netAcceptedByFamily[family] += 1;
        // "after capacity" = the store was already full when this accept landed
        // (⇒ it required an eviction). RAW accept count; the honest headroom signal
        // subtracts the costly evictions below (netHeadroomAfterCapacity).
        if (globalCapacityReachedEpoch !== null && wasFullBeforeLearn) {
          netAcceptedAfterCapacityByFamily[family] += 1;
          if (evictStillCoversActive) costlyAfterCapacityByFamily[family] += 1;
          if (firstDiscovery && !evictStillCoversActive) costlessFirstDiscoveryAfterCapacityByFamily[family] += 1;
        }
        if (rotates && epoch > transitionEpoch) netAcceptedAfterTransitionByFamily[family] += 1;
        if (isReload) reloadCount[family] += 1;
        if (isRekey) rekeyCount[family] += 1;
        if (firstDiscovery) { firstDiscoveryStepSigs.add(cluster.stepSig); firstDiscoveryByEra[cluster.era]?.add(cluster.stepSig); }

        if (evicted) {
          evictionDetail.push(Object.freeze({
            residencyKey: `qk:${evicted.queryKey}`,
            family: evicted.family, era: evicted.era,
            stillCoversActiveMotif: evictStillCoversActive,
            counterfactualUtilityDelta: netDeltaU,          // U(candidate)-U(parent), real bounded states
            evictionCostUtility: evictCost,                  // U lost on evicted's still-active clusters (0 if dead)
            // §17.39 item-2: canonical 256-bit (64-hex) words + coverage witness so
            // the coordinator can RE-EXECUTE the evicted program and DERIVE
            // costliness itself (never trust stillCoversActiveMotif). activeInstanceCount
            // is the live-instance count of the evicted class recomputed from the
            // ACTUAL post-retirement active catalog.
            realProgramWordsHex: dist.encodeBmuPublicPathProgramWords({
              branchLimit: evicted.program.branchLimit, queryKey: evicted.queryKey,
              validFromEpoch: 0n, expiryEpoch: 0n, steps: evicted.program.steps,
            }).map((w) => `0x${w.toString(16).padStart(64, '0')}`),
            coverageWitness: { activeInstanceCount: evictCost },
            evictedCue: evicted.cue, evictedClaimedSignature: evicted.operationClass,
          }));
        }

        acceptJournal.push(Object.freeze({
          epoch, family, era: cluster.era, operationClass: cluster.operationClass,
          cue: cluster.cue, stepSig: cluster.stepSig,
          realProgramWordsHex: dist.encodeBmuPublicPathProgramWords({
            branchLimit: cluster.program.branchLimit, queryKey: cluster.queryKey,
            validFromEpoch: 0n, expiryEpoch: 0n, steps: cluster.program.steps,
          }).map((w) => `0x${w.toString(16)}`),
          counterfactualUtilityDelta: netDeltaU, grossGain,
          isReload, isRekey, firstDiscovery,
          evicted: evicted ? { residencyKey: `qk:${evicted.queryKey}`, family: evicted.family, era: evicted.era, stillCoversActiveMotif: evictStillCoversActive } : null,
        }));
      }
    }

    perEvolveJournal.push(buildEraJournalEvolveRecord({
      schedule, evolve: evolveIndex, epoch,
      acceptedByFamily, gateConfirmAcceptedByFamily,
      retirementsByFamily, evictionDetail,
    }));
  }

  // ── summary + verdict ──
  const transitionRec = rotates ? eraTransitionAt(schedule, transitionEpoch) : null;
  const afterTransition = perEvolveJournal.filter((e) => rotates && e.epoch > transitionEpoch);
  const netAfterTransitionByFamily = emptyFamilyCounts();
  const costlyAfterTransitionByFamily = emptyFamilyCounts();
  for (const e of afterTransition) {
    for (const f of FAMILIES) {
      netAfterTransitionByFamily[f] += e.gateConfirmAcceptedByFamily[f] - e.costlyEvictionsByFamily[f];
      costlyAfterTransitionByFamily[f] += e.costlyEvictionsByFamily[f];
    }
  }
  // aggregate net over the WHOLE horizon (accept − COSTLY evictions)
  const netByFamily = emptyFamilyCounts();
  let totalCostly = 0;
  let totalEvictions = 0;
  for (const e of perEvolveJournal) {
    for (const f of FAMILIES) {
      netByFamily[f] += e.gateConfirmAcceptedByFamily[f] - e.costlyEvictionsByFamily[f];
      totalCostly += e.costlyEvictionsByFamily[f];
      totalEvictions += e.evictionsByFamily[f];
    }
  }

  // §17.39 item-4 retirement provenance — the gimmick diagnostic. A CURRENT-era
  // retirement is unjustified free churn (a real scorer still queries the motif);
  // a PRIOR-era retirement is genuine grammar obsolescence.
  const retiredPriorEra = retirementEvents.filter((e) => e.reason === 'prior-era-obsolete').length;
  const retiredCurrentEra = retirementEvents.filter((e) => e.currentEraAtRetire === true).length;
  // Honest headroom after saturation = accepts-after-capacity − costly-after-capacity.
  const netHeadroomAfterCapacityByFamily = emptyFamilyCounts();
  for (const f of FAMILIES) netHeadroomAfterCapacityByFamily[f] = netAcceptedAfterCapacityByFamily[f] - costlyAfterCapacityByFamily[f];
  const netAcceptedAfterCapacityTotal = FAMILIES.reduce((a, f) => a + netAcceptedAfterCapacityByFamily[f], 0);
  const costlyAfterCapacityTotal = FAMILIES.reduce((a, f) => a + costlyAfterCapacityByFamily[f], 0);
  const netHeadroomAfterCapacityTotal = FAMILIES.reduce((a, f) => a + netHeadroomAfterCapacityByFamily[f], 0);

  return {
    arm, admissionPolicy, fromEra, toEra, schedule: schedule.entries, transitionEpoch: rotates ? transitionEpoch : null,
    transition: transitionRec,
    pins: { evolves, cadenceEpochs, armEpoch, maxAgeEpochs, mintPerFamilyPerEvolve, capacity: CAPACITY },
    summary: {
      globalCapacityReachedEpoch,
      netAcceptedByFamily, netAcceptedAfterTransitionByFamily,
      netAcceptedAfterCapacityByFamily,
      costlyAfterCapacityByFamily, costlessFirstDiscoveryAfterCapacityByFamily,
      netHeadroomAfterCapacityByFamily,
      grossWouldAcceptByFamily,
      reloadCount, rekeyCount,
      firstDiscoveryStepSigs: firstDiscoveryStepSigs.size,
      firstDiscoveryFromEra: firstDiscoveryByEra[fromEra].size,
      firstDiscoveryToEra: firstDiscoveryByEra[toEra].size,
      totalRetirements: retirementEvents.length,
      retiredPriorEra, retiredCurrentEra,
      totalEvictions, totalCostlyEvictions: totalCostly,
      netByFamilyHorizon: netByFamily,
      netAfterTransitionByFamily, costlyAfterTransitionByFamily,
      residentCount: store.size(),
      operationsAllCorrect,
    },
    checks: {
      // rotates: costly-adjusted NET stays >0 across/after the rotation, per family.
      // (rotating: true — prior-era drain funds it; rotate-no-retire: false — no
      // retirement, so the store stays saturated with still-covered residents.)
      netPositiveAfterTransition: rotates
        ? FAMILIES.every((f) => netAfterTransitionByFamily[f] > 0)
        : null,
      // Raw accepts that landed AFTER the store saturated (back-compat field).
      netAcceptedAfterCapacityTotal,
      costlyAfterCapacityTotal,
      netHeadroomAfterCapacityTotal,
      // GENUINE sustained headroom: costly-adjusted net accepts after saturation
      // are strictly positive PER FAMILY (static → false, rotate-no-retire → false,
      // frontier-chase-in-static → false; rotating → true; retire-only → true but
      // see `headroomFromPriorEraRetirementOnly` for the gimmick unmasking).
      sustainedHeadroomAfterCapacity: FAMILIES.every((f) => netHeadroomAfterCapacityByFamily[f] > 0),
      // back-compat: rotates keeps net-admitting after saturation (raw).
      sustainedNetAfterCapacity: rotates
        ? FAMILIES.every((f) => netAcceptedAfterCapacityByFamily[f] > 0)
        : null,
      // STATIC control: net acceptance RATE → 0 at saturation. A bounded one-time
      // saturation-boundary swap (≤1/family) is permitted.
      staticNetRateCollapsesToZero: arm === 'static'
        ? netAcceptedAfterCapacityTotal <= FAMILIES.length
        : null,
      // THE FREE-CHURN GIMMICK UNMASK: retire-only's positive headroom is fuelled
      // ENTIRELY by CURRENT-era retirements (unjustified). rotating retires ZERO
      // current-era instances — its headroom comes only from genuine prior-era
      // obsolescence. This is what isolates the two mechanisms.
      retiredCurrentEra, retiredPriorEra,
      headroomFromPriorEraRetirementOnly: retiredCurrentEra === 0,
      // toEra fresh discoveries actually happened (rotates)
      toEraFreshDiscoveries: rotates ? firstDiscoveryByEra[toEra].size : null,
      operationsAllCorrect,
      appliedStateRoundTripsThroughout: true,
    },
    perEvolveJournal, acceptJournal, retirementEvents,
  };
}

/**
 * Bidirectional miner-transfer honesty over REAL execution: no fromEra program
 * solves any toEra cluster AND no toEra program solves any fromEra cluster; each
 * cluster's OWN program solves it (positive control). Returns leak counts.
 */
export function crossEraTransferAudit({ dist, fromEra, toEra }) {
  const catalog = buildClassCatalog({ eras: [fromEra, toEra], queryKeyOf: dist.bmuOperationQueryKey });
  const clustersOf = (era) => [...catalog.values()].filter((c) => c.era === era);
  const programsOf = (era) => clustersOf(era).map((c) => c.program);
  const solves = (program, cluster) => {
    let out;
    try { out = executeProgramOverRelations({ program, relations: cluster.relations, seedIds: [cluster.seedId], branchLimit: program.branchLimit }); }
    catch { return false; }
    const got = new Set(out.terminalIds);
    if (got.size !== cluster.requiredTerminals.size) return false;
    for (const t of cluster.requiredTerminals) if (!got.has(t)) return false;
    return true;
  };
  let fromSolvesTo = 0;
  let toSolvesFrom = 0;
  let ownControlFailures = 0;
  const fromPrograms = programsOf(fromEra);
  const toPrograms = programsOf(toEra);
  for (const cluster of clustersOf(toEra)) {
    if (!solves(cluster.program, cluster)) ownControlFailures += 1;
    for (const p of fromPrograms) if (solves(p, cluster)) fromSolvesTo += 1;
  }
  for (const cluster of clustersOf(fromEra)) {
    if (!solves(cluster.program, cluster)) ownControlFailures += 1;
    for (const p of toPrograms) if (solves(p, cluster)) toSolvesFrom += 1;
  }
  return {
    fromEra, toEra,
    fromSolvesToCount: fromSolvesTo,
    toSolvesFromCount: toSolvesFrom,
    ownProgramControlFailures: ownControlFailures,
    honestBothDirections: fromSolvesTo === 0 && toSolvesFrom === 0 && ownControlFailures === 0,
  };
}

// ─── cross-family dedup census (peer §17.27 sub-task) ────────────────────────

/**
 * Canonicalize each program's step-signature CUE-AGNOSTICALLY and count DISTINCT
 * signatures across all four families POOLED, per era. If 144 (36×4) collapses
 * well below 144 that is a runway-narrowing finding — a step-transferring miner
 * needs only `distinctCrossFamilySigs` genuine discoveries to cover all 144
 * cue-bound classes (re-binding queryKeys is cheap).
 */
export function crossFamilyDedupCensus({ eras = [1, 2] } = {}) {
  const perEra = {};
  for (const era of eras) {
    const bank = programBankForEra(era);
    const all = [];
    const bySig = new Map();
    for (const family of FAMILIES) {
      for (let ordinal = 0; ordinal < bank.length; ordinal++) {
        const op = executableOperationForFamilySlot(family, ordinal * 2, { era });
        const sig = stepSigOf({ branchLimit: op.operationProgram.branchLimit, steps: op.operationProgram.steps });
        all.push(sig);
        (bySig.get(sig) ?? bySig.set(sig, new Set()).get(sig)).add(family);
      }
    }
    const distinct = new Set(all);
    const sharingSets = {};
    for (const [, fams] of bySig) {
      const key = [...fams].sort().join('+');
      sharingSets[key] = (sharingSets[key] ?? 0) + 1;
    }
    perEra[era] = {
      totalCueBoundClasses: all.length,
      distinctCrossFamilySigs: distinct.size,
      collapseRatio: Number((distinct.size / all.length).toFixed(4)),
      narrowing: distinct.size < all.length,
      familySharingSets: sharingSets,
    };
  }
  return perEra;
}

/**
 * Exhaustive ceiling on distinct cross-family step-signatures achievable under
 * the current deep-terminal bank + single mutually-exclusive suppress flag per
 * suppressable NON-FINAL INCOMING step (the live generator's overlay envelope:
 * no flags on the outgoing seed or the terminal step; 0x20/0x40 mutually
 * exclusive). Proves whether the N1 target 144/144 is reachable WITHOUT changing
 * the bank shape / decoder.
 *
 * Per program: achievable flag-patterns = 3^(#suppressable non-final incoming
 * steps) — 3 for a 3-step program (only step 1), 9 for a 4-step (steps 1,2). A
 * program contributes at most min(#families, #patterns) distinct cross-family
 * sigs (pigeonhole). Current bank = 32 three-step + 4 four-step ⇒ ceiling
 * 32·min(4,3) + 4·min(4,9) = 96 + 16 = 112 < 144.
 */
export function crossFamilyDistinctnessCeiling({ era = 1, familyCount = 4 } = {}) {
  const bank = programBankForEra(era);
  const perShape = {};
  let ceiling = 0;
  for (const program of bank) {
    let suppressable = 0;
    for (let i = 1; i < program.steps.length - 1; i++) if (program.steps[i].direction === 'incoming') suppressable += 1;
    const patterns = 3 ** suppressable;
    const contribution = Math.min(familyCount, patterns);
    ceiling += contribution;
    const shape = `${program.steps.length}-step`;
    perShape[shape] = perShape[shape] ?? { count: 0, patternsPerProgram: patterns, contributionPerProgram: contribution };
    perShape[shape].count += 1;
  }
  return {
    familyCount,
    totalCueBoundClasses: bank.length * familyCount,
    maxDistinctCrossFamilySigs: ceiling,
    reaches144: ceiling >= bank.length * familyCount,
    ratioCeiling: Number((ceiling / (bank.length * familyCount)).toFixed(4)),
    perShape,
  };
}

/**
 * §17.30 feasibility gate — the recommended ERA-3 all-4-step multi-depth bank.
 * Proof-of-mechanism (NOT a live grammar; the implementation is a dedicated
 * lane). Returns the cross-family census + guard checks + the actual mandatory
 * terminal-pool size (real number vs the pinned Qwen cap 128).
 */
export const RERANKER_INPUT_TOPK = 128; // pinned bundle cap (bundle/index.ts:951)
export function era3RecommendedDesignCensus() {
  const spec = { outgoingEdgeTypes: ['coreference_of', 'co_occurs_with'], incomingEdgeTypes: ['causes', 'derived_from', 'supports', 'supersedes'] };
  const plan = {
    temporal: { step: 1, flag: 'suppress' },
    conflict_lifecycle: { step: 2, flag: 'suppress' },
    near_collision_abstention: { step: 1, flag: 'offPathSuppress' },
    multi_hop_relation: { step: 2, flag: 'offPathSuppress' },
  };
  // 36 distinct 4-step base routes from era-3's disjoint partition
  const base = [];
  outer: for (const o of spec.outgoingEdgeTypes) {
    for (const a of spec.incomingEdgeTypes) for (const b of spec.incomingEdgeTypes) for (const c of spec.incomingEdgeTypes) {
      base.push({ branchLimit: 4, steps: [{ direction: 'outgoing', edgeType: o }, { direction: 'incoming', edgeType: a }, { direction: 'incoming', edgeType: b }, { direction: 'incoming', edgeType: c }] });
      if (base.length >= 36) break outer;
    }
  }
  const sigWith = (program, flagByStep) => program.steps.map((s, i) => {
    const f = flagByStep[i] ?? 'none';
    return `${s.direction}:${s.edgeType}${f === 'suppress' ? ':sup' : f === 'offPathSuppress' ? ':off' : ''}`;
  }).join('/') + `|b${program.branchLimit}`;
  const sigs = [];
  const perFamilyDistinct = {};
  for (const family of FAMILIES) {
    const fam = new Set();
    for (const b of base) { const s = sigWith(b, { [plan[family].step]: plan[family].flag }); sigs.push(s); fam.add(s); }
    perFamilyDistinct[family] = fam.size;
  }
  const travOf = (steps) => steps.map((s) => `${s.direction}:${s.edgeType}`).join('/');
  const era1Trav = new Set(programBankForEra(1).map((p) => travOf(p.steps)));
  const era2Trav = new Set(programBankForEra(2).map((p) => travOf(p.steps)));
  const crossEraOverlap = [...new Set(base.map((p) => travOf(p.steps)))].filter((t) => era1Trav.has(t) || era2Trav.has(t)).length;
  // actual mandatory terminal pool for a depth-3 program (controlled topology).
  // Terminal count is EDGE-AGNOSTIC (depends only on the diamond shape), so we
  // measure on a REGISTERED-era 4-step program (era-3 is feasibility-only, not
  // registered, so it would fail the era-lint by design).
  const shape = programBankForEra(2).find((pr) => pr.steps.length === 4);
  const topo = buildProgramPathTopology({ program: shape, seedId: 'S_seed', sinkIds: ['S_sink'], goldIds: ['S_gold'], decoyIds: ['S_decoy'], midIdFor: (l) => `S_mid${l}` });
  const out = executeProgramOverRelations({ program: shape, relations: topo.relations, seedIds: ['S_seed'], branchLimit: 4 });
  // distinct demotion operations across the 4 families (genuine distinctness)
  const demotion = (step, flag) => {
    const pr = { branchLimit: 4, steps: shape.steps.map((s, i) => ({ direction: s.direction, edgeType: s.edgeType, ...(i === step && flag === 'suppress' ? { suppress: true } : {}), ...(i === step && flag === 'offPathSuppress' ? { offPathSuppress: true } : {}) })) };
    const t = buildProgramPathTopology({ program: pr, seedId: 'D_seed', sinkIds: ['D_sink'], goldIds: ['D_gold'], decoyIds: ['D_decoy'], midIdFor: (l) => `D_mid${l}` });
    const o = executeProgramOverRelations({ program: pr, relations: t.relations, seedIds: ['D_seed'], branchLimit: 4 });
    return JSON.stringify([[...o.suppressLineageIds].sort(), [...o.offPathSuppressedIds].sort()]);
  };
  const distinctDemotions = new Set(FAMILIES.map((f) => demotion(plan[f].step, plan[f].flag))).size;
  return {
    totalCueBoundClasses: sigs.length,
    distinctCrossFamilySigs: new Set(sigs).size,
    reaches144: new Set(sigs).size === 144,
    withinFamilyReuseRatioZero: FAMILIES.every((f) => perFamilyDistinct[f] === 36),
    crossEraTraversalOverlap: crossEraOverlap,
    crossEraDisjoint: crossEraOverlap === 0,
    distinctDemotionOperations: distinctDemotions,
    fourGenuinelyDistinctOperations: distinctDemotions === 4,
    terminalsAdmitted: out.terminalIds.length,
    promotePathIntermediates: out.promotePathNodeIds.length,
    withinQwenCap: out.terminalIds.length + out.promotePathNodeIds.length <= RERANKER_INPUT_TOPK,
    pinnedQwenCap: RERANKER_INPUT_TOPK,
  };
}

export function sha256Hex(text) {
  return createHash('sha256').update(text).digest('hex');
}
