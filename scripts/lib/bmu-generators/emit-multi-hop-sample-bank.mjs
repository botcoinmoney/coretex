/**
 * BMU P2 — multi_hop_relation family sample-bank emitter (certification-stage
 * input).
 *
 * Emits ≥22 complete clusters (≥110 eval_hidden rows — the §6.7b E_f_min for
 * this family) across ≥3 synthetic epochs, deterministic from the pinned
 * params below, as JSON:
 *   sample-bank.json  — clusters (public docs + relations + k=5 rows with
 *                       full §4.1 bmuTask stamps)
 *   manifest.json     — generation params + m=1 census + integrity counts
 *
 * Usage:  node scripts/lib/bmu-generators/emit-multi-hop-sample-bank.mjs <outDir>
 *
 * Split landing uses the CANONICAL composition (splitForRecord over the
 * production live-tail id — the evolve wiring, coretex-epoch-evolve.mjs:583)
 * with a pinned corpusEpoch, recorded in the manifest so the certification
 * stage re-derives identically.
 *
 * Mirrors the P2 temporal lane's emitter (emit-temporal-sample-bank.mjs) so
 * the certification stage consumes all family banks uniformly. Subject-bank
 * ids are namespaced `subj_bmuh_*` — DISJOINT from the temporal lane's
 * `subj_bmu_*` bank so that a combined multi-family run over one GLOBAL m=1
 * active index (the rev3.2 law) can never collide on synthetic subjects.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import { generateMultiHopClusters } from './multi_hop_relation.mjs';
import { bmuDocIdKeyCommit, deriveBmuEpochDocIdKeyHex, createBmuActiveIndex, retireAgedClusters, m1Census } from './common.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pkgDist = resolve(here, '../../../packages/coretex/dist');
const { splitForRecord } = await import(`${pkgDist}/eval/retrieval-corpus.js`);
const { liveTailQueryId } = await import(`${pkgDist}/corpus/logical-delta-bridge.js`);

// ── Pinned generation params ─────────────────────────────────────────────────
export const SAMPLE_BANK_PARAMS = Object.freeze({
  family: 'multi_hop_relation',
  spec: 'BMU_SPEC.md rev3.2 ad7e523',
  seed: 'bmu-p2-multihop-cert-v1',
  corpusEpoch: 138,           // A2 fork pin lineage (G-A3 artifacts)
  epochs: [150, 151, 152],    // synthetic, disjoint from live history
  clustersPerEpoch: 8,        // 24 clusters / 120 rows ≥ E_f_min 110 (§6.7b)
  maxAge: 32,                 // §6.2 — sample window never retires (3 epochs)
  universe: 'user_scope_bmu_p2_multihop_cert',
  budgetB: 4,
});

/** Deterministic synthetic subject bank (persons + `-svc-` projects; the
 *  isProject convention is the ancestor's, evolve-corpus.mjs). Ids are
 *  `subj_bmuh_*` — disjoint from the temporal lane bank (see module note). */
export function sampleSubjectBank() {
  const persons = [
    'Beatriz Salcedo', 'Corin Aldana', 'Devika Menon', 'Elias Vranik', 'Farida Osei', 'Gunnar Toft',
    'Hana Sorel', 'Ivo Radek', 'Jamila Bensaid', 'Kenji Morita', 'Lucia Ferrant', 'Mateo Quiroga',
  ];
  const projects = [
    'atlas-svc-ledger', 'beacon-svc-router', 'cedar-svc-paging', 'delta-svc-signoff',
    'ember-svc-oncall', 'falcon-svc-relay', 'granite-svc-desk', 'harbor-svc-digest',
    'atlas-svc-rota', 'beacon-svc-cover', 'cedar-svc-standby', 'delta-svc-fallback',
  ];
  // Block layout (persons then projects), NOT interleaved: a strict
  // person/project alternation aligns with the ordinal-parity hop schedule
  // and starves one 3-hop variant (measured: an interleaved bank produced 12
  // coref-framed and 0 plain 3-hop clusters). Blocks make the seeded
  // skip-scan cross person/project runs so both 3-hop shapes are exercised.
  const subjects = [];
  for (let i = 0; i < persons.length; i++) subjects.push({ id: `subj_bmuh_p${i}`, canonicalName: persons[i] });
  for (let i = 0; i < projects.length; i++) subjects.push({ id: `subj_bmuh_s${i}`, canonicalName: projects[i] });
  return subjects;
}

export function buildMultiHopSampleBank(params = SAMPLE_BANK_PARAMS, { docIdMasterKeyHex } = {}) {
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
  let operationClassSlotOffset = 0;
  for (const epoch of params.epochs) {
    retireAgedClusters(activeIndex, epoch, params.maxAge);
    const out = generateMultiHopClusters({
      epoch,
      seed: params.seed,
      docIdKeyHex: deriveBmuEpochDocIdKeyHex(docIdMasterKeyHex, epoch),
      subjects,
      universe: params.universe,
      clusterCount: params.clustersPerEpoch,
      splitOf,
      activeIndex,
      operationClassSlotOffset,
    });
    operationClassSlotOffset += params.clustersPerEpoch;
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

export function emitMultiHopSampleBank(outDir, params = SAMPLE_BANK_PARAMS, { docIdMasterKeyHex } = {}) {
  const { subjects, clusters, perEpoch, census } = buildMultiHopSampleBank(params, { docIdMasterKeyHex });
  mkdirSync(outDir, { recursive: true });
  const bank = {
    kind: 'bmu-p2-sample-bank',
    family: params.family,
    params,
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
    docIdKeyCommits: Object.fromEntries(params.epochs.map((epoch) => [
      epoch, bmuDocIdKeyCommit(deriveBmuEpochDocIdKeyHex(docIdMasterKeyHex, epoch)),
    ])),
    subjectBank: subjects,
    counts: {
      epochs: params.epochs.length,
      clusters: clusters.length,
      rows: rowCount,
      docs: docCount,
      relations: clusters.reduce((n, c) => n + c.relations.length, 0),
      hopCountHistogram: clusters.reduce((histo, c) => {
        histo[c.hopCount] = (histo[c.hopCount] ?? 0) + 1;
        return histo;
      }, {}),
      corefFramedClusters: clusters.filter((c) => c.corefFramed).length,
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
    console.error('usage: node emit-multi-hop-sample-bank.mjs <outDir>');
    process.exit(1);
  }
  const { bankPath, manifestPath, manifest } = emitMultiHopSampleBank(resolve(outDir), SAMPLE_BANK_PARAMS, {
    docIdMasterKeyHex: process.env.CORETEX_BMU_DOC_ID_KEY_HEX,
  });
  console.log(`sample bank: ${bankPath}`);
  console.log(`manifest:    ${manifestPath}`);
  console.log(JSON.stringify(manifest.counts, null, 1));
}
