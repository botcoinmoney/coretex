# CoreTex v4 Ongoing Audit

Audit notes for the orchestrator agent implementing the v4 production
upgrade. This file lives in the CoreTex repo (`/root/cortex/ongoing_audit.md`)
and is appended each wake cycle (~10 min). Findings flagged here should be
reviewed before the next checkpoint commit.

Auditor scope: correctness against the canonical plan, scoped to
`/root/cortex` only. The plan is the source for the rules being checked,
but the audit tracks no other repository — only commits, working-tree
changes, and file contents under `/root/cortex`.

## Repository baseline (audit start)

Captured 2026-05-08, before any orchestrator-driven changes land.

- HEAD: `a57e0eb` coretex: verify replay bundle provenance
  (was `81aac77` at audit start; commits since: `3882830`,
  `e551544`, `012d7e2`, `c59d5fe`, `3fe7776`, `a57e0eb`)
- Working tree: only `ongoing_audit.md` is dirty (auditor artifact).

### Layout snapshot

```
packages/
  cortex/            (TS substrate impl + simulate.ts regression harness)
  cortex-py/         (Python parity)
  cortex-handler/
  cortex-server/
specs/               (cortex_state_v0, cortex_schema_v0.json, packing_spec_v0,
                      merkleization_spec_v0, patch_format_v0)
docs/                (state-spec.md and supporting docs)
benchmark/fixtures/season1/coretex_season1_10000.json   (10k synthetic, scale-only)
scripts/             (generate-season1-corpus.mjs, season1-shard-smoke.mjs)
test/e2e/phase-7/    (run.mjs, season1-10k-shard-smoke)
ops/                 (production handoff docs)
```

## Audit checklist (each wake, scoped to /root/cortex)

For each wake the auditor:

1. Captures `git rev-parse HEAD`, `git log --oneline <prior>..HEAD`,
   `git status --short`, and `git diff --stat` against the working tree.
2. Reads the diff for each new commit and matches it to the plan slice
   the commit message claims (convention: `coretex: <slice>`).
3. Reads any dirty working-tree files end-to-end.
4. Verifies, against the plan:
   - Substrate stays 1024 uint256 words / 32 KB binary; no JSON or
     free-text state.
   - Patch wire stays 1-4 word compact patches with signed int64 score
     delta * 1e6 (ppm), parent root bound.
   - TS/Python parity gate stays green; no forks of substrate logic.
   - No new "DA artifacts" subsystem; replay assets live in the CoreTex
     client bundle (substrate decoder, corpus, model manifest, evaluator,
     replay CLI, hashes).
   - Reranker manifest pins Qwen3-Reranker-0.6B (or pinned
     MemReranker-0.6B) with deterministic fetch/install + hashes.
   - Corpus structure follows the section 9 record schema (provenance,
     hard negatives, expected_state_regions, temporal labels).
   - Synthetic Season 1 fixture stays demoted to scale/plumbing only;
     not used as reward law.
   - `packages/cortex/src/simulate.ts` keeps its "not real benchmark"
     warning; not promoted to production reward path.
   - No retired files re-appear (per plan §15:
     `ORGANISM_CORTEX_STATE_PLAN.md`).
   - Naming uses CoreTex for product/docs; lowercase `cortex` only for
     real paths/identifiers (`/root/cortex`, `packages/cortex`,
     `cortex_schema_v0.json`, `coretex-replay`, `CortexState`).
   - No secrets in commits: `.env`, private keys, seed phrases, API
     tokens, authenticated RPC URLs, signing keys, private logs,
     unlicensed datasets/model weights.
   - Commits are small, named per `coretex: <slice>` convention.
5. Records concrete file:line citations for any deviation.

The auditor does NOT touch `/root/botcoin` or any other repo. It does
NOT run the full test suite — only structural/lint-level checks if a
file changed (e.g., parity gate script, JSON schema validation). The
orchestrator owns full test runs.

## Findings

### Wake 0 (2026-05-08, baseline)

No findings yet. Auditor primed and scheduled.

Risks to watch on next wake:
- A bps -> ppm migration in `/root/botcoin` reward-lane code may pull
  in renamed score fields here too (e.g., patch wire constants in
  `packages/cortex/src/state/`); confirm parity tests still cover
  the rename if it lands.
- The Season 1 fixture is currently the only corpus checked in; any
  edit that promotes it to "production reward law" instead of
  scale-plumbing is a finding.
- `simulate.ts` should not start being called from a real evaluator
  path; only from regression harnesses.
- New top-level subsystem directories (e.g., `da-artifacts/`,
  `validators/`, regional pools) would all be plan §14 violations.

### Wake 1 (2026-05-08 23:14)

HEAD unchanged: still `81aac77`. Orchestrator has not committed yet
since baseline — all activity is in the working tree.

Working tree changes since baseline:

```
M  .gitignore  (+14)
D  ORGANISM_CORTEX_STATE_PLAN.md   (-751)   ← plan §15 cleanup ✓
M  README.md   (+88 -??)                    ← naming + DA-stance ✓
M  context.md  (-120 net)                   ← retired stale text ✓
M  instructions.md  (~50/50)                ← local-wiring + secret discipline ✓
D  ops/CORETEX_CORPUS_PRODUCTION_HANDOFF.md (-225)  ← plan §9 fold-in ✓
?? packages/cortex/src/bundle/index.ts      ← NEW client-bundle manifest module
?? packages/cortex/src/replay/v4.ts         ← NEW v4 transition replay module
```

Doc churn (README.md, context.md, instructions.md) all point at
`/root/botcoin/CORETEX_V4_PRODUCTION_PLAN.md` as authority and preserve:
- CoreTex/cortex naming discipline (instructions.md:21, README.md:11)
- "no DA-artifacts subsystem" stance (README.md:39, instructions.md:140)
- secret/never-commit list (instructions.md:114-123, README.md:67-76)
- pinned 0.6B reranker target (instructions.md:39, README.md:51)
No retired files reappear; the two deletions match plan §15 exactly.

#### Audit of `packages/cortex/src/bundle/index.ts` (263 lines)

Strong alignment with plan §11 (CoreTex client bundle):

- bundle/index.ts:40-45 enforces `wordCount: 1024` and
  `packedBytes: 32768` as literal types — substrate body invariant
  (plan §0) cannot drift from this manifest schema.
