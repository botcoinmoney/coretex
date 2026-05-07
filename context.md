# Cortex — Current Context

> Strict-rule file per ORGANISM_CORTEX_STATE_PLAN.md §13.5. Driver-only edits per CONTRIBUTING.md.

## Current state

**ALL 9 PHASES + Phase 1 follow-up + V0 POLICY DECISIONS LANDED.** Tags on `main`:

- `v0.bootstrap`, `v0.phase-{0,1,1b,2,3,4,5,6,7,8,9}` — every §9 phase scaffolded.
- HEAD is past the 2026-05-05/06 V0 policy decisions:
  - **LoCoMo Path B applied** — LoCoMo removed; `SyntheticTemporalLoader` (Apache-2.0) + `MemoryAgentBenchLoader` (MIT) cover the temporal family. Issue #4 CLOSED.
  - **Multisig deferred to V1** — `CortexRegistry.ownerRevertEpoch(uint64)` is the V0 audit-window override (single owner). `voteRevertEpoch` 2-of-N wiring retained for V1 reactivation.
  - **Live mid-epoch state advances** — verified improvements emit `CortexStateAdvanced` and update the current epoch root immediately; the 24h epoch seals the ordered advance chain.
  - **Mining V4 work-credit lane** — CoreTex uses `BotcoinMiningV4.submitWorkReceipt(...)`: screener pass = 1x current tier credits; state advance = policy-weighted 3x+; active policy hash pins the exact verifier math.
  - **Season 1 corpus added** — production dry-runs use a committed 10,000-record DACR-shaped corpus with deterministic hidden-shard eval. `experienceCorpusRoot=0x43ebf3457a51476adc5c563bbaace98af00106d7d28f92b5d7d29ec859fd8f7f`.
  - **License: Apache-2.0** confirmed (patent grant matters for crypto/ML; ethos preserves redistribution rights).
  - **Repo: private** (per §13.1; reconsider at V0 launch).

## V0 validation completed

| What | Result |
|------|--------|
| Workspace build | **PASS** (`npm run build --workspaces --if-present`) |
| Phase 3 eval perf gate | **p50 0.508 ms / p99 0.872 ms** on 10k fuzz; target is <10 ms / <50 ms |
| Phase 3 E2E | **16/16 pass, 1 SKIP** (`BASE_RPC_URL` fork replay self-skip) |
| Unit tests touched by Merkle/eval/reducer/scorer/model sidecar | **108/108 pass** (Merkle/eval/patch/reducer/live-epoch/legacy bonus/real scorer + local model sidecar) |
| Local model-assisted eval unit/smoke path | **PASS** with deterministic hashing embedder; open-weight MiniLM gate is production-default unless `CORTEX_LOCAL_MODEL_EVAL=0` |
| Local MiniLM calibration | **PASS** across long-horizon, near-collision, and temporal known-good patches (`Xenova/multi-qa-MiniLM-L6-cos-v1`; prewarm 378 texts; warm eval ~3.2-13.7 ms in calibration) |
| Phase 1 E2E | **6/6 gates green** |
| Phase 5 E2E | **17 pass, 1 SKIP** (fork receipt test needs `BASE_RPC_URL`) |
| Phase 6 E2E | **46/46 pass**; no-uplift gate asserts `MERGE_MULTIPLIER_BPS = 10000` |
| Phase 7 E2E (real corpus) | **8/8 pass** with `CORTEX_E2E_LIVE=1`; 7/7 + 1 SKIP without anvil. Includes baseline validity, 1M-patch adversarial fuzz under `EXTENDED_FUZZ=1`, and live mine→submit→advance over Anvil |
| Season 1 corpus scale smoke | **PASS**; 10,000 records, hidden shard 256/family, 4-word long-horizon patch Δ=4688 ppm vs 500 ppm gate |
| Real Phase 7 winner pick | **Baseline A** across seeds 1, 7, 42, 99, 1234. `coreVersionHash` + `genesisStateRoot` frozen in `ops/v0-frozen.json` |
| Phase 8 E2E | **4 pass, 6 SKIP** (testnet/operator gates self-skip without RPC/live run) |
| Phase 9 E2E | **3 pass, 5 SKIP** (mainnet-only gates self-skip) |
| `forge test` (no-fork): `CortexPhase2` + `GasBudget` | **58/58 pass** (54 + 4) |
| `/root/botcoin` V4 contract suite | **176/176 pass** (`forge test --fuzz-runs 10000`), including **18/18** `BotcoinMiningV4Test` |
| CoreTex work-unit policy tests | **10/10 pass**; default `workPolicyHash=0xd5bc0e0ce151f289f9cc46a3852b2154816d741c4a0adc1cd33f5e974dbbb774` |
| `cortex-server` real eval boot smoke | **PASS** with `CORTEX_REAL_EVAL=1` on Node 22 |
| `forge test --fork-url $BASE_RPC_URL` (real Base mainnet fork) | **6/7 pass, 1 SKIP** (Phase-3-dep log-replay) |
| Anvil-fork-of-mainnet deploy via `forge create` | Both contracts deployed; bytecode verified |
| Full lifecycle (commit→submit→finalize→reveal) on fork | All 5 transactions succeed; events emit |
| `ownerRevertEpoch(uint64)` on fork | Flips `epochFinalized` true→false, `epochReverted` false→true |
| Pause matrix on fork | Registry pause does NOT pause bonus (independent ✓) |
| SWCP non-interference: BOTCOIN reads on the same fork | `totalSupply=1e29`, `symbol="BOTCOIN"`, `decimals=18` ✓ |
| `scripts/post-deploy-smoke.mjs` | OK |

