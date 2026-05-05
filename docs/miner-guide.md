# Botcoin Cortex — Miner Guide

This guide is for miners participating in the Botcoin Cortex lane. It is the public, miner-facing complement to [`ORGANISM_CORTEX_STATE_PLAN.md`](../ORGANISM_CORTEX_STATE_PLAN.md) (the canonical design plan) and [`instructions.md`](../instructions.md) (operator wiring).

## What Cortex mining is

Cortex mining proves: **I improved the shared memory substrate that future Botcoin agents read through Core — and I get paid through the same receipt path I already use, plus a sister-contract bonus when my patch is merged.**

The shared memory substrate is a **compact 1024-word on-chain-rooted memory codec** (≈32 KB active state). You propose a small patch to it (1–4 word changes per patch). Botcoin Core deterministically verifies that your patch improves the codec against an anchored benchmark. If your patch passes the screener, you earn credits at your current on-chain tier rate through the existing `BotcoinMining.submitReceipt` path. If the epoch reducer also accepts ("merges") your patch, you additionally qualify for a **1.5× merge multiplier** paid through the peer `CortexMergeBonus` contract.

`BotcoinMiningV3` is **unchanged**. The SWCP challenge system is **unchanged**. Cortex is a parallel lane — same auth, same tier system, same RPC origin (`/v1/cortex/*`), same signing key.

## How to mine

The Cortex coordinator is mounted at the same origin as the SWCP coordinator, behind path-prefix routing.

```bash
# 1. Request a challenge
curl -s "$COORDINATOR/v1/cortex/challenge" \
     -H "x-miner: $MINER_ADDRESS" \
     -H "x-auth: $YOUR_EXISTING_AUTH"
```

Response shape:

```json
{
  "lane": "cortex",
  "epoch": 812,
  "parentStateRoot": "0x...",
  "experienceCorpusRoot": "0x...",
  "coreVersionHash": "0x...",
  "patchObjective": "KEY_UPDATE",
  "patchBudget": 4,
  "shardId": "0x...",
  "shardDescriptor": { "...": "..." },
  "submissionFormat": "patch_v0",
  "creditsPerSolve": "<from getTier()>"
}
```

`creditsPerSolve` is your **current on-chain tier credits** — same value the SWCP lane returns. No separate Cortex tier table.

```bash
# 2. Compute a patch (using any LLM externally, or a heuristic, or a hand-crafted patch).
#    The patch must be a 1–4 word change to non-reserved indices, encoded per
#    specs/patch_format_v0.md (LEB128 indices, old-words OMITTED — they are
#    reconstructed from parent state).
#
# 3. Submit
curl -s "$COORDINATOR/v1/cortex/submit" \
     -H "x-miner: $MINER_ADDRESS" \
     -H "x-auth: $YOUR_EXISTING_AUTH" \
     -H "content-type: application/json" \
     -d "$(cat patch.json)"
```

Response: a signed receipt that you submit on-chain via `BotcoinMiningV3.submitReceipt(...)`. Credits accrue through the same `claim()` math you already use.

## Receipt field mapping (V0)

Cortex receipts ride the **existing `BotcoinMining` EIP-712 domain** with `rulesVersion = 0xC0` as the Cortex discriminator. The contract validates the signature only — field labels are by convention. The on-chain mapping:

| `BotcoinMining` field   | Cortex meaning                                                                |
|-------------------------|-------------------------------------------------------------------------------|
| `worldSeed` (uint128)   | u128 of `keccak(H_e ‖ miner ‖ solveIndex ‖ parentStateRoot)`                   |
| `docHash`               | `parentStateRoot`                                                              |
| `questionsHash`         | `experienceCorpusRoot`                                                         |
| `constraintsHash`       | `shardCommitment`                                                              |
| `answersHash`           | `patchHash`                                                                    |
| `rulesVersion`          | `0xC0` (reserved Cortex value)                                                 |

Block explorers will see `doc/questions/constraints/answers` labels — that is the V0 soft-coupling. **V1 path**: `BotcoinMining.submitCortexReceipt(...)` sister function with explicit Cortex field names. Tracked in the [V1 roadmap](./v1-roadmap.md).

## Credits

**Layer A — screener credits (broad)**: every screener-pass patch earns your current on-chain tier credits via `BotcoinMiningV3.submitReceipt`. The same value SWCP solves earn.

**Layer B — merge multiplier (selective)**: if the epoch reducer accepts your patch into the canonical `patchSetRoot`, you additionally qualify for a 1.5× uplift on your own pro-rata epoch reward, paid via:

```solidity
CortexMergeBonus.claimMergeBonus(uint64[] epochIds);
```

UX is identical to the existing `BonusEpoch.claimBonus`. The coordinator returns pre-encoded calldata via:

