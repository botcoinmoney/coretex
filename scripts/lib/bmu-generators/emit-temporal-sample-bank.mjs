/**
 * BMU P2 — temporal family sample-bank emitter (certification-stage input).
 *
 * Emits ≥16 complete clusters (≥80 eval_hidden rows) across ≥3 synthetic
 * epochs, deterministic from the pinned params below, as JSON:
 *   sample-bank.json  — clusters (public docs + k=5 rows with bmuTask stamps)
 *   manifest.json     — generation params + m=1 census + integrity counts
 *
 * Usage:  node scripts/lib/bmu-generators/emit-temporal-sample-bank.mjs <outDir>
 *
 * Split landing uses the CANONICAL composition (splitForRecord over the
 * production live-tail id — the evolve wiring, coretex-epoch-evolve.mjs:583)
 * with a pinned corpusEpoch, recorded in the manifest so the certification
 * stage re-derives identically.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import { generateTemporalClusters } from './temporal.mjs';
import { createBmuActiveIndex, retireAgedClusters, m1Census } from './common.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pkgDist = resolve(here, '../../../packages/coretex/dist');
const { splitForRecord } = await import(`${pkgDist}/eval/retrieval-corpus.js`);
const { liveTailQueryId } = await import(`${pkgDist}/corpus/logical-delta-bridge.js`);

// ── Pinned generation params ─────────────────────────────────────────────────
export const SAMPLE_BANK_PARAMS = Object.freeze({
  family: 'temporal',
  spec: 'BMU_SPEC.md rev3.2 ad7e523',
  seed: 'bmu-p2-temporal-cert-v1',
  corpusEpoch: 138,           // A2 fork pin lineage (G-A3 artifacts)
  epochs: [150, 151, 152],    // synthetic, disjoint from live history
  clustersPerEpoch: 6,
  maxAge: 32,                 // §6.2 — sample window never retires (3 epochs)
  universe: 'user_scope_bmu_p2_temporal_cert',
  budgetB: 3,
});

/** Deterministic synthetic subject bank (persons + `-svc-` projects; the
 *  isProject convention is the ancestor's, evolve-corpus.mjs). */
export function sampleSubjectBank() {
  const persons = [
    'Marisol Vega', 'Anders Holt', 'Priya Raman', 'Tomas Iwu', 'Greta Lindqvist', 'Rafael Ochoa',
    'Yuki Tanabe', 'Leila Farouk', 'Dmitri Kovacs', 'Nia Abara', 'Sofia Petrov', 'Emeka Uzo',
  ];
  const projects = [
    'atlas-svc-billing', 'beacon-svc-ingest', 'cedar-svc-notify', 'delta-svc-search',
    'ember-svc-reports', 'falcon-svc-queue', 'granite-svc-authz', 'harbor-svc-export',
    'atlas-svc-metrics', 'beacon-svc-replay', 'cedar-svc-webhooks', 'delta-svc-archive',
  ];
  const subjects = [];
  for (let i = 0; i < Math.max(persons.length, projects.length); i++) {
    if (i < persons.length) subjects.push({ id: `subj_bmu_p${i}`, canonicalName: persons[i] });
    if (i < projects.length) subjects.push({ id: `subj_bmu_s${i}`, canonicalName: projects[i] });
  }
  return subjects;
}

export function buildTemporalSampleBank(params = SAMPLE_BANK_PARAMS) {
  const splitOf = (logicalQueryId, liveUpdateEpoch) => splitForRecord(
    liveUpdateEpoch !== undefined && liveUpdateEpoch !== null
      ? liveTailQueryId(logicalQueryId, liveUpdateEpoch)
      : logicalQueryId,
    params.corpusEpoch,
  );
  const subjects = sampleSubjectBank();
  const activeIndex = createBmuActiveIndex();
  const clusters = [];
  const perEpoch = [];
  let operationSequenceOffset = 0;
  for (const epoch of params.epochs) {
    retireAgedClusters(activeIndex, epoch, params.maxAge);
    const out = generateTemporalClusters({
      epoch,
      seed: params.seed,
      subjects,
      universe: params.universe,
      clusterCount: params.clustersPerEpoch,
      splitOf,
      activeIndex,
      operationSequenceOffset,
    });
    operationSequenceOffset += params.clustersPerEpoch;
    clusters.push(...out.clusters);
    perEpoch.push(out.telemetry);
  }
  const census = m1Census(activeIndex);
  if (census.length > 0) {
    throw new Error(`sample bank violates GLOBAL m=1:\n${census.join('\n')}`);
  }
  return { params, subjects, clusters, perEpoch, census };
}

function hashJsonStable(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function emitTemporalSampleBank(outDir, params = SAMPLE_BANK_PARAMS) {
  const { subjects, clusters, perEpoch, census } = buildTemporalSampleBank(params);
  mkdirSync(outDir, { recursive: true });
  const bank = {
    kind: 'bmu-p2-sample-bank',
    family: params.family,
    generatedBySpec: params.spec,
    clusters,
  };
  const bankPath = resolve(outDir, 'sample-bank.json');
  const bankJson = JSON.stringify(bank, null, 1);
  writeFileSync(bankPath, bankJson);
  const rowCount = clusters.reduce((n, c) => n + c.rows.length, 0);
  const docCount = clusters.reduce((n, c) => n + c.docs.length, 0);
  const manifest = {
    kind: 'bmu-p2-sample-bank-manifest',
    family: params.family,
    generationParams: params,
    subjectBank: subjects,
    counts: {
      epochs: params.epochs.length,
      clusters: clusters.length,
      rows: rowCount,
      docs: docCount,
      templatesUsed: new Set(clusters.flatMap((c) => c.templateIds)).size,
      subjectsUsed: new Set(clusters.map((c) => c.subjectEntityId)).size,
    },
    perEpochTelemetry: perEpoch,
    globalM1Census: { violations: census, holds: census.length === 0 },
    splitLaw: 'splitForRecord(liveTailQueryId(id, liveUpdateEpoch), corpusEpoch) === eval_hidden for every row id',
    sampleBankSha256: createHash('sha256').update(bankJson).digest('hex'),
    clustersDigest: hashJsonStable(clusters.map((c) => c.motifGroupId)),
  };
  const manifestPath = resolve(outDir, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 1));
  return { bankPath, manifestPath, manifest };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outDir = process.argv[2];
  if (!outDir) {
    console.error('usage: node emit-temporal-sample-bank.mjs <outDir>');
    process.exit(1);
  }
  const { bankPath, manifestPath, manifest } = emitTemporalSampleBank(resolve(outDir));
  console.log(`sample bank: ${bankPath}`);
  console.log(`manifest:    ${manifestPath}`);
  console.log(JSON.stringify(manifest.counts, null, 1));
}
