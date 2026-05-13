# CoreTex Label-Reranker Correlation Investigation (2026-05-13)

## Task and finding under investigation

Task #16 investigated the prior FAIL in:

- `/var/lib/coretex/reports/label-reranker-correlation-smoke.json`

Prior failing signal (2026-05-10):

- `__truth_current mean = 7.442e-4`
- bottom aggregate (`trap`) mean = `8.064e-4`
- error: truth bucket not above bottom bucket

## Root-cause analysis

### 1) Prompt format mismatch confirmed

`scripts/reranker_runner.py` was not using the Qwen3-Reranker model-card prompt shape.

Patched runner now matches the documented template for:

- system instruction (`Judge whether the Document meets the requirements...`)
- user payload with `<Instruct>`, `<Query>`, `<Document>`
- assistant prelude with `<think> ... </think>` scaffold
- yes/no token ids resolved using `convert_tokens_to_ids("yes"|"no")`

Reference checked during investigation:

- [Qwen/Qwen3-Reranker-0.6B model card](https://huggingface.co/Qwen/Qwen3-Reranker-0.6B)

### 2) Re-run results after patch

Re-ran under constrained resources (`nice`, `ionice`, 4 threads).

#### A. Calibration corpus re-run

Output:

- `/var/lib/coretex/reports/label-reranker-correlation-1k-2026-05-13.json`

Observed:

- sample size = 245
- `__truth_current mean = 0.9040549695`
- `__truth_stale mean = 0.9999569189`
- `pass = true`, `errors = []`

Note: this calibration corpus sample only contained truth categories for this run (`__truth_current`, `__truth_stale`), so this run validates removal of the prior "truth below floor" failure but is not a full category-spread stress sample.

#### B. Prior failing smoke corpus re-run

Output:

- `/var/lib/coretex/reports/label-reranker-correlation-smoke-2026-05-13.json`

Observed:

- sample size = 200 (4 categories present)
- `__truth_current mean = 0.9164823514`
- `trap mean = 0.4320530251`
- `near_collision_entity mean = 0.4225616262`
- `pass = true`, `errors = []`

This directly clears the previously failing dataset/shape.

## Decision

- Prior FAIL is resolved after prompt-template alignment in `scripts/reranker_runner.py`.
- Root cause is implementation mismatch vs Qwen3 expected prompt structure, not launch-blocking model-quality collapse.
- Keep this as a resolved issue with follow-up monitoring in future correlation reports (especially when full category coverage is present).
