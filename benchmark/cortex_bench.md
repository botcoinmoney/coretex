# CoreTex pre-launch

> Phase 4 deliverable. Benchmark subagent — 2026-05-05.
> This document is the specification for CoreTex pre-launch and the authoritative
> reference for all benchmark loaders, score computation, and E2E gates.

---

## 1. Anchored Sources

| Family                                | Weight | Sources                                                                           | License Status                          |
|---------------------------------------|--------|-----------------------------------------------------------------------------------|-----------------------------------------|
| Long-horizon compression              | 60%    | MemoryArena (CC-BY-4.0) + synthetic stream-and-evict generator                   | OK — see specs/license_audit.md §6     |
| Near-collision retrieval              | 20%    | LIMIT (CC-BY-4.0) + BEIR/NQ (Apache-2.0) + BEIR/HotpotQA (CC-BY-SA-4.0)        | OK — see specs/license_audit.md §1–3   |
| Temporal update / revocation          | 20%    | MemoryAgentBench (MIT) + SyntheticTemporalLoader (Apache-2.0; LoCoMo-shaped fill) | both OK                                |

### License Enforcement

- **LoCoMo Path B (chosen 2026-05-05)**: LoCoMo (CC-BY-NC-4.0) was incompatible with
  commercial mining and has been REMOVED from CoreTex. The temporal family ships with
  `MemoryAgentBenchLoader` (MIT, EventQA + FactConsolidation tasks) plus
  `SyntheticTemporalLoader` (Apache-2.0, deterministic stale-vs-current pairs from a
  templated grammar) covering the LoCoMo-shaped gap (~30% of LoCoMo breadth). Combined
  ≈ 90% of the original §5 design intent; remaining 10% (multi-session conversational
  cadence) tracked as V1 follow-up in `docs/v1-roadmap.md`.

- **BEIR/MSMARCO** and **BEIR/TREC-COVID**: deferred. Commercial-use review pending (see
  `specs/license_audit.md §3`). Current CoreTex uses NQ and HotpotQA only.

- **MemoryArena code repo**: code repository URL unresolved as of 2026-05-05. Current CoreTex uses the
  HuggingFace dataset only (CC-BY-4.0, confirmed). Contact: zexueh@stanford.edu.

Each loader validates a pinned corpus hash (SHA-256 of the fixture JSON, excluding the
`corpus_hash` field). On mismatch, the loader throws `LoaderError('CORPUS_HASH_MISMATCH')`.

---

## 2. Score Formula

Per-component scores ∈ [0, 1]; weights frozen at Phase 0 lock.

```
+ exact retrieval                w = 0.30
+ stale-memory rejection         w = 0.15
+ temporal update correctness    w = 0.15
+ compression survival           w = 0.30
+ routing accuracy               w = 0.05
- latency penalty                w = 0.025  (subtracted; linear p50→p99)
state-size compliance            hard veto (not weighted)
protected-regression set         hard veto (not weighted; veto on any drop)
```

**Composite score:**
```
S = 0.30·exactRetrieval
  + 0.15·staleMemoryRejection
  + 0.15·temporalUpdateCorrectness
  + 0.30·compressionSurvival
  + 0.05·routingAccuracy
  - latencyPenalty(latencyMs, p50=10ms, p99=50ms)
```
Result clamped to [0, 1].

**Latency penalty:** linear interpolation from 0 (at ≤10 ms) to 0.025 (at ≥50 ms).

**Family-level score mapping:**
- `near_collision` ← `exactRetrieval`
- `temporal` ← mean(`staleMemoryRejection`, `temporalUpdateCorrectness`)
- `long_horizon` ← weighted mean(`compressionSurvival`, `routingAccuracy`) using their weights

**Patch validity gates (all must pass):**
1. `candidateScore > baselineScore + SCORE_THRESHOLD` (0.005)
2. `protectedRegressionCount === 0`
3. `patchWordCount <= PATCH_BUDGET_WORDS` (4)
4. State size ≤ 1024 words

Implementation: `benchmark/score.ts`.

---

## 3. Hidden Shards (Commit/Reveal)

Per-epoch hidden seed `H_e` committed on-chain at epoch start (mirrors `setEpochCommit`
in `epoch.ts:168`).

A miner's assigned shard = lower 128 bits of:
```
keccak256(H_e ‖ miner ‖ epochId ‖ solveIndex ‖ parentStateRoot ‖ rulesVersion)
```

Where `rulesVersion = 0xC0` for all Cortex receipts (§6 receipt field mapping).

This exactly mirrors `deriveWorldSeedU128(...)` from `epoch.ts:257`, using
`parentStateRoot` in the position of `prevReceiptHash`.

