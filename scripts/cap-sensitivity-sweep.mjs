#!/usr/bin/env node
/**
 * Cap sensitivity sweep: how does composite score + reranker work scale
 * with `rerankerInputTopK` ∈ {64, 96, 128, 192}? Confirms cap=128 is a
 * reasonable launch pin, not over- or under-conservative.
 *
 * For each cap value: score empty + lightly-engineered substrate on a
 * pack of 16 queries (calibration split), compute composite + measure
 * approximate reranker pair count from cappedDocIds length.
 */
import { distIndex } from './_repo-root.mjs';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { argv, exit } from 'node:process';
import { createHash } from 'node:crypto';

function flag(name, fb) {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  return fb;
}

const corpusPath = flag('corpus');
const profilePath = flag('bundle-profile');
const packSize = Number(flag('pack-size', '16'));
const caps = (flag('caps', '64,96,128,192')).split(',').map(Number);
const reportPath = flag('out', '/var/lib/coretex/reports/cap-sensitivity.json');
const seedHex = flag('seed', '0x' + 'ee'.repeat(32));

if (!corpusPath || !existsSync(corpusPath)) { console.error(`--corpus missing: ${corpusPath}`); exit(1); }

const {
  loadProductionCorpus,
  evaluateRetrievalBenchmarkState,
  biEncoderModelIdHash,
  biEncoderFromEnv,
  rerankerFromEnv,
  createDeterministicReranker,
  encodeMemoryIndexSlot,
  encodeRetrievalKeySlot,
  encodeRelationCategoryLens,
  stableRecordIdFor,
  DEFAULT_PROFILE,
} = await import(distIndex);
const { buildProvenance } = await import('./calibration-provenance.mjs');

const corpus = loadProductionCorpus(corpusPath, { verifyCorpusRoot: false, verifySplits: false });
const profile = profilePath ? JSON.parse(readFileSync(profilePath, 'utf8')).profile : DEFAULT_PROFILE;
const LAYOUT = corpus.biEncoderRetrievalKeyLayout;
const BI = { modelId: corpus.biEncoderModelId, revision: corpus.biEncoderRevision, mode: 'dense' };
const biEncoderHash = biEncoderModelIdHash(BI.modelId, BI.revision, BI.mode);

const reranker = (process.env.CORETEX_RERANKER === 'qwen3')
  ? await rerankerFromEnv()
  : await createDeterministicReranker();
const biEncoder = biEncoderFromEnv(LAYOUT, { modelId: BI.modelId, revision: BI.revision });

// Pack from calibration split
const events = corpus.events.filter((e) => e.split === 'calibration');
const scored = events.map((e) => ({ e, s: parseInt(createHash('sha256').update(seedHex + ':' + e.id).digest('hex').slice(0, 8), 16) }));
scored.sort((a, b) => a.s - b.s);
const pack = { epochId: 0, evalSeedCommit: seedHex, events: scored.slice(0, packSize).map((x) => x.e) };

// Build lightly-engineered substrate (top-K anchors)
const RANGES = { MEMORY_INDEX_START: 32, RETRIEVAL_KEYS_START: 384, RELATIONS_START: 672 };
function buildLightSubstrate(events) {
  const words = new Array(1024).fill(0n);
  for (let i = 0; i < Math.min(events.length, 16); i++) {
    const ev = events[i];
    const slot = { slotIndex: i, recordId: stableRecordIdFor(ev.id), family: ev.family, domainBits: 1n, valid: true, revoked: false, protected: false, retrievalSlot: i, expiryEpoch: 0n };
    const w = encodeMemoryIndexSlot(slot);
    for (let j = 0; j < 8; j++) words[RANGES.MEMORY_INDEX_START + i*8 + j] = w[j];
    const truth = ev.truthDocuments[0];
    if (truth) {
      const emb = ev.embeddings.perTruth.get(truth.id);
      if (emb) {
        const k = { slotIndex: i, modelIdHash: biEncoderHash, l2Norm: 1.0, versionTag: 1, quantizedBytes: emb };
        const kw = encodeRetrievalKeySlot(k, { retrievalKeyHeaderBytes: LAYOUT.headerBytes });
        for (let j = 0; j < 8; j++) words[RANGES.RETRIEVAL_KEYS_START + i*8 + j] = kw[j];
      }
    }
  }
  // 3 category lenses
  for (let i = 0; i < 3; i++) {
    const types = ['derived_from', 'supports', 'supersedes'];
    words[RANGES.RELATIONS_START + 127 - i] = encodeRelationCategoryLens({ entryIndex: 127 - i, edgeType: types[i], weight: 0x8000 });
  }
  return { words };
}
const ZERO = { words: new Array(1024).fill(0n) };
const ENG = buildLightSubstrate(pack.events);

const baseOpts = {
  weights: profile.compositeWeights ?? DEFAULT_PROFILE.compositeWeights,
  biEncoder, reranker, retrievalKeyLayout: LAYOUT, biEncoderHash,
  relationHopBudget: 2, abstentionThreshold: 0.001, rerankerTopK: 10,
  retrievalKeyTopK: 50, firstStageTopK: profile.firstStageTopK ?? 3200,
  lensTopK: 36,
  lensWeight: profile.lensWeight ?? 0.4,
  anchorWeight: profile.anchorWeight ?? 0.6,
  relationExpansionBudget: profile.relationExpansionBudget ?? 12,
  categoryLensExpansionBudget: profile.categoryLensExpansionBudget ?? profile.relationExpansionBudget ?? 50,
  temporalCurrentBoost: 0.1, temporalStaleSuppression: 0.1,
  lensDiversityFloor: profile.lensDiversityFloor ?? 0.7,
  pipelineVersion: profile.pipelineVersion,
};

const results = [];
for (const cap of caps) {
  const opts = { ...baseOpts, rerankerInputTopK: cap };
  console.error(`[cap-sweep] cap=${cap}`);
  const tE = Date.now();
  const sE = await evaluateRetrievalBenchmarkState(ZERO, corpus, pack, opts);
  const tE2 = Date.now() - tE;
  const totalCapped = sE.perQuery.reduce((a, q) => a + (q.cappedDocIds?.length ?? 0), 0);
  const tF = Date.now();
  const sF = await evaluateRetrievalBenchmarkState(ENG, corpus, pack, opts);
  const tF2 = Date.now() - tF;
  results.push({
    cap,
    empty: { composite: sE.composite, nDCG10: sE.nDCG10, totalCappedDocs: totalCapped, latencyMs: tE2 },
    engineered: { composite: sF.composite, nDCG10: sF.nDCG10, latencyMs: tF2 },
    gap: sF.composite - sE.composite,
  });
  console.error(`  empty composite=${sE.composite.toFixed(4)} (latency=${(tE2/1000).toFixed(1)}s, cappedDocs=${totalCapped})`);
  console.error(`  engineered composite=${sF.composite.toFixed(4)} (latency=${(tF2/1000).toFixed(1)}s)`);
}

const report = {
  schemaVersion: 'coretex.cap-sensitivity.v1',
  generatedAt: new Date().toISOString(),
  provenance: buildProvenance(),
  inputs: { corpus: corpusPath, corpusRoot: corpus.corpusRoot, eventCount: corpus.events.length, bundleProfile: profilePath, packSize, caps, seedHex, rerankerKind: reranker.model },
  results,
};
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.error(`\n[cap-sweep] report → ${reportPath}`);
