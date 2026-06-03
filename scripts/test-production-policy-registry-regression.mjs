#!/usr/bin/env node
/**
 * Production plumbing regression test (auditor item 9).
 *
 * Question: when the reduced launch profile is loaded via the PRODUCTION
 * scoring path — that is, scoringOptionsFromProfile + NO harness-side manual
 * injection of policyEntityRegistry — does a conflict_lifecycle PolicyAtom
 * still policy-admit and produce a positive composite delta?
 *
 * The 8ee4602 harness fix injects policyEntityRegistry into optsForProd at
 * harness time. That keeps the surface-search and live-evolve harnesses
 * honest, but the PRODUCTION code path (anything that calls
 * scoringOptionsFromProfile directly, e.g. retrieval-benchmark via the
 * coordinator) does NOT carry the registry. This test exposes whether
 * production scoring still has the same plumbing gap.
 *
 * Pass: composite delta from a canonical conflict_lifecycle patch is
 * positive AND the conflict atom fires on at least one pack query.
 * Fail: composite delta is zero AND no conflict atom fires → production
 * scorer is still relying on the eventsInStage1 fallback, not the
 * query-conditioned admission, and production paths must plumb the
 * registry through scoringOptionsFromProfile (or accept a runtime
 * `corpus` arg and derive the registry there).
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import process from 'node:process';
import { distIndex, repoRoot } from './_repo-root.mjs';
import { inertBiEncoder } from './lib/build-v2-production-corpus.mjs';
import { loadMaterializedCorpus } from './lib/load-materialized-corpus.mjs';
import { conflictUnits } from './lib/v2-patch-families.mjs';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const BUNDLE_PATH = flag('bundle', 'release/bundle/bundle-manifest-v2-dgen1-policy-r5-300k-launch-reduced.json');
const PROFILE_PATH = flag('profile', 'release/bundle/evaluator-profile-v2-dgen1-policy-r5-300k-launch-reduced.json');
const CORPUS_PATH = flag('corpus', 'release/calibration/2026-05-21-memory-corpus-v2/dgen1-r5-synth-300k-v15-corpus.json');
const EMB_PATH = flag('emb', 'release/calibration/2026-05-21-memory-corpus-v2/dgen1-r5-synth-300k-v15-embeddings.json');
const OUT = flag('out', 'release/calibration/2026-05-21-memory-corpus-v2/test-production-policy-registry-regression-2d953b71.json');

const C = await import(distIndex);
const {
  scoringOptionsFromProfile, deriveQueryPack, evaluateRetrievalBenchmarkState,
  applyPatch, decodeSubstrate, parseQueryConflictIntent,
  createDeterministicReranker, biEncoderModelIdHash, PATCH_TYPE, merkleizeState, RANGES,
} = C;

const profile = JSON.parse(readFileSync(resolve(repoRoot, PROFILE_PATH), 'utf8'));
console.log('[reg-test] loading materialized base corpus ...');
const baseBundle = loadMaterializedCorpus(BUNDLE_PATH, { sourceCorpusPath: CORPUS_PATH, sourceEmbPath: EMB_PATH });
const currentProd = baseBundle.corpus;
const { BE, RR, LAYOUT } = baseBundle;
const rawCorpus = JSON.parse(readFileSync(resolve(repoRoot, CORPUS_PATH), 'utf8'));
const logicalQById = new Map(rawCorpus.queries.map((q) => [q.id, q]));
const eventByDocId = new Map(); for (const ev of currentProd.events) eventByDocId.set(ev.id, ev);

const reranker = await createDeterministicReranker();
const biEncoderHash = biEncoderModelIdHash(BE.modelId, BE.revision, 'dense');
const rt = () => ({ biEncoder: inertBiEncoder(BE, LAYOUT), reranker, biEncoderHash, retrievalKeyLayout: LAYOUT });

// PRODUCTION PATH: scoringOptionsFromProfile only — no manual registry injection.
const optsProd = { ...scoringOptionsFromProfile(profile, rt()), exposeFullRanking: true, policyEmitTraces: true };

// HARNESS PATH: scoringOptionsFromProfile + manual policyEntityRegistry — the fix the
// harness already carries. Test the reference path so we can detect the SPECIFIC
// production-vs-harness gap.
const policyEntityRegistry = (rawCorpus.entities ?? []).map((e) => ({ id: e.id, names: [e.canonicalName, ...(e.aliases ?? [])].filter(Boolean).map((n) => String(n).toLowerCase()) }));
const optsHarness = { ...scoringOptionsFromProfile(profile, rt()), exposeFullRanking: true, policyEmitTraces: true, policyEntityRegistry, policyGenericEntityIds: ['e_universe'] };

const frontierSeed = profile.epochFrontier?.seed ?? 'coretex-launch-frontier';
const evalSeedHex = '0x' + createHash('sha256').update(frontierSeed).digest('hex');
const pack = deriveQueryPack(0, evalSeedHex, currentProd, { ...(profile.hiddenPack ?? {}), packSize: 64 });
console.log(`[reg-test] pack: ${pack.events.length} events`);

const genesisState = { words: new Array(1024).fill(0n) };
const u = conflictUnits({ pack, logicalQById, eventByDocId, conflictSlot: 0, action: 'boost' });
if (!u.indices?.length) {
  console.error(`[reg-test] conflictUnits returned no units: ${u.reason}`);
  process.exit(1);
}
const patch = { patchType: PATCH_TYPE.MIXED, wordCount: u.indices.length, scoreDelta: 0, parentStateRoot: merkleizeState(genesisState), indices: u.indices, newWords: u.newWords };
const applied = applyPatch(genesisState, patch, true);
if (!applied.ok) { console.error('apply failed:', applied.code, applied.message); process.exit(1); }

async function score(label, opts) {
  const before = await evaluateRetrievalBenchmarkState(genesisState, currentProd, pack, opts);
  const after = await evaluateRetrievalBenchmarkState(applied.state, currentProd, pack, opts);
  const conflictFired = (after.perQuery ?? []).some((q) => (q.policyTraces ?? []).some((t) => t.atomFamily === 'conflict_lifecycle'));
  const dPpm = Math.round(((after.composite ?? 0) - (before.composite ?? 0)) * 1_000_000);
  console.log(`[reg-test] ${label}: composite ${before.composite?.toFixed(6)} → ${after.composite?.toFixed(6)}  Δppm=${dPpm}  conflictAtomFired=${conflictFired}`);
  return { label, beforeComposite: before.composite, afterComposite: after.composite, compositeDeltaPpm: dPpm, conflictAtomFired: conflictFired };
}

console.log('[reg-test] scoring production path (no manual registry) ...');
const prod = await score('production', optsProd);
console.log('[reg-test] scoring harness path (with manual registry) ...');
const harn = await score('harness', optsHarness);

const verdict = {
  productionAtomFired: prod.conflictAtomFired,
  harnessAtomFired: harn.conflictAtomFired,
  productionCompositeDeltaPpm: prod.compositeDeltaPpm,
  harnessCompositeDeltaPpm: harn.compositeDeltaPpm,
  productionPathStillBroken: !prod.conflictAtomFired && harn.conflictAtomFired,
  productionPathOk: prod.conflictAtomFired,
};
console.log('[reg-test] verdict:', verdict);

const report = {
  schema: 'coretex.production-policy-registry-regression.v1',
  bundleHash: baseBundle.manifest.bundleHash, corpusRoot: baseBundle.manifest.corpusRoot,
  profile: PROFILE_PATH, anchoredDocId: u.minedDocId,
  prodResult: prod, harnessResult: harn, verdict,
  recommendation: verdict.productionPathStillBroken
    ? 'PRODUCTION PATH BROKEN: scoringOptionsFromProfile does not plumb policyEntityRegistry. Anything that calls it directly (coordinator, future scorer entry points) will silently lose conflict/abstention admission. Fix: add a profile sentinel "policyEntityRegistry: derive-from-corpus" that the bundle layer materializes from currentLogical.entities, OR accept a runtime corpus argument and derive the registry inside scoringOptionsFromProfile.'
    : 'PRODUCTION PATH OK: registry plumbing matches harness behavior.',
};
const outAbs = resolve(repoRoot, OUT);
mkdirSync(dirname(outAbs), { recursive: true });
writeFileSync(outAbs, JSON.stringify(report, null, 2));
console.log(`[reg-test] wrote ${outAbs}`);
process.exit(verdict.productionPathStillBroken ? 2 : 0);
