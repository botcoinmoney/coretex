/**
 * Keyless GPU scorer-server /score-state unit tests.
 *
 * Exercises the pure state-job handler `handleScoreStateJob` with a FAKE
 * evaluator — no real Qwen3 load, no CUDA, no signing material (keyless).
 * The state lane is PATCHLESS + DEDUP-FREE + ADMISSION-FREE: no patch bytes,
 * no miner, no thresholdPpm, no publicEvalContext / seed machinery anywhere
 * on the wire — the baseline seed is a caller-provided deterministic bytes32.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { handleScoreStateJob } from '../../dist/scorer-server-cli.js';
import { pack, merkleizeState, bytesToHex, RANGES, PACKED_SIZE } from '../../dist/index.js';

const B32 = (seed) => `0x${seed.repeat(Math.ceil(64 / seed.length)).slice(0, 64)}`;
const MODEL_ID = 'Qwen/Qwen3-Reranker-0.6B';
const REVISION = 'e61197ed45024b0ed8a2d74b80b4d909f1255473';

// A REAL parent substrate the scorer can verify: a full-size (1024-word)
// state, its canonical packing, and the merkle root it hashes to.
function makeParentState() {
  const words = new Array(RANGES.WORD_COUNT).fill(0n);
  words[0] = 0x4321n;
  words[5] = (1n << 128n) | 7n;
  words[RANGES.WORD_COUNT - 1] = 0x9abcn;
  return { words };
}
const PARENT_STATE = makeParentState();
const PARENT_PACKED_HEX = bytesToHex(pack(PARENT_STATE));
const PARENT_ROOT = bytesToHex(merkleizeState(PARENT_STATE)).toLowerCase();

const LOADED_PINS = {
  modelId: MODEL_ID,
  revision: REVISION,
  promptTemplateHash: B32('ab'),
  bundleHash: B32('dd'),
  corpusRoot: B32('cc'),
  coreVersionHash: B32('dd'),
};

const HEALTH = {
  commit: 'deadbee',
  modelId: MODEL_ID,
  revision: REVISION,
  promptTemplateHash: B32('ab'),
  dtype: 'fp32',
  tf32: false,
  cuda: true,
  device: 'NVIDIA GeForce RTX 4090',
  torch: '2.3.0',
  transformers: '4.44.0',
  python: '3.11.9',
};

const BASELINE_SEED = B32('f0');

function baseStateJob(over = {}) {
  return {
    jobId: 'state-job-1',
    epochId: 133,
    parentStateRoot: PARENT_ROOT,
    packedParentStateHex: PARENT_PACKED_HEX,
    corpusRoot: LOADED_PINS.corpusRoot,
    bundleHash: LOADED_PINS.bundleHash,
    coreVersionHash: LOADED_PINS.coreVersionHash,
    baselineSeedHex: BASELINE_SEED,
    samples: 3,
    expectedScorerPins: {
      modelId: MODEL_ID,
      revision: REVISION,
      promptTemplateHash: LOADED_PINS.promptTemplateHash,
      bundleHash: LOADED_PINS.bundleHash,
      corpusRoot: LOADED_PINS.corpusRoot,
    },
    ...over,
  };
}

function baselineScores(over = {}) {
  return {
    parentScorePpm: 432_100,
    variancePpm: 12,
    samples: 3,
    corpusRoot: LOADED_PINS.corpusRoot,
    epochId: 133,
    compositeScore: { composite: 0.4321 },
    ...over,
  };
}

/** Fake evaluator — records the scoreState input, returns a fixed baseline. */
function fakeStateEvaluator(result = baselineScores(), counter = { calls: 0 }) {
  return {
    async scoreState(input) {
      counter.calls += 1;
      counter.lastInput = input;
      return result;
    },
  };
}

function throwingStateEvaluator(message, counter = { calls: 0 }) {
  return {
    async scoreState() {
      counter.calls += 1;
      throw new Error(message);
    },
  };
}