- bundle/index.ts:31 `scoreScale: 'ppm'` — locks the bundle to the
  ppm wire (plan §6). No bps anywhere in this file.
- bundle/index.ts:100-115 default profile family weights match plan §9
  composite weighting exactly (20/20/20/20/10/10).
- bundle/index.ts:106 `protectedRegressionVeto: true` honors plan §9
  hard veto.
- bundle/index.ts:117-127 `qwen3Reranker06BManifest` builds a Qwen3
  manifest with caller-pinned `revision`; bundle/index.ts:237-239
  rejects `revision === 'main'`. Honors plan §8 pinning intent.
- bundle/index.ts:155-162 `replay.commands` includes
  `coordinatorCacheOptional: true` constant — encodes plan §11
  "coordinator cache is a convenience, not a trust layer."
- bundle/index.ts:200-212 canonical JSON serializer is
  field-sorted; bundle hash via keccak256 over canonical JSON
  (bundle/index.ts:225-227). Reproducibility requirement (plan §11
  "current bundle hash matches `coreVersionHash`") is satisfied.
- bundle/index.ts:169-198 `verifyBundleManifest` rehashes every
  declared file and the manifest itself; tampering surfaces as
  errors per file. Matches plan §11 "tampered corpus/model/substrate
  data fails hash checks."

Tunable to flag (not a violation):
- bundle/index.ts:105 `replayTolerancePpm: 250`. Plan §8 mandates
  "score replay within defined tolerance" but does not pin the
  number. 250 ppm = 0.025%, vs plan §7 `MIN_IMPROVEMENT_PPM = 2_500`
  (0.25%) — i.e., tolerance is 10× tighter than the minimum
  improvement, leaving headroom. Sane default; should be revisited
  once the production corpus + 0.6B model are pinned and a stability
  sweep exists. Mark as "needs corpus-grounded calibration."

#### Audit of `packages/cortex/src/replay/v4.ts` (226 lines)

Strong alignment with plan §6 / §11 replay surface:

- replay/v4.ts:65-68 event topic constants:
  `CoretexPatchBytes(uint64,address,bytes32,bytes32,bytes)` and
  `CortexStateAdvanced(uint64,uint64,bytes32,bytes32,bytes32,bytes32,uint16)`.
  Matches plan §6 "emit compact patch bytes, or emit enough
  transition words to reconstruct the compact patch from chain events."
- replay/v4.ts:85-88 `PATCH_HASH_MISMATCH` enforces
  `keccak256(compactPatchBytes) == patchHash` AND
  `patchHash == advance.patchHash` — plan §6 receipt invariant.
- replay/v4.ts:91-94 `PATCH_PARENT_MISMATCH` enforces "compact patch
  parent root equals receipt parent root" (plan §6).
