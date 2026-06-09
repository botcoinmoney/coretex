/**
 * Resolves the CoreTex repo root, dist root, and dist entry path for
 * calibration scripts. Used in place of `/root/cortex` literals so the
 * harness works on any host (Vast `/workspace/cortex`, dev laptops, CI)
 * without silently importing a stale `/root/cortex` copy.
 *
 * Resolution order:
 *   1. `CORETEX_REPO_ROOT` env var, when set.
 *   2. Walked up from this file's directory (scripts/.. == repo root).
 *
 * The resolved path is stamped in calibration provenance so artifacts
 * carry the exact repo path that produced them.
 */
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = process.env.CORETEX_REPO_ROOT
  ? resolve(process.env.CORETEX_REPO_ROOT)
  : resolve(here, '..');
export const distRoot = resolve(repoRoot, 'packages/cortex/dist');
export const distIndex = resolve(distRoot, 'index.js');
export const distValidator = resolve(distRoot, 'validator.js');
export const distBiEncoder = resolve(distRoot, 'eval/bi-encoder.js');
export const distPublicCorpusIndexDts = resolve(distRoot, 'eval/public-corpus-index.d.ts');
export const scriptsRoot = here;
export const provenanceModule = resolve(here, 'calibration-provenance.mjs');
