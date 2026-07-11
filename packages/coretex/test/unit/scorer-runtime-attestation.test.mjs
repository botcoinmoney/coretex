/**
 * AUDIT-2 (law half, task 3) — runtime-attestation contract for the keyless
 * scorer. Pins:
 *  - 3c: REWARD_CRITICAL_SCORING_CLOSURE covers the FULL transitive import
 *        closure of the reward-critical scoring modules (a newly-imported
 *        scoring module cannot silently escape the code pin);
 *  - 3c: computeScorerCodeHealth reports the new per-module hashes + the closure
 *        rollup, and coretexPackageSha256 excludes the runtime staging fact;
 *  - 3b: stagedPayloadSha256 reflects CORETEX_SCORER_PAYLOAD_SHA256 and is NOT
 *        folded into coretexPackageSha256 (code identity is host-independent);
 *  - 3d: scorerVersionMatchesRange rejects the round-7 defect (torch 2.13.0+cpu
 *        vs a 2.6.* pin) and accepts the pinned cpu wheel;
 *  - 3a: attestModelWeights verifies real bytes against the bundle pin,
 *        fail-closed on a swapped checkpoint and on an unresolvable dir.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  computeScorerCodeHealth,
  attestModelWeights,
  REWARD_CRITICAL_SCORING_CLOSURE,
} from '../../dist/scorer-server-cli.js';
import { scorerVersionMatchesRange } from '../../dist/validator-runtime.js';

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));

// Recompute the reward-critical import closure directly from source and assert
// the pinned constant covers it exactly.
function importClosure(roots) {
  const seen = new Set();
  const out = new Set();
  const walk = (mod) => {
    if (seen.has(mod)) return;
    seen.add(mod);
    const p = join(SRC, `${mod}.ts`);
    let txt;
    try { txt = readFileSync(p, 'utf8'); } catch { return; }
    out.add(mod);
    const re = /from\s+['"](\.[^'"]+)['"]/g;
    let m;
    while ((m = re.exec(txt))) {
      const rel = m[1].replace(/\.js$/, '');
      const segs = mod.split('/');
      segs.pop();
      for (const s of rel.split('/')) {
        if (s === '.') continue;
        else if (s === '..') segs.pop();
        else segs.push(s);
      }
      walk(segs.join('/'));
    }
  };
  roots.forEach(walk);
  return [...out].sort();
}

describe('3c — reward-critical scoring closure', () => {
  test('REWARD_CRITICAL_SCORING_CLOSURE covers the actual import closure', () => {
    const closure = importClosure([
      'eval/retrieval-benchmark',
      'eval/bmu-benchmark',
      'eval/bmu-task',
      'substrate/retrieval-decoder',
      'eval/bmu-operation-program',
    ]);
    const pinned = new Set(REWARD_CRITICAL_SCORING_CLOSURE);
    const missing = closure.filter((m) => !pinned.has(m));
    assert.deepEqual(missing, [], `closure modules not pinned in REWARD_CRITICAL_SCORING_CLOSURE: ${missing.join(', ')}`);
    // No stale entries either (the constant must equal the closure).
    const stale = [...pinned].filter((m) => !closure.includes(m));
    assert.deepEqual(stale, [], `stale pins not in the closure: ${stale.join(', ')}`);
  });
});

describe('3c/3b — computeScorerCodeHealth', () => {
  test('reports the new per-module hashes + closure rollup', () => {
    const health = computeScorerCodeHealth();
    for (const k of ['biEncoderSha256', 'irMetricsSha256', 'hiddenQueryPackSha256', 'publicCorpusIndexSha256', 'rerankerSha256', 'structuralValiditySha256', 'scoringClosureSha256']) {
      assert.match(health[k], /^[0-9a-f]{64}$/, `${k} must be a sha256`);
    }
  });
  test('stagedPayloadSha256 reflects env and is EXCLUDED from coretexPackageSha256', () => {
    const before = process.env['CORETEX_SCORER_PAYLOAD_SHA256'];
    delete process.env['CORETEX_SCORER_PAYLOAD_SHA256'];
    const a = computeScorerCodeHealth();
    assert.equal(a.stagedPayloadSha256, null);
    process.env['CORETEX_SCORER_PAYLOAD_SHA256'] = `0x${'ab'.repeat(32)}`;
    const b = computeScorerCodeHealth();
    assert.equal(b.stagedPayloadSha256, `0x${'ab'.repeat(32)}`);
    // Code identity must NOT move when only the staging fact changes.
    assert.equal(a.coretexPackageSha256, b.coretexPackageSha256);
    if (before === undefined) delete process.env['CORETEX_SCORER_PAYLOAD_SHA256'];
    else process.env['CORETEX_SCORER_PAYLOAD_SHA256'] = before;
  });
});

describe('3d — runtime-manifest torch/transformers pin', () => {
  test('rejects the round-7 defect (torch 2.13.0+cpu vs 2.6.*) and accepts the pinned cpu wheel', () => {
    assert.equal(scorerVersionMatchesRange('2.13.0+cpu', '2.6.*'), false);
    assert.equal(scorerVersionMatchesRange('2.6.0+cpu', '2.6.*'), true);
    assert.equal(scorerVersionMatchesRange('4.55.2', '4.55.*'), true);
    assert.equal(scorerVersionMatchesRange('4.46.0', '4.55.*'), false);
  });
});

describe('3a — attestModelWeights', () => {
  const bytes = Buffer.from('pretend-safetensors-weights');
  const sha = createHash('sha256').update(bytes).digest('hex');
  const mkBundle = (pinSha) => ({
    model: { reranker: { modelId: 'Qwen/Qwen3-Reranker-0.6B', revision: 'e61197ed', files: [
      { path: 'model.safetensors', sha256: pinSha, bytes: bytes.length },
    ] } },
  });

  test('verifies real bytes against the bundle pin (explicit dir)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coretex-weights-'));
    writeFileSync(join(dir, 'model.safetensors'), bytes);
    const out = attestModelWeights(mkBundle(sha), { CORETEX_RERANKER_MODEL_DIR: dir });
    assert.equal(out.sha256, sha);
  });

  test('resolves the HF snapshot layout under a cache env', () => {
    const cache = mkdtempSync(join(tmpdir(), 'coretex-hfcache-'));
    const snap = join(cache, 'models--Qwen--Qwen3-Reranker-0.6B', 'snapshots', 'e61197ed');
    mkdirSync(snap, { recursive: true });
    writeFileSync(join(snap, 'model.safetensors'), bytes);
    const out = attestModelWeights(mkBundle(sha), { CORTEX_LOCAL_MODEL_CACHE: cache });
    assert.equal(out.sha256, sha);
  });

  test('fails closed on a swapped checkpoint (sha mismatch)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coretex-weights-'));
    writeFileSync(join(dir, 'model.safetensors'), bytes);
    assert.throws(() => attestModelWeights(mkBundle(`0x${'00'.repeat(32)}`.slice(2)), { CORETEX_RERANKER_MODEL_DIR: dir }), /sha .* != bundle pin/);
  });

  test('fails closed when weights are unresolvable (no escape hatch)', () => {
    assert.throws(() => attestModelWeights(mkBundle(sha), {}), /cannot resolve reranker weights/);
  });

  test('escape hatch returns null with a note only when explicitly allowed', () => {
    const out = attestModelWeights(mkBundle(sha), { CORETEX_SCORER_ALLOW_UNVERIFIED_WEIGHTS: '1' });
    assert.equal(out.sha256, null);
    assert.match(out.note, /unresolvable/);
  });
});
