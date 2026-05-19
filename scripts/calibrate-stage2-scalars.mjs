#!/usr/bin/env node
/**
 * Calibration Run 0 — stage-2 scalar sensitivity sweep.
 *
 * Spec: docs/CORETEX_SUBSTRATE_EXPANSION_HARDENING.md §5 Run 0.
 *
 * Pins `lensWeight`, `anchorWeight`, and `relationExpansionBudget`
 * by sweeping each through {0, 0.25×default, default, 4×default}
 * and measuring the composite gap between an empty substrate and a
 * feasible-upper-bound engineered substrate. The elbow of the curve
 * (where additional scalar magnitude stops increasing the gap) is
 * the pinned value.
 *
 * Smoke mode (deterministic reranker): fast, validates the pipeline,
 * tells you whether lens/anchor scalars produce measurable lift over
 * empty. Real-launch calibration must run with CORETEX_RERANKER=qwen3
 * (etc.) to get a semantically-meaningful elbow on relation expansion.
 *
 * Usage:
 *   # smoke (~1 min):
 *   node --max-old-space-size=16384 scripts/calibrate-stage2-scalars.mjs \
 *     --corpus /var/lib/coretex/corpus-epoch-0-launch-MERGED.json \
 *     --bundle-profile /etc/coretex/bundle-profile.json \
 *     --pack-size 8 \
 *     --reranker deterministic \
 *     --out /var/lib/coretex/reports/stage2-scalar-sweep-smoke.json
 *
 *   # real-launch calibration (~30-60 min, depending on reranker latency):
 *   CORETEX_RERANKER=qwen3 CORETEX_RERANKER_PRODUCTION=1 \
 *   CORETEX_BIENCODER=pinned CORETEX_RERANKER_MODE=streaming \
 *     node --max-old-space-size=16384 scripts/calibrate-stage2-scalars.mjs \
 *       --corpus /var/lib/coretex/corpus-epoch-0-launch-MERGED.json \
 *       --bundle-profile /etc/coretex/bundle-profile.json \
 *       --pack-size 16 \
 *       --reranker env \
 *       --out /var/lib/coretex/reports/stage2-scalar-sweep.json
 *
 * Exit codes:
 *   0 = sweep completed; report written
 *   1 = setup error
 *   2 = sweep produced no measurable empty-vs-engineered gap at any scalar
 *       value (substrate has no expressive lever — design issue, surface
 *       to operator)
 */

import { distIndex } from './_repo-root.mjs';
import { profileAttestation } from './lib/profile-attestation.mjs';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { argv, exit, env } from 'node:process';
import { createHash } from 'node:crypto';

function flag(name, fb) {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  return fb;
}

const corpusPath = flag('corpus');
const profilePath = flag('bundle-profile');
const packSize = Number(flag('pack-size', '8'));
const rerankerArg = flag('reranker', 'deterministic');
const reportPath = flag('out', '/var/lib/coretex/reports/stage2-scalar-sweep.json');
const seedHex = flag('seed', '0x' + '11'.repeat(32));

function fail(msg, code = 1) { console.error(`[calibrate-stage2] ${msg}`); exit(code); }
if (!corpusPath || !existsSync(corpusPath)) fail(`--corpus missing or not found: ${corpusPath}`);

const {
  loadProductionCorpus,
  evaluateRetrievalBenchmarkState,
  deriveQueryPack,
  biEncoderModelIdHash,
  createDeterministicBiEncoder,
  createDeterministicReranker,
  rerankerFromEnv,
  biEncoderFromEnv,
  encodeMemoryIndexSlot,
  encodeRetrievalKeySlot,
  encodeRelationEdge,
  stableRecordIdFor,
  DEFAULT_PROFILE,
} = await import(distIndex);
const { buildProvenance } = await import('./calibration-provenance.mjs');

