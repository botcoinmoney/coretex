/**
 * This test intentionally imports only the published compiled entrypoint.
 *
 * The BMU v2 launch/certification harnesses execute `dist/`, so a test that
 * reaches source modules can pass while an older dist silently runs the v1
 * law.  Keep the v2 pipeline pin and the concrete public-path primitive in
 * this assertion: both were introduced together and neither exists in a
 * pre-v2 build.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BMU_V2_PUBLIC_PATH_BUNDLE,
  CORETEX_PIPELINE_VERSION_BMU_V2,
  isBmuV2ScoringLaw,
} from '../../dist/index.js';

test('compiled dist exports and identifies the BMU v2 public-path law', () => {
  assert.equal(CORETEX_PIPELINE_VERSION_BMU_V2, 'coretex-bmu-v2-r5state');
  assert.equal(isBmuV2ScoringLaw(CORETEX_PIPELINE_VERSION_BMU_V2), true);
  assert.deepEqual(BMU_V2_PUBLIC_PATH_BUNDLE, {
    stage1SeedLimit: 4,
    branchLimit: 4,
    maxPrograms: 32,
    maxRenderedLineageChars: 8192,
  });
});
