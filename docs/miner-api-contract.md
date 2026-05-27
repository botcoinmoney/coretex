# CoreTex Miner-Facing API Contract

Public contract a miner uses to construct valid, non-oracle patches without running the
full CoreTex stack. Validated by `scripts/miner-api-contract-gate.mjs` (route handler +
payload contract) against the launch profile + candidate bundle + dgen1-r5-synth corpus.

Routes (`packages/cortex/src/coordinator/endpoints.ts`):

| method | path | purpose |
|---|---|---|
| GET | `/coretex/challenge` | the public challenge payload (below) |
| POST | `/coretex/submit` | submit a patch (wire bytes + parentStateRoot + minerAddress) |
| GET | `/coretex/status` | epoch + difficulty status |
| GET | `/coretex/substrate/:stateRoot` | full 1024-word state by root (off-chain by root) |
| GET | `/coretex/patch/:hash` | patch bytes by patchHash |
| GET | `/coretex/patch-received/:hash` | PatchReceivedNotice (anti-delay witness) |
| GET | `/coretex/eval-report/:hash` | post-reveal eval report for replay |
| GET | `/coretex/corpus-delta/:epoch` | corpus growth delta |
| GET | `/coretex/bundle/:bundleHash` / `/coretex/bundle/by-core-version/:hash` | bundle manifest |
| GET | `/coretex/health` | liveness |

## Challenge payload — MUST include (public only)

| field | meaning |
|---|---|
| `epochId` | current epoch |
| `parentStateRoot` / `currentStateRoot` | substrate root to patch against (keccak256 binary-Merkle over 1024 BE uint256 leaves) |
| `substrateAccess.byRoot` | URL to fetch the full state by root; `wordCount` 1024, `packedBytes` 32768 |
| `bundleHash` / `coreVersionHash` | pins the exact scoring/controller/model behavior (see `bundle-attestation-smoke.mjs`) |
| `profileName` / `pipelineVersion` | e.g. `coretex-retrieval-v2-policy-r5` (selects r4 vs r5 atom interpretation) |
| `corpusRoot` + `corpusMeta` | Merkle commitment over durable event primitives only (NOT qrels); bi-encoder model id/revision |
| `activeFrontierRoot` | active-frontier root if churn is on (default **null** at launch — churn off) |
| `allowedPatchTypes` + `patchWordRanges` | writable patch types and their word-index ranges, per active surface |
| `patchWordBudget` | max words per STATE_ADVANCE patch (**4**) |
| `minImprovementPpm` / `replayTolerancePpm` | acceptance floor + replay tolerance |
| `screenerThresholdPpm` | current dynamic screener threshold (from live baseline + noise) |
| `perMinerCap` | per-epoch admission cap |
| `memoryIRSchemaVersion` | the fixed Memory-IR protocol grammar version (renderer is protocol-owned) |
| `activeSubstrateSurfaces` | the live earned surfaces: `temporal`, `relation_typed_routing`, `evidence_bundle`, `guarded_abstention` (+ `conflict_state` only when enabled) |
| `exampleValidPatch` | a worked, structurally-valid patch encoding |
| `hiddenEvalWarning` | explicit notice that hidden qrels / eval pack / answer IDs / epochSecret are not public |

## Challenge payload — MUST NOT include

- hidden eval query-pack contents (the `events`/`pack`/`queries` arrays)
- hidden qrels, `truthDocuments`, `relevance`, answer IDs
- `epochSecret` before reveal, or the `evalSeed`/`hiddenPack` contents used to derive the pack
- per-query failure/success statistics (would create oracle behavior)

The gate enforces absence via a deep key scan (`qrel|truthdoc|hardnegativ|answer|epochsecret|evalseed|hiddenpack|truth|relevance|failurestat`) and asserts no pack/events array is embedded.

## Patch construction + error taxonomy

A miner builds a patch targeting an `allowedPatchType`'s `patchWordRange`, ≤ `patchWordBudget`
words, carrying the current `parentStateRoot`. Structural validation (stable codes, `state/types.ts`):