- replay/v4.ts:96-103 `STATE_PARENT_MISMATCH` reproduces parent
  state body via `merkleizeState` and compares to advance event —
  catches stale-root replay attempts (plan §5 "stale-root
  transactions revert with `CortexStateRootMismatch`" mirror).
- replay/v4.ts:108-115 `NEW_ROOT_MISMATCH` reapplies patch and
  re-merkleizes — proves the on-chain advance is actually the
  declared compact patch's effect (plan §11 "replay disagreement is
  loud and deterministic").
- replay/v4.ts:133-137 `loadPackedState` rejects packed states that
  aren't 32768 bytes — substrate body invariant (plan §0).

Findings (not blocking):

1. replay/v4.ts:84 — fallback `patches[patches.length - 1]` after
   `find` miss. Functionally safe because the next check at
   replay/v4.ts:86 will fail with `PATCH_HASH_MISMATCH`, but the
   error message in that path will refer to the wrong patch event.
   A clearer error code (`NO_MATCHING_PATCH_EVENT_FOR_ADVANCE`)
   would aid replay disagreement diagnostics. **Suggest fix**.

2. replay/v4.ts:139-151 `decodeCoretexPatchBytesLog` assumes the
   ABI-encoded data layout is `(bytes32 receiptHash, bytes
   compactPatchBytes)`. Reads offset at byte 32, then length at
   `offset` and bytes at `offset + 32`. This matches Solidity ABI
   encoding when `receiptHash` is the first non-indexed param and
   `compactPatchBytes` is the second. **Action**: verify the
   on-chain V4 contract emits the event with `receiptHash` as
   the first non-indexed arg before this gets shipped — if the
   contract reorders, this decoder silently mis-parses. Track
   alongside the V4 contract event-emission slice when it lands.

3. The bundle/index.ts:156-160 replay command examples use
   `--parent-state <state.bin>`, which requires the operator to
   keep a packed substrate file. The bundle itself doesn't promise
   to ship "current and historical substrate snapshots needed to
   bootstrap replay" (plan §11). Either the bundle should declare
   a `snapshots/` directory with packed-state hashes in the
   manifest, or the replay CLI should accept a `--from-snapshot`
   pointer to such bundle entries. **Suggest** extending the
   bundle manifest with a `snapshots: BundleFile[]` field and
   matching CLI flag in the next slice.

#### Forge build

Skipped: no `.sol` files under /root/cortex; this repo has no Solidity.

#### Commit hygiene

No commits since baseline. Per plan repository discipline ("Commit
and push to the private CoreTex repo constantly at coherent
checkpoints"), the bundle + replay slice should checkpoint as soon
as the new modules have a green TS build / parity test pass. Flag
to orchestrator: don't let bundle/replay code accumulate uncommitted
across multiple wakes.

### Wake 2 (2026-05-08 23:27)

HEAD unchanged: still `81aac77`. Working tree expanded — orchestrator
landed the replay CLI, the bundle-manifest CLI subcommand, and unit
tests for both new modules.

New since wake 1:

```
?? packages/cortex/src/replay-cli.ts            (80 lines, new)
?? packages/cortex/test/unit/bundle.test.mjs    (49 lines, new)
?? packages/cortex/test/unit/replay-v4.test.mjs (132 lines, new)
M  packages/cortex/package.json                 (+1: coretex-replay bin)
M  packages/cortex/src/cli.ts                   (+39: bundle-manifest subcmd + flag helpers)
M  packages/cortex/src/index.ts                 (+2: re-export bundle + replay/v4)
```

#### Audit of `packages/cortex/src/replay-cli.ts`

Strong alignment with plan §11 user-story commands:

- replay-cli.ts:46-54 implements `coretex-replay tx --tx <hash> --rpc <url> --parent-state <file>`
  with optional `--logs` for offline replay. Matches plan §11 example.
- replay-cli.ts:56-62 implements `coretex-replay current --events <file>
  --parent-state <file>` for replaying from a captured event dump.
  Matches plan §11 example.
- replay-cli.ts:44 `loadPackedState` enforces 32768-byte packed
  substrate (replay/v4.ts:135) — substrate body invariant preserved
  at the CLI boundary.
- replay-cli.ts:50-60, 70 `process.exit(1)` on `result.ok === false`
  — replay disagreement is loud (plan §8 / §11).

Findings:

1. replay-cli.ts:64-73 — `watch` is a **single-shot** range query, not
   an actual continuous watch. Plan §11 expects "auto-detect new
   on-chain state changes, reconstruct/apply patch events, use the
   installed bundle data, and report whether the state advance
   improved." Today's implementation runs one `eth_getLogs` from
   `--from-block` (default `latest`) to `--to-block` (default
   `latest`) and exits. **Suggest** a polling loop with
   `--poll-interval` and a tracked highest-block cursor, or
   `eth_subscribe`-via-WebSocket if the installed RPC supports it.
   Track this as a wake-1-style follow-up; it's an incomplete
   implementation rather than a regression.

2. replay-cli.ts:35-77 — no `--bundle-hash` (or `--core-version-hash`)
   flag to cross-check that the supplied `--parent-state` file came
   from an installed CoreTex bundle whose hash matches the on-chain
   `coreVersionHash`/policy metadata at the parent root. Plan §11
   says "current bundle hash matches `coreVersionHash`/policy
   metadata" and "tampered corpus/model/substrate data fails hash
   checks." Right now the parent-state bytes are trusted by content,
   not by provenance. **Suggest** an optional `--bundle-manifest
   <path>` flag that loads a CoreTex bundle manifest and asserts its
   `bundleHash` matches a passed-in `--expected-bundle-hash` (or
   reads it from chain via the V4 epoch metadata).

#### Audit of `packages/cortex/test/unit/bundle.test.mjs`

- bundle.test.mjs:14-35 builds a manifest and round-trips
  `verifyBundleManifest`; asserts deterministic schema, 1024-word
  invariant, 32768-byte packed body, Qwen3 model id, and bytes32
  bundle hash format. Strong coverage for plan §11 invariants.
- bundle.test.mjs:37-47 asserts that `revision === 'main'` is
  rejected by `buildBundleManifest`. Confirms plan §8 pinned-revision
  intent at the test layer.
- Imports from `dist/index.js` (bundle.test.mjs:9) — orchestrator
  must `npm run build` before `node --test`. This is convention here
  (existing tests follow same pattern); not a finding, just a note.

#### Audit of `packages/cortex/test/unit/replay-v4.test.mjs`

- replay-v4.test.mjs:42-90 builds a real patch via `encodePatch`,
  applies it, merkleizes parent + new state, constructs synthetic
  `CoretexPatchBytes` + `CortexStateAdvanced` log entries, and runs
  `replayV4TransitionFromLogs`. Asserts `scoreDeltaPpm === '5000'`
  and `wordCount === 1` — locks the ppm wire and 1-4 word patch
  invariant at the test layer (plan §6).
- replay-v4.test.mjs:92-130 tampers a single patch byte and asserts
  the replayer rejects with `PATCH_HASH_MISMATCH`. Plan §6 receipt
  invariant covered.
- replay-v4.test.mjs:60-68, 71-82 — the synthetic log fixture lays
  out `CoretexPatchBytes.data = [receiptHash(32) | offset(32) |
  length(32) | patchBytes(padded)]` and `CortexStateAdvanced.data =
  [parent(32) | newRoot(32) | patchHash(32) | artifactHash(32) |
  wordCount(32)]`. This is internally consistent with the decoder
  (replay/v4.ts:139-165). **Open dependency** (carried from wake 1
  finding 2): the actual V4 Solidity event-emit slice must place
  `receiptHash` as the first non-indexed param of `CoretexPatchBytes`
  and the five fields above in order for `CortexStateAdvanced`.
  When that contract slice lands, run an integration check against
  these decoder offsets.

#### Audit of `packages/cortex/src/cli.ts` diff

- cli.ts:38-43 imports the new bundle helpers. cli.ts:329-348 adds
  `bundle-manifest build` and `bundle-manifest verify` subcommands
  with deterministic JSON output. Verify path exits 1 on errors.
  Operationally clean wiring of the new module into the existing
  CLI.
- cli.ts:355-361 introduces `flagValue` / `requireFlag` helpers.
  Naming overlaps stylistically with replay-cli.ts's `opt` /
  `required` (replay-cli.ts:17-24). Two CLIs in the same package
  with different helper names is a minor style drift — not a
  finding, but the orchestrator might consolidate later.

#### Audit of `packages/cortex/src/index.ts` diff

- index.ts:17-18 re-exports both `bundle/index.js` and `replay/v4.js`.
  Intentional: tests + CLI consume via the package barrel. No public
  API leakage of internal helpers (the bundle/replay modules
  themselves are well-scoped).

#### Cross-cutting: still no commits

Working tree has now accumulated five-plus coherent slices since
baseline (`81aac77`):
- doc cleanup and naming discipline
- bundle manifest module
- replay module
- replay-cli + bundle-manifest CLI subcommand
- unit tests for bundle and replay

Plan repository discipline says "Commit and push to the private
CoreTex repo constantly at coherent checkpoints." The orchestrator
should checkpoint NOW — at minimum split into a `coretex: doc
cleanup`, `coretex: client-bundle manifest`, `coretex: v4 replay
module + cli`, `coretex: unit tests for bundle and replay` series.
Letting a slice this large stay uncommitted across multiple wakes
risks a bisect blind spot if any later change breaks parity tests.

#### Forge build

Skipped: no `.sol` files under /root/cortex.

#### Structural check

Did not run `tsc` / `node --test` — those require the orchestrator's
build step and are explicitly outside the auditor's scope. The TS
modules import each other consistently (no obvious cycle), the
`dist/index.js` import path used by tests matches `package.json`
`main` (`dist/index.js`).

### Wake 3 (2026-05-08 23:29)

HEAD advanced to `012d7e2`. Three commits since baseline `81aac77`:

```
3882830 coretex: refresh production repo guidance
e551544 coretex: add v4 client bundle replay tooling
012d7e2 coretex: add deterministic corpus evaluator
```

Working tree adds (uncommitted):

```
?? packages/cortex/src/coordinator/endpoints.ts
?? packages/cortex/test/unit/coordinator-endpoints.test.mjs
M  packages/cortex/src/index.ts                 (+1: re-export coordinator/endpoints)
```

#### Commit `3882830` — production repo guidance

Matches plan §15 cleanup: deletes `ORGANISM_CORTEX_STATE_PLAN.md`
(751 lines) and `ops/CORETEX_CORPUS_PRODUCTION_HANDOFF.md` (225
lines), refreshes `README.md`, `instructions.md`, `.gitignore`.
Also commits `ongoing_audit.md` itself (376 lines as of wake 2) —
intentional, this file is now part of the repo handoff. Note:
`context.md` rewrite landed in the *next* commit, not this one;
not a finding, just an order observation.

#### Commit `e551544` — v4 client bundle replay tooling

This commit incorporated three of my prior findings:

- ✅ **Wake 1 #1 RESOLVED**: `replay/v4.ts:55` adds
  `'NO_MATCHING_PATCH_EVENT_FOR_ADVANCE'` to the error-code union;
  `replay/v4.ts:101-108` returns it explicitly when no patch event
  matches the advance event's patchHash, replacing the old fallback
  that quietly used the wrong event.
- ✅ **Wake 1 #3 RESOLVED**: `bundle/index.ts:58` adds
  `snapshots: readonly BundleFile[]` to the manifest type;
  `bundle/index.ts:72` adds `snapshotFiles?: readonly string[]` to
  `BuildBundleManifestOptions`; `bundle/index.ts:165` builds them;
  `bundle/index.ts:186` includes them in `verifyBundleManifest`.
  Bundle now declares packed-state snapshots needed for replay
  bootstrap (plan §11).
- ✅ **Wake 2 #1 RESOLVED**: `replay-cli.ts:86-108` replaces the
  single-shot watch with a polling loop. New flags
  `--poll-interval-ms` (default 12 s), `--once`, `--cortex-state`.
  Tracks block cursor, advances forward, reuses
  `replayV4TransitionsFromLogs` (new batch helper at
  `replay/v4.ts:157-186`) so that consecutive transitions in one
  poll window apply in order with intermediate state advance.
  This is the plan §11 auto-detect behavior.

Other notes on this commit:

- New batch helper `replayV4TransitionsFromLogs` (`replay/v4.ts:157-186`)
  walks ordered advance events, reapplies each with its matching
  patch event, and returns the final packed state. Required for
  the polling watch loop to be correct across multi-advance windows.
- `bundle/index.ts:96-101` `DEFAULT_EVALUATOR_FILES` now includes
  `eval/index.ts`, `eval/corpus.ts`, `replay/v4.ts`, `replay-cli.ts`
  — bundle hash now binds the evaluator/replay surface area, so
  any drift in those files invalidates the bundle hash deterministically.

Carry-forward open findings:

- 🟡 **Wake 1 #2 STILL OPEN**: `replay/v4.ts:194-220` ABI decoder
  still assumes `CoretexPatchBytes(... bytes32 receiptHash, bytes
  compactPatchBytes)` and `CortexStateAdvanced(... bytes32 parent,
  bytes32 newRoot, bytes32 patchHash, bytes32 artifactHash, uint16
  wordCount)`. The replay-v4 unit test at lines 60-83 confirms this
  is internally consistent with the encoder, but the V4 Solidity
  contract is not in this repo — must be cross-checked when the
  contract emit slice lands. The auditor cannot verify this from
  /root/cortex alone.
- 🟡 **Wake 2 #2 STILL OPEN**: `replay-cli.ts:56-108` — no
  `--bundle-hash` / `--core-version-hash` provenance flag. Parent
  state and bundle metadata are still trusted by content. Suggest
  adding `--bundle-manifest <path> --expected-bundle-hash <0x...>`
  that asserts manifest's `bundleHash` matches the on-chain
  `coreVersionHash` for the parent root.

#### Commit `012d7e2` — deterministic corpus evaluator

`packages/cortex/src/eval/corpus.ts` (321 lines) implements plan §8
`scoreProductionState` with three families and reads three
substrate regions:

- `corpus.ts:124-133` reads MemoryIndex shards at words
  `32 + s*8` for `s in [0, 44)` — correct per substrate region map.
- `corpus.ts:135-143` reads RetrievalKeys shards at words
  `384 + s*8` for `s in [0, 36)` — correct per region map.
- `corpus.ts:146-148` reads Relations region at words `[672..799]`
  — matches plan §9 substrate-region mention.
- `corpus.ts:281-285` deterministic shard selection via
  `sha256(${shardId}:${event.id})` — replay determinism (plan §8
  "same query pack" / "same evaluator code hash").
- `corpus.ts:75-114` `loadProductionCorpus` rejects mismatched
  `corpus_hash` (line 86-87) and mismatched `experience_corpus_root`
  (line 100-102). Matches plan §11 "tampered corpus/model/substrate
  data fails hash checks."
- `corpus.ts:48-73` `ProductionCorpusLoader` integrates as a
  `CorpusLoader` (existing shape), so the legacy eval pipeline can
  consume the new scorer.

🔴 **NEW FINDING — composite-weight inconsistency**:

`corpus.ts:166-172` composite formula:

```
0.30 * exactRetrieval         // near_collision family
+ 0.15 * staleMemoryRejection // temporal stale
+ 0.15 * temporalUpdateCorrectness // temporal current
+ 0.30 * compressionSurvival  // long_horizon family
+ 0.05 * routingAccuracy      // relations region
```

Sum = **0.95**, not 1.0. `clamp01` (corpus.ts:166, 311-313)
silently caps to 1.0 from above and 0 from below, but the composite
will never exceed 0.95 even on a perfect score. That alone is a
bug — a "perfect" production state is mathematically capped at 95%.

Compare against:

- **plan §9** intended weights: 20% near-collision retrieval,
  20% temporal current/stale, 20% long-horizon compression survival,
  20% relation/multi-hop routing, 10% codebook compression, 10%
  local model agreement. **Sum = 100%** across **6 categories**.
- **bundle/index.ts:110-117** `DEFAULT_PROFILE.familyWeights`
  matches the plan exactly: 20/20/20/20/10/10 across the same six
  categories.
- **corpus.ts:166-172** scorer implements **5 categories** (no
  codebook, no local-model-agreement) with 30/15/15/30/5
  weighting. Routing collapses from 20% → 5%; near-collision and
  long-horizon both get inflated to 30%; temporal split into
  stale+current at 15+15=30% (vs plan's 20% combined).

This is a substantive deviation. Two paths to reconcile:

1. **Implement to the plan**: extend `ProductionCorpusEvent` with
   codebook and local-model-agreement signals, reweight to
   20/20/20/20/10/10, and ensure the family list in
   `bundle/index.ts:110-117` is consumed by the scorer instead of
   being a decorative profile.
2. **Update the plan and the bundle**: if the launch surface is
   intentionally the 5-category 30/15/15/30/5 shape (because the
   substrate doesn't yet have a codebook region or local-model
   harness), update plan §9, drop codebook/local-model-agreement
   from `DEFAULT_PROFILE`, and renormalize to sum to 1.0.

Either way, the **bundle's declared profile must match the actual
scorer** so that bundle-hash drift catches changes to reward law.
Right now the bundle's family weights are decorative — the scorer
hardcodes its own. Flag to orchestrator: pick a path before the
next state-advance receipt is signed under this scorer.

Additional minor: `corpus.ts:165` defines a separate
`longHorizon = (compressionSurvival * 0.30 + routingAccuracy * 0.05) / 0.35`
just for the per-family score (not the composite). It's correct as
a normalized family score, but combined with the composite-weight
mismatch above it makes the relationship between family scores and
composite hard to reason about. Doc-level comment in source would
help future readers.

#### Working-tree slice — coordinator endpoints

`packages/cortex/src/coordinator/endpoints.ts` (148 lines) declares
the production CoreTex HTTP surface from plan §12. Strong:

- endpoints.ts:19-30 `CORETEX_ENDPOINTS` lists all ten plan §12
  endpoints with exact method+path. Test at
  `test/unit/coordinator-endpoints.test.mjs:11-22` asserts the list
  matches the plan order/wording exactly.
- endpoints.ts:57-124 `handleCoreTexCoordinatorRoute` returns
  `{handled: false}` for non-coretex paths
  (endpoints.ts:122-123) — additive integration with existing V3
  router (plan §12 "Existing V3 endpoints stay unchanged").
- endpoints.ts:130-132 `notConfigured` returns 503 for missing
  handlers — fail-closed for unwired routes.
- endpoints.ts:44-55 `CoreTexCoordinatorDataSource` is a fully
  injected interface — no signing keys live here. Honors plan §12
  "Coordinator remains the only receipt signer. The CoreTex
  evaluator must not hold signing keys."
- Tests cover happy path (substrate-current, substrate-by-root,
  patch-by-hash, screen/evaluate POST), the additive miss
  (`/v1/challenge` returns `{handled:false}`), and the fail-closed
  503 for an unconfigured handler.

Concerns (minor):

- endpoints.ts has no auth/rate-limit hook. Plan §12 says "Rate
  limiting and RPC guards modeled on current coordinator patterns" —
  appropriate that the host coordinator owns those, but a hook
  point on `CoreTexCoordinatorDataSource` (e.g.,
  `authorize?(req): boolean`) would make integration cleaner. Not
  a blocker; the host can wrap `handleCoreTexCoordinatorRoute`.
- endpoints.ts:64-66 `health` returns
  `{ ok: true, service: 'coretex' }` if no handler. That's a
  liveness check, not a readiness check — a real `health` should
  also verify that bundle/corpus paths are reachable. Suggest
  the host always supplies a `health` handler.
- The screen/evaluate routes accept any body shape. The receipt
  schema split between screener (plan §4 — base credits, no
  state mutation) and state-advance (plan §5 — full eval, full
  receipt) is enforced downstream by the coordinator's receipt
  signer, not here. That's correct given plan §12's "additive
  integration only" framing, but worth flagging that the cortex
  package could expose typed request/response schemas later.

#### Forge build

Skipped: still no `.sol` files under /root/cortex.

#### Commit hygiene

Three coherent checkpoints in 4 minutes — vastly improved cadence
over wakes 0–2. The doc cleanup, replay tooling, and corpus
evaluator are clean atomic slices. Coordinator slice should
checkpoint as `coretex: add coordinator endpoint contract` once it
stabilizes.

### Wake 4 (2026-05-08 23:41)

HEAD advanced to `c59d5fe`. One commit since wake 3:

```
c59d5fe coretex: add coordinator endpoint contract
```

Commit content (`git show --stat c59d5fe`): exactly the working-tree
slice audited in wake 3 — `packages/cortex/src/coordinator/endpoints.ts`
(+147), `packages/cortex/src/index.ts` (+1 re-export),
`packages/cortex/test/unit/coordinator-endpoints.test.mjs` (+86),
`context.md` (+3). Commit-message naming convention exactly matches
the suggestion logged in wake 3. No additional changes; wake 3's
coordinator-endpoint audit stands.

Carry-forward open findings (none resolved this wake):

- 🟡 Wake 1 #2: V4 ABI decoder cross-check still pending external
  contract slice (not in /root/cortex).
- 🟡 Wake 2 #2: replay-cli.ts still has no `--bundle-hash` /
  `--core-version-hash` provenance flag.
- 🔴 Wake 3 (TOP PRIORITY): `eval/corpus.ts:166-172` composite
  weighting still 0.95-cap and 5-category 30/15/15/30/5, while
  `bundle/index.ts:110-117` `DEFAULT_PROFILE.familyWeights` is
  6-category 20/20/20/20/10/10 per plan §9. Bundle profile remains
  decorative until reconciled. **No state-advance receipt should be
  signed under this scorer** without reconciling first.

Working tree only has `ongoing_audit.md` (auditor artifact, not
committed by orchestrator). No new files to audit.

#### Forge build

Skipped: still no `.sol` files under /root/cortex.

### Wake 5 (2026-05-08 23:43)

HEAD unchanged: still `c59d5fe`. No new commits.

Working tree changed since wake 4 — orchestrator re-ran the
synthetic-dryrun experiment + phase-3/phase-4 e2e suites on a
different host:

```
M  experiments/results/synthetic-dryrun/{A,B,C,D,E}.json
M  experiments/results/synthetic-dryrun/comparison.csv
M  experiments/results/synthetic-dryrun/comparison.md
M  experiments/results/synthetic-dryrun/golden-vectors.json
M  test/e2e/phase-3/fixtures/expected-hashes.json
M  test/e2e/phase-3/fixtures/perf-results.json
M  test/e2e/phase-4/run.mjs
```

#### Substrate determinism: PRESERVED

`comparison.md` shows identical final state roots for all five
baselines (A `0x755c8ee9...`, B `0xda712cc9...`, C `0x30ba3ec8...`,
D `0x46cbf055...`, E `0x613980c9...`). Net deltas, accept counts,
and Net Δ values are unchanged. `golden-vectors.json` content
(state roots, patch hashes, expected report hashes) unchanged
modulo `generatedAt`. ✅ Plan §0/§8 determinism preserved across
hosts.

Latencies updated (e.g. A p50 132.33 → 140.83 ms). Pure host noise,
not a finding.

#### `test/e2e/phase-4/run.mjs:270` deletion: SAFE

The removed line was `const { createHash } = require('node:crypto');`
inside a block scope. Module already does
`import { createHash, randomBytes } from 'node:crypto'` at line 25.
The deleted `require` was either dead-code shadow (best case) or
broken in the `.mjs` ES-module context (worst case). Removing it
is a legitimate cleanup. ✅

#### 🟡 Finding: Node version regressed in determinism fixtures

`test/e2e/phase-3/fixtures/expected-hashes.json:5` and
`test/e2e/phase-3/fixtures/perf-results.json:6` both now report
`"nodeVersion": "v20.18.2"` where they previously claimed
`"v22.22.2"`. The substrate determinism doesn't depend on Node
version (binary substrate is platform-independent), so the recorded
hashes still pass — but the fixtures are now retroactively
**describing a different baseline platform** than what they
documented before. Two concerns:

1. CI / future dev machines pinning to v22 will write back v22 next
   time these fixtures are regenerated, causing perpetual fixture
   churn. Suggest pinning a single CI-baseline Node version (the
   plan implicitly favors stability) or accepting `nodeVersion`
   as informational and not committing it (e.g. moving it to a
   `.gitignore`d local-info file or omitting from the schema).

2. perf-results.json:3-4 also moved p50 0.507 → 0.543 ms and p99
   0.872 → 0.920 ms. These are perf-baseline values; if a future
   regression check compares against committed baseline, this
   silently raises the bar.

Not a substrate/correctness issue — flag for orchestrator visibility.

#### Carry-forward open findings (none resolved this wake)

- 🟡 Wake 1 #2 OPEN: V4 ABI decoder cross-check pending external
  contract slice (not in /root/cortex).
- 🟡 Wake 2 #2 OPEN: replay-cli.ts has no `--bundle-hash` /
  `--core-version-hash` provenance flag.
- 🔴 Wake 3 OPEN (TOP PRIORITY): `eval/corpus.ts:166-172` composite
  weighting still 0.95-cap and 5-category 30/15/15/30/5; bundle
  declares 6-category 20/20/20/20/10/10. Bundle profile remains
  decorative until reconciled. **No state-advance receipt should be
  signed under this scorer** without reconciling first.

#### Forge build

Skipped: still no `.sol` files under /root/cortex.

#### Commit hygiene

Fixture-regeneration noise is dirty in working tree alongside
ongoing_audit.md. None of these changes should be committed
without reviewing whether the Node-version downgrade is intended.

### Wake 6 (2026-05-08 23:53)

HEAD unchanged: still `c59d5fe`. No new commits.

#### Wake 5 finding partially resolved

- 🟢 `test/e2e/phase-3/fixtures/expected-hashes.json` reverted —
  no longer in `git status`. Determinism fixture's
  `nodeVersion: v22.22.2` claim restored.
- 🟢 `test/e2e/phase-3/fixtures/perf-results.json:6` Node version
  also reverted to `v22.22.2`; only `p50ms` and `p99ms` keep
  drifting per host run (0.507→0.519ms, 0.872→0.982ms).

The Node-version regression has been rolled back. The remaining
perf-number drift in `perf-results.json` and the synthetic-dryrun
result JSONs is per-run host noise — still appearing in the dirty
working tree each wake but not impacting substrate determinism.

#### Substrate determinism still preserved

`comparison.md` final state roots unchanged across the latest
re-run (A `0x755c8ee9...`, B `0xda712cc9...`, etc.). Net deltas,
accept counts, winner unchanged. `golden-vectors.json` content
unchanged modulo `generatedAt`.

#### Observation: noisy per-run fixtures

`experiments/results/synthetic-dryrun/*.json`,
`experiments/results/synthetic-dryrun/comparison.{md,csv}`, and
`test/e2e/phase-3/fixtures/perf-results.json` regenerate on every
e2e run with new timestamps and per-host latencies. They have been
dirty in the working tree across multiple wakes without being
committed. **Suggest** to orchestrator:

1. Add latency/timestamp-only files to `.gitignore` so they don't
   stay perma-dirty, OR
2. Strip non-deterministic fields (timestamps, p50/p99) from
   committed files and only retain deterministic content (state
   roots, hashes, accept counts), OR
3. Commit a single representative baseline once and stop
   regenerating those files in the audit/test loop.

Not a blocker — just clutter that masks real diffs.

#### Carry-forward open findings (none resolved this wake)

- 🟡 Wake 1 #2 OPEN: V4 ABI decoder cross-check pending external
  contract.
- 🟡 Wake 2 #2 OPEN: replay-cli.ts has no `--bundle-hash` /
  `--core-version-hash` provenance flag.
- 🔴 Wake 3 OPEN (TOP PRIORITY): `eval/corpus.ts:166-172`
  composite weighting still 0.95-cap and 5-category 30/15/15/30/5;
  `bundle/index.ts:110-117` still declares 6-category
  20/20/20/20/10/10. **No state-advance receipt should be signed
  under this scorer** without reconciling first.

#### Forge build

Skipped: still no `.sol` files under /root/cortex.

---

(Subsequent wake entries will be appended below.)

### Orchestrator resolution (2026-05-08 23:50)

Reviewed Wake 3/Wake 6 TOP PRIORITY scorer-weight finding before the
next checkpoint. Resolved in the working tree before commit:

- `packages/cortex/src/eval/corpus.ts` now scores the production
  corpus against the launch profile declared in
  `packages/cortex/src/bundle/index.ts`: 20% near-collision
  retrieval, 20% temporal current/stale, 20% long-horizon
  compression, 20% relation/multi-hop routing, 10% codebook
  compression, and 10% local-model-agreement proxy.
- `packages/cortex/test/unit/eval.test.mjs` now includes a unit
  guard proving a complete structural state reaches composite `1`
  under the 20/20/20/20/10/10 profile.
- `test/e2e/phase-4/run.mjs` ESM cleanup was verified by the full
  Node 22 e2e pass.

Post-resolution verification:

```text
npm run build --workspace @botcoin/cortex
npm run test:unit --workspace @botcoin/cortex
npx -y node@22 scripts/run-e2e.mjs
```

All passed. Environment-gated Base/mainnet/testnet checks remained
skipped where the required env vars were absent.

Follow-up: Wake 2 #2 replay provenance finding was also resolved
after the scoring-profile checkpoint. `coretex-replay` now accepts
`--bundle-manifest <path>` with optional
`--expected-bundle-hash <0x...>` / `--core-version-hash <0x...>` and
fails before replay if the manifest files or bundle hash do not
verify.

### Wake 7 (2026-05-08 23:55)

HEAD advanced to `3fe7776 coretex: reconcile production scoring
profile`. Auditor confirms the orchestrator's resolution:

#### 🟢 Wake 3 RESOLVED — corpus weight reconciliation

Verified in committed `packages/cortex/src/eval/corpus.ts`:

- corpus.ts (composite): `0.20 * nearCollisionRetrieval + 0.20 *
  temporalCurrentStale + 0.20 * longHorizonCompression + 0.20 *
  relationMultiHop + 0.10 * codebookCompression + 0.10 *
  localModelAgreement`. **Sum = 1.00** ✅, six categories matching
  plan §9 and `bundle/index.ts:110-117` family weights exactly.
- corpus.ts (codebook reader): new loop reads
  `state.words[896 + slot * 2]` for `slot in [0, 48)` checking
  code, codeType ∈ {1,2}, and active flag — surfaces a Codebook
  region the previous scorer ignored.
- `packages/cortex/test/unit/eval.test.mjs` (new test): builds a
  fully-populated state across all six regions and asserts each
  component scores `1` and `composite === 1`. The unit guard now
  catches future weight drift.

Caveat (minor follow-up, not blocking): `localModelAgreement` is
the average of the other five components — a "self-agreement
proxy" rather than an actual local-0.6B-reranker output. Plan §9
intent is "local model no-regression / retrieval agreement: 10%"
where the local model produces its own ranking. The proxy is
weight-correct and unit-tested but should be re-wired to the real
0.6B reranker output when the model-runner slice lands. Track as
soft TODO.

#### 🟢 Wake 2 #2 RESOLVED (working tree, pending next commit)

Verified in working-tree `packages/cortex/src/replay-cli.ts`:

- replay-cli.ts:15 imports `verifyBundleManifest` and
  `CoreTexBundleManifest` from `./bundle/index.js`.
- replay-cli.ts:62 usage line now documents
  `--bundle-manifest manifest.json --expected-bundle-hash 0x...`.
- replay-cli.ts:67 calls `verifyBundleIfRequested(args)` immediately
  after `loadPackedState`, so any replay command (tx/current/watch)
  honors the provenance check.
- replay-cli.ts:116-128 `verifyBundleIfRequested` is no-op when
  `--bundle-manifest` is absent, otherwise calls
  `verifyBundleManifest`, additionally compares
  `manifest.bundleHash` against `--expected-bundle-hash` (or
  `--core-version-hash` alias), and dies with a combined error
  message on any mismatch.

This change lives in the working tree alongside the +1 line in
`context.md` documenting the new flag. Should checkpoint as
`coretex: add bundle hash provenance to replay cli` (or similar)
in the next commit.

#### 🟡 Wake 1 #2 STILL OPEN — V4 ABI decoder vs contract emit

`replay/v4.ts:194-220` decoder still depends on the V4 contract
emitting events with the assumed parameter ordering. This is
external to /root/cortex and remains pending the V4 contract emit
slice. The internal consistency between `decodeCoretexPatchBytesLog`
and the test fixture is verified, but the cross-check to actual
Solidity is out of audit scope from this repo alone.

#### Wake 5 finding fully resolved

`expected-hashes.json` and `perf-results.json` are no longer in the
dirty working tree at all. Synthetic-dryrun churn is also gone.
Wake 6's advisory about gitignoring those fixtures stands but is
moot for the current handoff.

#### Forge build

Skipped: still no `.sol` files under /root/cortex.

#### Summary

- 🟢 Wake 1 #1, Wake 1 #3, Wake 2 #1, Wake 2 #2, Wake 3, Wake 5
  RESOLVED.
- 🟡 Wake 1 #2 OPEN: pending external V4 contract emit slice.
- 🟢 New from this wake: bundle-hash provenance now wired into
  `coretex-replay` (working tree, pending commit).

This is a high-confidence checkpoint. The /root/cortex side of the
plan §11 client-bundle and replay surface is now self-consistent
end-to-end: bundle hash binds substrate decoder, corpus, evaluator,
replay code; scorer matches declared profile; replay can refuse to
run against an unverified bundle. Only external cross-check
remaining is the V4 contract emit shape.

### Wake 8 (2026-05-09 00:06)

HEAD advanced to `a57e0eb coretex: verify replay bundle provenance`.
One commit since wake 7, matches `git show --stat a57e0eb`:
`context.md +1`, `ongoing_audit.md +7`, `replay-cli.ts +20`. Exactly
the working-tree slice already audited in wake 7.

🟢 **Wake 2 #2 now formally committed** (was working-tree-only at
end of wake 7).

Working tree is clean except for `ongoing_audit.md` (auditor
artifact).

#### Outstanding

- 🟡 Wake 1 #2 OPEN: V4 ABI decoder cross-check still external to
  /root/cortex.
- 🟡 Wake 7 soft TODO: `eval/corpus.ts` `localModelAgreement`
  remains a self-agreement proxy; re-wire when the 0.6B model
  runner slice lands.

#### Forge build

Skipped: still no `.sol` files under /root/cortex.

### Wake 9 (2026-05-09 00:07)

No diffs since prior HEAD `a57e0eb`. Working tree clean except for
`ongoing_audit.md` (auditor artifact). Outstanding findings unchanged.

### Wake 10 (2026-05-09 00:17)

No diffs since prior HEAD `a57e0eb`. Outstanding findings unchanged.

### Wake 11 (2026-05-09 00:18)

No diffs since prior HEAD `a57e0eb`. Outstanding findings unchanged.

### Wake 12 (2026-05-09 00:28)

No diffs since prior HEAD `a57e0eb`. Outstanding findings unchanged.

### Wake 13 (2026-05-09 00:29)

No diffs since prior HEAD `a57e0eb`. Outstanding findings unchanged.

### Wake 14 (2026-05-09 00:39)

No diffs since prior HEAD `a57e0eb`. Outstanding findings unchanged.

### Wake 15 (2026-05-09 00:40)

No diffs since prior HEAD `a57e0eb`. Outstanding findings unchanged.

### Wake 16 (2026-05-09 00:50)

No diffs since prior HEAD `a57e0eb`. Outstanding findings unchanged.

### Wake 17 (2026-05-09 00:51)

No diffs since prior HEAD `a57e0eb`. Outstanding findings unchanged.

### Wake 18 (2026-05-09 01:01)

No diffs since prior HEAD `a57e0eb`. Outstanding findings unchanged.

### Wake 19 (2026-05-09 01:02)

No diffs since prior HEAD `a57e0eb`. Outstanding findings unchanged.

### Wake 20 (2026-05-09 01:12)

No diffs since prior HEAD `a57e0eb`. Outstanding findings unchanged.
Orchestrator has been idle for 13 wakes (~130 min) since the bundle
provenance commit. Auditor remains armed.

### Wake 21 (2026-05-09 01:13)

No diffs since prior HEAD `a57e0eb`. Outstanding findings unchanged.

### Wake 22 (2026-05-09 01:23)

No diffs since prior HEAD `a57e0eb`. Outstanding findings unchanged.

### Wake 23 (2026-05-09 01:24)

No diffs since prior HEAD `a57e0eb`. Outstanding findings unchanged.

### Wake 24 (2026-05-09 01:34)

No diffs since prior HEAD `a57e0eb`. Outstanding findings unchanged.

### Wake 25 (2026-05-09 01:35)

No diffs since prior HEAD `a57e0eb`. Outstanding findings unchanged.

### Wake 26 (2026-05-09 01:45)

No diffs since prior HEAD `a57e0eb`. Outstanding findings unchanged.

### Wake 27 (2026-05-09 01:46)

No diffs since prior HEAD `a57e0eb`. Outstanding findings unchanged.

### Wake 28 (2026-05-09 01:56)

No diffs since prior HEAD `a57e0eb`. Outstanding findings unchanged.

### Wake 29 (2026-05-09 01:57)

No diffs since prior HEAD `a57e0eb`. Outstanding findings unchanged.

### Wake 30 (2026-05-09 02:07)

No diffs since prior HEAD `a57e0eb`. Outstanding findings unchanged.

### Wake 31 (2026-05-09 02:08)

No diffs since prior HEAD `a57e0eb`. Outstanding findings unchanged.

---

## Orchestrator handoff round 2 (2026-05-09 ~04:00)

The auditor role is closed for this session. Audit hand-off note:
the orchestrator role was reassumed and the five highest-impact
gaps from Wake 7's checkpoint have now landed. New HEAD is at
`/root/cortex` master after these commits:

```
34d0e3d coretex: add qwen3 reranker eval path
7b45fd8 coretex: add difficulty calculator per plan §7
a5c3d17 coretex: add §9 corpus pipeline + V3 bridge
3693ba9 coretex: add phase-10 anvil full-flow e2e
```

And on `/root/botcoin` master:

```
c1bcada coretex: add e2e flow forge script
```

### Resolutions to outstanding audit findings

- 🟢 **Wake 7 soft TODO RESOLVED**: `localModelAgreement` proxy is
  superseded by a real Qwen3-Reranker-0.6B path
  (`eval/reranker.ts`). The proxy field in `eval/corpus.ts` stays
  for back-compat but the new reranker-based scorer
  (`evaluatePatchWithReranker`) is the production reward law.

- 🟡 **Wake 1 #2 STILL OPEN by design**: the V4 ABI decoder
  assumption is now exercised end-to-end against a real Anvil
  deploy of `/root/botcoin/contracts/BotcoinMiningV4.sol` in
  `test/e2e/phase-10/run.mjs`. Phase-10 PASSES, so the layout
  matches the contract emit. Cross-check is now empirically
  verified, not just internally consistent. The audit "open"
  status was about external code we hadn't tested against;
  that's no longer the case.

### New end-to-end proof

`node /root/cortex/test/e2e/phase-10/run.mjs` does, in one
command, the production-shaped sequence the plan §13 calls for:

1. spawn anvil
2. forge build (contracts) + npm build (cortex package)
3. deploy MockERC20 + CortexState + BotcoinMiningV4 in one
   broadcast
4. CortexState owner sets V4 as reward lane
5. Initialize + freeze a CortexState epoch with the JS-merkleized
   parent root
6. Mint + stake 10M botcoin to the miner (tier 1)
7. Build, EIP-712-sign, submit a SCREENER_PASS receipt — assert
   state unchanged + 100 credits earned
8. Build, sign, submit a STATE_ADVANCE receipt with a real
   KEY_UPDATE compact patch at word 384 — V4
   `_validateCompactPatch` validates patch hash, parent root,
   score delta. CortexState.acceptTransition emits
   CortexStateAdvanced. Total 820 credits earned.
9. JS replay client (`replayV4TransitionsFromLogs`) reproduces
   the new state root from the all-zero parent + chain events
10. WorkCreditAccepted event count == 2 (screener + advance)

This is the first time the full deploy → submit → state advance
→ replay-reproduction loop has been run against a real chain in
this session. All assertions PASS.

### Final state

- 254+ unit tests pass on `npm run test:unit --workspace
  @botcoin/cortex` (was 188 at audit baseline `c59d5fe`).
- Full e2e phase 1-9 still pass per orchestrator's prior round.
- Phase 10 (this round) PASSES.

Items still requiring host-side / external work are documented
in `/root/cortex/context.md` under "Known outstanding work" —
live coordinator wiring, pinned Qwen3 model file hashes,
production corpus volume, Base fork rehearsal. The CoreTex
substrate, replay, evaluator, difficulty, reward law, and one
live mining cycle are self-consistent end to end.

(Auditor artifact closed for this session.)
