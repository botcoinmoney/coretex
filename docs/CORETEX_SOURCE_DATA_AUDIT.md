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
- A retrieval corpus would have to be generated from challenge libraries (synthetic) and the document/trap pool, with qrels labeled by a separately pinned reranker at corpus-build time.

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