function deps(evaluator, over = {}) {
  return { evaluator, loadedPins: LOADED_PINS, scorerHealth: HEALTH, ...over };
}

describe('scorer-server — handleScoreStateJob happy path', () => {
  test('valid request scores the VERIFIED substrate and returns the baseline', async () => {
    const counter = { calls: 0 };
    const res = await handleScoreStateJob(baseStateJob(), deps(fakeStateEvaluator(baselineScores(), counter), {
      now: (() => { let t = 1000; return () => (t += 7); })(),
    }));
    assert.equal(res.status, 200);
    assert.equal(counter.calls, 1);
    const b = res.body;
    assert.equal(b.jobId, 'state-job-1');
    assert.equal(b.epochId, 133);
    assert.equal(b.parentScorePpm, 432_100);
    assert.equal(b.variancePpm, 12);
    assert.equal(b.samples, 3);
    assert.equal(b.corpusRoot, LOADED_PINS.corpusRoot);
    assert.equal(b.bundleHash, LOADED_PINS.bundleHash);
    assert.equal(b.coreVersionHash, LOADED_PINS.coreVersionHash);
    assert.ok(b.wallMs >= 0);
    // scorerHealth carries the runtime fingerprint, NO signing material.
    assert.deepEqual(b.scorerHealth, HEALTH);
    // The evaluator receives the caller seed + samples + the UNPACKED,
    // merkle-verified parent state (not the root hash).
    assert.equal(counter.lastInput.baselineSeedHex, BASELINE_SEED);
    assert.equal(counter.lastInput.samples, 3);
    assert.deepEqual(counter.lastInput.parentState.words, PARENT_STATE.words);
  });

  test('result epochId is the EVALUATOR pack epochId, not a blind job echo', async () => {
    const res = await handleScoreStateJob(baseStateJob({ epochId: 133 }), deps(fakeStateEvaluator(baselineScores({ epochId: 134 }))));
    assert.equal(res.status, 200);
    assert.equal(res.body.epochId, 134);
  });

  test('samples omitted stays omitted (evaluator applies its default)', async () => {
    const counter = { calls: 0 };
    const job = baseStateJob();
    delete job.samples;
    const res = await handleScoreStateJob(job, deps(fakeStateEvaluator(baselineScores({ samples: 1 }), counter)));
    assert.equal(res.status, 200);
    assert.equal('samples' in counter.lastInput, false);
  });

  test('NO patch/miner/threshold/seed/publicEvalContext fields anywhere', async () => {
    const job = baseStateJob();
    for (const key of ['patchHash', 'compactPatchBytesHex', 'miner', 'thresholdPpm', 'policyHash', 'publicEvalContext']) {
      assert.equal(key in job, false, `state job must not carry ${key}`);
    }
    const counter = { calls: 0 };
    const res = await handleScoreStateJob(job, deps(fakeStateEvaluator(baselineScores(), counter)));
    assert.equal(res.status, 200);
    for (const key of ['miner', 'seedContext', 'injectedSeeds', 'screenerThresholdPpm', 'patchBytesHex']) {
      assert.equal(key in counter.lastInput, false, `evaluator input must not carry ${key}`);
    }
  });
});