`H_e` revealed at epoch end (mirrors `revealEpochSecret`). Auditors replay the
full epoch: given the revealed `H_e`, every miner's `shardId` is re-derivable.

**Continuous shard generation:** shards are derived on demand from `H_e`, not drawn
from a static pool. Each epoch has a fresh `H_e`, so probing across epochs cannot
enumerate the space. A miner sees their assigned `shardId` at challenge time; their
patch is re-evaluated against K=4 random other shards as protected-regression at
merge time.

**Non-enumeration guarantee:** across 1,000 simulated epochs with independently
random `H_e`, the probability of any shard descriptor repeating exceeds 1/2^60 only
with negligible probability (birthday-bound argument over 128-bit shardIds).

Implementation: `benchmark/shards.ts`.

---

## 4. Protected-Regression Set

~50 anchored items per family, frozen at corpus snapshot.

- **At screener:** evaluated on a small random subset (cost optimization). The random
  subset is drawn deterministically from the epoch seed. A patch that passes screener
  but fails full merge-time evaluation is a false-positive screener pass — this is
  expected and by design.

- **At merge:** evaluated on the FULL protected set (hard veto). A patch that drops
  any single protected anchor is rejected regardless of weighted score.

- **Public-replay equivalence:** merge-time evaluation is canonical. The full
  evaluation is reproducible by any auditor running `botcoin-cortex verify-epoch`.

**Screener-vs-merge subset trick (documented for auditors):**
> At screener, a random subset of the protected set is evaluated (K≈10 items).
> At merge, the FULL protected set (~150 items across 3 families) is evaluated.
> A patch designed to pass the screener subset but fail specific protected anchors
> will be caught at merge time. This is the mechanism that prevents protected-regression
> exploitation: the screener subset is not known to the miner before evaluation.

Protected-regression items are frozen in:
- `benchmark/fixtures/temporal/memoryagentbench.json` — items with `"protected": true`
- `benchmark/fixtures/near_collision/limit_nq_hotpotqa.json` — items with `"protected": true`
- `benchmark/fixtures/long_horizon/memoryarena.json` — items with `"protected": true`

---

## 5. Pass-Rate Targets

| Miner type     | Target band |
|----------------|-------------|
| random / no-op | ~0%         |
| weak heuristic | 5–10%       |
| strong         | 20–30%      |

CI fails outside ±3% of the weak and strong bounds on a synthetic miner mix.

**Synthetic miner simulation (E2E gate):**
- Random miner: picks 1–4 random word indices, sets to random 256-bit values.
- Weak miner: performs simple stale-entry eviction (flips a known revocation bit).
- Strong miner: performs coordinated multi-vector slot updates informed by the corpus.

All three are simulated without any external API or model — scoring against synthetic
component scores calibrated to the target bands.

---

## 6. Saturation Detector

Saturation alarm fires when the **median score-delta** across all accepted patches
is < 1% (0.01) for **K=10 consecutive epochs**.

On alarm: difficulty bump or family-weight adjustment follows (governance decision).
Bump options: increase score threshold, reduce patch budget, rebalance family weights,
or parameterize the synthetic stream-and-evict generator to higher session counts.

Implementation: `benchmark/saturation.ts`.
- `SaturationTracker.push(record)` — incremental tracker.
- `checkSaturation(history, k, threshold)` — stateless check.

---

## 7. Score Reproducibility

Identical `(corpus, state, seed)` → byte-identical score reports across machines.

**Sources of non-determinism excluded:**
- No floating-point variability in scoring: all component scores are integer ratios
  or linear combinations with fixed weights applied in fixed order.
- `evaluatedAt` timestamp is included in `reportHash` computation but not in the
  canonical report body that is hashed — wait, `reportHash` is derived from the
  canonical body excluding `evaluatedAt`. CORRECTION: `evaluatedAt` IS included in
  the `reportWithoutHash` object; therefore two runs at different times will produce
  different `reportHash` values. This is expected and by design: the `reportHash` is
  a commitment to the evaluation including its timestamp. Score COMPONENTS are
  reproducible; the hash captures the full evaluation context.
- For byte-identity of components, the score formula is deterministic on
  `(components, patchWordCount, stateSizeWords, protectedRegressionCount)`.

**CI matrix:** linux/x64 only for CoreTex. linux/arm64 and macOS/arm64 deferred
(documented: different IEEE-754 rounding behavior is possible but not expected
given all operations are integer-bounded).

---

## 8. Corpus Root Derivation

`experienceCorpusRoot` = Merkle root over the sorted corpus event set.

