#!/usr/bin/env node
/**
 * Promote the candidate V2 owner-scope evaluator profile into a SIGNED
 * bundle/manifest path (bundleHash). This puts the winning V2 config
 * (ownerScopeMode / categoryLensFinalBonusWeight / categoryLensScoreInheritance /
 * majorDeltaThreshold / V2 hidden-pack quotas / pipelineVersion) under the signed
 * `bundleHash`, so production / replay verify against the SAME profile — closing
 * the "profile path can't express the winning config" gap.
 *
 * CANDIDATE, not the launch bundle: corpus.root is the V2 PRODUCTION corpus root
 * (computed from the bridged logical corpus); corpus.files references the logical
 * corpus file (sha256-verified). Serializing the V2 ProductionCorpus to the v1
 * on-disk format + re-rooting is the launch step. α=0.3 is not launch-pinned.
 *
 * Usage: node scripts/build-v2-bundle-candidate.mjs [--corpus <p1>] [--emb <p1emb>]
 *        [--profile release/bundle/evaluator-profile-v2-ownerscope-r1.json] [--out <path>]
 */
import { distIndex, repoRoot } from './_repo-root.mjs';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, relative, dirname } from 'node:path';
import { buildV2ProductionCorpus } from './lib/build-v2-production-corpus.mjs';

const {
  buildBundleManifest, verifyBundleManifest, bgeM3DenseManifest, qwen3Reranker06BManifest, memReranker4BManifest,
} = await import(distIndex);

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const corpusPath = flag('corpus', 'release/calibration/2026-05-21-memory-corpus-v2/p1-corpus.json');
const embPath = flag('emb', 'release/calibration/2026-05-21-memory-corpus-v2/p1-embeddings.json');
const profilePath = flag('profile', 'release/bundle/evaluator-profile-v2-ownerscope-r1.json');
const pinBundlePath = flag('bundle', 'release/bundle/bundle-manifest-v2-dgen1-policy-r5-300k-calibration.json');
const outPath = resolve(repoRoot, flag('out', 'release/bundle/bundle-manifest-v2-ownerscope-candidate.json'));

const evaluatorProfile = JSON.parse(readFileSync(resolve(repoRoot, profilePath), 'utf8'));
const { corpus } = buildV2ProductionCorpus({ corpusPath, embPath, bundlePath: pinBundlePath });
const corpusRoot = corpus.corpusRoot;
// Attest BOTH the logical corpus AND the embeddings file: embeddings feed the production events /
// corpusRoot / scoring path, so the signed bundle must commit the embeddings sha256 too (not just
// the corpus). Without this, verifyBundleManifest (which re-hashes only listed files) would not by
// itself catch a swapped embeddings sidecar — it would only surface on a full corpusRoot re-derive.
const corpusFiles = [
  relative(repoRoot, resolve(repoRoot, corpusPath)).replaceAll('\\', '/'),
  relative(repoRoot, resolve(repoRoot, embPath)).replaceAll('\\', '/'),
];

const manifest = buildBundleManifest({
  repoRoot, corpusRoot, corpusFiles,
  biEncoder: bgeM3DenseManifest(), reranker: qwen3Reranker06BManifest(), labelingReranker: memReranker4BManifest(),
  evaluatorProfile,
});
const errors = verifyBundleManifest(manifest, repoRoot);
if (errors.length > 0) { console.error(JSON.stringify({ ok: false, errors }, null, 2)); process.exit(2); }

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(manifest, null, 2));
const p = manifest.evaluator.profile;
console.log(JSON.stringify({ ok: true, out: relative(repoRoot, outPath), bundleHash: manifest.bundleHash, corpusRoot: manifest.corpus.root,
  profileSigned: { name: p.name, ownerScopeMode: p.ownerScopeMode, firstStageMode: p.firstStageMode, firstStageTopK: p.firstStageTopK, firstStageDenseWeight: p.firstStageDenseWeight, firstStageLexicalWeight: p.firstStageLexicalWeight, categoryLensFinalBonusWeight: p.categoryLensFinalBonusWeight, categoryLensScoreInheritance: p.categoryLensScoreInheritance, majorDeltaThreshold: p.majorDeltaThreshold, hiddenPackQuotas: p.hiddenPack.quotas.map((q) => q.stratum) } }, null, 2));
