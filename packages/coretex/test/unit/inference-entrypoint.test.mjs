import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as inference from '../../dist/inference.js';
import * as full from '../../dist/index.js';

// G-B16 / §19 / I11 — the portable inference entrypoint (@botcoin/coretex/inference)
// must expose the whole inference/harness surface and NONE of the coordinator surface.

const COORDINATOR_SYMBOLS = [
  'CoreTexCoordinatorCore',
  'createInProcessCoreTexSubmitQueue',
  'expectedDualPackProofKind',
];

const REQUIRED_INFERENCE_SYMBOLS = [
  // state / patch
  'RANGES', 'applyPatch',
  // canonical
  'canonicalJson',
  // decoder / substrate
  'decodeSubstrate', 'decodeBmuPublicPathPrograms', 'encodeBmuPublicPathProgramWords',
  'encodeMemoryIndexSlot', 'encodeTemporalRecord', 'biEncoderModelIdHash',
  // eval pipeline
  'scoreSubstrateAgainstQuery', 'evaluateBmuBenchmarkState', 'evaluateRetrievalBenchmarkState',
  'bmuJudgeTopB', 'computeBmuTaskUtility', 'bmuOperationQueryKey', 'buildBmuPublicPathProgramPatch',
  'createDeterministicBiEncoder', 'deriveQueryPack', 'computeCorpusRoot', 'stableRecordIdFor',
  // bundle / pipeline / profile
  'DEFAULT_PROFILE', 'BMU_V2_PUBLIC_PATH_BUNDLE', 'CORETEX_PIPELINE_VERSION_BMU_V2',
];

test('inference entrypoint EXPOSES the full inference/harness surface', () => {
  const missing = REQUIRED_INFERENCE_SYMBOLS.filter((s) => typeof inference[s] === 'undefined');
  assert.deepEqual(missing, [], `inference entrypoint missing required symbols: ${missing.join(', ')}`);
});

test('inference entrypoint EXCLUDES every coordinator symbol', () => {
  const leaked = COORDINATOR_SYMBOLS.filter((s) => typeof inference[s] !== 'undefined');
  assert.deepEqual(leaked, [], `inference entrypoint must not export coordinator symbols; leaked: ${leaked.join(', ')}`);
});

test('control: the full barrel DOES export the coordinator symbols (proves the exclusion is real, not a typo)', () => {
  const present = COORDINATOR_SYMBOLS.filter((s) => typeof full[s] !== 'undefined');
  assert.deepEqual(present, COORDINATOR_SYMBOLS, 'full barrel should still export all coordinator symbols');
});

test('inference entrypoint canonicalJson is the SAME function as the full barrel (no serializer drift)', () => {
  assert.equal(inference.canonicalJson, full.canonicalJson);
});
