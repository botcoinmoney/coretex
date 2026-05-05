# Cortex Research Brief V0

> Phase 0 deliverable. Skeleton — Research subagent fills in §§2–7.

## 1. One-page thesis

> Proof-of-Cortex over compact on-chain memory codec, credit-unified with SWCP.

Botcoin Cortex turns mining into public proof-of-memory-improvement, paid through the same economic spine the protocol already runs on. The organism is not a model and not a text database. It is a compact, on-chain-rooted memory codec that becomes better only when miners prove improvements under Botcoin Core. Screener-pass patches earn credits at the miner's current on-chain tier through the same `BotcoinMining.submitReceipt` path. Merge-multiplier uplift (1.5×) is paid through a peer `CortexMergeBonus` contract that mirrors the existing `BonusEpoch` pattern.

## 2. Source review

- **LIMIT** (Weller et al., 2025) — single-vector retrieval saturation; motivates multi-vector slot design.
- **MTEB Retrieval / BEIR** — public retrieval task suites; near-collision family base.
- **WARP** — late-interaction multi-vector retrieval efficiency.
- **LoCoMo** — long conversational memory; temporal update / revocation family base.
- **MemoryAgentBench** — memory-grounded agent benchmark; temporal subset for stale-vs-current truth.
- **MemoryArena** — multi-session loops; long-horizon compression family base.
- **ERM** — correctness-gated key updates; informs validity-interval design.
- **Experience Compression Spectrum (ECS)** — memory/skills/rules compression levels frame.
- **Proof-of-Improvement logic** — improvement-only credit model.

License verification status, citation pins, and subset selections are filled in by the Research subagent.

## 3. V0 non-goals

See `non_goals_v0.md`.

## 4. Family weights (locked)

| Family                                | Weight |
|---------------------------------------|--------|
| Long-horizon compression              | 0.60   |
| Near-collision retrieval              | 0.20   |
| Temporal update / revocation          | 0.20   |

Long-horizon does not saturate as the codec improves — that is why it carries the dominant weight.

## 5. Pass-rate targets (locked)

| Miner mix              | Target    |
|------------------------|-----------|
| Random / no-op         | ~0%       |
| Weak heuristic         | 5–10%     |
| Strong                 | 20–30%    |

A 40–60% target across the board rewards finding shard quirks, not improving the substrate.

## 6. Failure modes

(Adversarial subagent fills in: overfit, no-op, spam, replay, protected-regression, multiplier-stacking attacks.)

## 7. License verification

(Per-source: license SPDX, redistribution constraints, citation requirements. Required before Phase 4 lock.)
