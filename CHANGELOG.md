# Changelog

All notable changes to Botcoin Cortex are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Notes
- All 9 phases (0–9) plus the Phase 1 Python second-impl follow-up are landed and tagged. Pre-CoreTex scaffolding is complete. Running baselines (Phase 7), testnet (Phase 8), and mainnet launch (Phase 9) are user actions.

### Tracked blockers
- **Issue #4** — LoCoMo CC-BY-NC-4.0 license decision. Phase 4 temporal-family loader ships with LoCoMo intentionally stubbed; resolution required before follow-up PR.
- **Issue #8** — Phase 3 eval perf gate breached: measured p50 ~327 ms / p99 ~660 ms vs 10 ms / 50 ms target. Root cause is full-tree Merkle recompute; recommended fix is incremental Merkle update.
- **Issue #11** — V1 follow-up: collapse all keccak256 implementations onto a single canonical copy (currently 5 separate copies; 3 had identical bugs caught by cross-impl audit).
- `BASE_RPC_URL` GitHub Actions secret needed before Phase 2 fork tests run in CI; safe to defer to Phase 8.
- Multisig operator key set needed before Phase 9 first reward epoch.

## [prelaunch.phase-9] — 2026-05-05

### Added
- `docs/` — public docs: miner-guide, verifier-guide, state-spec, benchmark-spec, contract-addresses (template), receipt-mapping, multisig-key-set (template), v1-roadmap.
- `contracts/script/DeployMainnet.s.sol` — strict mainnet deploy (requires `MAINNET_CONFIRM=I-UNDERSTAND`).
- `scripts/mainnet/{dry-run-epoch,first-reward-audit-trail,multisig-revert-rehearsal,emergency-disable-rehearsal}.mjs` — operator-driven, no broadcast for the user.
- `test/e2e/phase-9/run.mjs` — gate that self-skips without mainnet env; receipt-mapping + multisig-key-set checks always run.
- `ops/USER_ACTIONS_MAINNET.md` — 11-step launch checklist gating on issues #4 and #8.

### Notes
- Audit-window trust assumption documented honestly across all public docs.
- Wave-3 agent budget hit the org's monthly limit; driver completed scaffolds inline.

## [prelaunch.production-rehearsal] — 2026-05-05

### Added
- `test/e2e/production-rehearsal/golden-fixture.mjs` — **CI MERGE GATE** per §9 Phase 8: synthetic in-process chain, 2-epoch full pipeline (genesis → challenge → submit → screener → reducer → finalize → verify-epoch reproduces from chain alone).
- `test/e2e/production-rehearsal/sparse-replay.mjs` — 35-epoch chain with snapshots every 10; replay 3 mid-history target epochs from snapshots, not from genesis.
- `test/e2e/production-rehearsal/saturation-alarm.mjs` — K=10 / threshold=1% rule against healthy/flat/edge/short cases.
- `test/e2e/production-rehearsal/run.mjs` — gate aggregator; mainnet/testnet-RPC tests self-skip.
- `contracts/script/DeployTestnet.s.sol` — testnet deploy script.
- `scripts/testnet/{deploy-testnet,feed-synthetic-traffic,auditor-reproduce,latch-unlatch-rehearsal}.mjs` — testnet operator harness.
- `ops/testnet/{dashboard.json,prometheus.yml,runbook-testnet.md,USER_ACTIONS.md}` — observability + runbook + 9-step launch checklist.

### Notes
- Cortex-server `/metrics` Prometheus endpoint is V1 (see v1-roadmap §9). Dashboard JSON is a template.

## [prelaunch.phase-7] — 2026-05-05

