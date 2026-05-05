# Changelog

All notable changes to Botcoin Cortex are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- **Wave 2 partial**: Phase 6 (reducer + credit mechanics) and Phase 1 follow-up (Python second reference impl) still in flight.

### Tracked blockers
- **Issue #4** — LoCoMo CC-BY-NC-4.0 license decision. Phase 4 temporal-family loader ships with LoCoMo intentionally stubbed; resolution required before follow-up PR.
- **Issue #8** — Phase 3 eval perf gate breached: measured p50 ~327 ms / p99 ~660 ms vs 10 ms / 50 ms target. Root cause is full-tree Merkle recompute; recommended fix is incremental Merkle update.
- `BASE_RPC_URL` GitHub Actions secret needed before Phase 2 fork tests run in CI; safe to defer to Phase 8.
- Multisig operator key set needed before Phase 9 first reward epoch.

## [v0.phase-5] — 2026-05-05

### Added
- `packages/cortex-server/` — standalone HTTP process (own PID, own SQLite WAL queue, own `worker_threads` pool). Endpoints: `/v1/cortex/{challenge,submit,state,epoch/:id,eval-report/:hash,merge-bonus/claim-calldata}` + `/healthz`. Path-prefix routing only; `?lane=cortex` query strings on the SWCP path NEVER reach this process.
- `packages/cortex-handler/` — single-line drop-in router for the SWCP coordinator: `mountCortexHandler(app, deps)`. Adds `/internal/{miner-tier,sign-cortex-receipt,epoch,rate-limit-budget,outstanding-challenge,outstanding-challenge/clear}`. The signing key lives exclusively in the SWCP `receiptSigner` — never duplicated. Cortex receipts ride the existing `BotcoinMining` EIP-712 domain with `rulesVersion = 0xC0` (§6 mapping); the sign endpoint rejects any other rulesVersion.
- `packages/cortex-handler/migrations/001_cortex_store.sql` + `apply-migrations.mjs` — cross-lane bookkeeping schema (outstanding-challenge state, merge-bonus funding receipts, multiplier-claim ledger).
- `test/e2e/phase-5/run.mjs` — fake SWCP harness + cortex-server launcher; 18 gates (3 PASS / 15 self-skip behind `npm run build` and `BASE_RPC_URL`).

### Notes
- HTTP framework: shipped with Node.js built-in `http` for zero-dependency bootstrap. **Fastify is recommended for production**; route handler signatures are Fastify-compatible. Documented in `src/index.ts`.
- Hardcoded `/root/botcoin-coordinator/...` typeRoots and `workspace:*` (pnpm) syntax fixed in a follow-up commit on main; would have broken CI.

## [v0.phase-4] — 2026-05-05

### Added
- `benchmark/cortex_bench_v0.md` — full body: anchored sources, score formula, hidden-shard derivation, protected-regression set, pass-rate targets, saturation alarm.
- `benchmark/sources.json`-driven loaders in `benchmark/generators/{near_collision,temporal,long_horizon}/` covering LIMIT (CC-BY-4.0) + BEIR/NQ (Apache-2.0) + BEIR/HotpotQA (CC-BY-SA-4.0); MemoryAgentBench (MIT); MemoryArena (CC-BY-4.0). LoCoMo loader is intentionally `LICENSE_BLOCKED` pending issue #4.
- `benchmark/score.ts` — composite score with frozen weights (Phase 0).
- `benchmark/shards.ts` — `deriveShardId` mirroring `deriveWorldSeedU128(...)`.
- `benchmark/saturation.ts` — median-score-delta-<1%-over-K=10 alarm.
- `test/e2e/phase-4/run.mjs` — 35/35 gates pass (synthetic-fixture mode).

### Notes
- 99th-pct synthetic-miner pass rates measured at random=0.0%, weak=6.5%, strong=27.0% — within the locked target bands (±3%).
- BEIR MSMARCO and TREC-COVID deferred (commercial-use review pending).
- `PINNED_CORPUS_HASH = FIXTURE_HASH_PLACEHOLDER` in dev mode; loaders skip hash check until `scripts/fetch-fixtures.mjs` is run with real external data.

## [v0.phase-3] — 2026-05-05

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

## [v0.phase-2] — 2026-05-05

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

## [v0.phase-1] — 2026-05-05

### Added
- `specs/cortex_state_v0.md` — full 1024-word layout, per-range packed bit fields.
- `specs/cortex_schema_v0.json` — machine-readable field registry.
- `specs/packing_spec_v0.md` — byte-level pack/unpack rules; round-trip law.
- `specs/merkleization_spec_v0.md` — keccak256 binary Merkle, 1024 leaves (no padding).
- `specs/patch_format_v0.md` — wire format with LEB128 varint indices, old words omitted, 99th-pct ≤ 200 bytes.
- `packages/cortex/src/state/` — TS reference impl (types, codec, keccak256, merkle, validate, patch with E01..E05 rejection taxonomy).
- `packages/cortex/test/unit/` — codec, merkle, patch, validate unit tests.
- `test/e2e/phase-1/run.mjs` — all six §9 fixtures.

### Notes
- Cross-impl Merkle parity (TS vs Python) gated to a follow-up PR — Python chosen because Rust/Go are not on this build host.
- TS impl is zero-runtime-deps (pure-JS keccak256).

## [v0.phase-0] — 2026-05-05

### Added
- `specs/research_brief_v0.md` — full ~5-page brief: locked thesis, source review for all anchors, locked family weights (60/20/20), pass-rate targets (0%/5–10%/20–30%), failure modes, license summary.
- `specs/non_goals_v0.md` — 12 hard-rejected items + 4 tracked V1 paths.
- `specs/license_audit.md` — per-source SPDX, redistribution OK?, attribution, pinned commit hash.
- `benchmark/sources.json` — machine-readable manifest for the Phase 4 loader.

### Tracked blockers surfaced
- LoCoMo CC-BY-NC-4.0 incompatible with commercial mining (issue #4).

## [v0.bootstrap] — 2026-05-05

### Added
- Repo created `botcoinmoney/cortex` (private), cloned to `/root/cortex`, branch `main`.
- §13.2 layout scaffolded.
- README, instructions.md (plug-and-play wiring), context.md (strict §13.5 handoff), Apache-2.0 LICENSE.
- npm workspaces, tsconfig.base.json.
- GitHub Actions CI with phase-scoped E2E matrix + e2e:all merge gate + context.md freshness PR check.
- Foundry submodules (forge-std, openzeppelin-contracts).
- Skeleton solidity contracts (CortexRegistry.sol, CortexMergeBonus.sol).
- packages/{cortex,cortex-server,cortex-handler}/ stubs.
- specs/, benchmark/, ops/ skeletons.
- CONTRIBUTING.md, CODEOWNERS, PR template, issue templates.
- `scripts/scripted-miner.mjs` and `scripts/post-deploy-smoke.mjs`.