Records in `ops/V0_VALIDATION_LOG.md` and `ops/AUDIT_HANDOFF.md`. The anvil-fork-mainnet run is strictly more thorough than a Base Sepolia deploy because Sepolia has none of the real upstream contracts; the fork has all of them.

## Open follow-ups (not blocking V0 architecture)

| # | What | Severity |
|---|------|----------|
| [#11](../../issues/11) | V1: collapse 5 vendored keccak copies to one canonical | Soft hardening |
| BASE_RPC_URL CI secret | Wire to GitHub Actions secrets so fork tests run on every PR | Operator action |
| Real Phase 8 testnet run | ≥100 epochs / ≥1k patches / ≥10 auditor reproductions / latch-unlatch ×2 | User operator task |
| Mainnet deploy (Phase 9) | Operator-only; `ops/USER_ACTIONS_MAINNET.md` 11-step checklist | User operator task |

## Resolved / closed in this session

- Issue #8 — Phase 3 eval perf. Incremental Merkle cache landed; perf now p50 0.509 ms / p99 0.995 ms on 10k compiled-dist fuzz.
- Issue #4 — LoCoMo CC-BY-NC-4.0 (Path B). Closed.
- **Phase 7 baseline iteration** — DONE. Real CortexBench V0 evaluator picked **Baseline A (empty)** across 5 stability seeds (1, 7, 42, 99, 1234). `coreVersionHash` = `0xe1a957805f855828338a2a9d1f90c46eb78c378d85f10c8d8c83a1ce6eb388d3` and `genesisStateRoot` = `0x7e704f76d6156405800141206cec1e6d7804daa8bf4e7da1542a1e431958504e` frozen in `ops/v0-frozen.json` and mirrored into `docs/contract-addresses.md`. 1M-patch adversarial fuzz: 0 panics, 0 nondeterminism. Live mine→submit→advance e2e on Anvil: 15/15 PASS via `scripts/e2e-real-improvement.mjs`.

## Recent decisions (last 10)

- 2026-05-07 — CoreTex screener calibration hardened. Pass threshold now adapts to current baseline headroom and observed noise floor; default `workPolicyHash=0xd5bc0e0ce151f289f9cc46a3852b2154816d741c4a0adc1cd33f5e974dbbb774`.
- 2026-05-07 — Season 1 corpus added for real dry-run testing: 10k records across DACR-shaped memory families, pinned by `experienceCorpusRoot=0x43ebf3457a51476adc5c563bbaace98af00106d7d28f92b5d7d29ec859fd8f7f`; large-corpus eval uses deterministic hidden shards.
- 2026-05-07 — Mining V4 lane added. `BotcoinMiningV4` keeps V3 stake/fund/claim mechanics and adds bounded lane/outcome work receipts. CoreTex verifier exports the matching work policy: screener pass 1x, state advance 3x/4x/6x/9x/12x by qualified screener passes since last state advance, pinned by `workPolicyHash`.
- 2026-05-06 — Added local model-assisted elevated-proposal eval. Consensus-safe structural scorer remains the base gate; the local gate loads `Xenova/multi-qa-MiniLM-L6-cos-v1` via `@huggingface/transformers` and checks actual memory-text retrieval.
- 2026-05-07 — Hardened model gate semantics: production default is MiniLM no-regression (`CORTEX_LOCAL_MODEL_EVAL!=0`) after deterministic structural improvement; equality is accepted by default, positive delta can be required via `CORTEX_LOCAL_MODEL_MIN_DELTA`. Near-collision structural scoring now ignores irrelevant near-miss keys.
- 2026-05-06 — Final review hardening: `makeRealMarginalEvaluator()` now scores raw state correctly; Phase 7 golden vectors use frozen Baseline A + real corpus; `cortex-server` can install real CortexBench eval via `CORTEX_REAL_EVAL=1` and fails closed otherwise; post-deploy smoke now reads real constant selectors.
- 2026-05-06 — Phase 7 real baseline iteration completed. Winner: Baseline A. Real-corpus scorer in `experiments/harness/cortex-bench-eval.mjs` replaces synthetic SEED-XOR; baselines mine corpus-aware 4-word patches; freeze script in `scripts/freeze-core-version.mjs`; reports under `experiments/results/phase7-real-30/` (comparison + patch sensitivity + adversarial). End-to-end live-improvement script `scripts/e2e-real-improvement.mjs` exercises mine→submit→advance + stale-parent rebase + no-credit bogus.
- 2026-05-06 — Protocol policy changed from end-of-epoch merge uplift to live mid-epoch state advances. Verified improvements update `liveStateRoot` immediately, stale-parent suggestions must rebase, and V0 uses no separate merge multiplier (`MERGE_MULTIPLIER_BPS=10000`).
- 2026-05-06 — Phase 7 synthetic gate expanded: baseline A-E validity checks plus live-epoch tests for non-overlap, stale-parent rejection, and no-credit bogus improvements.
- 2026-05-06 — Phase 3 incremental Merkle update landed. Eval now caches the 1024-word tree and recomputes only touched leaf paths; worker cache is keyed by parent state root, not packed-state prefix.
- 2026-05-06 — Audit hardening: Phase 6 no-uplift gate/docs aligned to `MERGE_MULTIPLIER_BPS = 10000`; Phase 8 double-`0x` log fixed.
- 2026-05-05 — V0 policy: LoCoMo Path B, multisig deferred, Apache-2.0 license, repo private. Confirmed by user.
- 2026-05-05 — Anvil-fork-of-Base-mainnet validation: full lifecycle works end-to-end against real upstream chain state.
- 2026-05-05 — Forge fork tests now run with the public Base RPC (`https://mainnet.base.org`); user's Infura URL has unencoded `/+=` in basic-auth that broke Foundry parser. Public RPC sufficient for read-only fork tests.
- 2026-05-05 — All 9 phases + Phase 1 follow-up tagged on main.
- 2026-05-05 — Phase 8 golden e2e fixture is the CI merge gate; runs in-process (no testnet RPC needed).
- 2026-05-05 — Phase 9 mainnet scripts produce calldata only — never broadcast for the user.
- 2026-05-05 — keccak in 5 places consolidated to consistent canonical fix; V1 collapses to single import (issue #11).

## How to resume

```bash
cd /root/cortex
git fetch origin && git status
git tag --list 'v0.*'
gh issue list                     # expected open: #11 keccak collapse + operator/runbook items
cat context.md                    # this file
cat ops/V0_VALIDATION_LOG.md      # what's been validated
cat ops/AUDIT_HANDOFF.md          # current audit/testing handoff
```

For the next operator session:
1. ~~Phase 7 real baseline iteration~~ — DONE (winner Baseline A, see `experiments/PHASE_7_USER_ACTIONS.md`).
2. Phase 8 testnet (`ops/testnet/USER_ACTIONS.md`).
3. Phase 9 mainnet (`ops/USER_ACTIONS_MAINNET.md`).