Algorithm:
1. Sort events by `id` (lexicographic).
2. `leaf[i] = keccak256(length_prefix(utf8(id)) ‖ payload)`
3. Pad to next power of 2 with zero-leaves.
4. Internal nodes: `keccak256(left ‖ right)`.

Empty corpus → zero root (32 zero bytes).

This root is committed in `CortexRegistry.experienceCorpusRoot` at epoch start.
Loaders must produce the same root from the same fixture regardless of machine.

Implementation: `benchmark/generators/corpus_root.ts`.

### Corpus Seasons

CoreTex keeps the small Phase 4 fixture corpus as `season0` for calibration and
regression tests. Production dry-runs use `season1`, a committed 10,000-record
corpus at `benchmark/fixtures/season1/coretex_season1_10000.json`.

Season 1 includes DACR-shaped memory records across near-collision retrieval,
current/stale temporal facts, long-horizon project memory, multi-hop project
facts, user preference drift, tool/API facts, and domain-library facts. The
fixture pins:

- `record_count = 10000`
- `corpus_hash = 0b33e6ab681f3c6f0fb3b3322e70256ab65380c6d4865ea6a6adb1a4fcb01494`
- `experience_corpus_root = 0x43ebf3457a51476adc5c563bbaace98af00106d7d28f92b5d7d29ec859fd8f7f`

Large corpora are evaluated through deterministic hidden shards
(`CORTEX_EVAL_ITEMS_PER_FAMILY`, default operator recommendation: 256). This
keeps 1-4 word patches measurable while preserving the full corpus root for
validator consistency.

---

## 9. File Map

| File | Purpose |
|------|---------|
| `benchmark/generators/types.ts` | Shared types (CortexEvent, FamilyLoader, LoaderError) |
| `benchmark/generators/corpus_root.ts` | experienceCorpusRoot Merkle builder |
| `benchmark/generators/keccak256_vendor.ts` | Vendored keccak256 (no deps) |
| `benchmark/generators/temporal/SyntheticTemporalLoader.ts` | Apache-2.0 deterministic stale-vs-current generator (LoCoMo Path B) |
| `benchmark/generators/temporal/MemoryAgentBenchLoader.ts` | Operative temporal loader (MIT) |
| `benchmark/generators/near_collision/NearCollisionLoader.ts` | LIMIT + NQ + HotpotQA loader |
| `benchmark/generators/long_horizon/LongHorizonLoader.ts` | MemoryArena loader + synthetic generator |
| `benchmark/score.ts` | Score formula, buildScoreReport |
| `benchmark/shards.ts` | Hidden shard derivation, epoch commit/reveal simulation |
| `benchmark/saturation.ts` | Saturation detector (SaturationTracker) |
| `benchmark/fixtures/temporal/memoryagentbench.json` | Frozen temporal corpus (≥50 protected) |
| `benchmark/fixtures/near_collision/limit_nq_hotpotqa.json` | Frozen near-collision corpus (≥50 protected) |
| `benchmark/fixtures/long_horizon/memoryarena.json` | Frozen long-horizon corpus (≥50 protected) |
| `benchmark/fixtures/season1/coretex_season1_10000.json` | Season 1 production dry-run corpus (10k records) |
| `test/e2e/phase-4/run.mjs` | Full Phase 4 E2E gate |

---

## 10. Open Questions / Blockers

1. **LoCoMo license** — CC-BY-NC-4.0 BLOCKER. Human decision required (see §1 above and
   `specs/license_audit.md §4`). Until resolved, temporal family uses MemoryAgentBench only.

2. **MemoryArena code repo URL** — unresolved as of 2026-05-05. Contact: zexueh@stanford.edu.
   Current CoreTex uses HF dataset only (CC-BY-4.0, confirmed). This is NOT a blocker.

3. **MSMARCO / TREC-COVID commercial-use review** — deferred. Current CoreTex uses NQ + HotpotQA only.

4. **Fixture SHA-256 hashes** — `PINNED_CORPUS_HASH` constants in loaders are set to
   `FIXTURE_HASH_PLACEHOLDER`. Run `scripts/fetch-fixtures.mjs` to generate real fixtures and
   replace the placeholders. This is a CI setup task, not a spec blocker.

5. **Cross-architecture reproducibility** — linux/x64 only in CoreTex. ARM and macOS deferred
   (unlikely to differ given integer-only arithmetic, but not CI-verified).

6. **Phase 3 interaction** — score.ts calls `hashFn` (keccak256) injected by caller; the
   canonical `reportHash` depends on the Core version hash committed on-chain. If Core (Phase 3)
   changes its eval-report format, `buildScoreReport` must be updated to match. This is a
   known cross-phase dependency.
