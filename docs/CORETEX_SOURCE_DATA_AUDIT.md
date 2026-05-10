# CoreTex Source Data Audit (Phase E0)

Last updated: 2026-05-10T03:15:54.893Z

## Source

- coordinator clone root: `/root/botcoin-coordinator-live`
- domains audited: `companies`, `quantum_physics`, `computational_biology`, `scrna_imputation`
- sampled seeds per domain: 5

## Coordinator clone code layout evidence

The audit inspected the local coordinator clone source in addition to any materialized dataset mirror.

- `packages/coordinator/src/dataset-layout.ts`: `dataset/v2`, `context/challenge.json`, `context/trap_metadata.json`
- `packages/coordinator/src/storage.ts`: `dataset/v2`
- `packages/coordinator/src/session-assembler-job.ts`: `dataset/v2`, `rejected_attempt`, `chosen_attempt`
- `packages/coordinator/src/export-hf-dataset.ts`: `dataset/v2`, `attempts/research-ready`, `sessions/research-ready`, `pairs/session/sequential`, `pairs/session/bookend`, `dataset/v2/exports/hf/v1`, `rejected_attempt`, `chosen_attempt`

## Per-category key counts and missing-field rates

### companies/__missing__

```json
{
  "exists": false
}
```

### quantum_physics/__missing__

```json
{
  "exists": false
}
```

### computational_biology/__missing__

```json
{
  "exists": false
}
```

### scrna_imputation/__missing__

```json
{
  "exists": false
}
```

## Capability to produce CoreTex retrieval-benchmark fields

| Field | Present in coordinator data? |
|---|---|
| graded relevance qrels | no |
| hidden eval queries | no |
| hard negatives | no |
| temporal current/stale labels | no |
| multi-hop relation labels | no |

Notes:

- Coordinator dataset_v2 records carry no graded relevance qrels.
- Coordinator records carry no explicit hard-negative document set; trap paragraphs (in trap_metadata.json) are plausible-but-wrong but unlabeled.
- No temporal current/stale labels exist; sequential and bookend pairs encode chosen/rejected attempts, not (current, stale) document pairs.
- No multi-hop relation graph is materialized; questions reference multi-hop within a single document but no cross-document edge labels exist.
- A retrieval corpus has to be generated from the challenge-library source code,
  not from materialized dataset_v2 traces. The library produces deterministic
  seeded worlds, domain-specific entity attributes, computed question answers,
  traps, constraints, and modifier-derived temporal updates. Qrels are labeled
  at corpus-build time by the separately pinned labeling reranker.

## Recommended outcome

**`reject_current_data`**

Rationale:

Coordinator dataset_v2 captures challenge-attempt traces. It does not
contain (query, answer-bearing-document, hard-negatives, graded-qrels)
tuples in any single record category. Bridging would require synthesizing
qrels from a labeling reranker, lifting traps to hard negatives, and
inferring temporal current/stale annotations. The plan specifies that
under `reject_current_data`, the orchestrator generates a CoreTex
retrieval corpus from the challenge libraries and the labeling-model
pipeline (`scripts/generate-coretex-retrieval-corpus.mjs`).

## CoreTex corpus source decision

The launch corpus source is:

```
scripts/generate-coretex-retrieval-corpus.mjs --source challenge-library
```

This imports the built coordinator challenge package at
`/root/botcoin-coordinator-live/packages/challenges/dist/index.js` by default
and calls `generateInterchangeableChallenge` over
`(domain, seed, modifierCount, constraintDifficulty)`.

The old CoreTex template synthesizer remains only behind
`--source synthetic` for local fallback. It is not a production corpus source:
it emits thin lexical templates and does not provide durable difficulty
growth. Challenge-library expansion scales by appending new seeds, increasing
modifier counts, increasing constraint difficulty, and enabling new
domain-library JSON bundles without CoreTex source changes.
