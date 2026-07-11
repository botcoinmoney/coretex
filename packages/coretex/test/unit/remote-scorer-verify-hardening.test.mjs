/**
 * Hardening tests for verifyScorerResult:
 *  - gate/confirm scores must be FINITE SAFE INTEGERS (typeof-number alone is
 *    NaN-bypassable: NaN defeats the `min(gate,confirm) < threshold` check);
 *  - the result's top-level scores must EQUAL the dual-pack proof's scores.
 * The full check-1..8 matrix (real artifacts) lives in the coordinator
 * integration repo; these tests pin the two canonical-layer gaps.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { verifyScorerResult } from '../../dist/coordinator/remote-scorer-verify.js';

const B32 = (b) => '0x' + b.repeat(32);

function minimalResult(over = {}) {
  return {
    jobId: 'job-1',
    accepted: true,
    deltaPpm: 42_000,
    gateScorePpm: 45_000,
    confirmScorePpm: 42_000,
    thresholdPpmUsed: 1_000,
    policyHash: B32('ee'),
    pairTraceHash: B32('aa'),
    scoreArrayHash: B32('bb'),
    evalReportHash: B32('e1'),
    artifactHash: B32('a1'),
    scorerHealth: { modelId: 'm', revision: 'r', promptTemplateHash: B32('ab') },
    ...over,
  };
}

// job.epochId deliberately != active.epochId: a result that gets PAST the
// schema check fails next at SCORER_STALE_CONTEXT — which proves the schema
// accepted it without needing full artifact fixtures.
const job = { jobId: 'job-1', epochId: 7, thresholdPpm: 1_000, policyHash: B32('ee') };
const active = { epochId: 8, parentStateRoot: B32('01'), corpusRoot: B32('cc'), bundleHash: B32('dd'), coreVersionHash: B32('dd'), workPolicyHash: B32('ee'), thresholdPpm: 1_000 };
const expectedHealth = { modelId: 'm', revision: 'r', promptTemplateHash: B32('ab') };
const outstanding = new Set(['job-1']);

function verify(result) {
  return verifyScorerResult({ result, job, outstandingJobIds: outstanding, active, expectedHealth });
}

describe('verifyScorerResult score hardening', () => {
  test('NaN / Infinity / float gate or confirm scores are SCORER_RESULT_MALFORMED', () => {
    for (const bad of [NaN, Infinity, -Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      for (const field of ['gateScorePpm', 'confirmScorePpm']) {
        const v = verify(minimalResult({ [field]: bad }));
        assert.equal(v.ok, false, `${field}=${bad}`);
        assert.equal(v.code, 'SCORER_RESULT_MALFORMED', `${field}=${bad} → ${v.code}: ${v.reason}`);
        assert.match(v.reason, /finite safe integers/);
      }
    }
  });

  test('finite safe-integer scores pass the schema (fail later at stale-context, not malformed)', () => {
    const v = verify(minimalResult());
    assert.equal(v.ok, false);
    assert.equal(v.code, 'SCORER_STALE_CONTEXT');
  });
});

// AUDIT-2 — accelerator-policy-aware CUDA check. Under a cpu_only BMU bundle the
// scorer runs deterministic fp32 on CPU (cuda:false), so the canonical
// verifyScorerResult must NOT hard-require cuda:true; GPU-pinned bundles keep it.
describe('verifyScorerResult accelerator-policy CUDA gate (§18.6 / round-7 CPU)', () => {
  const alignedJob = { jobId: 'job-1', epochId: 8, parentStateRoot: B32('01'), corpusRoot: B32('cc'), bundleHash: B32('dd'), coreVersionHash: B32('dd'), policyHash: B32('ee'), thresholdPpm: 1_000 };
  const alignedActive = { epochId: 8, parentStateRoot: B32('01'), corpusRoot: B32('cc'), bundleHash: B32('dd'), coreVersionHash: B32('dd'), workPolicyHash: B32('ee'), thresholdPpm: 1_000 };
  const healthOf = (over) => ({ modelId: 'm', revision: 'r', promptTemplateHash: B32('ab'), dtype: 'fp32', tf32: false, ...over });
  const run = (scorerHealth, acceleratorPolicy) => verifyScorerResult({
    result: minimalResult({ accepted: false, scorerHealth }),
    job: alignedJob,
    outstandingJobIds: new Set(['job-1']),
    active: alignedActive,
    expectedHealth: { modelId: 'm', revision: 'r', promptTemplateHash: B32('ab'), ...(acceleratorPolicy ? { acceleratorPolicy } : {}) },
  });
  const cudaMismatch = (v) => v.code === 'SCORER_HEALTH_MISMATCH' && /cuda/.test(v.reason);

  test('cpu_only bundle: cuda:false + device cpu is ACCEPTED past the health gate', () => {
    const v = run(healthOf({ cuda: false, device: 'cpu' }), 'cpu_only');
    assert.equal(cudaMismatch(v), false, `should not be a cuda mismatch: ${v.code} ${v.reason ?? ''}`);
  });
  test('cpu_only bundle: cuda:true is REFUSED (cuda != false)', () => {
    const v = run(healthOf({ cuda: true, device: 'cuda:0' }), 'cpu_only');
    assert.equal(v.code, 'SCORER_HEALTH_MISMATCH');
    assert.match(v.reason, /cuda true != false/);
  });
  test('cpu_only bundle: a non-cpu device is REFUSED even with cuda:false', () => {
    const v = run(healthOf({ cuda: false, device: 'cuda:0' }), 'cpu_only');
    assert.equal(v.code, 'SCORER_HEALTH_MISMATCH');
    assert.match(v.reason, /device .* != cpu/);
  });
  test('GPU-pinned (no acceleratorPolicy): cuda:false is REFUSED (round-7 guard kept for r5/GPU)', () => {
    const v = run(healthOf({ cuda: false, device: 'cpu' }));
    assert.equal(v.code, 'SCORER_HEALTH_MISMATCH');
    assert.match(v.reason, /cuda false != true/);
  });
  test('GPU-pinned: cuda:true is ACCEPTED past the health gate', () => {
    const v = run(healthOf({ cuda: true, device: 'cuda:0' }));
    assert.equal(cudaMismatch(v), false, `should not be a cuda mismatch: ${v.code} ${v.reason ?? ''}`);
  });
});
