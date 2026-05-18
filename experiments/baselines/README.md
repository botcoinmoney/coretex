# Phase 7 Baselines — A through E

Per `ORGANISM_CORTEX_STATE_PLAN.md §9 Phase 7`.

## Overview

Five Cortex state seeds ("baselines") compete on CoreTex pre-launch to inform the
selection of Core CoreTex. Each baseline defines:

- `genesisState()` — a deterministic state-seed factory that returns a
  `CortexState` with 1024 uint256 words.
- `mineCandidatePatch(state, shardDescriptor, opts?)` — a corpus-aware miner
  that proposes a 1–4-word candidate patch. When `opts.corpus` is provided
  (default for the harness) the miner targets the next uncovered event in
  its specialty family; without a corpus the previous heuristic is used.

The harness (`experiments/harness/`) runs all five over the same seeds and
the real Phase 4 fixture corpus, scores via
`experiments/harness/cortex-bench-eval.mjs`, and emits a comparison report.

**CoreTex winner**: **Baseline A (empty)** — selected on 2026-05-06 by running
the real CoreTex pre-launch evaluator over seeds 1, 7, 42, 99, 1234. Final
composite 0.2588 (long-horizon compression saturates the 60% family
weight). See `experiments/results/phase7-real-30/comparison.md` and the
per-seed stability runs under `experiments/results/phase7-stability/`.
Frozen `genesisStateRoot` + `coreVersionHash` live in `ops/coretex-frozen.json`
and are mirrored into `docs/contract-addresses.md`.

## Baselines

| ID  | Name | Key feature | Final composite (seed 42, 30 epochs) |
|-----|------|-------------|-------------------------------------:|
| A ★ | Empty Cortex | All-zero state — miner fills memory_index | **0.2588** |
| B   | Dense-key Cortex | Header + dense retrieval keys | 0.2077 |
| C   | Binary-key Cortex | Header + binary retrieval keys | 0.2077 |
| D   | Late-interaction Cortex | Multi-slot WARP-style multi-vector | 0.0692 |
| E   | Revocation-aware Cortex | Memory_index slots with REVOKED flag | 0.1178 |

## Metrics collected by the harness

For each baseline, per epoch:

- **per-component scores** — exact retrieval, stale rejection, temporal
  update correctness, compression survival, routing accuracy
- **composite trajectory** — genesis → final composite under real corpus
- **marginal-gain delta** — `composite_after − composite_before` per patch
- **latency** — wall time per mine + apply + score iteration (p50 / p99)
- **family contribution** — sum of accepted Δ split by family
- **patch-sensitivity** — see `experiments/results/<label>/{A..E}.json` for
  per-epoch component breakdown (a real per-family sensitivity report)

## Scoring

Real CoreTex pre-launch evaluator (`cortex-bench-eval.mjs`):

- **Exact retrieval (0.30)** — relevant near-collision events whose `keyId =
  keccak('cortex-key128:'+id)[lo128]` matches an active retrieval-key slot.
- **Stale rejection (0.15)** — temporal stale-truth events whose
  `eventId = keccak('cortex-mem128:'+id)[lo128]` matches a memory_index
  slot with REVOKED set (bit 65, inside VALIDITY_FLAGS at 79:64).
- **Temporal update correctness (0.15)** — temporal current-truth events
  whose `eventId` matches a memory_index slot with VALID set and REVOKED
  clear.
- **Compression survival (0.30)** — long-horizon events whose `eventId`
  matches an active memory_index slot.
- **Routing accuracy (0.05)** — fraction of relation entries whose weight
  bits 207:192 are non-zero.

Latency penalty subtracts up to 0.025 between p50=10 ms and p99=50 ms.

The corpus is loaded once via `loadRealCorpus()` from
`benchmark/fixtures/{near_collision,temporal,long_horizon}/*.json` plus
the deterministic Apache-2.0 `SyntheticTemporalLoader` events. No
`StubCorpusLoader` in the Phase 7 path.

## How to run

```bash
# Build the workspace once
npm run build --workspaces --if-present

# Run all baselines on the real corpus, 30 epochs, seed 42
node experiments/harness/compareBaselines.mjs --epochs 30 --seed 42 --label phase7-real-30

# Phase 7 CI gate (5-epoch dry run + golden vectors + 10k fuzz + live-epoch)
node test/e2e/phase-7/run.mjs

# Extended 1M-patch fuzz for the pre-launch release
EXTENDED_FUZZ=1 node test/e2e/phase-7/run.mjs

# Freeze coreVersionHash + genesisStateRoot for a chosen baseline
node scripts/freeze-core-version.mjs --baseline A
```