console.log(`[calibrate-stage2] loading corpus ${corpusPath}`);
const t0 = Date.now();
const corpus = loadProductionCorpus(corpusPath, { verifyCorpusRoot: false, verifySplits: false });
console.log(`  loaded ${corpus.events.length} events in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

// Bundle profile (or DEFAULT_PROFILE). Bundle artifacts wrap the profile
// inside a top-level { schemaVersion, inputs, profile } envelope; raw
// profile files are flat. Unwrap if wrapped, otherwise use as-is —
// reading a wrapped file without unwrapping silently dropped every
// substrate-routing pin and made the script fall back to DEFAULT_PROFILE.
const profile = profilePath && existsSync(profilePath)
  ? (() => { const r = JSON.parse(readFileSync(profilePath, 'utf8')); return r.profile ?? r; })()
  : DEFAULT_PROFILE;

const BI = {
  modelId: corpus.biEncoderModelId,
  revision: corpus.biEncoderRevision,
  mode: 'dense',
};
const LAYOUT = corpus.biEncoderRetrievalKeyLayout;
const biEncoderHash = biEncoderModelIdHash(BI.modelId, BI.revision, BI.mode);

// Build the calibration pack from the `calibration` split.
const calibProfile = { packSize, quotas: [] };
const pack = deriveQueryPack(0, seedHex, corpus, calibProfile);
console.log(`[calibrate-stage2] eval pack size=${pack.events.length} from ${seedHex}`);

// ─── Substrates ─────────────────────────────────────────────────────────────

const EMPTY_STATE = { words: new Array(1024).fill(0n) };

// Engineered substrate: anchor each pack-query's source event in a MemoryIndex
// slot + use its query embedding as a lens vector. With pack-size ≤ 36, this
// is feasibly within the slot budget (44 MemoryIndex / 36 RetrievalKey).
function buildEngineeredState() {
  if (pack.events.length > 36) {
    throw new Error(`pack-size ${pack.events.length} exceeds RetrievalKey slot count 36`);
  }
  const words = new Array(1024).fill(0n);
  const RANGES = {
    MEMORY_INDEX_START: 32,
    RETRIEVAL_KEYS_START: 384,
    RELATIONS_START: 672,
  };

  // Use the canonical stableRecordIdFor — NOT a local sha256 reimplementation.
  // The scorer's corpusByRecordId index uses keccak256-derived bigints; any
  // hash mismatch makes engineered anchors invisible to the scorer (silent
  // architecture leak). This bug was present in this script since Run 0 and
  // invalidates any prior calibration that depended on engineered anchor
  // structure. See commit message of 96b064e for full context.

  // Pick a single domain bit for the engineered substrate so all anchors share
  // a domain (required by the §6.4 relation-edge predicate).
  const sharedDomain = 1n;

  for (let i = 0; i < pack.events.length; i++) {
    const ev = pack.events[i];
    // ─ Memory index slot i
    const memSlot = {
      slotIndex: i,
      recordId: stableRecordIdFor(ev.id),
      family: ev.family,
      domainBits: sharedDomain,
      valid: true,
      revoked: false,
      protected: ev.protected ?? false,
      retrievalSlot: i,
      expiryEpoch: 0n,
    };
    const memWords = encodeMemoryIndexSlot(memSlot);
    const base = RANGES.MEMORY_INDEX_START + i * 8;
    for (let j = 0; j < 8; j++) words[base + j] = memWords[j];

    // ─ Retrieval key slot i = the pack-query's TRUTH-DOC embedding (more
    //   diverse than query embeddings, which collapse onto the same domain
    //   centroid and trip the §6.4 lens-diversity floor). Truth docs are
    //   specific entities/answers — their BGE-M3 embeddings spread across
    //   the company space, giving the substrate a real mixture-of-lenses.
    const truthDoc = ev.truthDocuments.find((t) => t.isCurrent) ?? ev.truthDocuments[0];
    const truthEmb = ev.embeddings.perTruth.get(truthDoc.id);
    if (!truthEmb) throw new Error(`pack event ${ev.id} missing truth-doc embedding`);
    const keySlot = {
      slotIndex: i,
      modelIdHash: biEncoderHash,
      l2Norm: 1.0,
      versionTag: 1,
      quantizedBytes: truthEmb,
    };
    const keyWords = encodeRetrievalKeySlot(keySlot, { retrievalKeyHeaderBytes: LAYOUT.headerBytes });
    const kbase = RANGES.RETRIEVAL_KEYS_START + i * 8;
    for (let j = 0; j < 8; j++) words[kbase + j] = keyWords[j];
  }

  // ─ Relation edges connecting the first 4 anchors (a sparse seed graph;
  //   bigger graphs are tested in Run 0 via relationExpansionBudget sweep).
  const nEdges = Math.min(8, pack.events.length - 1);
  for (let i = 0; i < nEdges; i++) {
    const edge = {
      entryIndex: i,
      sourceSlot: i,
      targetSlot: (i + 1) % pack.events.length,
      edgeType: 'supports', // RelationEdgeType string enum
      weight: 1,
    };
    words[672 + i] = encodeRelationEdge(edge);
  }

  return { words };
}

const ENGINEERED_STATE = buildEngineeredState();
console.log(`[calibrate-stage2] engineered substrate built (${pack.events.length} anchors + lenses, ${Math.min(8, pack.events.length - 1)} relation edges)`);

// ─── Reranker + bi-encoder ──────────────────────────────────────────────────

let reranker;
let biEncoder;
if (rerankerArg === 'env') {
  console.log('[calibrate-stage2] reranker: env-driven (CORETEX_RERANKER=' + (env.CORETEX_RERANKER ?? '') + ')');
  reranker = await rerankerFromEnv();
  biEncoder = biEncoderFromEnv(LAYOUT, { modelId: BI.modelId, revision: BI.revision });
} else {
  console.log('[calibrate-stage2] reranker: deterministic (smoke mode)');
  reranker = await createDeterministicReranker();
  biEncoder = createDeterministicBiEncoder({ modelId: BI.modelId, revision: BI.revision, layout: LAYOUT });
}

// ─── Sweep ──────────────────────────────────────────────────────────────────

const DEFAULTS = {
  weights: profile.compositeWeights ?? DEFAULT_PROFILE.compositeWeights,
  retrievalKeyLayout: LAYOUT,
  biEncoderHash,
  biEncoder,
  reranker,
  relationHopBudget: profile.relationHopBudget ?? 3,
  abstentionThreshold: profile.abstentionThreshold ?? 0.001,
  rerankerTopK: profile.rerankerTopK ?? 10,
  retrievalKeyTopK: profile.retrievalKeyTopK ?? 50,
  firstStageTopK: profile.firstStageTopK ?? 200,
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

// Extended sweep range — original {0, 0.025, 0.1, 0.4} pinned at the upper
// boundary (gap was monotonically increasing), which is a *boundary*, not an
// elbow. Sweep further to find the real saturation knee or confirm the gap
// keeps growing (in which case the substrate dominates the reranker, which
// is its own design concern).
const SWEEPS = {
  lensWeight: [0, 0.1, 0.4, 0.8, 1.5, 3.0],
  anchorWeight: [0, 0.15, 0.6, 1.2, 2.4, 5.0],
  relationExpansionBudget: [0, 12, 50, 200],
};

async function scoreWithOpts(state, scalarName, value) {
  const opts = { ...DEFAULTS, [scalarName]: value };
  const score = await evaluateRetrievalBenchmarkState(state, corpus, pack, opts);
  return score;
}

const results = [];
for (const [scalarName, values] of Object.entries(SWEEPS)) {
  console.log(`\n[calibrate-stage2] sweeping ${scalarName} ∈ {${values.join(', ')}}`);
  for (const value of values) {
    const tEmpty = Date.now();
    const emptyScore = await scoreWithOpts(EMPTY_STATE, scalarName, value);
    const tMidEmpty = Date.now() - tEmpty;
    const tEng = Date.now();
    const engScore = await scoreWithOpts(ENGINEERED_STATE, scalarName, value);
    const tMidEng = Date.now() - tEng;
    const gap = engScore.composite - emptyScore.composite;
    results.push({
      scalar: scalarName,
      value,
      empty: { composite: emptyScore.composite, nDCG10: emptyScore.nDCG10 },
      engineered: { composite: engScore.composite, nDCG10: engScore.nDCG10 },
      gap,
      latencyMs: { empty: tMidEmpty, engineered: tMidEng },
    });
    console.log(`  ${scalarName}=${value.toString().padEnd(6)}  empty=${emptyScore.composite.toFixed(4)}  engineered=${engScore.composite.toFixed(4)}  gap=${gap.toFixed(4)}  (${tMidEmpty + tMidEng} ms)`);
  }
}

// ─── Elbow detection ────────────────────────────────────────────────────────

function pickElbow(scalarName) {
  const rows = results.filter((r) => r.scalar === scalarName).sort((a, b) => a.value - b.value);
  if (rows.length < 3) return null;
  // Compute first-differences in gap. The elbow is the rightmost value
  // where the next step in scalar yields ≤25% additional gap.
  let elbow = rows[rows.length - 1].value; // default to max if no plateau detected
  for (let i = 1; i < rows.length - 1; i++) {
    const dPrev = rows[i].gap - rows[i - 1].gap;
    const dNext = rows[i + 1].gap - rows[i].gap;
    if (dNext < 0.25 * dPrev || dNext <= 0) { elbow = rows[i].value; break; }
  }
  return elbow;
}

const pinned = {
  lensWeight: pickElbow('lensWeight'),
  anchorWeight: pickElbow('anchorWeight'),
  relationExpansionBudget: pickElbow('relationExpansionBudget'),
};

const anyGap = results.some((r) => Math.abs(r.gap) > 1e-4);

const report = {
  schemaVersion: 'coretex.stage2-scalar-sweep.v2',
  generatedAt: new Date().toISOString(),
  provenance: buildProvenance(),
  inputs: {
    corpus: corpusPath,
    corpusRoot: corpus.corpusRoot,
    eventCount: corpus.events.length,
    bundleProfile: profilePath ?? null,
    profileAttestation: profileAttestation(profile, profilePath),
    rerankerMode: rerankerArg,
    rerankerModel: reranker.model,
    biEncoderModelId: BI.modelId,
    biEncoderRevision: BI.revision,
    packSeedHex: seedHex,
    packSize: pack.events.length,
    pipelineVersion: profile.pipelineVersion,
    rerankerInputTopK: profile.rerankerInputTopK,
    firstStageTopK: profile.firstStageTopK,
  },
  sweeps: SWEEPS,
  results,
  pinned,
  notes: !anyGap
    ? 'WARNING: no scalar value produced a measurable empty-vs-engineered gap. ' +
      'Either the reranker is hash-blind (deterministic) and unable to distinguish ' +
      'truths from negatives, or the engineered substrate is too weak. Re-run with ' +
      'CORETEX_RERANKER=qwen3 for meaningful relation/anchor calibration.'
    : null,
};

mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(`\n[calibrate-stage2] report → ${reportPath}`);
console.log(`[calibrate-stage2] pinned:`);
console.log(`  lensWeight = ${pinned.lensWeight}`);
console.log(`  anchorWeight = ${pinned.anchorWeight}`);
console.log(`  relationExpansionBudget = ${pinned.relationExpansionBudget}`);

exit(anyGap ? 0 : 2);