| code | name | cause |
|---|---|---|
| E01 | WRONG_PARENT_ROOT | patch.parentStateRoot ≠ current root |
| E02 | WRONG_TYPE_FIELD | index in reserved range, out of range, or type/range mismatch |
| E03 | OVER_BUDGET | wordCount > 4 |
| E04 | RESERVED_BIT_SET | resulting state sets a reserved bit |
| E05 | NOOP_PATCH | every new word equals the current word |

Acceptance (per-patch hidden eval): the patch is scored on a gate pack and a confirm pack
(domain-separated seeds derived from a post-submission blockhash + epochSecret); it advances
state only if BOTH packs clear `minImprovementPpm + variancePpm + replayTolerancePpm`. Seeds
do NOT include `minerAddress` — first submitter of a given `(parentRoot, patchBytes)` wins via
the dedup cache.

## Minimal worked examples (per launch surface)

Generated + validated by `scripts/miner-patch-examples.mjs` (`--json` for full wire bytes). Each is
encoded from PUBLIC structure only, round-trips, validates, and applies onto genesis. A deeper miner
guide will live in a canonical skill file; these prevent format-guessing. Patch budget ≤ 4 words.

### 1. temporal / lifecycle  — `MIXED (0xFF)`, 3 words
- **Public data seen:** corpus doc IDs + temporal currency (which doc supersedes which); MemoryIndex slot layout.
- **Patch:** indices `[32, 33, 800]` = stale MemoryIndex slot (revoked) + current slot (valid) + a TemporalRecord linking them. `wire 0xff03…`, child root `0x04d107ad…`.
- **Forbidden:** pointing the record at qrel/answer doc IDs; > 4 words; any reserved-range index.
- **If it fires:** `temporalBonus` on the current doc; the stale doc's nDCG credit is dropped (temporalStaleContrast) and tracked in `temporalContrastRecall`.

### 2. relation-typed routing  — `RELATION_UPDATE (0x04)`, 1 word
- **Public data seen:** public relation graph (supports/causes/supersedes/…) + the query's parsed relation-intent.
- **Patch:** index `[799]` = one `supports` category-lens edge. `wire 0x0401…`.
- **Forbidden:** flooding all edge types; relying on the entity-only (untyped) selector; query→answer edges.
- **If it fires:** `categoryLensBFS` admits the matched anchor reach; bounded by `policyMaxBudgetEvidence` (beta 0.25).

### 3. conflict_state (conflict_lifecycle)  — `POLICY_UPDATE (0x07)`, 1 word
- **Public data seen:** public `contradicts` / `scope_differs` edge DIRECTION (src = resolving/asserting doc, dst = contradicted candidate); the anchor MemoryIndex slot.
- **Patch:** index `[512]` = conflict atom `selector=CONFLICT_SET_MEMBER, evidenceFeature=CONTRADICTS_EDGE, action=boost, scope=conflict_set, targetSlot=anchor`. Add a second atom `action=suppress` for the candidate. `wire 0x0701…`.
- **Forbidden:** using the corpus `lifecycleState` label or qrels (selector reads PUBLIC edge direction only); firing on non-conflict queries (the conflict-INTENT gate `policyConflictIntentAdmission` prevents off-family damage); wrong-direction (boost candidate) — provably HURTS.
- **If it fires:** conflict-atom trace `boost@contradicts-src / suppress@contradicts-dst`, query-local (top-K gate), bounded `±budget/1000·spread`.

### 4. guarded abstention  — `POLICY_UPDATE (0x07)`, 1 word
- **Public data seen:** whether the query has ANY public evidence path (relation/support edge) to a candidate.
- **Patch:** index `[640]` = abstention atom `selector=MISSING_EVIDENCE, evidenceFeature=NO_PUBLIC_EVIDENCE_PATH, action=abstain, targetSlot=NONE, flags=REQUIRE_NO_EVIDENCE_PATH`. `wire 0x0701…`.
- **Forbidden:** `targetSlot` pointing at a real anchor (abstention uses `POLICY_TARGET_NONE`); abstaining on answerable queries — the OPERATOR gate (top1 < 0.9995 AND top1-top2 margin < 0.0003) prevents it; the miner cannot force abstention alone.
- **If it fires:** abstention trace fires only when the miner selector matches AND the operator top1+margin gate trips.