```bash
curl -s "$COORDINATOR/v1/cortex/merge-bonus/claim-calldata?epochs=812,813"
```

**Multiplier cap**: 1.5× per miner per epoch. Additional merged patches in the same epoch do **not** grant additional uplift. The cap is enforced both off-chain (in the coordinator funding tx) and on-chain (in `CortexMergeBonus.claimMergeBonus` via the Merkle leaf's `capBOTCOIN` field).

**Worked example**: A miner with 200 SWCP solves + 20 Cortex screener passes in epoch `e`, with one merged patch, earns:

- Their normal `(200 + 20) × tierCredits` from `BotcoinMiningV3.claim()`.
- An additional `0.5 × claimBaseForMerger(e, miner)` from `CortexMergeBonus.claimMergeBonus([e])`.

Strong but not pool-dominating, and structurally separable in audits.

## Cross-lane rules

- **Single outstanding challenge across lanes.** Before the cortex process serves a challenge, it queries `/internal/outstanding-challenge?miner=0x...` on the SWCP process. If you have an unsubmitted SWCP or Cortex challenge that has not expired, the cortex process returns 409. Same guard runs SWCP-side. Avoids `nextIndex` / `lastReceiptHash` races.
- **Shared rate-limit budget.** Per-miner submit caps are shared across lanes. You cannot bypass SWCP rate limits by switching lanes.
- **Same auth.** Your existing miner credentials work on both lanes.

## Hidden shards (commit/reveal)

Per epoch, a hidden seed `H_e` is committed on-chain at epoch start (mirrors `setEpochCommit` in the SWCP coordinator). Your assigned shard is:

```
shardId = keccak(H_e ‖ miner ‖ solveIndex ‖ parentStateRoot)
```

derived through the existing `deriveWorldSeedU128(...)` machinery. `H_e` is revealed at epoch end (mirrors `revealEpochSecret`). Auditors then replay every shard.

**Continuous shard generation**: shards are derived on demand from `H_e`, not drawn from a static pool. Probing across many epochs cannot enumerate the space because each `H_e` is fresh.

You see your `shardId` at challenge time. Your patch is silently re-evaluated against `K=4` random other shards as protected-regression at merge time. A patch that overfits to your assigned shard will fail merge.

## Audit window (V0 trust assumption — disclosed honestly)

Each epoch's finalization is **provisional for `CHALLENGE_WINDOW_SECONDS` (V0 default: 6 hours)**. Within that window:

- Any party can run `botcoin-cortex verify-epoch <epoch>` from chain alone and demonstrate divergence.
- If divergence is shown, a **2-of-N operator multisig** (key set published in [`docs/multisig-key-set.md`](./multisig-key-set.md)) calls `revertEpoch(epoch)` and the coordinator re-finalizes.
- After the window, finalization is canonical and `CortexMergeBonus` is funded.

**This is not an on-chain fraud proof.** The EVM cannot re-run Botcoin Core. The audit window is a public delay during which divergence can be demonstrated and the multisig can act. **V1 path**: bond-based or ZK fraud proofs replace the multisig override. See [V1 roadmap](./v1-roadmap.md).

`CortexMergeBonus` is **not funded** for an epoch until that epoch's audit window closes without a successful revert. Screener-pass receipts are NOT subject to the window — they are settled through the existing `BotcoinMining.submitReceipt` path immediately.

## Filler / abuse rejection

Patches are rejected at the screener for:

- No-op (every new word equals the current word).
- Random mutation (no measurable score delta).
- Public-test overfit (passes one shard but fails the K=4 protected-regression shards).
- Protected-regression breaches (drops a protected anchor).
- Patch budget abuse (>4 words).
- Reserved-bit violations.

Stable error codes: `E01` (wrong parent root), `E02` (wrong-type field), `E03` (over-budget), `E04` (reserved-bit set), `E05` (no-op).

## Fail-safes

- **Lane disable**: the operator can stop `cortex-server` or remove the nginx upstream at any time. SWCP claims are unaffected. Your queued submissions are preserved in the cortex SQLite queue and resume on restart.
- **Emergency pause**: `CortexRegistry.pause()` halts new state finalization. `CortexMergeBonus.pause()` halts merge-bonus claims separately.
- **Multisig override**: see "Audit window" above.

## See also

- [`verifier-guide.md`](./verifier-guide.md) — how to audit an epoch from chain alone.
- [`receipt-mapping.md`](./receipt-mapping.md) — the §6 receipt field mapping in detail.
- [`v1-roadmap.md`](./v1-roadmap.md) — what's deferred.
- [`contract-addresses.md`](./contract-addresses.md) — mainnet `CortexRegistry`, `CortexMergeBonus`, and `BotcoinMiningV3` addresses.
