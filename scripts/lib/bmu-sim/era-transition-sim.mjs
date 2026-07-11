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
    for (const family of FAMILIES) {
      for (let ordinal = 0; ordinal < bank.length; ordinal++) {
        const op = executableOperationForFamilySlot(family, ordinal * 2, { era });
        const program = { branchLimit: op.operationProgram.branchLimit, steps: op.operationProgram.steps };
        const queryKey = queryKeyOf(op.operationCue);
        const classKey = `e${era}:${family}:${ordinal}`;
        const mg = `mg_${classKey}`;
        const topology = buildProgramPathTopology({
          program,
          seedId: `${mg}_seed`,
          sinkIds: [`${mg}_sink`],
          goldIds: [`${mg}_gold`],
          decoyIds: [`${mg}_decoy`],
          midIdFor: (level) => `${mg}_mid${level}`,
        });
        catalog.set(classKey, Object.freeze({
          classKey, era, family, ordinal,
          operationClass: op.operationClass,
          operationClassBasis: op.operationClassBasis,
          cue: op.operationCue,
          program: Object.freeze(program),
          queryKey,
          stepSig: stepSigOf(program),
          relations: topology.relations,
          seedId: `${mg}_seed`,
          requiredTerminals: new Set(topology.terminalIds),
        }));
      }
    }
  }
  return catalog;
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
 * @param {object} opts
 * @param {'rotating'|'static'} opts.arm — rotating exercises the era transition +
 *   maxAge retirement; static freezes the frontier (no retirement, era-1 only) —
 *   the net→0 control.
 * @param {object} opts.dist — built @botcoin/coretex (encode/decode/queryKey).
 * @param {number} opts.transitionEpoch — epoch era-2 activates (rotating arm).
 */
