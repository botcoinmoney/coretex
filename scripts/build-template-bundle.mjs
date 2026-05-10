// Build a template bundle manifest (no corpus yet) so the corpus generator
// and calibrator can read pinned model fields. The final bundle is rebuilt
// after calibration with the real corpusRoot via npm run build:bundle.
import { writeFileSync } from 'node:fs';
import {
  buildBundleManifest,
  bgeM3DenseManifest,
  qwen3Reranker06BManifest,
  memReranker4BManifest,
} from '@botcoin/cortex';

const PLACEHOLDER_CORPUS_ROOT = '0x' + '00'.repeat(32);
const repoRoot = '/root/cortex';

const manifest = buildBundleManifest({
  repoRoot,
  corpusRoot: PLACEHOLDER_CORPUS_ROOT,
  corpusFiles: [],
  biEncoder: bgeM3DenseManifest(),
  reranker: qwen3Reranker06BManifest(),
  labelingReranker: memReranker4BManifest(),
  bundleName: 'botcoin-coretex-v4-template',
});

writeFileSync('/etc/coretex/template-bundle.json', JSON.stringify(manifest, null, 2));
console.log('template-bundle.json written; bundleHash=', manifest.bundleHash);
console.log('  bi-encoder:', manifest.model.biEncoder.modelId, '@', manifest.model.biEncoder.revision.slice(0, 8));
console.log('  reranker:', manifest.model.reranker.modelId, '@', manifest.model.reranker.revision.slice(0, 8));
console.log('  labeler:', manifest.model.labelingReranker.modelId, '@', manifest.model.labelingReranker.revision.slice(0, 8));
