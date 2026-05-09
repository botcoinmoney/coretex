# Coordinator S3 / DACR-LT-Training → CoreTex Corpus Mapping (v0)

**Status:** v0 production candidate. Pinned with the `dacr-bridge.ts` / `build-corpus-from-dacr.mjs` commit landing alongside this spec.

This spec defines the deterministic mapping from the Botcoin coordinator's published long-term training data (HuggingFace dataset `botcoinmoney/dacr-lt-training`, mirror of the `dataset/v2/*` S3 layout) into the §9 `ProductionCorpusEvent` schema CoreTex evaluates against.

The mapping is implemented in:

- `/root/cortex/packages/cortex/src/corpus/dacr-bridge.ts` (TS bridge)
- `/root/cortex/scripts/build-corpus-from-dacr.mjs` (Node corpus-builder)

The producer (coordinator) layout is implemented in:

- `/root/botcoin-coordinator-live/packages/coordinator/src/dataset-layout.ts`
- `/root/botcoin-coordinator-live/packages/coordinator/src/export-hf-dataset.ts`

## 1. Source schema

The HuggingFace dataset has four top-level prefixes (one per record category):

```
raw_attempts/{domain}/part-NNNNN.jsonl
sessions/{domain}/part-NNNNN.jsonl
pairs_sequential/{domain}/part-NNNNN.jsonl
pairs_bookend/{domain}/part-NNNNN.jsonl
manifest.json
README.md
```

Domains: `companies`, `computational_biology`, `quantum_physics`, `scrna_imputation`. New domains added by the coordinator are auto-included.

### 1.1 raw_attempt row

Top-level fields (flat — no `attempt.{}` wrapper):

```
challenge_id              0x-prefixed bytes32 hex string
challenge_seed            decimal-string (uint128-ish)
challenge_domain          ChallengeDomain enum
record_id                 storage-id of this attempt
document                  paragraph-numbered text
questions                 string[]
constraints               string[]
question_metadata         { answer_type, expected_path, ... }[]
trap_metadata             { worldSeed, traps: { wrong_value, correct_value, target_entity, attribute, derivation_role, wrong_paragraphs, correct_paragraph, path_a_derived, path_b_derived }[] }
submitted_answers         { qXX: { value, expected, correct, source } }
answer_verification       { correct: number, total: number, required: number,
                            passed_threshold: bool, per_question: { qXX: { ... correct: bool ... } } }
pass                      bool — true iff required questions all passed
reasoning_depth           { reasoning_depth_score: number in [0,1], ... }
trace_quality             { score: number in [0,1] } | null
miner_id                  0x-prefixed address
timestamp                 ISO-8601
storage_schema_version    int (currently 2)
dataset_namespace         "dataset/v2"
```

### 1.2 pairs_sequential row

```
pair_family               "session_revision" | …
pair_quality              { dataset_export_eligible: bool, rejection_reasons: string[] }
improvement_basis         string[] — e.g. ["more_constraints_passed", "terminal_pass"]
chosen                    { think, artifact, submitted_answers, answer_verification, pass, ... }
rejected                  { ... same shape ... }
```

The `chosen` / `rejected` pair captures a real (current truth, stale truth) example for a single challenge: a miner attempt was wrong (`rejected`), then revised to correct (`chosen`). Perfect for §9 temporal records.

### 1.3 pairs_bookend row

Same shape as `pairs_sequential` but with the rejected attempt being the *bookend* (first attempt) rather than a revision attempt. The bridge processes both pair types identically.

## 2. Target schema (§9 ProductionCorpusEvent)

```ts
interface ProductionCorpusEvent {
  readonly id: string;
  readonly family: 'near_collision' | 'temporal' | 'long_horizon';
  readonly taskType: string;
  readonly isProtected: boolean;
  readonly epochCommitted: number;
  readonly sourceRef: string;
  readonly queryText: string;
  readonly truthText: string;
  readonly isStaleTruth: boolean;
  readonly relevant: boolean;
  readonly distractors: readonly string[];
  readonly relations: readonly string[];
  readonly expectedStateRegions: readonly ('memory_index'|'retrieval_keys'|'relations'|'temporal'|'codebook')[];
  readonly validFromEpoch: number;
  readonly expiresAtEpoch: number;
  readonly noveltyBucket: 'low' | 'medium' | 'high';
  readonly hardnessSignal: number;
}
```

## 3. Mapping rules

### 3.1 raw_attempt → corpus event(s)

Emit zero events if `pass !== true`.

For each `(qKey, ver)` pair in `answer_verification.per_question` where `ver.correct === true`:

| Target field | Source |
|---|---|
| `id` | `dacr-${challenge_id.slice(2,14)}-${qKey}` |
| `family` | `routeDacrFamily(challenge_domain)` (see §3.3) |
| `taskType` | `${challenge_domain}:${qKey}` |
| `isProtected` | `false` |
| `epochCommitted` | bridge option `epochCommitted` |
| `sourceRef` | `dacr-lt-training:${challenge_domain}/${challenge_id}` |
| `queryText` | `questions[index of qKey - 1]` (qKey is 1-indexed) |
| `truthText` | `ver.expected ?? submitted_answers[qKey].expected` |
| `isStaleTruth` | `false` |
| `relevant` | `true` |
| `distractors` | up to `maxDistractors` from `trap_metadata.traps[i].{wrong_value, decoy, decoy_value, lure, lure_value, path_a_derived, path_b_derived}` plus the `submitted_answers[qKey].value` if it was wrong |
| `relations` | `[]` |
| `expectedStateRegions` | `defaultDacrRegions(family)` (see §3.4) |
| `validFromEpoch` | `epochCommitted` |
| `expiresAtEpoch` | `0` (no expiry) |
| `noveltyBucket` | bucketing of `sha256(challenge_seed:challenge_domain)[0:2]` mod 3 → `low|medium|high` |
| `hardnessSignal` | `0.6 * reasoning_depth.reasoning_depth_score + 0.4 * (1 - correct_count/total)` clamped to `[0, 1]` |

