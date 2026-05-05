# Phase 7 — User Actions

This is what the user (botcoinmoney) does after the Phase 7 PR lands. The Phase 7 in-repo deliverable is the **harness**; selecting Core V0 from a baseline winner is a research decision that needs real iteration.

## 1. Run the synthetic dry-run

Verify the harness works:

```bash
npm run build --workspaces --if-present
node experiments/harness/compareBaselines.mjs --epochs 5 --seed 42
```

Output: `experiments/results/synthetic-dryrun/{comparison.md,comparison.csv,A..E.json}`. **Synthetic scoring** — no real corpus, no real winner pick.

## 2. Resolve LoCoMo blocker (issue #4)

Phase 4 temporal-family loader is `LICENSE_BLOCKED` on LoCoMo. Pick A (Snap commercial license), B (replace with permissive alt), or C (synthetic Apache-2.0). Document in `specs/license_audit.md` and `context.md`.

Without this, Phase 7 baseline iteration uses only MemoryAgentBench for the temporal family — partial coverage. The harness still runs but the temporal-family scores are degraded.

## 3. Run real baseline iteration

With a real corpus loader and resolved licensing:

```bash
node experiments/harness/compareBaselines.mjs --epochs 100 --seed 1 --real-corpus
# (the --real-corpus flag is a Phase-4-follow-up wiring; currently unimplemented)
```

Run with multiple seeds to confirm stability. Compare the metrics in `comparison.md`:

- Retrieval accuracy across families
- Stale rejection
- Compression survival (the dominant 60% weight)
- Latency (must hit p50 < 10 ms after issue #8 incremental Merkle fix)
- Patch sensitivity per family
- Overfit resistance

## 4. Pick the winner

Likely **Baseline E (revocation-aware)** per §9 Phase 7 expectations. If a different baseline wins, document the rationale and update `experiments/baselines/README.md`.

## 5. Freeze `coreVersionHash`

```bash
# After picking a winning baseline:
node packages/cortex/dist/cli.js freeze-core-version
# Output: 0x<keccak256-of-pinned-Core-binary>
```

Commit the value:

- `docs/contract-addresses.md` — replace `<TBD>` for `coreVersionHash`.
- `packages/cortex/src/eval/index.ts` — update the `CORE_VERSION_HASH` constant if there is one.

## 6. Freeze `genesisStateRoot`

```bash
node -e "
import('./packages/cortex/dist/state/index.js').then(async ({ pack, merkleizeState, bytesToHex }) => {
  const { genesisState } = await import('./experiments/baselines/baseline_e_revocation_aware/index.mjs');
  const state = genesisState();
  console.log('genesisStateRoot: 0x' + bytesToHex(merkleizeState(state)));
});
"
```

Commit the value:

- `docs/contract-addresses.md`.
- `contracts/script/DeployMainnet.s.sol` — wire as a constructor argument if appropriate.

## 7. Re-run Phase 7 E2E with the real winner

```bash
npm run test:e2e -- --filter phase-7
```

The CI gate becomes authoritative once the placeholder winner is replaced with the real one.

## 8. Adversarial fuzz upgrade (≥1M)

Per §9 Phase 7 spec the adversarial fuzz target is ≥1M patches. The V0 E2E runs 10k for CI speed. For the real release, run a longer fuzz separately:

```bash
EXTENDED_FUZZ=1 node test/e2e/phase-7/run.mjs
```

(The `EXTENDED_FUZZ` flag is a follow-up wiring; default 10k for CI.)

## 9. Patch-sensitivity report

Per §9 Phase 7 — document score deltas for canonical patch families on each baseline. The harness emits this per-baseline; aggregate into a single report at `experiments/results/patch-sensitivity-report.md`.

## 10. Adversarial report

Listing of known failure modes (overfit, no-op, spam, replay, protected-regression breach, multiplier stacking). Aggregate from Phase 6's filler-rejection battery + Phase 4's hard-veto coverage + Phase 7's overfit-resistance gate.

---

## Pass criteria

A green Phase 7 with the real winner is the **precondition** for Phase 8 testnet (per ops/USER_ACTIONS_MAINNET.md step 2). Do not proceed until:

- Real winner picked (likely E) and committed.
- `coreVersionHash` and `genesisStateRoot` frozen and committed.
- Adversarial fuzz ≥1M passes clean.
- Patch-sensitivity report published.
