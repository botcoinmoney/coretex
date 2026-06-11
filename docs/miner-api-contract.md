# CoreTex Miner-Facing API Contract

Public contract a miner uses to construct valid, non-oracle patches without running the
full CoreTex stack.

Status note, reconciled 2026-06-06: CoreTex v16 is the launch posture. The
live `/coretex/status` is the source of truth for enabled surfaces and
allowed patch ranges; the v16 launch candidate includes temporal, relation,
evidence, conflict, abstention, and promoted validity/scope/entity atoms when
they are present in `activeSubstrateSurfaces`.

Validation gate: `scripts/miner-api-contract-gate.mjs` must be rerun against the
current launch profile, bundle, and corpus before signing.

Routes (`packages/cortex/src/coordinator/endpoints.ts`) — v0 canonical surface
(exactly 5; anything not in this list is removed from public v0):

| method | path | purpose |
|---|---|---|
| GET | `/coretex/health` | coordinator system health — version, epoch, chainId, confirmation depth, chain live root, confirmed live root, finality lag, epoch pins, `acceptingSubmissions`. No miner-specific data. |
| GET | `/coretex/status` | per-miner dynamic context (pass `?miner=0x…`): epoch/root pins, allowed patch types, thresholds, `nextIndex`, `lastReceiptHash`, `screenersThisEpoch`, `remaining`, and `cap`. |
| GET | `/coretex/substrate/:stateRoot` | full 1024-state-cell substrate state by root (off-chain by root). Only chain-confirmed roots are served. |
| POST | `/coretex/submit` | submit a patch (wire bytes + parentStateRoot + minerAddress). Returns either a signed receipt envelope or a rejection. |
| GET | `/coretex/receipt/:hash` | re-fetch a previously signed coordinator receipt + pre-encoded V4 transaction by patchHash. Works for BOTH the miner-submitted (original) hash AND the coordinator-rewritten signed hash. Returns `200` for pending/confirmed (envelope tagged with state), `409` + `PendingReceiptStale` for stale (no transaction handed back), `404 + "receipt expired"` once the receipt's `expiresAt` elapses. |

The following routes are NOT part of the v0 public surface and the gate
(`scripts/miner-api-contract-gate.mjs`) fails the build if they reappear:
`/coretex/challenge`, `/coretex/patch/:hash`, `/coretex/patch-received/:hash`,
`/coretex/eval-report/:hash`, `/coretex/corpus-delta/:epoch`,
`/coretex/bundle/:bundleHash`, `/coretex/bundle/by-core-version/:hash`.

## Status payload — MUST include (public only)

| field | meaning |
|---|---|
| `epochId` | current epoch |
| `currentStateRoot` | substrate root to patch against (keccak256 binary-Merkle over 1024 BE uint256 leaves). `stateRoot` is not a v0 alias. |
| `confirmedTransitionCount` | chain-confirmed CoreTex state-advance count for the current epoch. `transitionCount` is not a v0 alias. |
| `substrate.uri` | URL to fetch the full state by root; response carries `wordCount` 1024 and `packedHex`. `wordCount` is the protocol field name for state-cell count. |
| `bundleHash` / `coreVersionHash` | pins the exact scoring/controller/model behavior (see `bundle-attestation-smoke.mjs`) |
| `profileName` / `pipelineVersion` | e.g. `coretex-retrieval-v2-policy-r5` (selects r4 vs r5 atom interpretation) |
| `corpusRoot` + `corpusMeta` | Merkle commitment over validator production events, including hidden qrels and embedding bytes; miners receive only the root/hash metadata plus bi-encoder model id/revision |
| `activeFrontierRoot` | active-frontier root for the C3 launch frontier. Launch profiles should expose a non-null root; `null` / all-zero is only for smoke, disabled, or an explicitly churn-off deployment. |
| `allowedPatchTypes` + `patchWordRanges` | writable patch types and their state-cell index ranges, per active surface |
| `patchWordBudget` | max state cells per STATE_ADVANCE patch (**4**) |
| `minImprovementPpm` / `replayTolerancePpm` | acceptance floor + replay tolerance |
| `screenerThresholdPpm` | current dynamic screener threshold (from live baseline + noise floor; recomputes after baseline/churn/corpus/reranker changes) |
| `perMinerScreenerCap` | on-chain V4 `coreTexScreenerCapPerMinerPerEpoch` (default **50**, adjustable by owner/policyAdmin). Hard ceiling on SCREENER_PASS receipts per miner per epoch; persists across state advances within the epoch; STATE_ADVANCE receipts and standard-lane receipts are not counted. Receipts above the cap revert `CoreTexScreenerCapExceeded`. |
| `memoryIRSchemaVersion` | the fixed Memory-IR protocol grammar version (renderer is protocol-owned) |
| `activeSubstrateSurfaces` | the live earned surfaces from the status response. For v16 this must include the promoted atom surfaces when active: `validity_atom`, `scope_atom`, and `entity_resolution_atom`. |
| `exampleValidPatch` | a worked, structurally-valid patch encoding |
| `hiddenEvalWarning` | explicit notice that hidden qrels / eval pack / answer IDs / epochSecret are not public |

