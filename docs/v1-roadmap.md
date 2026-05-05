# Botcoin Cortex — V1 Roadmap

These items are explicitly **out of V0 scope** and tracked for V1. They are not blocking the V0 mainnet launch.

## 1. `BotcoinMining.submitCortexReceipt(...)` sister function

**V0 status**: Cortex receipts ride the existing `BotcoinMining` EIP-712 domain via the [§6 receipt field mapping](./receipt-mapping.md) with `rulesVersion = 0xC0`. The contract validates only the signature; field labels (`docHash`, `questionsHash`, etc.) are by convention. Block explorers see SWCP labels even for Cortex receipts.

**V1 deliverable**: Add `submitCortexReceipt(...)` to `BotcoinMining` (whichever V is current at the time) with explicit Cortex field names: `parentStateRoot`, `experienceCorpusRoot`, `shardCommitment`, `patchHash`. Storage layout unchanged. Receipt validation logic unchanged. The new function is purely a labeling/UX improvement.

**Migration**: deploy V<n+1> with the new function; `cortex-server` switches to it; old receipts remain valid; auditors can decode either form.

## 2. Bond-based or ZK fraud proofs for the audit window

**V0 status**: 6-hour audit window with 2-of-N operator multisig override (`revertEpoch`). Trust assumption disclosed honestly in [`miner-guide.md`](./miner-guide.md) and [`multisig-key-set.md`](./multisig-key-set.md). The EVM cannot re-run Botcoin Core, so on-chain fraud proofs require either a bond-and-challenge game or a SNARK over the verify-epoch computation.

**V1 deliverable**: replace the multisig override with one of:

- **Bond-based**: any party can post a bond and challenge a finalized epoch. The challenger and coordinator each post a sequence of intermediate state roots; the dispute is bisected to a single step that an on-chain SNARK or interactive truth machine can resolve. Whoever loses forfeits their bond.
- **ZK fraud proof**: the coordinator (or a third party) generates a ZK proof of correct epoch reduction. Verification on-chain replaces the audit window entirely.

Both paths require substantial additional engineering. Likely a multi-quarter project.

## 3. Collapse keccak256 to a single canonical implementation ([issue #11](../../issues/11))

**V0 status**: 5 separate keccak implementations across the repo. The Phase 1 follow-up cross-impl audit caught three real bugs in the canonical TS implementation; three additional vendored copies had identical bugs. All 5 are now consistent, but this is a footgun.

**V1 deliverable**: single canonical keccak in `packages/cortex/src/state/keccak256.ts`. All callers import from there. Grep test in CI: exactly one definition.

## 4. Phase 3 eval perf — incremental Merkle update ([issue #8](../../issues/8))

**V0 status**: eval perf measured at p50 ~327 ms / p99 ~660 ms vs the 10 ms / 50 ms target in §9 Phase 3. Architecture is correct; the perf gap is a result of full-tree Merkle recompute on every eval.

**V1 deliverable**: incremental Merkle update — cache leaf and internal-node hashes for the parent state on the worker thread; recompute only the affected paths from leaf to root (~40 keccaks instead of ~2047). Expected speedup: ~50×, well within the p50 budget.

## 5. Adaptive compression across ECS levels

**V0 status**: the [Experience Compression Spectrum](../specs/research_brief_v0.md#28-experience-compression-spectrum-ecs) frames memory / skills / rules as different compression levels. V0 encodes all three levels in the state layout but does NOT implement adaptive cross-level compression — i.e., automatically promoting a frequently-used memory to a skill, or codifying repeated skill patterns as rules.

**V1 deliverable**: dynamic ECS-level transitions, governed by deterministic rules in Core. The "missing diagonal" is the research frontier and likely to be a multi-Core-version effort.

## 6. Per-subset BEIR license verification automation

**V0 status**: V0 uses NQ (Apache-2.0) and HotpotQA (CC-BY-SA-4.0) only. MSMARCO and TREC-COVID are deferred pending commercial-use review.

**V1 deliverable**: automated per-subset license check in CI. The benchmark loader manifests license terms per subset; CI verifies the manifest and rejects unverified subsets.

## 7. LoCoMo licensing resolution ([issue #4](../../issues/4))

**V0 status**: LoCoMo (CC-BY-NC-4.0) is `LICENSE_BLOCKED` in the Phase 4 temporal-family loader. MemoryAgentBench (MIT) is fully operative.

**V1 deliverable**: pick A/B/C from the [issue](../../issues/4):
- (A) Snap Research commercial license exception.
- (B) Permissive replacement (extend MemoryAgentBench coverage).
- (C) Synthetic Apache-2.0 records.

This is a V0-blocker for the LoCoMo loader specifically, not for Phase 4 overall.

## 8. Cross-architecture CI matrix

**V0 status**: CI runs linux/x64 only. ARM64 (Apple Silicon, AWS Graviton) and macOS reproducibility are documented but not enforced.

**V1 deliverable**: GitHub Actions matrix expanded to `[ubuntu-latest, ubuntu-22.04-arm, macos-14]`. Every E2E gate runs on each. Cross-arch determinism is enforced.

## 9. Prometheus `/metrics` endpoint on cortex-server

**V0 status**: Phase 8 dashboard JSON template references metrics that cortex-server doesn't currently expose via Prometheus.

**V1 deliverable**: add `GET /metrics` to cortex-server emitting standard Prometheus text format. Phase 8 dashboard becomes drop-in.

---

## Out-of-scope items not on this roadmap

These are explicitly REJECTED for both V0 and V1 (see [`../specs/non_goals_v0.md`](../specs/non_goals_v0.md)):

- Weights on-chain.
- LoRA mining.
- Subjective AI judging in canonical scoring.
- Separate Cortex reward currency.
- Editing `BotcoinMiningV3` storage.

Anything not on this roadmap and not in non_goals is open to a new spec PR.
