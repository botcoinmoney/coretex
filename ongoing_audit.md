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

- HEAD: `81aac77` docs: hand off production corpus hardening
- Working tree: clean as of capture; will diff each wake.

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

---

(Subsequent wake entries will be appended below.)
