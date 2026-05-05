#!/usr/bin/env node
/**
 * Phase 2 E2E test runner.
 *
 * Default (no args): runs the fast no-fork subset via `forge test --root contracts`.
 * Fork tests: set BASE_RPC_URL env var; fork tests auto-skip when absent.
 *
 * Usage:
 *   node test/e2e/phase-2/run.mjs                        # fast, no fork needed
 *   BASE_RPC_URL=<url> node test/e2e/phase-2/run.mjs     # includes fork tests
 */

import { spawnSync } from "child_process";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot  = resolve(__dirname, "../../..");

const forgeArgs = [
  "test",
  "--root", resolve(repoRoot, "contracts"),
  "-vv",
];

const rpcUrl = process.env.BASE_RPC_URL;
if (rpcUrl) {
  console.log(`[phase-2 e2e] BASE_RPC_URL set — fork tests will run.`);
} else {
  console.log("[phase-2 e2e] BASE_RPC_URL not set — fork tests will self-skip.");
}

console.log("[phase-2 e2e] Running: forge", forgeArgs.join(" "));

const result = spawnSync("forge", forgeArgs, {
  stdio: "inherit",
  cwd:   repoRoot,
  env:   process.env,
});

if (result.status !== 0) {
  console.error("[phase-2 e2e] FAILED (exit code", result.status, ")");
  process.exit(result.status ?? 1);
} else {
  console.log("[phase-2 e2e] ALL TESTS PASSED");
}
