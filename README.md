# Botcoin CoreTex

CoreTex is an external memory-policy substrate for agent/model memory retrieval. It is not a base-model memory system.
The current launch lane tests whether small miner-emitted `STATE_ADVANCE` patches to a compact 1024-word substrate
produce real hidden-query retrieval lift under a frozen corpus, evaluator profile, and reranker epoch.

The current stack is:

```text
memory adapters -> Memory IR -> 1024-word CoreTex substrate/state
-> retrieval plan -> evidence bundle -> Qwen reranker -> compact packet to the agent/model
```

The active goal is maximum honest runway: minimize plateau risk by keeping substrate regions that produce real hidden
eval lift, reclaiming regions that do not, and validating any new surface with bottom-up probes before protocol changes.

## Current Truth

Read these first:

- `docs/HANDOFFS/NEW_CORPUS_HANDOFF.md` — zero-context current handoff.
- `release/calibration/CURRENT.md` — authoritative calibration state.
- `release/calibration/2026-05-21-memory-corpus-v2/DIFFICULTY_LONGEVITY_CALIBRATION_RUNBOOK.md` — execution gates.
- `release/calibration/2026-05-21-memory-corpus-v2/SUBSTRATE_SURFACE_RUNWAY_MATRIX.md` — miner-facing surface audit.
- `release/calibration/2026-05-21-memory-corpus-v2/SUBSTRATE_VNEXT_COMPOSITION.md` — trim/replace audit.
- `release/calibration/CALIBRATION_LEDGER.jsonl` — calibration run registry.

Current high-level state:

- Temporal is the strongest proven runway surface.
- Tier-2 repacked `MemoryIndex` to stride-1 and lifted temporal pair capacity from 18 to 96.
- Controller params are pinned through the evaluator profile path.
- Relation is useful but bounded and scorer-mediated.
- Static `RetrievalKeys` and static `Codebook`/EvidencePolicy probes failed and are reclaim candidates.
- Reranker tuning is useful only as a new epoch after baseline reset; raw `(query, doc)` tuning does not replace the
  temporal substrate.

## Canonical Architecture

The active substrate layout is defined in `specs/cortex_state.md` and implemented by the V2 substrate decoder:

```text
Header:          32 words
MemoryIndex:    352 words   stride-1, proven temporal infrastructure
RetrievalKeys:  288 words   static lens failed; reclaim candidate
Relations:      128 words   bounded secondary
Temporal:        96 words   proven runway
Codebook:        96 words   static policy failed; reclaim candidate
Reserved:        32 words
```

`packages/cortex/src/substrate/retrieval-decoder.ts` is the canonical V2 retrieval decoder. `packages/cortex/src/decoder/index.ts`
still exists for legacy/raw compatibility and must not be treated as the current V2 MemoryIndex authority.

## Canonical Code Paths

Core implementation:

- `packages/cortex/src/eval/retrieval-benchmark.ts` — scorer, candidate routing, source attribution, Qwen scoring path.
- `packages/cortex/src/substrate/retrieval-decoder.ts` — V2 substrate decode/encode helpers.
- `packages/cortex/src/state/types.ts` — state ranges and constants.
- `packages/cortex/src/state/validate.ts` — reserved-bit and cross-region validation.
- `packages/cortex/src/bundle/index.ts` — evaluator profile schema and profile-to-runtime options.
- `packages/cortex/src/rewards/difficulty.ts` — difficulty controller.
- `packages/cortex/src/eval/reranker.ts` — reranker interface.
- `packages/cortex/src/eval/hidden-query-pack.ts` — hidden query pack derivation.

Canonical corpus/eval/mining scripts:

- `scripts/generate-dgen1-corpus.mjs` — DGEN-1 corpus generator.
- `scripts/lib/build-v2-production-corpus.mjs` — production corpus assembly.
- `scripts/embed-corpus-v2.mjs` and `scripts/embed-corpus-v2-incremental.mjs` — embedding caches.
- `scripts/p05-production-bridge.mjs` — production scorer bridge.
- `scripts/simulate-v2-long-horizon.mjs` — long-horizon mining/controller harness.
- `scripts/lib/v2-patch-families.mjs` — honest patch family encoders.
- `scripts/plumbing-gate.mjs` — end-to-end plumbing gate.
- `scripts/smoke-v2-profile-replay.mjs` — evaluator profile replay smoke.
- `scripts/export-accepted-traces.mjs` — accepted trace export for reranker flywheel work.

Canonical runway/calibration scripts:

- `scripts/measure-temporal-yield-incontext.mjs`
- `scripts/measure-temporal-honest-lift-yield.mjs`
- `scripts/measure-dgen1-churn-replenish.mjs`
- `scripts/simulate-v2-runway-ratematch.mjs`
- `scripts/calc-max-sustainable-target.mjs`

## Tests

Primary tests for the current path:

- `packages/cortex/test/unit/retrieval-decoder.test.mjs`
- `packages/cortex/test/unit/temporal-capacity-crosslayer.test.mjs`
- `packages/cortex/test/unit/controller-params-from-profile.test.mjs`
- `packages/cortex/test/unit/v2-profile-scoring-options.test.mjs`
- `packages/cortex/test/unit/difficulty.test.mjs`
- `packages/cortex/test/unit/owner-scope-and-promotion.test.mjs`
- `packages/cortex/test/unit/relation-qrels.test.mjs`
- `packages/cortex/test/unit/evidence-policy.test.mjs`
- `packages/cortex/test/unit/retrieval-benchmark.test.mjs`
- `packages/cortex/test/unit/candidate-source-attribution.test.mjs`

Run the standard suite with:

```bash
npm test
```

## Bundle And Profiles

Current candidate launch artifacts live under `release/bundle/`:

- `release/bundle/evaluator-profile-v2-dgen1-deep-r1.json`
- `release/bundle/evaluator-profile-v2-ownerscope-r1.json`
- `release/bundle/bundle-manifest-v2-ownerscope-candidate.json`

## Hygiene

Treat this repo as future-public. Never commit `.env`, private keys, wallet material, API tokens, authenticated RPC URLs,
cookies, production logs, database dumps, private user data, or coordinator signing secrets. Commit generated corpus/model
artifacts only when license, size, and reproducibility policy allow it; otherwise commit manifests, hashes, and deterministic
fetch/build instructions.