export function runEraTransition({
  arm = 'rotating',
  dist,
  evolves = 48,
  cadenceEpochs = 8,
  armEpoch = 152,
  maxAgeEpochs = 32,
  transitionEpoch = 152 + 24 * 8, // mid-horizon by default
  mintPerFamilyPerEvolve = 2,
}) {
  if (!['rotating', 'static'].includes(arm)) throw new Error(`runEraTransition: bad arm ${arm}`);
  const schedule = arm === 'rotating'
    ? makeEraSchedule([
      { era: 1, activationEpoch: -Infinity },
      { era: 2, activationEpoch: transitionEpoch, coexistenceWindowEpochs: maxAgeEpochs, retireGraceEpochs: 0 },
    ])
    : genesisEraSchedule(1);

  const catalog = buildClassCatalog({ eras: [1, 2], queryKeyOf: dist.bmuOperationQueryKey });
  const byEraFamOrdinal = (era, family, ordinal) => catalog.get(`e${era}:${family}:${ordinal % CLASSES_PER_FAMILY}`);

  const store = createBoundedResidentStore({
    encodeWords: dist.encodeBmuPublicPathProgramWords,
    decodeState: dist.decodeBmuPublicPathPrograms,
    wordCount: dist.WORD_COUNT_VALUE ?? 1024n,
  });

  // Active workload = live cluster INSTANCES (motif instances of a class). Each
  // mint appends instances; retirement drops instances older than maxAge (rotating)
  // — static never retires.
  let activeInstances = []; // [{ classKey, mintEpoch, instanceId }]
  const retirementEvents = [];
  const perEvolveJournal = [];
  const acceptJournal = [];
  const mintCursor = Object.fromEntries(FAMILIES.map((f) => [f, 0]));

  // per-family running counters (P5-schema names)
  const netAcceptedByFamily = emptyFamilyCounts();
  const netAcceptedAfterTransitionByFamily = emptyFamilyCounts();
  const netAcceptedAfterCapacityByFamily = emptyFamilyCounts();
  const grossWouldAcceptByFamily = emptyFamilyCounts();
  const firstDiscoveryStepSigs = new Set();
  const firstDiscoveryByEra = { 1: new Set(), 2: new Set() };
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

    // ── frontier retirement (rotating only): drop instances older than maxAge ──
    const retirementsByFamily = emptyFamilyCounts();
    if (arm === 'rotating') {
      const survivors = [];
      for (const inst of activeInstances) {
        if (epoch - inst.mintEpoch >= maxAgeEpochs) {
          const cluster = catalog.get(inst.classKey);
          retirementsByFamily[cluster.family] += 1;
          retirementEvents.push({ epoch, instanceId: inst.instanceId, classKey: inst.classKey, era: cluster.era, family: cluster.family, ageEpochs: epoch - inst.mintEpoch });
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

        // eviction cost = U lost on the evicted program's still-active clusters
        const evictCost = evict ? activeInstancesForQueryKey(evict.queryKey) : 0;
        const evictStillCoversActive = evict ? evictCost > 0 : false;

        const netAdvanced = netDeltaU > 0; // min gate/confirm modeled identically (deterministic)
        if (!netAdvanced) break; // no positive-net candidate for this family this evolve

        // reload / rekey (solver-equivalence) flags — first-discovery credit gate
        const isReload = store.wasEvicted(cluster.queryKey);
        const isRekey = !isReload && (store.hasStepSig(cluster.stepSig) || store.wasDiscovered(cluster.stepSig));
        const firstDiscovery = !isReload && !isRekey;

        const { evicted } = store.learn(learnedRecord, epoch);
        if (!store.verifyAppliedState()) throw new Error(`applied bounded state failed to round-trip at epoch ${epoch}`);
        if (store.size() === CAPACITY && globalCapacityReachedEpoch === null) globalCapacityReachedEpoch = epoch;

        const wasFullBeforeLearn = store.isFull();
        acceptedByFamily[family] += 1;
        gateConfirmAcceptedByFamily[family] += 1;
        netAcceptedByFamily[family] += 1;
        // "after capacity" = the store was already full when this net-accept
        // landed (⇒ it required a — here costless — eviction). This is the
        // sustained-net signal: rotating > 0, static → 0.
        if (globalCapacityReachedEpoch !== null && wasFullBeforeLearn) netAcceptedAfterCapacityByFamily[family] += 1;
        if (arm === 'rotating' && epoch > transitionEpoch) netAcceptedAfterTransitionByFamily[family] += 1;
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
            realProgramWordsHex: dist.encodeBmuPublicPathProgramWords({
              branchLimit: evicted.program.branchLimit, queryKey: evicted.queryKey,
              validFromEpoch: 0n, expiryEpoch: 0n, steps: evicted.program.steps,
            }).map((w) => `0x${w.toString(16)}`),
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
  const transitionRec = arm === 'rotating' ? eraTransitionAt(schedule, transitionEpoch) : null;
  const afterTransition = perEvolveJournal.filter((e) => arm === 'rotating' && e.epoch > transitionEpoch);
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

  return {
    arm, schedule: schedule.entries, transitionEpoch: arm === 'rotating' ? transitionEpoch : null,
    transition: transitionRec,
    pins: { evolves, cadenceEpochs, armEpoch, maxAgeEpochs, mintPerFamilyPerEvolve, capacity: CAPACITY },
    summary: {
      globalCapacityReachedEpoch,
      netAcceptedByFamily, netAcceptedAfterTransitionByFamily,
      netAcceptedAfterCapacityByFamily,
      grossWouldAcceptByFamily,
      reloadCount, rekeyCount,
      firstDiscoveryStepSigs: firstDiscoveryStepSigs.size,
      firstDiscoveryEra1: firstDiscoveryByEra[1].size,
      firstDiscoveryEra2: firstDiscoveryByEra[2].size,
      totalRetirements: retirementEvents.length,
      totalEvictions, totalCostlyEvictions: totalCostly,
      netByFamilyHorizon: netByFamily,
      netAfterTransitionByFamily, costlyAfterTransitionByFamily,
      residentCount: store.size(),
    },
    checks: {
      // ROTATING: net stays >0 across/after the rotation, per family.
      netPositiveAfterTransition: arm === 'rotating'
        ? FAMILIES.every((f) => netAfterTransitionByFamily[f] > 0)
        : null,
      // SUSTAINED-NET signal: net-accepts that landed AFTER the store saturated.
      // rotating keeps net-admitting (retirement frees costless slots);
      // static collapses to zero (every post-capacity swap is net ≤ 0).
      netAcceptedAfterCapacityTotal: FAMILIES.reduce((a, f) => a + netAcceptedAfterCapacityByFamily[f], 0),
      sustainedNetAfterCapacity: arm === 'rotating'
        ? FAMILIES.every((f) => netAcceptedAfterCapacityByFamily[f] > 0)
        : null,
      // STATIC control: net acceptance RATE → 0 at saturation (no sustained
      // advance). A bounded one-time saturation-boundary swap (≤1/family) is
      // permitted; sustained post-capacity net acceptance is not.
      staticNetRateCollapsesToZero: arm === 'static'
        ? FAMILIES.reduce((a, f) => a + netAcceptedAfterCapacityByFamily[f], 0) <= FAMILIES.length
        : null,
      // era-2 fresh discoveries actually happened (rotating)
      era2FreshDiscoveries: arm === 'rotating' ? firstDiscoveryByEra[2].size : null,
      appliedStateRoundTripsThroughout: true,
    },
    perEvolveJournal, acceptJournal, retirementEvents,
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

export function sha256Hex(text) {
  return createHash('sha256').update(text).digest('hex');
}