### 3.2 pairs_sequential → corpus event(s) (temporal)

Skip if `pair_quality.dataset_export_eligible !== true` or if either `chosen` or `rejected` is missing.

For each qKey where `chosen.answer_verification.per_question[qKey].correct === true` and `rejected.submitted_answers[qKey].value` differs from chosen's value:

Emit two events:

1. **Current truth** (`isStaleTruth: false`):
   - id: `dacr-pair-${challenge_id.slice(2,14)}-${qKey}-current`
   - family: `temporal`
   - truthText: chosen value
   - distractors: `[rejected.submitted_answers[qKey].value]`
   - relations: `["supersedes:dacr-pair-...-stale"]`
   - hardnessSignal: 0.7 (default for paired temporal)

2. **Stale truth** (`isStaleTruth: true`):
   - id: `dacr-pair-${challenge_id.slice(2,14)}-${qKey}-stale`
   - family: `temporal`
   - truthText: rejected value
   - distractors: `[chosen value]`
   - relations: `["superseded_by:dacr-pair-...-current"]`
   - expiresAtEpoch: epochCommitted (immediately stale)
   - hardnessSignal: 0.6

### 3.3 Domain → family routing (default heuristic)

| `challenge_domain` | Default family |
|---|---|
| `companies` | `near_collision` (entity-name lookup with similar tickers/founders) |
| `quantum_physics` | `near_collision` (similar code names like "Hastings Protocol" vs "Hastings Complex") |
| `computational_biology` | `long_horizon` (multi-paragraph reasoning) |
| `scrna_imputation` | `long_horizon` (multi-paragraph reasoning) |
| any other | `long_horizon` |

This is a heuristic. The coordinator team can override per-question by emitting an explicit `family` field on records, which the bridge will respect.

### 3.4 Family → expected_state_regions

| Family | Regions |
|---|---|
| `near_collision` | `['memory_index', 'retrieval_keys']` |
| `temporal` | `['memory_index', 'temporal']` |
| `long_horizon` | `['memory_index', 'retrieval_keys']` |

## 4. Admission policy

The default §9 admission policy applied after bridging:

| Rule | Default |
|---|---|
| `requireSourceProvenance` | true |
| `minDistractorsPerRecord` | 1 (relax to 2 for production) |
| `minHardnessSignal` | 0.05 |
| `allowedRegions` | all 5 |
| `perDomainCap` | 1500 (raise per quarter) |
| `totalCap` | 10000 (raise per quarter) |

Reject reasons surfaced for audit:

- `missing_source_provenance` — empty `sourceRef`
- `insufficient_distractors` — less than `minDistractorsPerRecord`
- `hardness_signal_too_low` — too easy to learn
- `no_allowed_state_region` — region tags don't overlap policy
- `per_domain_cap_exceeded` / `total_cap_exceeded`

## 5. Determinism guarantees

- The mapping is **pure**: same input row → same output event(s) bytewise.
- `noveltyBucket` and `hardnessSignal` are SHA-256-derived from stable fields (`challenge_seed`, `challenge_domain`, `reasoning_depth_score`, correctness fraction).
- `id` is derived from `challenge_id` + `qKey`, both stable across the dataset's lifetime.
- The corpus root computed by `computeProductionCorpusRoot` is the deterministic Merkle root of the canonical `(id, family, task, query, truth, is_stale, epoch_committed, source_ref)` tuple of each admitted event, sorted by `id`.

## 6. Forward compatibility

When the coordinator adds new domains or new record categories:

- New domain → bridge defaults to `long_horizon`. Add an explicit case in `routeDacrFamily` for production-quality routing.
- New record category → currently raw_attempts and pairs_sequential are processed; sessions and pairs_bookend are accepted by the script if listed but use the same per-attempt logic. Update `bridgeDacrBatch` to add custom handling.
- Schema-version bumps (`storage_schema_version`) → the bridge should reject `storage_schema_version > 2` until tested. Currently the bridge ignores unknown fields and is permissive — tighten in v1.

## 7. Reproducibility checklist

Producing a corpus is deterministic given:

- A pinned HuggingFace dataset commit (use `dataset_revision_hash` from manifest.json's `generated_at` snapshot)
- The exact bridge commit hash on this repo
- The `epochCommitted` and admission policy passed at build time

Production consumers MUST commit:

```
{
  "version": "coretex-dacr-v0",
  "source": "botcoinmoney/dacr-lt-training",
  "dataset_revision": "<HF git commit>",
  "bridge_commit": "<this repo commit>",
  "build_options": { "epochCommitted": ..., "admission_policy": {...} },
  "record_count": <n>,
  "experience_corpus_root": "0x...",
  "corpus_hash": "<sha256 over canonical-encoded items[]>"
}
```

## 8. Open items

- **Sessions and bookend pairs** are not yet bridged into events. The session-trajectory rows contain richer reasoning traces; they would map to long_horizon events with relations across the trajectory. Implement in v1.
- **Cross-domain distractors**: when trap_metadata is sparse, sample wrong answers from other miners' attempts on the same challenge_id. Requires the bridge to receive a richer batch.
- **Per-question family override**: the coordinator should expose `question_metadata[i].coretex_family` so the bridge doesn't have to heuristically route.
