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
    lensTopK: profile.lensTopK ?? 36,
    lensWeight: profile.lensWeight ?? 0.10,
    anchorWeight: profile.anchorWeight ?? 0.15,
    relationExpansionBudget: profile.relationExpansionBudget ?? 50,
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

  for (let epoch = 1; epoch <= epochs; epoch++) {
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
      for (let i = 0; i < probesPerEpoch; i++) {
        const patch = randomPatch(currentState, rand);
        const result = await evaluateRetrievalBenchmarkPatch(
          currentState,
          patch,
          activeCorpus,
          pack,
          scoringOpts,
          {
            minImprovementPpm: Number(currentMinImprovement),
            structuralFloor: profile.patchAcceptanceFloors.structuralFloor,
            protectedRegressionFloor: profile.patchAcceptanceFloors.protectedRegressionFloor,
            familyCatastrophicFloor: profile.patchAcceptanceFloors.familyCatastrophicFloor,
          },
        );
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
      };
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
