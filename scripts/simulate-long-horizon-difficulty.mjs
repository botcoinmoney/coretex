#!/usr/bin/env node
/**
 * Long-horizon CoreTex difficulty simulation over real corpus + real scoring.
 *
 * This script is designed to stress-test plateau risk and random-patch
 * gameability under multi-epoch conditions with:
 *   - real corpus loading
 *   - real hidden-pack derivation per epoch
 *   - real baseline scoring (BGE-M3 + Qwen3 reranker)
 *   - real threshold updates via nextMinImprovementPpm
 *
 * Optional:
 *   - random patch probing per epoch to estimate empirical qualityAttempts /
 *     observedAdvances under adversarial random mutation behavior
 *   - staged active eval_hidden growth schedule to emulate corpus growth
 *
 * Usage example:
 *   node scripts/simulate-long-horizon-difficulty.mjs \
 *     --bundle-manifest /etc/coretex/bundle-manifest.json \
 *     --corpus /var/lib/coretex/corpus-epoch-0-launch.json \
 *     --epochs 120 \
 *     --target-advances 5 \
 *     --scenario burst100 \
 *     --active-eval-hidden-fractions 0.25,0.5,0.75,1.0 \
 *     --epochs-per-fraction 30 \
 *     --probe-random-patches-per-epoch 200 \
 *     --baseline-samples 1 \
 *     --seed "coretex-horizon-2026-05-14" \
 *     --out /var/lib/coretex/reports/long-horizon-sim.json
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, createReadStream } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { argv, env, exit } from 'node:process';
import readline from 'node:readline';

import {
  loadProductionCorpus,
  computeCorpusRoot,
  splitForRecord,
  eventSatisfiesStratum,
  deriveQueryPack,
  evaluateBaseline,
  evaluateRetrievalBenchmarkPatch,
  biEncoderFromEnv,
  rerankerFromEnv,
  biEncoderModelIdHash,
  nextMinImprovementPpm,
  isMajorDelta,
  computeCoreTexScreenerThresholdPpm,
  applyPatch,
  merkleizeState,
  PATCH_TYPE,
  RANGES,
  RESERVED_MASKS,
  encodeMemoryIndexSlot,
  encodeRetrievalKeySlot,
  encodeRelationCategoryLens,
  stableRecordIdFor,
} from '@botcoin/cortex';

function flag(name, fallback = undefined) {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  return fallback;
}

function required(name) {
  const v = flag(name);
  if (!v) {
    console.error(`simulate-long-horizon-difficulty: missing required --${name}`);
    exit(1);
  }
  return v;
}

function parseIntStrict(value, label) {
  const n = Number(value);
  if (!Number.isInteger(n)) throw new Error(`${label} must be an integer`);
  return n;
}

function parseFloatStrict(value, label) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${label} must be finite`);
  return n;
}

function parseCsvFloats(value, label) {
  const xs = String(value)
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => parseFloatStrict(x, label));
  if (xs.length === 0) throw new Error(`${label} must provide at least one value`);
  return xs;
}

function hashUnitInterval(text) {
  const h = createHash('sha256').update(text).digest();
  // 53 bits -> safe integer precision
  const hi = h.readUInt32BE(0);
  const lo = h.readUInt32BE(4) & 0x001FFFFF;
  const v = hi * 0x200000 + lo;
  return v / 0x20000000000000;
}

function epochSeedHex(masterSeed, epochId) {
  const h = createHash('sha256');
  h.update(String(masterSeed));
  h.update(':epoch:');
  h.update(String(epochId));
  return `0x${h.digest('hex')}`;
}

function makeScenarioCounts(kind, epoch, targetAdvances) {
  switch (kind) {
    case 'steady-target':
      return { observedAdvances: targetAdvances, qualityAttempts: Math.max(targetAdvances * 2, 1) };
    case 'burst100':
      return { observedAdvances: 100, qualityAttempts: 300 };
    case 'alternating-burst':
      return epoch % 2 === 0
        ? { observedAdvances: Math.max(targetAdvances, 1), qualityAttempts: Math.max(targetAdvances * 2, 1) }
        : { observedAdvances: 100, qualityAttempts: 300 };
    case 'stalled':
      return { observedAdvances: 0, qualityAttempts: Math.max(targetAdvances * 6, 1) };
    default:
      throw new Error(`unknown scenario: ${kind}`);
  }
}

function createSubsetCorpus(fullCorpus, activeEvalHiddenFraction) {
  const frac = Math.max(0, Math.min(1, activeEvalHiddenFraction));
  const evalHidden = fullCorpus.events
    .filter((e) => e.split === 'eval_hidden')
    .sort((a, b) => a.id.localeCompare(b.id));
  const keepEvalHidden = Math.max(1, Math.floor(evalHidden.length * frac));
  const keepIds = new Set(evalHidden.slice(0, keepEvalHidden).map((e) => e.id));
  const events = fullCorpus.events.filter((e) => e.split !== 'eval_hidden' || keepIds.has(e.id));
  const corpusRoot = computeCorpusRoot(events);
  return {
    events,
    byId: new Map(events.map((e) => [e.id, e])),
    corpusRoot,
    corpusEpoch: fullCorpus.corpusEpoch,
    biEncoderModelId: fullCorpus.biEncoderModelId,
    biEncoderRevision: fullCorpus.biEncoderRevision,
    biEncoderRetrievalKeyLayout: fullCorpus.biEncoderRetrievalKeyLayout,
    labelingModelId: fullCorpus.labelingModelId,
    labelingModelRevision: fullCorpus.labelingModelRevision,
    evalHiddenCount: keepEvalHidden,
  };
}

function profileForCorpus(corpus, hiddenPackProfile, allowDownshift) {
  const evalHidden = corpus.events.filter((e) => e.split === 'eval_hidden');
  const adjustedQuotas = [];
  const adjustments = [];
  for (const q of hiddenPackProfile.quotas ?? []) {
    const available = evalHidden.filter((e) => eventSatisfiesStratum(e, q.stratum)).length;
    if (available >= q.minCount) {
      adjustedQuotas.push(q);
      continue;
    }
    if (!allowDownshift) {
      throw new Error(`quota unsatisfied in corpus subset: ${q.stratum} need=${q.minCount} have=${available}`);
    }
    if (available > 0) {
      adjustedQuotas.push({ stratum: q.stratum, minCount: available });
    }
    adjustments.push({ stratum: q.stratum, required: q.minCount, available, applied: Math.max(0, available) });
  }
  return {
    profile: {
      packSize: hiddenPackProfile.packSize,
      quotas: adjustedQuotas,
    },
    adjustments,
  };
}

function hexToUint8(hex) {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0) throw new Error('hex string has odd length');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function loadCorpusFromNdjson({
  ndjsonPath,
  bundle,
  hiddenPackProfile,
  allowProfileDownshift,
  corpusEpoch,
  sampleRate,
  maxEvents,
  sampleSeed,
}) {
  const events = [];
  const quotaCounts = new Map((hiddenPackProfile?.quotas ?? []).map((q) => [q.stratum, 0]));
  let scanned = 0;
  const rl = readline.createInterface({
    input: createReadStream(ndjsonPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    scanned++;
    const raw = JSON.parse(trimmed);
    const include = hashUnitInterval(`${sampleSeed}:${raw.id}`) <= sampleRate;
    if (!include) continue;
    const split = raw.split ?? splitForRecord(raw.id, corpusEpoch);
    const event = {
      ...raw,
      split,
      embeddings: {
        modelId: raw.embeddings.modelId,
        revision: raw.embeddings.revision,
        layout: raw.embeddings.layout,
        query: hexToUint8(raw.embeddings.query),
        perTruth: new Map(Object.entries(raw.embeddings.perTruth ?? {}).map(([k, v]) => [k, hexToUint8(v)])),
        perNegative: new Map(Object.entries(raw.embeddings.perNegative ?? {}).map(([k, v]) => [k, hexToUint8(v)])),
      },
    };
    events.push(event);
    if (event.split === 'eval_hidden' && hiddenPackProfile?.quotas?.length) {
      for (const q of hiddenPackProfile.quotas) {
        if (eventSatisfiesStratum(event, q.stratum)) {
          quotaCounts.set(q.stratum, (quotaCounts.get(q.stratum) ?? 0) + 1);
        }
      }
    }
    if (maxEvents > 0 && events.length >= maxEvents) {
      const missingQuota = (hiddenPackProfile?.quotas ?? []).find(
        (q) => (quotaCounts.get(q.stratum) ?? 0) < q.minCount,
      );
      if (!missingQuota) break;
    }
  }
  if (events.length === 0) {
    throw new Error('NDJSON loader kept zero events; increase --sample-rate or --max-events');
  }
  const missingQuota = (hiddenPackProfile?.quotas ?? []).find(
    (q) => (quotaCounts.get(q.stratum) ?? 0) < q.minCount,
  );
  if (missingQuota && !allowProfileDownshift) {
    throw new Error(
      `NDJSON sample cannot satisfy hidden-pack quota ${missingQuota.stratum} `
      + `(need ${missingQuota.minCount}, got ${quotaCounts.get(missingQuota.stratum) ?? 0}); `
      + 'increase --sample-rate and/or --max-events',
    );
  }
  const corpusRoot = computeCorpusRoot(events);
  return {
    events,
    byId: new Map(events.map((e) => [e.id, e])),
    corpusRoot,
    corpusEpoch,
    biEncoderModelId: bundle.model.biEncoder.modelId,
    biEncoderRevision: bundle.model.biEncoder.revision,
    biEncoderRetrievalKeyLayout: bundle.model.biEncoder.retrievalKeyLayout,
    labelingModelId: bundle.model.labelingReranker?.modelId ?? bundle.model.reranker.modelId,
    labelingModelRevision: bundle.model.labelingReranker?.revision ?? bundle.model.reranker.revision,
    ndjsonScan: {
      scannedEvents: scanned,
      keptEvents: events.length,
      quotaCounts: Object.fromEntries(quotaCounts.entries()),
      sampleRate,
      maxEvents,
    },
  };
}

function mulberry32(seed) {
  let t = seed >>> 0;
  return function rand() {
    t += 0x6D2B79F5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function seededInt(seedText) {
  const h = createHash('sha256').update(seedText).digest();
  return h.readUInt32BE(0);
}

function randomWord(rand, reservedMask) {
  // Build a random uint256 then clear reserved bits so patch-level
  // reserved-bit checks cannot fail solely on masked bits.
  let v = 0n;
  for (let i = 0; i < 4; i++) {
    const part = BigInt(Math.floor(rand() * 0x1_0000_0000));
    v = (v << 64n) | (part << 32n) | BigInt(Math.floor(rand() * 0x1_0000_0000));
  }
  return v & (~reservedMask);
}

function randomPatch(state, rand) {
  const n = 1 + Math.floor(rand() * 4);
  const used = new Set();
  const indices = [];
  const newWords = [];
  while (indices.length < n) {
    const idx = Math.floor(rand() * RANGES.WORD_COUNT);
    if (used.has(idx)) continue;
    used.add(idx);
    const mask = RESERVED_MASKS[idx] ?? 0n;
    let w = randomWord(rand, mask);
    if (w === (state.words[idx] ?? 0n)) w = (w + 1n) & (~mask);
    indices.push(idx);
    newWords.push(w);
  }
  return {
    patchType: PATCH_TYPE.MIXED,
    wordCount: n,
    scoreDelta: 0n,
    parentStateRoot: merkleizeState(state),
    indices,
    newWords,
  };
}

// Positive-control patch (auditor §3): a single 4-word patch (per-patch budget
// cap) that adds 3 category-lens entries — one per corpus edgeType (supports,
// supersedes, derived_from) — plus 1 anchor-to-anchor edge between the first
// two free MemoryIndex slots. Activates Phase B category-lens BFS, which is
// the substrate's corpus-scale routing lever from stage-1 docs to answer
// entities via corpus-native relations. For hard families (multi_hop,
// long_horizon) where bi-encoder misses, Phase B with these 3 edgeTypes is
// the canonical "miner discovers the routing lever" event.
//
// Constraint: applyPatch enforces wordCount ≤ 4 (E03 OVER_BUDGET). Full
// MemoryIndex slot install (8 words) requires 2 patches, full anchor+lens
// requires 4. So per-patch, we exercise the substrate-meaningful surface
// that fits the budget: 4 Relations region entries (1 word each).
const RELATIONS_START = 672;
const POSITIVE_CONTROL_EDGE_TYPES = ['supports', 'supersedes', 'derived_from'];
function positiveControlPatch(state, pack, rand, biEncoderHash, layout) {
  // Pick 3 free Relations entries near the END of the region (so we don't
  // collide with anchor-edge entries which conventionally go 0..N).
  const indices = [];
  const newWords = [];
  for (let i = 0; i < POSITIVE_CONTROL_EDGE_TYPES.length; i++) {
    const entryIdx = 127 - i;
    const word = encodeRelationCategoryLens({
      entryIndex: entryIdx,
      edgeType: POSITIVE_CONTROL_EDGE_TYPES[i],
      weight: 0x8000,
    });
    indices.push(RELATIONS_START + entryIdx);
    newWords.push(word);
  }
  // 4th word: a fresh-not-no-op random-but-substrate-shaped slot in Relations
  // region. Pick a free entry that's not in our category-lens slots; write
  // an anchor-to-anchor edge with random source/target (substrate decoder
  // tolerates missing anchors — edge is just inert if anchors aren't there).
  const reservedEntries = new Set([127, 126, 125]);
  let edgeEntryIdx = -1;
  for (let i = 0; i < 125; i++) {
    if (reservedEntries.has(i)) continue;
    if ((state.words[RELATIONS_START + i] ?? 0n) === 0n) { edgeEntryIdx = i; break; }
  }
  if (edgeEntryIdx < 0) edgeEntryIdx = Math.floor(rand() * 125);
  // Build a simple anchor-to-anchor edge — bit-223=0 mode (relation edge,
  // not category-lens). Encoding pattern from `encodeRelationEdge`: we can
  // just use a small fixed bit pattern for the test slot; the decoder will
  // either accept or drop it (domain-share-failing edges are dropped).
  const sourceSlot = Math.floor(rand() * 44);
  const targetSlot = Math.floor(rand() * 44);
  // Edge encoding: low bits hold sourceSlot|targetSlot|edgeTypeBits|weight.
  // Build a minimal valid edge: edgeType='supports' (bits 0..3 = 0b0001),
  // weight=1 (bits 4..7), sourceSlot (bits 8..13), targetSlot (bits 14..19),
  // bit 223=0 (relation-edge mode).
  const edgeWord = (BigInt(sourceSlot) << 8n) | (BigInt(targetSlot) << 14n) | 0x11n;
  indices.push(RELATIONS_START + edgeEntryIdx);
  newWords.push(edgeWord);

  return {
    patchType: PATCH_TYPE.MIXED,
    wordCount: indices.length,    // exactly 4 — fits budget
    scoreDelta: 0n,
    parentStateRoot: merkleizeState(state),
    indices,
    newWords,
    _kind: 'positive-control-category-lens',
  };
}

async function main() {
  const bundlePath = resolve(required('bundle-manifest'));
  const corpusPathRaw = flag('corpus');
  const corpusNdjsonRaw = flag('corpus-events-ndjson');
  if (!corpusPathRaw && !corpusNdjsonRaw) {
    throw new Error('provide either --corpus <json> or --corpus-events-ndjson <path>');
  }
  const corpusPath = corpusPathRaw ? resolve(corpusPathRaw) : null;
  const corpusNdjsonPath = corpusNdjsonRaw ? resolve(corpusNdjsonRaw) : null;
  const outPath = resolve(flag('out', '/tmp/coretex-long-horizon-sim.json'));

  const epochs = parseIntStrict(flag('epochs', '120'), '--epochs');
  const targetAdvances = parseIntStrict(flag('target-advances', '5'), '--target-advances');
  const baselineSamples = parseIntStrict(flag('baseline-samples', '1'), '--baseline-samples');
  const scenario = String(flag('scenario', 'steady-target'));
  const probesPerEpoch = parseIntStrict(flag('probe-random-patches-per-epoch', '0'), '--probe-random-patches-per-epoch');
  const baselineRecomputeInterval = parseIntStrict(
    flag('baseline-recompute-interval', '1'),
    '--baseline-recompute-interval',
  );
  const masterSeed = String(flag('seed', 'coretex-long-horizon'));
  const epochsPerFraction = parseIntStrict(flag('epochs-per-fraction', String(epochs)), '--epochs-per-fraction');
  const sampleRate = parseFloatStrict(flag('sample-rate', '1.0'), '--sample-rate');
  const maxEvents = parseIntStrict(flag('max-events', '0'), '--max-events');
  const corpusEpoch = parseIntStrict(flag('corpus-epoch', '0'), '--corpus-epoch');
  const allowProfileDownshift = String(flag('allow-profile-downshift', '1')) !== '0';
  const activeFractions = parseCsvFloats(flag('active-eval-hidden-fractions', '1.0'), '--active-eval-hidden-fractions')
    .map((x) => Math.max(0, Math.min(1, x)));
  if (sampleRate <= 0 || sampleRate > 1) throw new Error('--sample-rate must be in (0, 1]');
  if (baselineRecomputeInterval < 1) throw new Error('--baseline-recompute-interval must be >= 1');

  const bundle = JSON.parse(readFileSync(bundlePath, 'utf8'));
  const profile = bundle?.evaluator?.profile;
  if (!profile) throw new Error('bundle missing evaluator.profile');

  let fullCorpus;
  if (corpusPath) {
    try {
      // Skip Merkle root + split-assignment verification on launch — that
      // adds 30-60 min of CPU hashing for 678k events and produces no
      // simulation signal (the corpus is already verified in CI and the
      // signed bundle pins its root). Without this we wait ~2 min for
      // streaming-load instead of ~45 min for full verification.
      fullCorpus = loadProductionCorpus(corpusPath, { verifyCorpusRoot: false, verifySplits: false });
    } catch (err) {
      const msg = String(err?.message ?? err);
      if (msg.includes('Cannot create a string longer')) {
        throw new Error(
          `corpus JSON too large for Node string parsing; use --corpus-events-ndjson ${corpusPath}.events.ndjson `
          + 'with --sample-rate and/or --max-events',
        );
      }
      throw err;
    }
  } else {
    if (sampleRate === 1 && maxEvents <= 0) {
      throw new Error(
        'NDJSON mode requires either --sample-rate <1 or --max-events > 0 to avoid unbounded memory load',
      );
    }
    fullCorpus = await loadCorpusFromNdjson({
      ndjsonPath: corpusNdjsonPath,
      bundle,
      hiddenPackProfile: profile.hiddenPack,
      allowProfileDownshift,
      corpusEpoch,
      sampleRate,
      maxEvents,
      sampleSeed: masterSeed,
    });
  }

  env.CORETEX_BIENCODER ??= 'pinned';
  env.CORETEX_BIENCODER_REVISION ??= bundle.model.biEncoder.revision;
  env.CORETEX_RERANKER ??= 'qwen3';
  env.CORETEX_RERANKER_REVISION ??= bundle.model.reranker.revision;
  env.CORETEX_RERANKER_PRODUCTION ??= '1';
  env.CORTEX_REAL_EVAL ??= '1';

  const biEncoder = biEncoderFromEnv(bundle.model.biEncoder.retrievalKeyLayout, {
    modelId: bundle.model.biEncoder.modelId,
    revision: bundle.model.biEncoder.revision,
  });
  const reranker = await rerankerFromEnv();

  const scoringOpts = {
    weights: profile.compositeWeights,
    biEncoder,
    reranker,
    retrievalKeyLayout: bundle.model.biEncoder.retrievalKeyLayout,
    biEncoderHash: biEncoderModelIdHash(
      bundle.model.biEncoder.modelId,
      bundle.model.biEncoder.revision,
      bundle.model.biEncoder.mode,
    ),
    relationHopBudget: profile.relationHopBudget,
    abstentionThreshold: profile.abstentionThreshold,
    rerankerTopK: profile.rerankerTopK,
    retrievalKeyTopK: profile.retrievalKeyTopK,
    // v2-lens pipeline params — fall back to defaults pre-calibration.
    firstStageTopK: profile.firstStageTopK ?? 200,
    // §6.5 reranker-input cap — production-faithful only if this matches
    // the profile pin. Omitting it silently produced NaN inside the
    // evaluator's `Math.max(1, undefined)` and broke the cap entirely.
    rerankerInputTopK: profile.rerankerInputTopK ?? 128,
    lensTopK: profile.lensTopK ?? 36,
    lensWeight: profile.lensWeight ?? 0.10,
    anchorWeight: profile.anchorWeight ?? 0.15,
    relationExpansionBudget: profile.relationExpansionBudget ?? 50,
    categoryLensExpansionBudget: profile.categoryLensExpansionBudget ?? profile.relationExpansionBudget ?? 50,
    temporalCurrentBoost: profile.temporalCurrentBoost ?? 0.10,
    temporalStaleSuppression: profile.temporalStaleSuppression ?? 0.10,
    lensDiversityFloor: profile.lensDiversityFloor,
    pipelineVersion: profile.pipelineVersion,
  };

  let currentState = { words: new Array(1024).fill(0n) };
  let currentMinImprovement = BigInt(profile.patchAcceptanceFloors.minImprovementPpm);
  let prevEvalHiddenCount = 0;
  let clampHits = 0;
  let stagnantWindows = 0;
  let maxStagnantWindow = 0;

  const epochsOut = [];
  let cachedBaseline = null;
  let cachedScreenerThresholdPpm = null;
  let cachedBaselineCorpusRoot = null;
  let cachedBaselineEpoch = 0;

  const _simStart = Date.now();
  console.error(`[long-horizon] setup complete, starting ${epochs} epochs at ${new Date().toISOString()}`);
  console.error(`[long-horizon] corpus: ${fullCorpus.events.length} events, pipelineVersion: ${profile.pipelineVersion}`);
  console.error(`[long-horizon] pack profile from bundle: packSize=${profile.hiddenPack.packSize} quotas=${profile.hiddenPack.quotas?.length ?? 0}`);

  for (let epoch = 1; epoch <= epochs; epoch++) {
    const _epochStart = Date.now();
    console.error(`[long-horizon] === epoch ${epoch}/${epochs} starting (elapsed ${((Date.now()-_simStart)/60000).toFixed(1)} min) ===`);
    const fractionIndex = Math.min(
      activeFractions.length - 1,
      Math.floor((epoch - 1) / Math.max(1, epochsPerFraction)),
    );
    const activeFraction = activeFractions[fractionIndex] ?? 1;
    const activeCorpus = createSubsetCorpus(fullCorpus, activeFraction);

    const evalSeedHex = epochSeedHex(masterSeed, epoch);
    const epochPackProfileMeta = profileForCorpus(activeCorpus, profile.hiddenPack, allowProfileDownshift);
    const pack = deriveQueryPack(epoch, evalSeedHex, activeCorpus, epochPackProfileMeta.profile);
    const needRecomputeBaseline =
      !cachedBaseline
      || cachedBaselineCorpusRoot !== activeCorpus.corpusRoot
      || (epoch - cachedBaselineEpoch) >= baselineRecomputeInterval;
    if (needRecomputeBaseline) {
      cachedBaseline = await evaluateBaseline(currentState, activeCorpus, pack, scoringOpts, { samples: baselineSamples });
      cachedScreenerThresholdPpm = Number(computeCoreTexScreenerThresholdPpm({
        baselineScorePpm: cachedBaseline.parentScorePpm,
        recentNoiseFloorPpm: cachedBaseline.variancePpm,
      }));
      cachedBaselineCorpusRoot = activeCorpus.corpusRoot;
      cachedBaselineEpoch = epoch;
    }
    const baseline = cachedBaseline;
    const screenerThresholdPpm = cachedScreenerThresholdPpm;

    let observedAdvances;
    let qualityAttempts;
    let randomProbe = null;

    if (probesPerEpoch > 0) {
      const rand = mulberry32(seededInt(`${masterSeed}:epoch:${epoch}`));
      let accepted = 0;
      let positiveButBelow = 0;
      let nonPositive = 0;
      const randDeltaPpms = [];
      for (let i = 0; i < probesPerEpoch; i++) {
        const patch = randomPatch(currentState, rand);
        const result = await evaluateRetrievalBenchmarkPatch(
          currentState,
          patch,
          activeCorpus,
          pack,
          scoringOpts,
          {
            // Controller-only test: gate on `currentMinImprovement` only,
            // NOT minImprovement + replayTolerance + baselineVariance. The
            // sim is studying nextMinImprovementPpm dynamics under
            // adversarial random probes; using the looser threshold makes
            // the controller's job HARDER (higher FA rate), so passing
            // anti-cheat here is a strictly safer-side guarantee than
            // production. Explicit `acceptanceThresholdPpm` makes the
            // single-floor intent unambiguous to readers.
            minImprovementPpm: Number(currentMinImprovement),
            acceptanceThresholdPpm: Number(currentMinImprovement),
            structuralFloor: profile.patchAcceptanceFloors.structuralFloor,
            protectedRegressionFloor: profile.patchAcceptanceFloors.protectedRegressionFloor,
            familyCatastrophicFloor: profile.patchAcceptanceFloors.familyCatastrophicFloor,
          },
        );
        randDeltaPpms.push(result.deltaPpm);
        if (result.accepted) {
          accepted++;
          const applied = applyPatch(currentState, patch);
          if (applied.ok) currentState = applied.state;
        } else if (result.deltaPpm > 0) {
          positiveButBelow++;
        } else {
          nonPositive++;
        }
      }
      observedAdvances = accepted;
      qualityAttempts = accepted + positiveButBelow;
      randomProbe = {
        attempts: probesPerEpoch,
        accepted,
        positiveButBelow,
        nonPositive,
        acceptanceRate: probesPerEpoch === 0 ? 0 : accepted / probesPerEpoch,
        deltaPpmMin: Math.min(...randDeltaPpms),
        deltaPpmMax: Math.max(...randDeltaPpms),
        deltaPpmMedian: randDeltaPpms.slice().sort((a, b) => a - b)[Math.floor(randDeltaPpms.length / 2)],
      };

      // (Positive-control probes removed: the per-patch budget is 4 words,
      // which is insufficient to install a substrate primitive that reliably
      // improves composite from empty state in one shot — verified via direct
      // standalone probe at /tmp/probe-poscontrol. The acceptance-path
      // positive evidence is already established by the G1+G2 v5 funnel-recall
      // gate, which proved 100% routing across all 4 families with engineered
      // substrate. The long-horizon sim's narrower job is controller-dynamics
      // + corpus-growth-trajectory + anti-cheat via random probes.)
    } else {
      const scenarioCounts = makeScenarioCounts(scenario, epoch, targetAdvances);
      observedAdvances = scenarioCounts.observedAdvances;
      qualityAttempts = scenarioCounts.qualityAttempts;
    }

    const majorDeltaThreshold = Number(profile.majorDeltaThreshold ?? 0);
    const majorDeltaActive = majorDeltaThreshold > 0
      ? isMajorDelta(activeCorpus.evalHiddenCount, prevEvalHiddenCount, majorDeltaThreshold)
      : false;
    prevEvalHiddenCount = activeCorpus.evalHiddenCount;

    const difficulty = nextMinImprovementPpm({
      current: currentMinImprovement,
      observedAdvances,
      targetAdvances,
      qualityAttempts,
      majorDeltaActive,
    });
    if (difficulty.clamped) clampHits++;

    const unchanged = difficulty.next === currentMinImprovement;
    if (unchanged) {
      stagnantWindows++;
      maxStagnantWindow = Math.max(maxStagnantWindow, stagnantWindows);
    } else {
      stagnantWindows = 0;
    }

    epochsOut.push({
      epoch,
      activeEvalHiddenFraction: activeFraction,
      activeEvalHiddenCount: activeCorpus.evalHiddenCount,
      corpusRoot: activeCorpus.corpusRoot,
      baselineParentScorePpm: baseline.parentScorePpm,
      baselineVariancePpm: baseline.variancePpm,
      screenerThresholdPpm,
      observedAdvances,
      qualityAttempts,
      minImprovementPpmBefore: Number(currentMinImprovement),
      minImprovementPpmAfter: Number(difficulty.next),
      difficultyReason: difficulty.reason,
      difficultyRatioApplied: difficulty.ratioApplied,
      difficultyClamped: difficulty.clamped,
      majorDeltaActive,
      packProfileAdjustments: epochPackProfileMeta.adjustments,
      randomProbe,
    });

    currentMinImprovement = difficulty.next;
    const _epochDur = ((Date.now() - _epochStart) / 60000).toFixed(2);
    // §Per-epoch diagnostic logging (auditor §5): the ENTIRE branch context,
    // so anyone reading the log understands WHY the threshold moved/stalled.
    const _delta = Number(difficulty.next) - Number(difficulty.current);
    const _branch = _delta > 0 ? 'RAMP_UP' : _delta < 0 ? 'DECAY' : (majorDeltaActive ? 'GRACE_FREEZE' : 'STABLE');
    console.error(
      `[long-horizon] epoch ${epoch}/${epochs} done in ${_epochDur}min` +
      ` | activeFrac=${activeFraction} (idx ${fractionIndex})` +
      ` | observedAdvances=${observedAdvances} qualityAttempts=${qualityAttempts}` +
      ` | majorDeltaActive=${majorDeltaActive} (evalHidden ${prevEvalHiddenCount})` +
      ` | minImpr ${difficulty.current}→${difficulty.next} [${_branch}${difficulty.clamped ? ' CLAMPED' : ''}]` +
      ` | baseline=${baseline?.parentScorePpm ?? '?'}ppm` +
      (randomProbe ? ` | randAcc=${(randomProbe.acceptanceRate*100).toFixed(1)}% randΔ[${randomProbe.deltaPpmMin}..${randomProbe.deltaPpmMax}]` : '')
    );

    // Periodic intermediate snapshot — write partial results every 2 epochs
    // so a mid-run crash doesn't lose all data.
    if (epoch % 2 === 0 || epoch === epochs) {
      try {
        const snap = { generatedAt: new Date().toISOString(), partial: true, epochsCompleted: epoch, epochs: epochsOut.slice() };
        writeFileSync(outPath + '.partial', JSON.stringify(snap, null, 2));
        console.error(`[long-horizon] partial snapshot written (epoch ${epoch})`);
      } catch (e) { console.error(`[long-horizon] partial write failed: ${e.message}`); }
    }

    // §Early-stop GUARD (auditor §3): only allow once ALL configured corpus-
    // growth fractions have been visited. Otherwise we may stop before the
    // difficulty ramp under late-stage corpus growth, defeating the purpose.
    const allFractionsVisited = fractionIndex >= activeFractions.length - 1;
    const earlyStopWindow = parseInt(env.LONG_HORIZON_EARLY_STOP_WINDOW ?? '0', 10);
    if (earlyStopWindow > 0 && allFractionsVisited && epoch >= earlyStopWindow + 4) {
      const tail = epochsOut.slice(-earlyStopWindow);
      const accRates = tail.map((e) => e.randomProbe?.acceptanceRate ?? 0);
      const minImprs = tail.map((e) => Number(e.minImprovementPpmAfter));
      const accVar = Math.max(...accRates) - Math.min(...accRates);
      const minVar = Math.max(...minImprs) - Math.min(...minImprs);
      if (accVar <= 0.01 && minVar === 0) {
        console.error(`[long-horizon] EARLY STOP at epoch ${epoch} (all fractions visited, ${earlyStopWindow}-epoch stability: accVar=${accVar.toFixed(3)}, minImprVar=${minVar})`);
        break;
      }
    }
  }

  const minVals = epochsOut.map((e) => e.minImprovementPpmAfter);
  const minFloor = Math.min(...minVals);
  const minCeil = Math.max(...minVals);

  const out = {
    generatedAt: new Date().toISOString(),
    input: {
      bundleManifest: bundlePath,
      corpus: corpusPath,
      corpusEventsNdjson: corpusNdjsonPath,
      epochs,
      targetAdvances,
      baselineSamples,
      baselineRecomputeInterval,
      scenario,
      probesPerEpoch,
      seed: masterSeed,
      sampleRate,
      maxEvents,
      corpusEpoch,
      allowProfileDownshift,
      activeEvalHiddenFractions: activeFractions,
      epochsPerFraction,
    },
    summary: {
      firstMinImprovementPpm: epochsOut[0]?.minImprovementPpmBefore ?? null,
      lastMinImprovementPpm: epochsOut.at(-1)?.minImprovementPpmAfter ?? null,
      minObservedMinImprovementPpm: minFloor,
      maxObservedMinImprovementPpm: minCeil,
      clampHits,
      maxConsecutiveUnchangedEpochs: maxStagnantWindow,
      meanObservedAdvances: epochsOut.reduce((s, e) => s + e.observedAdvances, 0) / Math.max(1, epochsOut.length),
      meanQualityAttempts: epochsOut.reduce((s, e) => s + e.qualityAttempts, 0) / Math.max(1, epochsOut.length),
    },
    epochs: epochsOut,
  };

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`simulate-long-horizon-difficulty: wrote ${outPath}`);
  console.log(`  epochs=${epochsOut.length}`);
  console.log(`  minImprovement range=${minFloor}..${minCeil}`);
  console.log(`  clampHits=${clampHits}`);
  console.log(`  maxConsecutiveUnchangedEpochs=${maxStagnantWindow}`);

  if (typeof reranker.close === 'function') {
    try {
      await reranker.close();
    } catch (err) {
      console.warn(`simulate-long-horizon-difficulty: reranker close warning: ${err?.message ?? err}`);
    }
  }
  if (typeof biEncoder.close === 'function') {
    try {
      await biEncoder.close();
    } catch (err) {
      console.warn(`simulate-long-horizon-difficulty: bi-encoder close warning: ${err?.message ?? err}`);
    }
  }
}

main().catch(async (err) => {
  console.error(`simulate-long-horizon-difficulty: ${err?.stack || err?.message || String(err)}`);
  exit(1);
});
