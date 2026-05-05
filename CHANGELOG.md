# Changelog

All notable changes to Botcoin Cortex are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- **Wave 2 in flight**: Phase 3 (Core decoder), Phase 4 (CortexBench), Phase 5 (mining API + cortex-server + cortex-handler), Phase 6 (reducer + credit mechanics), Phase 1 follow-up (Python second reference impl).

### Tracked blockers
- **Issue #4** — LoCoMo CC-BY-NC-4.0 license decision. Phase 4 temporal-family loader ships with LoCoMo intentionally stubbed; resolution required before follow-up PR.
- `BASE_RPC_URL` GitHub Actions secret needed before Phase 2 fork tests run in CI; safe to defer to Phase 8.
- Multisig operator key set needed before Phase 9 first reward epoch.

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