## Status payload — MUST NOT include

- hidden eval query-pack contents (the `events`/`pack`/`queries` arrays)
- hidden qrels, `truthDocuments`, `relevance`, answer IDs
- `epochSecret` before reveal, or the `evalSeed`/`hiddenPack` contents used to derive the pack
- per-query failure/success statistics (would create oracle behavior)

The gate enforces absence via a deep key scan (`qrel|truthdoc|hardnegativ|answer|epochsecret|evalseed|hiddenpack|truth|relevance|failurestat`) and asserts no pack/events array is embedded.

## Patch construction + error taxonomy

A miner builds a patch targeting an `allowedPatchType`'s `patchWordRange`, ≤ `patchWordBudget`
state cells, carrying the current `parentStateRoot`. Structural validation (stable codes, `state/types.ts`):

| code | name | cause |
|---|---|---|
| E01 | WRONG_PARENT_ROOT | patch.parentStateRoot ≠ current root |
| E02 | WRONG_TYPE_FIELD | index in reserved range, out of range, or type/range mismatch |
| E03 | OVER_BUDGET | wordCount > 4 |
| E04 | RESERVED_BIT_SET | resulting state sets a reserved bit |
| E05 | NOOP_PATCH | every new state-cell value equals the current value |

Acceptance (per-patch hidden eval): the patch is scored on a gate pack and a confirm pack
(domain-separated seeds derived from a post-submission blockhash + epochSecret); it advances
state only if BOTH packs clear `minImprovementPpm + variancePpm + replayTolerancePpm`. Seeds
do NOT include `minerAddress` — first submitter of a given `(parentRoot, patchBytes)` wins via
the dedup cache.

## On-chain protocol caps (V4 + Registry)

Two explicit on-chain rules a miner sees in addition to per-patch evaluation. Both are exposed in the
status payload (above) and queryable on-chain.

- **`coreTexScreenerCapPerMinerPerEpoch`** (V4, default **50**): per-miner, per-epoch hard cap on
  SCREENER_PASS receipts. Persists across state advances within an epoch — a state advance resets only
  the *global* `qualifiedScreenerPassesSinceLastStateAdvance` (which feeds the work-multiplier tier)
  but NOT a miner's per-epoch screener count. Exceeding reverts `CoreTexScreenerCapExceeded`.
- **No on-chain per-epoch state-advance cap** in the registry. State-advance scarcity is enforced
  by the coordinator's signing policy (every advance carries an EIP-712 receipt it must sign),
  the off-chain frontier (`epochFrontier.targetAccepts` / `maxRootDeltaPerEpoch` in the signed
  evaluator profile), and V4's per-advance work-multiplier tiers. Advances are also strictly
  serialized on-chain (parent must equal `liveStateRoot`), so at most one advance per block.

The state-advance work-multiplier tier (`30000/40000/60000/90000/120000` bps @ `0/25/100/250/500`
since-last-advance screeners, hard cap `300000` bps = 30x) is enforced on-chain in V4
(`computeCoreTexWorkUnitsBps`) and is the in-receipt economic control.

## Minimal worked examples

Generated + validated by `scripts/miner-patch-examples.mjs` (`--json` for full wire bytes). Each is
encoded from PUBLIC structure only, round-trips, validates, and applies onto genesis. These examples
prevent format-guessing; they are not all reward-active launch surfaces. Patch budget ≤ 4 state cells.

> **Patch type names below are off-chain SEMANTIC categories (`RELATION_UPDATE`,
> `POLICY_UPDATE`, …) that align with the on-chain wire byte.** The on-chain compact-patch
> encoding accepts byte values `0x01–0x07` (each scoped to a specific state-cell index range) plus
> `0xff` (universal/MIXED). `0x07` (POLICY_UPDATE) targets indices `384–671` (the three r5
> PolicyAtom regions: evidence-bundle 384–511, conflict 512–639, abstention 640–671). At
> wire-encoding time the on-chain byte is determined by the *state-cell index range* your patch
> writes into — read `allowedPatchTypes[*].byte` from the live `/coretex/status` and pick
> the byte whose `wordIndexRange` contains your write indices, or use `0xff` to bypass the
> per-type range check. The `(0xNN)` annotations in the section titles below ARE the wire
> byte you put at offset 0 of `patchBytes`.
>
> **MemoryIndex layout (launch substrate).** Cells `32–383` are 352 single-cell slots,
> stride-1 (one slot per cell, slotIndex `0..351`). Miners must target stride-1.

