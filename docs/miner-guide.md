# Botcoin Cortex — Miner Guide

This guide is for miners participating in the Botcoin Cortex lane. It is the public, miner-facing complement to [`ORGANISM_CORTEX_STATE_PLAN.md`](../ORGANISM_CORTEX_STATE_PLAN.md) (the canonical design plan) and [`instructions.md`](../instructions.md) (operator wiring).

## What Cortex mining is

Cortex mining proves: **I improved the shared memory substrate that future Botcoin agents read through Core — and I get paid through the same receipt path I already use when that improvement advances the live state.**

The shared memory substrate is a **compact 1024-word on-chain-rooted memory codec** (≈32 KB active state). You propose a small patch to it (1–4 word changes per patch). Botcoin Core deterministically verifies that your patch improves the codec against an anchored benchmark and the current live state root, then the production elevated gate verifies that the patch does not regress local open-weight model retrieval. If both gates pass, the coordinator emits a `CortexStateAdvanced` checkpoint during the still-open 24-hour epoch and issues normal Botcoin credits for that state advance. There is **no separate merge multiplier** in V0 production.

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

Response: a signed receipt that you submit on-chain via `BotcoinMiningV3.submitReceipt(...)` only after the patch advances the live Cortex state. Credits accrue through the same `claim()` math you already use.

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

**State-advance credits**: a patch earns credits only when it is verified as a real marginal improvement on the current live state and is emitted as `CortexStateAdvanced`. A cheap screener pass by itself is not enough; if the patch does not improve the live state, it receives a stable rejection code and no receipt.

**Model no-regression gate**: production Cortex runs a local open-weight MiniLM retrieval check for elevated state advances. The deterministic scorer must improve, and the model-facing retrieval components must be equal or better than the parent state. If the model gate regresses, the patch does not advance state and no credits are issued.

**No separate merge multiplier**: `MERGE_MULTIPLIER_BPS` is set to `10000` (1.0×, zero separate uplift). The old `CortexMergeBonus` rail is retained only as legacy/deployment compatibility and should not be funded for V0 production epochs.

**Worked example**: A miner with 200 SWCP solves + 20 Cortex state advances in epoch `e` earns:

- Their normal `(200 + 20) × tierCredits` from `BotcoinMiningV3.claim()`.

The incentive is now direct: advance useful state early, earn normal credits. There is no extra end-of-epoch jackpot to withhold for.

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

You see your `shardId` at challenge time. Your patch is silently re-evaluated against protected-regression shards before it can advance live state. A patch that overfits to your assigned shard will fail and earns no credits.

## Audit window (V0 trust assumption — disclosed honestly)

Each epoch's finalization is **provisional for `CHALLENGE_WINDOW_SECONDS` (V0 default: 6 hours)**. Within that window:

- Any party can run `botcoin-cortex verify-epoch <epoch>` from chain alone and demonstrate divergence.
- If divergence is shown, a **2-of-N operator multisig** (key set published in [`docs/multisig-key-set.md`](./multisig-key-set.md)) calls `revertEpoch(epoch)` and the coordinator re-finalizes.
- After the window, finalization is canonical. No V0 merge-bonus funding is required.

**This is not an on-chain fraud proof.** The EVM cannot re-run Botcoin Core. The audit window is a public delay during which divergence can be demonstrated and the multisig can act. **V1 path**: bond-based or ZK fraud proofs replace the multisig override. See [V1 roadmap](./v1-roadmap.md).

State-advance receipts are settled through the existing `BotcoinMining.submitReceipt` path. The audit window protects the epoch state root; if the epoch is reverted, the coordinator replays from the last valid state and re-finalizes.

## Filler / abuse rejection

Patches are rejected at the screener for:

- No-op (every new word equals the current word).
- Random mutation (no measurable score delta).
- Public-test overfit (passes one shard but fails the K=4 protected-regression shards).
- Protected-regression breaches (drops a protected anchor).
- Patch budget abuse (>4 words).
- Reserved-bit violations.

Stable error codes: `E01` (wrong parent root), `E02` (wrong-type field), `E03` (over-budget), `E04` (reserved-bit set), `E05` (no-op).

## Why the V0 patch budget is 1-4 words

The 4-word limit is conservative on purpose. It keeps attribution clean, makes
state advances cheap to replay, and prevents miners from bundling many unrelated
changes into one opaque proposal. Larger patches also increase the chance that
one good edit hides one bad edit. Since Cortex advances live state throughout
the 24-hour epoch, miners can still land many improvements; they just land them
as auditable increments. A future macro-patch lane can raise the budget after
testnet data proves larger changes still pass the local model no-regression
gate reliably.

## Fail-safes

- **Lane disable**: the operator can stop `cortex-server` or remove the nginx upstream at any time. SWCP claims are unaffected. Your queued submissions are preserved in the cortex SQLite queue and resume on restart.
- **Emergency pause**: `CortexRegistry.pause()` halts new state advances and finalization.
- **Multisig override**: see "Audit window" above.

## See also

- [`verifier-guide.md`](./verifier-guide.md) — how to audit an epoch from chain alone.
- [`receipt-mapping.md`](./receipt-mapping.md) — the §6 receipt field mapping in detail.
- [`v1-roadmap.md`](./v1-roadmap.md) — what's deferred.
- [`contract-addresses.md`](./contract-addresses.md) — mainnet `CortexRegistry` and `BotcoinMiningV3` addresses.