describe('scorer-server — handleScoreStateJob shape refusals (400, no eval)', () => {
  const cases = [
    ['non-bytes32 baselineSeedHex', { baselineSeedHex: '0x1234' }, /baselineSeedHex/],
    ['missing baselineSeedHex', { baselineSeedHex: undefined }, /baselineSeedHex/],
    ['wrong-length packedParentStateHex', { packedParentStateHex: '0x1234' }, /packedParentStateHex/],
    ['non-hex packedParentStateHex', { packedParentStateHex: 'zz' }, /packedParentStateHex/],
    ['missing jobId', { jobId: '' }, /jobId/],
    ['zero epochId', { epochId: 0 }, /epochId/],
    ['non-integer epochId', { epochId: 'x' }, /epochId/],
    ['non-bytes32 parentStateRoot', { parentStateRoot: '0xbeef' }, /parentStateRoot/],
    ['non-bytes32 corpusRoot', { corpusRoot: '0xbeef' }, /corpusRoot/],
    ['samples=0', { samples: 0 }, /samples/],
    ['samples above the cap', { samples: 33 }, /samples/],
    ['non-integer samples', { samples: 1.5 }, /samples/],
    ['missing expectedScorerPins', { expectedScorerPins: undefined }, /expectedScorerPins/],
  ];
  for (const [name, over, reasonRe] of cases) {
    test(`${name} is refused with 400`, async () => {
      const counter = { calls: 0 };
      const res = await handleScoreStateJob(baseStateJob(over), deps(fakeStateEvaluator(baselineScores(), counter)));
      assert.equal(res.status, 400);
      assert.equal(res.body.error, 'invalid-job');
      assert.match(res.body.reason, reasonRe);
      assert.equal(counter.calls, 0, 'evaluator must not run on a malformed job');
    });
  }
});

describe('scorer-server — handleScoreStateJob pin refusals (409, no eval)', () => {
  test('job-level corpusRoot mismatch is refused', async () => {
    const counter = { calls: 0 };
    const res = await handleScoreStateJob(baseStateJob({ corpusRoot: B32('99') }), deps(fakeStateEvaluator(baselineScores(), counter)));
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'pin-mismatch');
    assert.match(res.body.reason, /corpusRoot/);
    assert.equal(counter.calls, 0);
  });

  test('expectedScorerPins.bundleHash mismatch is refused', async () => {
    const counter = { calls: 0 };
    const job = baseStateJob();
    job.expectedScorerPins = { ...job.expectedScorerPins, bundleHash: B32('99') };
    const res = await handleScoreStateJob(job, deps(fakeStateEvaluator(baselineScores(), counter)));
    assert.equal(res.status, 409);
    assert.equal(counter.calls, 0);
  });

  test('overlay-law scorer refuses a state job without the activeFrontierRoot pin', async () => {
    const counter = { calls: 0 };
    const res = await handleScoreStateJob(baseStateJob(), {
      evaluator: fakeStateEvaluator(baselineScores(), counter),
      loadedPins: { ...LOADED_PINS, activeFrontierRoot: B32('4f') },
      scorerHealth: HEALTH,
    });
    assert.equal(res.status, 409);
    assert.match(res.body.reason, /activeFrontierRoot/);
    assert.equal(counter.calls, 0);
  });
});

describe('scorer-server — handleScoreStateJob parent-state refusal (422, no eval)', () => {
  test('packed state that merkles to a DIFFERENT root is refused', async () => {
    const other = { words: PARENT_STATE.words.slice() };
    other.words[10] = 0xbeefn; // perturb -> different merkle root
    const counter = { calls: 0 };
    const res = await handleScoreStateJob(
      baseStateJob({ packedParentStateHex: bytesToHex(pack(other)) }),
      deps(fakeStateEvaluator(baselineScores(), counter)),
    );
    assert.equal(res.status, 422);
    assert.equal(res.body.error, 'SCORER_PARENT_STATE_MISMATCH');
    assert.equal(counter.calls, 0, 'evaluator must not run on an unverified substrate');
  });

  test('sanity: the packed substrate is exactly PACKED_SIZE bytes', () => {
    assert.equal((PARENT_PACKED_HEX.length - 2) / 2, PACKED_SIZE);
  });
});

describe('scorer-server — handleScoreStateJob evaluator failure (500)', () => {
  test('a throwing scoreState returns eval-failure with the reason', async () => {
    const counter = { calls: 0 };
    const res = await handleScoreStateJob(baseStateJob(), deps(throwingStateEvaluator('CUDA OOM', counter)));
    assert.equal(res.status, 500);
    assert.equal(res.body.error, 'eval-failure');
    assert.match(res.body.reason, /CUDA OOM/);
    assert.equal(counter.calls, 1);
  });
});