### 1. temporal / lifecycle  — `MIXED (0xFF)`, 3 state cells
- **Public data seen:** corpus doc IDs + temporal currency (which doc supersedes which); MemoryIndex slot layout.
- **Patch:** indices `[32, 33, 800]` = stale MemoryIndex slot (revoked) + current slot (valid) + a TemporalRecord linking them. `wire 0xff03…`, child root `0x04d107ad…`.
- **Forbidden:** pointing the record at qrel/answer doc IDs; > 4 state cells; any reserved-range index.
- **If it fires:** `temporalBonus` on the current doc; the stale doc's nDCG credit is dropped (temporalStaleContrast) and tracked in `temporalContrastRecall`.

### 2. relation-typed routing structural example — `RELATION_UPDATE (0x04)`, 1 state cell
- **Public data seen:** public relation graph (supports/causes/supersedes/…) + the query's parsed relation-intent.
- **Patch:** index `[799]` = one `supports` category-lens edge. `wire 0x0401…`.
- **Forbidden:** flooding all edge types; relying on the entity-only (untyped) selector; query→answer edges.
- **Current launch posture:** safe-but-not-active as a positive lift surface after 100k scale findings unless the live status response explicitly enables it.
- **If it fires:** `categoryLensBFS` admits the matched anchor reach; bounded by `policyMaxBudgetEvidence` (beta 0.25).

### 3. evidence_bundle bootstrap structural example — `MIXED (0xFF)`, 2 state cells
- **Public data seen:** the anchor MemoryIndex slot's public subject + public out-edges; the query's parsed relation intent + public subject grounding.
- **Patch:** one MemoryIndex policy anchor plus index `[384]` = evidence atom `selector=ANSWER_DENSITY, evidenceFeature=SUPPORT_IN_DEGREE, action=bundle, scope=relation_path, targetSlot=anchor`. If the anchor already exists, an atom-only update uses `POLICY_UPDATE`; bootstrapping anchor+atom uses `MIXED`.
- **Forbidden:** anchoring a generic/owner entity; budget over `policyMaxBudgetEvidence`; firing off-intent or cross-subject; reading qrels.
- **If it fires:** `policyAdmitted` via the evidence atom; query-local, subject-scoped, bounded by `policyMaxBudgetEvidence`.

### 4. conflict_state bootstrap structural example — `MIXED (0xFF)`, 2 state cells
- **Public data seen:** public `contradicts` / `scope_differs` edge DIRECTION (src = resolving/asserting doc, dst = contradicted candidate); the anchor MemoryIndex slot.
- **Patch:** one MemoryIndex policy anchor plus index `[512]` = conflict atom `selector=CONFLICT_SET_MEMBER, evidenceFeature=CONTRADICTS_EDGE, action=boost, scope=conflict_set, targetSlot=anchor`. Add a second atom `action=suppress` for the candidate. If the anchor already exists, an atom-only update uses `POLICY_UPDATE`; bootstrapping anchor+atom uses `MIXED`.
- **Forbidden:** using the corpus `lifecycleState` label or qrels (selector reads PUBLIC edge direction only); firing on non-conflict queries (the conflict-INTENT gate `policyConflictIntentAdmission` prevents off-family damage); wrong-direction (boost candidate) — provably HURTS.
- **Current launch posture:** safe-but-not-active as a positive lift surface after 300k scale findings unless the live status response explicitly enables it.
- **If it fires:** conflict-atom trace `boost@contradicts-src / suppress@contradicts-dst`, query-local (top-K gate), bounded `±budget/1000·spread`.

### 5. guarded abstention  — `POLICY_UPDATE (0x07)`, 1 state cell
- **Public data seen:** whether the query has ANY public evidence path (relation/support edge) to a candidate.
- **Patch:** index `[640]` = abstention atom `selector=MISSING_EVIDENCE, evidenceFeature=NO_PUBLIC_EVIDENCE_PATH, action=abstain, targetSlot=NONE, flags=REQUIRE_NO_EVIDENCE_PATH`. `wire 0x0701…`.
- **Forbidden:** `targetSlot` pointing at a real anchor (abstention uses `POLICY_TARGET_NONE`); abstaining on answerable queries — the OPERATOR top1 gate prevents it; the miner cannot force abstention alone.
- **If it fires:** abstention trace fires only when the miner selector matches AND the operator top1 gate trips. The older top1+margin operating point is archived; production-scale findings support top1-only as the launch posture.