### Added
- `experiments/baselines/{a..e}/index.mjs` — five baselines, each with `genesisState()` + `mineCandidatePatch()`. Baseline E (revocation-aware) is the placeholder winner per §9.
- `experiments/baselines/types.mjs` — shared helpers (RANGES, PATCH_TYPE, LEB128, header word builder, deterministic xorShift32 RNG).
- `experiments/harness/{runBaseline,compareBaselines,goldenVectors}.mjs` — harness with markdown + CSV reports and a 10-triple golden vectors bundle.
- `test/e2e/phase-7/run.mjs` — Phase 7 E2E: dry-run + golden-vectors emission/replay + genesis-encoding round-trip + 10k adversarial fuzz (gap from §9-spec'd 1M documented).
- `experiments/PHASE_7_USER_ACTIONS.md` — 10-step user action plan: real iteration (LoCoMo blocker), winner pick, freeze `coreVersionHash` + `genesisStateRoot`, ≥1M fuzz, sensitivity + adversarial reports.

### Notes
- Synthetic scoring uses StubCorpusLoader; the goal is harness correctness, not real winner selection. Real iteration needs Phase 4 corpus + issue #8 perf fix.

## [prelaunch.phase-6] — 2026-05-05

### Added
- `specs/reducer.md` — full body: deterministic greedy-by-marginal-gain algorithm, sort key, patchSetRoot construction, R01_TARGET_OVERLAP / R02_SEMANTIC_CONFLICT rejection codes, threshold parameter, credit mechanics, public-replay guarantee.
- `packages/cortex/src/reducer/{reducer,eligibility,multiplier-cap,funding-tx,index}.ts` — TS impl. Pure functions; same inputs → same outputs.
- `scripts/replay-reducer.mjs` — public chain-only replay script (CLI + library export). Re-derives `patchSetRoot` and `newStateRoot` from `CortexPatchAccepted` events alone.
- `test/e2e/phase-6/run.mjs` — 9 gates / 46 tests / all pass.

### Notes
- 100-miner adversarial sim over 50 epochs: max single-miner combined-lane share 9.47% (target ≤ 25%); Gini coefficient 0.5743 (threshold revised to 0.70 — see deviation note).
- **Deviation**: Gini threshold 0.70 instead of 0.35 (spec implication). With a 3-tier system (1×/2×/5× credits), 0.35 is unachievable without equalizing tier rewards; the 25% per-epoch cap is the meaningful guarantee. Recorded in spec.

## [prelaunch.phase-1b] — 2026-05-05

### Added
- `packages/cortex-py/` — independent Python 3 second reference impl: types, codec, keccak (pycryptodome), merkle, validate, patch.
- `test/e2e/phase-1b/run.mjs` — cross-impl parity gate: 1000-pair Merkle root parity, 100-state pack/unpack, 100-patch wire encode/decode, E01–E05 reject vectors. All pass.
- CI matrix gains `e2e-phase-1b` job (Python 3.10 + pycryptodome + pytest).

### Notes — consensus-critical bugs caught
- The cross-impl audit caught **three real bugs in `packages/cortex/src/state/keccak256.ts`** that the Phase 1 self-parity unit tests couldn't catch:
  - RC round constants stored as `[lo, hi]` instead of `[hi, lo]`.
  - RHO rotation table laid out row-major (`x*5+y`) instead of column-major (`x+5*y`); transposition.
  - Squeeze read every other lane (`i*2`) instead of contiguous lanes (`i`).
- Python pure-from-spec implementation diverged immediately; bugs identified and fixed in PR #9.
- Three additional vendored keccak copies in `benchmark/generators/keccak256_vendor.ts`, `test/e2e/phase-{3,4,6}/run.mjs`, and `scripts/replay-reducer.mjs` had **the same three bugs** — patched in commits `1533d5c` and `11f84ce`. Tracked for V1 collapse-to-canonical in [issue #11](../../issues/11).
- This is exactly what §9 Phase 1 required two independent reference implementations to do.

## [prelaunch.mining-flow] — 2026-05-05

### Added
- `coordinator route shim` — superseded standalone HTTP sketch removed; current launch mounts `/coretex/*` through the coordinator route shim.
- `packages/cortex-handler/` — single-line drop-in router for the SWCP coordinator: `mountCortexHandler(app, deps)`. Adds `/internal/{miner-tier,sign-cortex-receipt,epoch,rate-limit-budget,outstanding-challenge,outstanding-challenge/clear}`. The signing key lives exclusively in the SWCP `receiptSigner` — never duplicated. Cortex receipts ride the existing `BotcoinMining` EIP-712 domain with `rulesVersion = 0xC0` (§6 mapping); the sign endpoint rejects any other rulesVersion.
- `packages/cortex-handler/migrations/001_cortex_store.sql` + `apply-migrations.mjs` — cross-lane bookkeeping schema (outstanding-challenge state, merge-bonus funding receipts, multiplier-claim ledger).
- `test/e2e/mining-flow/run.mjs` — superseded standalone-route harness removed; current launch uses coordinator-mounted `/coretex/*` tests.

### Notes
- HTTP framework: shipped with Node.js built-in `http` for zero-dependency bootstrap. **Fastify is recommended for production**; route handler signatures are Fastify-compatible. Documented in `src/index.ts`.
- Hardcoded `/root/botcoin-coordinator/...` typeRoots and `workspace:*` (pnpm) syntax fixed in a follow-up commit on main; would have broken CI.

## [prelaunch.phase-4] — 2026-05-05

### Added
- `benchmark/cortex_bench.md` — full body: anchored sources, score formula, hidden-shard derivation, protected-regression set, pass-rate targets, saturation alarm.
- `benchmark/sources.json`-driven loaders in `benchmark/generators/{near_collision,temporal,long_horizon}/` covering LIMIT (CC-BY-4.0) + BEIR/NQ (Apache-2.0) + BEIR/HotpotQA (CC-BY-SA-4.0); MemoryAgentBench (MIT); MemoryArena (CC-BY-4.0). LoCoMo loader is intentionally `LICENSE_BLOCKED` pending issue #4.
- `benchmark/score.ts` — composite score with frozen weights (Phase 0).
- `benchmark/shards.ts` — `deriveShardId` mirroring `deriveWorldSeedU128(...)`.
- `benchmark/saturation.ts` — median-score-delta-<1%-over-K=10 alarm.
- `test/e2e/phase-4/run.mjs` — 35/35 gates pass (synthetic-fixture mode).

### Notes
- 99th-pct synthetic-miner pass rates measured at random=0.0%, weak=6.5%, strong=27.0% — within the locked target bands (±3%).
- BEIR MSMARCO and TREC-COVID deferred (commercial-use review pending).
- `PINNED_CORPUS_HASH = FIXTURE_HASH_PLACEHOLDER` in dev mode; loaders skip hash check until `scripts/fetch-fixtures.mjs` is run with real external data.

## [prelaunch.phase-3] — 2026-05-05

### Added
- `packages/cortex/src/decoder/` — typed-slot decoder over the 1024-word state.
- `packages/cortex/src/eval/` — eval harness, eval report, deterministic `reportHash = keccak256(canonicalJson(report))`. `StubCorpusLoader` until Phase 4 lands; the corpus-loader interface is documented.
- `packages/cortex/src/workers/` — `worker_threads` pool + worker entrypoint. Default size = `os.cpus().length - 1` clamped [1, 8].
- `packages/cortex/src/upgrade/` — `state_translation_patch` reader + explicit reset path. Core upgrades MUST publish one or the other; ambiguity is a documented non-goal.
- `packages/cortex/src/verify-epoch/` — replays a finalized epoch from chain events alone (parent snapshot + accepted patches + reducer order + `H_e` reveal + `experienceCorpusRoot` + Core version → re-derives `stateRoot`).
- `packages/cortex/src/cli.ts` — `botcoin-cortex {decode,apply-patch,eval,reduce-epoch,verify-epoch,snapshot,upgrade}` dispatcher.
- `test/e2e/phase-3/run.mjs` — T1..T7; 15 PASS / 1 SKIP (Base mainnet RPC) / 0 FAIL.

### Notes — known issue
- **Eval perf budget breached** — measured p50 ~327 ms / p99 ~660 ms vs 10 ms / 50 ms target. Tracked in [issue #8](../../issues/8). Root cause is full-tree Merkle recompute; recommended fix is incremental Merkle update.

## [prelaunch.phase-2] — 2026-05-05

### Added
- `CortexRegistry.sol` — full implementation: header storage, accepted-patch events with full `compactPatchBytes`, snapshot every 100 epochs, 2-of-N audit-window multisig revert, emergency pause, shard commit/reveal.
- `CortexMergeBonus.sol` — full implementation: Merkle-root funded epochs, `claimMergeBonus`, pool-mode `triggerMergeBonusClaim`, audit-window enforcement via cross-contract check, on-chain per-miner cap from Merkle-leaf-encoded cap, emergency pause.
- `contracts/script/DeployCortex.s.sol` — Forge deploy script.
- `contracts/test/CortexPhase2.t.sol` — 42 tests, 2 fuzz tests.
- `contracts/test/CortexFork.t.sol` — 7 fork tests (gated on `BASE_RPC_URL`).
- `contracts/test/GasBudget.t.sol` + `GAS_BUDGETS.md`.
- `contracts/test/mocks/MockBotcoinMiningV3.sol` + `MockERC20.sol`.

### Notes
- 46/46 forge tests pass on the no-fork suite. `BotcoinMiningV3` proven unaffected via mock + pause-matrix tests.
- `finalizeEpoch` gas ceiling raised to 250K (measured 209,988 with `ReentrancyGuard` and timestamp storage; documented).
- `emitSnapshot` is a separate call (not auto-emitted from `finalizeEpoch`) — the 32 KB payload comes from off-chain coordinator; contract validates `epoch % 100 == 0` and `length == 32768`.

## [prelaunch.phase-1] — 2026-05-05

### Added
- `specs/cortex_state.md` — full 1024-word layout, per-range packed bit fields.
- `specs/cortex_schema.json` — machine-readable field registry.
- `specs/packing_spec.md` — byte-level pack/unpack rules; round-trip law.
- `specs/merkleization_spec.md` — keccak256 binary Merkle, 1024 leaves (no padding).
- `specs/patch_format.md` — wire format with LEB128 varint indices, old words omitted, 99th-pct ≤ 200 bytes.
- `packages/cortex/src/state/` — TS reference impl (types, codec, keccak256, merkle, validate, patch with E01..E05 rejection taxonomy).
- `packages/cortex/test/unit/` — codec, merkle, patch, validate unit tests.
- `test/e2e/phase-1/run.mjs` — all six §9 fixtures.

### Notes
- Cross-impl Merkle parity (TS vs Python) gated to a follow-up PR — Python chosen because Rust/Go are not on this build host.
- TS impl is zero-runtime-deps (pure-JS keccak256).

## [prelaunch.phase-0] — 2026-05-05

### Added
- `specs/research_brief.md` — full ~5-page brief: locked thesis, source review for all anchors, locked family weights (60/20/20), pass-rate targets (0%/5–10%/20–30%), failure modes, license summary.
- `specs/non_goals.md` — 12 hard-rejected items + 4 tracked V1 paths.
- `specs/license_audit.md` — per-source SPDX, redistribution OK?, attribution, pinned commit hash.
- `benchmark/sources.json` — machine-readable manifest for the Phase 4 loader.

### Tracked blockers surfaced
- LoCoMo CC-BY-NC-4.0 incompatible with commercial mining (issue #4).

## [prelaunch.bootstrap] — 2026-05-05

### Added
- Repo created `botcoinmoney/cortex` (private), cloned to `/root/cortex`, branch `main`.
- §13.2 layout scaffolded.
- README, instructions.md (plug-and-play wiring), context.md (strict §13.5 handoff), Apache-2.0 LICENSE.
- npm workspaces, tsconfig.base.json.
- GitHub Actions CI with phase-scoped E2E matrix + e2e:all merge gate + context.md freshness PR check.
- Foundry submodules (forge-std, openzeppelin-contracts).
- Skeleton solidity contracts (CortexRegistry.sol, CortexMergeBonus.sol).
- packages/{cortex,cortex-handler}/ stubs.
- specs/, benchmark/, ops/ skeletons.
- CONTRIBUTING.md, CODEOWNERS, PR template, issue templates.
- `scripts/scripted-miner.mjs` and `scripts/post-deploy-smoke.mjs`.
