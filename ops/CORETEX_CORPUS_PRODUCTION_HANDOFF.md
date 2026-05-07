# BOTCOIN CoreTex — Production Corpus Hardening Handoff

Date: 2026-05-07

## Current Corpus State

The current committed large corpus is:

- Path: `benchmark/fixtures/season1/coretex_season1_10000.json`
- Records: `10,000`
- `corpus_hash`: `0b33e6ab681f3c6f0fb3b3322e70256ab65380c6d4865ea6a6adb1a4fcb01494`
- `experienceCorpusRoot`: `0x43ebf3457a51476adc5c563bbaace98af00106d7d28f92b5d7d29ec859fd8f7f`
- Generator: `scripts/generate-season1-corpus.mjs`
- Smoke gate: `scripts/season1-shard-smoke.mjs`
- E2E inclusion: `test/e2e/phase-7/run.mjs` includes `season1-10k-shard-smoke`

Distribution:

| Family | Count |
|--------|------:|
| near_collision | 2,200 |
| temporal | 3,600 |
| long_horizon | 4,200 |

Task breakdown:

| Task | Count |
|------|------:|
| `dacr_near_collision` | 2,200 |
| `temporal_current` | 1,400 |
| `temporal_stale` | 1,400 |
| `long_horizon` | 2,200 |
| `multi_hop_project` | 1,000 |
| `preference_drift` | 800 |
| `tool_api_fact` | 500 |
| `domain_library_fact` | 500 |

This is a strong **scale and plumbing** fixture. It is not yet the ideal final production corpus, because most records are deterministic synthetic templates. It proves the architecture can run a 10k root-pinned corpus and that a 1-4 word patch can still show measurable signal under deterministic hidden-shard eval.

## Is This The Ideal Shape?

Not yet.

The ideal corpus for the current 1024-word CoreTexState should pressure exactly the fields the state can express:

- `MemoryIndex` slots: durable event handles, object types, validity/revocation flags, compact checksums, corpus epoch, expiry epoch.
- `RetrievalKeys` slots: discriminative keys for near-collisions and hidden-shard recall.
- `Relations` slots: multi-hop routing, dependency links, and weighted edges.
- `Temporal` slots: explicit stale/current/revoked transitions and validity windows.
- `Codebook` slots: compressed operators and domain abstractions that let a small state cover a larger corpus.

The current Season 1 corpus stresses `MemoryIndex`, `RetrievalKeys`, and some temporal flags. It under-stresses relation routing and codebook compression, and its content is too templated to be considered bulletproof against overfitting.

## Production Corpus Target

Build `season1-production` or replace the current Season 1 fixture before paid mainnet epochs.

Minimum acceptable production target:

- At least `10,000` records committed in-tree or content-addressed with a pinned manifest.
- At least `1,000` records for local/mainnet rehearsal if the full 10k corpus is too heavy for a first dry run.
- At least `20%` real source-grounded records from existing BOTCOIN DACR/domain libraries, accepted trace artifacts, operator runbooks, and public docs.
- At least `20%` adversarial temporal records with explicit stale/current/revoked pairs.
- At least `20%` near-collision records with plausible wrong neighbors.
- At least `15%` long-horizon compression records whose value depends on preserving information across many unrelated records.
- At least `10%` relation/multi-hop records that require using relation slots, not just memory-key slots.
- At least `5%` tool/API facts grounded in exact source text or versioned docs.
- At least `5%` codebook/compression records that reward compact shared abstractions.

Recommended production target:

- `25,000` to `50,000` records.
- Hidden-shard eval at `CORTEX_EVAL_ITEMS_PER_FAMILY=256` or `512`.
- Protected-regression set: at least `1,000` records, balanced across families.
- Holdout set: deterministic but hidden until epoch reveal, so public source code does not make gaming trivial.

## Source Inputs To Use

Prefer sources already available locally or already canonical to BOTCOIN:

- `/root/botcoin` DACR domain libraries and challenge generators.
- Accepted/rejected reasoning trace experiment files under `/root/botcoin/experiments/*`.
- Existing BOTCOIN docs and runbooks.
- CoreTex docs/specs in `/root/cortex/benchmark`, `/root/cortex/docs`, `/root/cortex/ops`.
- Public permissive research-paper metadata only if license and redistribution are clear.

Do not add non-commercial datasets. Do not add private user data. Do not add unpinned scraped web pages.

## Required Record Schema Hardening

The next corpus should make the answer fields less template-like and more structurally meaningful:

```json
{
  "id": "s1p-000001",
  "family": "temporal",
  "task": "preference_drift",
  "protected": true,
  "split": "train|eval|protected|holdout",
  "epoch_committed": 12,
  "source_ref": "botcoin-domain-library:<file-or-artifact>:<stable-id>",
  "query": "Question future miners must retrieve against",
  "truth": "Current/source-of-truth answer",
  "distractors": ["plausible stale/wrong answer"],
  "relations": ["depends_on:s1p-...", "supersedes:s1p-..."],
  "expected_state_regions": ["memory_index", "temporal", "relations"],
  "is_stale": false,
  "valid_from_epoch": 12,
  "expires_at_epoch": 0
}
```

Every record should declare what state region it is meant to exercise. This prevents a corpus that only rewards one easy slot family.

## Required Scorer Hardening

Update `experiments/harness/cortex-bench-eval.mjs` so each record can specify expected state regions:

- `memory_index` hit for durable event handles.
- `retrieval_key` hit for near-collision recall.
- `temporal` hit for current/stale/expiry/revocation correctness.
- `relation` hit for dependency edges and multi-hop routing.
- `codebook` hit for compact shared operators.

The final composite should make it impossible for a miner to dominate the score by filling only memory slots. A suggested production weighting:

| Component | Weight |
|-----------|-------:|
| exact/near-collision retrieval | 20% |
| temporal current/stale correctness | 20% |
| long-horizon compression survival | 20% |
| relation/multi-hop routing | 20% |
| codebook/compression abstraction | 10% |
| local model no-regression / retrieval agreement | 10% |

Keep hard vetoes:

- reserved-bit violation
- stale parent
- protected-regression drop
- relevant near-collision over threshold
- local model regression on elevated state advances

## Required E2E Tests

Add tests before claiming production-ready corpus:

1. `season1-production-root-repro`
   - Regenerate fixture from manifest.
   - Recompute `corpus_hash`.
   - Recompute `experienceCorpusRoot`.
   - Assert exact match.

2. `season1-production-balance`
   - Assert record count >= 10,000.
   - Assert family/task distribution minimums.
   - Assert protected set >= 1,000.
   - Assert every record has `source_ref`, `split`, `query`, `truth`, and `expected_state_regions`.

3. `season1-production-shard-signal`
   - Run at least 100 deterministic hidden shards.
   - For each major family, construct a known-good 1-4 word patch.
   - Assert delta >= current adaptive screener threshold.

4. `season1-production-negative-controls`
   - Random mutation fails.
   - Wrong/stale parent fails.
   - Near-collision bait fails.
   - Stale fact marked current fails.
   - Relation-only record without relation slot fails.

5. `season1-production-local-model`
   - Prewarm local MiniLM.
   - Known-good retrieval patch has no model regression.
   - Known-bad distractor patch regresses or fails no-signal.

6. `season1-production-live-flow`
   - Spin Anvil.
   - Deploy registry.
   - Submit at least three non-overlapping state advances from different families in one 24h epoch.
   - Verify all advance live state.
   - Verify stale replay reverts.
   - Finalize epoch and replay root.

7. `season1-production-v4-flow`
   - Run coordinator signing path.
   - Screener receipt earns 1x.
   - State-advance receipt earns policy tier.
   - `workPolicyHash`, `experienceCorpusRoot`, and `coreTexVersionHash` match published values.

## Mainnet Readiness Gate

Do not enable paying mainnet CoreTex epochs until:

- The production corpus has passed all tests above.
- At least one coordinator validator and one independent validator reproduce the same corpus root.
- Testnet or anvil-fork campaign has run at least `1,000` patch attempts against the production corpus.
- Observed screener pass rate and state-advance rate are measured and used to calibrate V4 work units.
- The final corpus root, policy hash, and core version hash are published in the operator handoff.

## Next Agent Starting Point

1. Read this file.
2. Read `benchmark/cortex_bench_v0.md`.
3. Read `scripts/generate-season1-corpus.mjs`.
4. Inspect `/root/botcoin` DACR/domain-library/challenge generator files.
5. Replace or augment `benchmark/fixtures/season1/coretex_season1_10000.json` with a source-grounded corpus.
6. Add the tests listed above.
7. Run:

```bash
cd /root/cortex
npm run build --workspaces --if-present
npx -y node@22 scripts/run-e2e.mjs --filter phase-7
EXTENDED_FUZZ=1 npx -y node@22 scripts/run-e2e.mjs --filter phase-7
```

8. If touching V4 receipt economics, also run:

```bash
cd /root/botcoin
forge test --fuzz-runs 10000
```

The desired end state is not "a bigger synthetic corpus." The desired end state is a root-pinned, source-grounded memory benchmark that forces miners to improve exactly the compact temporal/retrieval/relation/codebook map that CoreTex puts on chain.
