# Cortex V0 Audit Handoff

Date: 2026-05-06

## Scope

This handoff covers the V0 Cortex on-chain memory lane: state codec, Merkle root, patch eval, live epoch state advancement, reducer sealing, verifier replay, server integration gates, and deployment/rehearsal scripts.

## Latest hardening landed

- Phase 3 incremental Merkle cache:
  - `buildMerkleCache(state)` builds the canonical 1024-leaf tree once.
  - `updateMerkleCache(cache, updates)` recomputes only touched leaf-to-root paths for 1-4 word patches.
  - `evalPatch()` accepts an immutable `merkleCache` and produces the same roots as full recompute.
- Worker cache hardening:
  - Worker cache is now keyed by `patch.parentStateRoot`.
  - A state is cached only when its computed Merkle root matches that parent root.
  - Small hosts default to one eval worker so `/healthz` remains responsive under eval flood.
- Validator parity:
  - Cached eval still performs full reserved-bit validation on the result state.
  - Phase 3 E2E compares incremental roots directly against the old full-recompute reference.
- Policy/doc alignment:
  - V0 production disables the separate merge uplift: `MERGE_MULTIPLIER_BPS = 10000` (1.0x).
  - Live state advances earn normal epoch credits; screener-only candidates do not.
  - Non-overlapping improvements can all advance during the same 24h epoch; stale-parent candidates must rebase on the current `liveStateRoot`.
  - Phase 8 golden fixture no longer prints double-`0x` roots.

## Local validation completed

| Command | Result |
|---------|--------|
| `npm run build --workspaces --if-present` | PASS |
| `node --test --test-reporter=spec packages/cortex/test/unit/merkle.test.mjs packages/cortex/test/unit/eval.test.mjs` | 30/30 PASS |
| `node --test --test-reporter=spec packages/cortex/test/unit/patch.test.mjs packages/cortex/test/unit/reducer.test.mjs` | 67/67 PASS |
| `node --test --test-reporter=spec packages/cortex/test/unit/merkle.test.mjs packages/cortex/test/unit/eval.test.mjs packages/cortex/test/unit/patch.test.mjs packages/cortex/test/unit/reducer.test.mjs` | 97/97 PASS |
| `npx -y node@22 scripts/run-e2e.mjs --filter phase-1` | 6/6 gates PASS |
| `npx -y node@22 scripts/run-e2e.mjs --filter phase-3` | 16 PASS, 1 SKIP |
| `npx -y node@22 scripts/run-e2e.mjs --filter phase-5` | 17 PASS, 1 SKIP |
| `npx -y node@22 scripts/run-e2e.mjs --filter phase-6` | 46/46 PASS |
| `npx -y node@22 scripts/run-e2e.mjs --filter phase-7` | 7/7 PASS, 1 SKIP (live e2e) |
| `CORTEX_E2E_LIVE=1 node test/e2e/phase-7/run.mjs` | 8/8 PASS (incl. mine→submit→advance over Anvil) |
| `EXTENDED_FUZZ=1 node test/e2e/phase-7/run.mjs` | 7/7 PASS, 1M-patch fuzz green |
| `node --test test/unit/cortex-bench-eval.test.mjs` | 6/6 PASS (real CortexBench scorer) |
| `npx -y node@22 scripts/run-e2e.mjs --filter phase-8` | 4 PASS, 6 SKIP |
| `npx -y node@22 scripts/run-e2e.mjs --filter phase-9` | 3 PASS, 5 SKIP |
| `forge test --root contracts --no-match-contract CortexForkTest` | 58/58 PASS |

Phase 3 perf fixture: `test/e2e/phase-3/fixtures/perf-results.json`

- `N = 10000`
- `p50ms = 0.508801`
- `p99ms = 0.995279`
- Target gate: p50 < 10 ms, p99 < 50 ms

## Known self-skips / operator gates

- `BASE_RPC_URL` not set in this shell, so Base fork replay tests self-skip outside the already-recorded fork validation.
- Phase 8 live testnet gates need `BASE_TESTNET_RPC_URL` and a funded operator wallet.
- Phase 8 external auditor reproduction requires real testnet artifacts.
- Phase 9 mainnet dry-run, first reward audit trail, pool-mode, and post-finalize audit-window checks require deployed mainnet addresses and operator confirmation.
- `docs/multisig-key-set.md` still has V1/TBD placeholders because V0 uses owner-only `ownerRevertEpoch(uint64)`.

## Production-readiness position

Phase 3 eval performance and Phase 7 baseline selection are both closed
locally. The remaining launch gates are operational and empirical, not
architecture blockers:

1. ~~Real Phase 7 baseline iteration + freeze `coreVersionHash` /
   `genesisStateRoot`.~~ DONE 2026-05-06. Winner: Baseline A. Frozen
   values in `ops/v0-frozen.json` and `docs/contract-addresses.md`.
   Reports: `experiments/results/phase7-real-30/{comparison.md,patch-sensitivity-report.md,adversarial-report.md}`.
   Stability runs: `experiments/results/phase7-stability/seed-{1,7,42,99,1234}/winner.json`
   (all picked A, identical 0.2588 final composite).
2. Run the full Phase 8 testnet campaign: >=100 epochs, >=1k patches,
   >=10 auditor reproductions, latch/unlatch x2.
3. Run Phase 9 mainnet rehearsals and publish the first reward epoch
   audit trail.

## Suggested audit focus

- Confirm incremental Merkle roots are byte-identical to full recompute for single, multi-word, duplicate-index, and edge-index updates.
- Confirm `evalPatch()` cached and uncached paths preserve the same rejection semantics (`E01`-`E05`).
- Confirm worker cache cannot serve a state under the wrong parent root.
- Confirm reducer multi-patch epochs accept non-overlapping patches sharing the same epoch parent root.
- Confirm live `CortexStateAdvanced` events chain by parent root and seal into the final epoch root.
- Confirm non-overlapping state advances during an epoch all earn credits, while stale-parent and no-marginal-improvement candidates earn none.
- Confirm `MERGE_MULTIPLIER_BPS = 10000` is consistent across contracts, reducer, docs, and test gates.
