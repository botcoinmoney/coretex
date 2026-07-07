# BMU v1 — Budgeted Memory Utility: the permanent CoreTex scoring law

**Revision:** rev2 (adversarial-review response; changelog in §17).
**Status:** SPEC FREEZE candidate (Track B, phase P1 B-lane). No production code
accompanies this document. Nothing here arms, pins, or deploys anything.

**Pinned code baseline:** every `file:line` citation below is into THIS
repository at commit `20412b5` (branch `coretex-c1-work-policy`), verified
2026-07-06/07. Paths are relative to the repo root (`packages/coretex/src/…`
abbreviated `src/…`; epoch-runner scripts under `scripts/…`). Track-A2
citations are into commit `c677e36` (branch `coretex-a2-unbrick`). Corpus
facts marked [E136] were measured directly on the live epoch-136 corpus
(`/var/lib/coretex/coretex-production-corpus-epoch-136.json.events.ndjson`,
read-only scan, 2026-07-07).

**Normative language:** MUST / MUST NOT / SHOULD / MAY per RFC 2119 intent.

**Ancestry (I10):** this spec DESCENDS from
(a) Acceptance Rule V2 — coordinator repo
`.ops/coretex-production-scoring-gap-fix-plan.md`, Phase 4 ("Surface-Aware
Acceptance Design": patch-claim classification, focused gate/confirm packs +
broad safety pack, proof kind `coretex-surface-aware-v2`), and
(b) the mining-unstall plan — coordinator repo
`.tmp-coretex-mining-unstall-plan.md` (Stage 1 cluster-aware acceptance and its
1-query-per-subject soundness problem; Stage 3-G1 typed clusters, question
types, attribute rotation, the motif-amplification law; Stage 4 frontier
overlay and the original §A5 frontier-aware `deriveQueryPack(…, activeIds?)`
design). §14 states exactly what is inherited, changed, and dropped.

---

## 1. Scope and non-scope

BMU v1 REPLACES the r5 scoring law: the objective function, the judge, and the
composite currently assembled at `src/eval/retrieval-benchmark.ts:3246-3251`
(`0.75·nDCG@10 + 0.08·temporal + 0.07·relation_recall + 0.05·abstention +
0.05·structural_sanity`, weights hard-floored to `w_retrieval ≥ 0.70` by
`assertValidWeights`, `src/eval/retrieval-benchmark.ts:84-93`). That floor is
the codified drift away from the Phase-0 intent (`specs/research_brief.md`
§4, lines 318-334) and CANNOT be rebalanced within r5; BMU does not try.

BMU v1 KEEPS, unmodified in mechanism:

- dual-pack seed machinery (`src/coordinator/per-patch-evaluator.ts:385-386`;
  `src/eval/seed-derivation.ts:112-146` — domain-prefixed gate/confirm seeds
  from one pinned future blockhash + epoch secret);
- dedup/admission/per-miner caps, SQLite-authoritative on the coordinator
  (per-miner screener cap default 50/epoch,
  `src/coordinator/coretex-coordinator-core.ts:952,1266`);
- replay / validator / attestation machinery, including the fail-closed
  overlay pairing (`src/coordinator/production-evaluator.ts:770-790`);
- the no-substrate baseline lane and keyless `scoreState`
  (`src/coordinator/production-evaluator.ts:870-880`,
  `src/scorer-server-cli.ts:157-179,238-254`);
- the Qwen3-Reranker-0.6B stage-2 reranker, UNCHANGED (§13.1 — removing it
  would be a second simultaneous law change; it survives as retrieval
  plumbing, no longer the reward carrier);
- the r5 STATE layout and decode law in full (I2; §3.2);
- work-unit tiers, screener-threshold controller, EIP-712 receipts, on-chain
  registry (`src/rewards/work-units.ts:105-110` tiers, `:207-266` screener
  threshold, `:21` max bps) — the scalar contract (I1) exists precisely so
  none of these change.

**Named deltas to inherited pack machinery (amending rev1's "verbatim"
claim):** BMU modifies exactly TWO pack-law mechanisms, both specified in §6:
(1) the live-eval overlay admission becomes seed-dependent with confirm-side
exclusion (rev1 kept `admitActiveLiveEvalEvents` verbatim, which is
seed-INDEPENDENT — newest-epoch-first per family,
`src/eval/hidden-query-pack.ts:392-399` — and would have injected the SAME
fresh rows into gate and confirm, defeating I6 on exactly the fresh-headroom
rows); (2) broad-pack eligibility becomes active-frontier-aware (the
designed-but-never-armed Stage-4 §A5 mechanism), which is what makes
retirement real for scored packs (§6.5). Everything else listed above is
inherited byte-for-byte.

r5 survives as a replay-only law for historical artifacts: profile pins keep
old receipts replayable forever (`CORETEX_PIPELINE_VERSIONS_SUPPORTED`,
`src/eval/retrieval-benchmark.ts:544-547`). Standing rule restated: **no r5
composite/weight/surface-admission tuning, ever** (the single sanctioned A2
unbrick transition, `c677e36`, is Track A's and is already built).

---

## 2. The scalar law

### 2.1 One number, one reason (I1)

BMU emits ONE scalar in ppm, integer, clamped to `[0, 1_000_000]`. Acceptance
is `candidate − parent ≥ threshold`, evaluated per pack, with the state-advance
rule unchanged from today: `min(gateΔppm, confirmΔppm) ≥ threshold`
(`src/coordinator/production-evaluator.ts:676-677`). The acceptance threshold
FORMULA is unchanged: `minImprovementPpm + replayTolerancePpm +
baselineVariancePpm` (`computeAcceptanceThresholdPpm`,
`src/eval/retrieval-benchmark.ts:107-121`; note `baselineVariancePpm` counts
only when `baselineVarianceSource ∈ {rotating_pack, broad_sampling}`,
`:114-117`). The BMU bundle re-PINS the terms (§2.4). The screener threshold
controller consumes the BMU scalar exactly as it consumes the r5 scalar
(`src/rewards/work-units.ts:207-266`); no field, tier, bound, or W0x
qualification reason changes.

Externally a rejected submission carries exactly ONE reason from the §7
taxonomy. Internal stage telemetry goes to the coordinator's PRIVATE audit
lane; the published artifact carries per-family aggregates only (§8.3).

### 2.2 Per-task utility (budget-B, I4)

Every BMU-scored hidden row is a TASK (schema in §4). For a task `t` with
budget `B_t`, required evidence set `R_t`, forbidden evidence set `F_t`, and
accepted answer id `a_t`:

Let `top-B` be the first `B_t` documents of the FINAL reranked ordering under
the deterministic judge ranking rule of §13.2 — the same stage-2 output whose
head `rerankerTopK` (10, live profile) already defines scored ranks.
`B_t ≤ 8 < rerankerTopK` always (§4.2), so the budget is a strict tightening
of the existing cap, not a new pipeline stage.

For ANSWERABLE tasks (`abstain` absent/false):

```
u(t) = 1  iff  R_t ⊆ top-B  AND  F_t ∩ top-B = ∅  AND  a_t ∈ top-B
               AND the abstention signal (§5.5) does NOT fire on t
u(t) = 0  otherwise
```

The last conjunct is the FALSE-ABSTAIN COUNTERWEIGHT (the BMU analog of r5's
`policyFalseAbstain`, `src/eval/retrieval-benchmark.ts:3200`): a substrate
that abstains on an answerable task earns nothing on it, so an always-abstain
patch zeroes every answerable row in the pack (~80% of rows) and is
catastrophically negative. The always-abstain control is a REQUIRED P4
control and part of the G-B5 fail set.

For ABSTENTION tasks (`abstain: true`; `R_t = ∅`, `answer` absent):

```
u(t) = 1  iff  F_t ∩ top-B = ∅  AND  the abstention signal (§5.5) fires on t
u(t) = 0  otherwise
```

Utility is BINARY per row. No partial credit, no graded margins in v1
(DEFER, §12). "Retrieve everything and rerank" fails by construction: `B` is
small and forbidden items are planted adjacent to required ones, so
indiscriminate recall admits a forbidden item. There is NO tokenizer metering
(I4).

**Why label knowledge alone earns nothing (load-bearing for §6.5):** u(t)
requires the forbidden trap to be ABSENT from top-B. Traps are constructed to
out-rank honestly (stale doc claiming currency with exact-question
vocabulary, `scripts/lib/evolve-corpus.mjs:120-123`; near-collision siblings;
off-path co-occurrence neighbors). Evicting them requires the family's memory
OPERATION (temporal record, conflict atom, routing structure, discrimination)
— not anchoring: raw routing anchors are disabled in the live profile and the
Stage-3 G1 indexing-only control measured Δ0 on every cluster
(`.tmp-coretex-mining-unstall-plan.md` Stage 3-G1 final evidence). An
adversary who knows a row's labels still has to perform the real operation to
flip it — at which point the patch is real mining.

### 2.3 Aggregation: composition-weighted uniform quantum

**The scalar is a plain mean over the pack:**

```
BMU_ppm = round( 1_000_000 · ( Σ_{rows t in pack} u(t) ) / packSize )
```

With `packSize = 64`, the per-row quantum is UNIFORM and exact:
`q = 1_000_000 / 64 = 15_625 ppm` — independent of family. Family weights are
realized by PACK COMPOSITION (quota law, §6.2), not by arithmetic
multipliers. Rationale: arithmetic per-family weights over binary rows make
the score lattice family-dependent (rev1's `w_f/N_f` quanta ranged
7.7k–37.5k ppm), which lets one lucky flip in a small-N family dwarf the
threshold while a flip in a large-N family doesn't clear it; uniform
composition weighting makes every threshold statement exact in units of
row-flips (§2.4) and eliminates the per-family quantum asymmetry an adversary
would farm.

**Composition targets** (the §2.3-rev1 weights, now realized structurally):

| family                      | target share w_f | target rows of 64 |
|-----------------------------|------------------|-------------------|
| temporal                    | 0.20             | ~13               |
| conflict_lifecycle          | 0.30             | ~18               |
| multi_hop_relation          | 0.30             | ~18               |
| near_collision / abstention | 0.20             | ~13               |

Phase-0 reconciliation unchanged from rev1: temporal-revocation 0.20 →
`temporal`; near-collision 0.20 → `near_collision/abstention`; long-horizon
compression 0.60 (deferred family) re-homed evenly onto `conflict_lifecycle`
+ `multi_hop_relation`, the two v1 families exercising persistent structured
state (MemoryArena framing, §11); compression takes its weight back from
those two in v2. Majority mass on the non-saturating structural axis, equal
minority mass on the two anti-gaming descendants — the Phase-0 shape
(`specs/research_brief.md:318-334`).

**Validation:** `assertValidBmuWeights` becomes a COMPOSITION validator: with
the pinned quotas Q_f, overlay share O_f, and free fill (§6.2), it asserts
`| (Q_f + O_f) / packSize − w_f | ≤ 0.03` for every family, and exactly the
four v1 families present. r5's `assertValidWeights`
(`retrieval-benchmark.ts:84-93`) is untouched for r5 replay.

**Per-family utility** `U_f = mean of u(t) over family-f rows in the pack` is
still computed — it drives the floors (§2.5), the G-B8 family-collapse alarm,
and the `/score-state` decomposition (§8.4) — it just no longer multiplies
into the scalar.

### 2.4 Threshold arithmetic (row-flip semantics)

BMU bundle pins:

- `patchAcceptanceFloors.minImprovementPpm = 20_000`
- `replayTolerancePpm = 250` (unchanged; satisfies the bundle validation
  `replayTolerancePpm ≤ minImprovementPpm`, `src/bundle/index.ts:1508-1509`)
- `baselineVarianceSource = 'rotating_pack'`, `baselineVariancePpm` measured
  at rebaseline (§10)

Acceptance threshold ≈ 20_250+ ppm. In row-flip units (q = 15_625):

- **1 net flip** = 15_625 < 20_250 → REJECTED for state advance. A single
  row flip can never advance state (this is also the §6.5 lucky-sampling
  backstop).
- **2 net flips** = 31_250 ≥ 20_250 → can advance.
- **Honest typed-cluster patch** (Stage-3 G1 evidence: 4–5 of 5 cluster rows
  lifted; §6.2 guarantees ~3 same-family fresh rows per pack, plus
  motif-amplification lift on same-attribute broad rows): expected 3–5 flips
  per pack = 46_875–78_125 ppm = **2.3–3.9× the 20k floor**. G-B4's "≥3×
  threshold" = 60_000 ppm = 4 flips — reachable for genuine cluster patches;
  P4 calibrates and MAY re-pin `minImprovementPpm` within [q+1, 2q] with the
  same one-flip-rejecting property.
- **Screener staircase:** the controller's dynamic ceiling
  (`min(maxThresholdPpm=150k, stateAdvanceThresholdPpm≈20.25k)`,
  `work-units.ts:260-265`) caps the screener at ~20_250 while its floor terms
  (minDelta 50, `stateAdvanceThresholdFloorBps` 2000 → ~4_050 ppm) keep it
  far below one quantum in normal regimes — so **1 flip = screener pass,
  ≥ 2 flips = state advance**: the pass-rate staircase intent
  (`specs/research_brief.md:281-308,338-354`) re-emerges denominated in
  row-flips. The Phase-0 staircase percentages (random ~0% / weak 5–10% /
  strong 20–30%) are P4/P5 calibration targets, not per-task grading.

### 2.5 Floors (quantization-aware; replaces rev1 §2.4)

Ratio floors are wrong on a binary lattice: the r5-style
`U_f(candidate) ≥ 0.85 · U_f(parent)` trips on ONE row regression unless
`U_f(parent) ≥ (1/N_f)/0.15` (≈ 0.51 at N_f = 13) — early low-utility parents
would mass-reject honest mixed patches (G-B7 implausible). BMU replaces them
with ABSOLUTE row-count budgets, evaluated on BOTH packs:

- **Per-family regression budget:** rows where u drops 1→0, per family,
  ≤ 1; total across families ≤ 2. Binds identically at every parent utility
  level. (Honest typed-cluster patches measured ZERO regressed rows — G1
  evidence — so this budget is slack for real patches and tight for
  gimmicks.)
- **Protected rows:** the BMU meaning of the protected-record floor (r5:
  per-query nDCG drop > `protectedRegressionFloor` on `protected: true`
  rows, `src/eval/retrieval-benchmark.ts:3322-3341`) — a designated set of
  `protected: true` bmuTask rows on which ANY u 1→0 regression is a hard
  veto (excluded from the ≤1 budget; zero tolerance).
- **Structural validity:** unchanged hard floor, `structuralFloor 0.95`
  (`retrieval-benchmark.ts:3267-3271`; live pin
  `release/calibration/2026-06-04-memory-atom-v16/bundle-manifest-…-liveeval8.json:145-154`).
  r5's 5% structural-sanity WEIGHT is dropped (paying score for validity was
  headroom-free filler; failing closed is the correct semantics).

There is NO separate third "broad safety pack" in BMU v1 — see §14.1.

---

## 3. Pipeline version and state layout

### 3.1 New pipelineVersion

`pipelineVersion = 'coretex-bmu-v1-r5state'`. The name is normative: it
declares that the DECODE LAW IS THE R5 DECODE LAW (I2). One law change per
transition — scoring law only; never a state-layout + scoring-law change
together.

### 3.2 r5 state layout survives byte-for-byte (I2)

- `RANGES` unchanged (`src/state/types.ts:78-104`): Header 0-31, MemoryIndex
  32-383, policy evidence 384-511, policy conflict 512-639, policy abstention
  640-671, Relations 672-799, Temporal 800-895, reserved r5 policy 896-991
  (MUST stay zero), reserved 992-1023.
- `decodeSubstrate` hard r4/r5 gate unchanged
  (`src/substrate/retrieval-decoder.ts:918-945`); per-atom fail-closed decode
  unchanged (`decodePolicyAtomRegion`, `:718-753`).
- Patch grammar unchanged: `applyPatch` policyAtomsMode semantics
  (`src/state/patch.ts:222,244`), canonical-byte rules
  (`policyWriteIsCanonical…`, `:474-509`), r5 suppression of
  KEY_UPDATE/CODEBOOK_UPDATE/HEADER_UPDATE in `buildAllowedPatchTypes`
  (`:511-524`).
- NO r6 region reclaim, NO multi-vector key carve-out in v1 (DEFER, §12).

Consequence: everywhere the code asks "is this the r5 state law?" by comparing
`pipelineVersion === 'coretex-retrieval-v2-policy-r5'`, the check MUST become
membership in a two-element set `{ 'coretex-retrieval-v2-policy-r5',
'coretex-bmu-v1-r5state' }` for STATE-LAYOUT decisions, while SCORING-LAW
routing distinguishes the two. §9 enumerates every such site.

---

## 4. Task JSON schema for `eval_hidden` rows

### 4.1 The `bmuTask` field

BMU adds ONE optional field to `ProductionCorpusEvent`
(`src/eval/retrieval-corpus.ts:196-294`). Optional-and-absent on every
pre-BMU row (absent keys do not change canonical event hashes — the same
back-compat convention as `entityIds`, `:208-217`).

```jsonc
"bmuTask": {
  "family": "temporal" | "conflict_lifecycle" | "multi_hop_relation"
          | "near_collision_abstention",       // REQUIRED (§5.6 mapping)
  "budgetB": 3,                                 // REQUIRED, integer 1..8
  "requiredEvidence": ["d0000157", "d0000158"], // REQUIRED, doc ids; [] only
                                                //   when abstain=true
  "forbiddenEvidence": ["d0000155"],            // REQUIRED, doc ids (stale/decoy)
  "answer": { "id": "d0000157",                 // REQUIRED unless abstain=true
              "value": "vegan" },               //   value: audit-only, optional
  "abstain": false,                             // OPTIONAL, default false
  "motifGroupId": "mg_e137_temporal_0042",      // REQUIRED — cluster identity;
                                                //   held-out partition key (§6.3)
  "templateId": "tt_supersession_q7_v3"         // REQUIRED — generator-stamped
                                                //   surface-form template id;
                                                //   held-out partition key (§6.3)
}
```

`motifGroupId` and `templateId` are generator-pinned and hidden exactly like
the rest of the eval_hidden row's labels (visible to validator-tier actors —
§6.5 adversary model). Load-time validation (fail-closed, corpus refuses to
load): `answer.id ∈ requiredEvidence` (when not abstain);
`requiredEvidence ∩ forbiddenEvidence = ∅`; every referenced doc id exists in
the corpus; `|requiredEvidence| ≤ budgetB`; `abstain=true ⇒ requiredEvidence
= [] ∧ answer absent`; `family` matches the row's (`logicalFamily`,
bucketed `family`) pair per the §5.6 table; `motifGroupId` non-empty and
shared by every row minted from the same memory structure and by no other
row; `templateId` non-empty.

**Template mint law (P2 generator obligation):** template banks are
partitioned per (family, epoch) so that any two clusters of the same family
minted for the same epoch carry DISJOINT `templateId` sets; two rows share a
`templateId` iff they instantiate the same surface-form template. This is
what makes §6.3's template-disjoint confirm derivation well-defined.

### 4.2 Budget defaults

Per-family default `budgetB` (generator MAY override per task within `[1,8]`;
the hard cap 8 is law — `budgetB > 8` fails corpus load):

| family                      | default B | rationale                                        |
|-----------------------------|-----------|--------------------------------------------------|
| temporal                    | 3         | current + provenance required; stale trap forbidden |
| conflict_lifecycle          | 4         | resolved + resolution-record (+ support); candidate trap forbidden |
| multi_hop_relation          | 4         | bridge chain of 2-3 + answer                     |
| near_collision / abstention | 3         | tight discrimination window; decoys forbidden    |

### 4.3 Coexistence with existing row fields

- `split`: unchanged — BMU rows are `eval_hidden` via the same deterministic
  id-hash split (`splitForRecord`, `src/eval/retrieval-corpus.ts:359-382`;
  splits are hash-bucket LABELS inside the single root-pinned corpus file,
  verified at load `:901-909` — not file partitions; §6.5 consequences);
  the typed-cluster minter already assigns ids so the split lands correctly
  (unstall plan, Stage-3 G0A).
- `validity` (`:220-221`, type `:172-179`): unchanged and still REQUIRED on
  temporal-family docs — `temporalRecordAppliesToQuery` scoping depends on it.
- `band` (`:279`): unchanged; still generator difficulty metadata feeding
  band strata (`strataOf`, `src/eval/hidden-query-pack.ts:163-194`).
- `logicalFamily` (`:293`): unchanged; consumed per the §5.6 namespace table.
- `qrels` / `truthDocuments` / `hardNegatives`: RETAINED on BMU rows. They are
  (a) the replay substrate for r5-law historical artifacts, (b) the hardness-
  certification input (P2), and (c) the generator's source of truth from which
  `requiredEvidence`/`forbiddenEvidence` are derived. For BMU SCORING they are
  inert: `bmuTask` is authoritative. Consistency rule at mint time (not load
  time — old corpora can't satisfy it): `requiredEvidence ⊆ {qrels with
  relevance ≥ 0.5}` and `forbiddenEvidence ⊆ {qrels with relevance = 0} ∪
  hardNegatives`.
- Pack eligibility: under `coretex-bmu-v1-r5state`, hidden-pack eligibility
  requires a valid `bmuTask` AND active-frontier membership (§6.5's
  eligibility delta to `hiddenPackEventEligible`,
  `src/eval/hidden-query-pack.ts:587-592`). A BMU bundle over a corpus
  without enough eligible rows to fill quotas fails pack derivation closed
  (`deriveQueryPack` throw behavior unchanged,
  `src/eval/hidden-query-pack.ts:292-296,306-308`).

---

## 5. Family definitions ×4 (I3)

Exactly these four. Coreference-as-family, causal-chain, and
compression-under-budget are DEFERRED to v2, contingent on v1 shadow results.
Each family states: what the miner's substrate must DO, what utility is
EARNED, and what the TRAP/forbidden set is. All four inherit the typed-cluster
design law proven in Stage 3-G1 (`buildTypedTemporalClusterSpec`,
`scripts/lib/evolve-corpus.mjs:114-188`): one memory structure → several
hidden tasks of DISTINCT question types, so one meaningful patch lifts
multiple tasks and per-doc indexing lifts ~none.

### 5.1 temporal (current / stale / supersession)

- **Substrate must:** encode the supersession operation — anchor the stale
  event revoked + anchor the current event + write the subject/attribute-
  scoped temporal record (words 800-895), the proven ≤4-cell patch shape
  (Stage 3-G1 evidence: 8/8 clusters, Δ 198k-304k ppm, controls 0).
- **Utility earned:** current-value, downstream-application,
  stale-verification, and change-provenance tasks (question types
  `scripts/lib/evolve-corpus.mjs:101-106`) resolve with the current record
  and/or provenance record inside top-B.
- **Trap/forbidden:** the stale doc that CLAIMS currency (`role:
  'stale_trap'`, minted with exact-question vocabulary,
  `scripts/lib/evolve-corpus.mjs:120-123`) plus escalation shadows. Any of
  these in top-B zeroes the task. Under r5 the trap was a graded negative;
  under BMU it is a hard veto — the family's anti-lexical-shortcut screen.

### 5.2 conflict_lifecycle

- **Substrate must:** perform the resolution operation: anchor the event
  carrying the conflict motif and write a `conflict_lifecycle` policy atom
  (words 512-639, actions boost/suppress —
  `src/substrate/retrieval-decoder.ts:705-709`) that ADMITS the resolved
  ("current/corrected/replaced-by") doc into the budget window and suppresses
  the superseded candidate. Note the measured mechanics: conflict's lever is
  retrieval-cap ADMISSION under distractor pressure, not rerank reordering
  (unstall plan, Stage 3-G1-CONFLICT) — small-B budgets recreate exactly the
  pressure that makes this family mineable, which fixture-scale r5 packs
  could not.
- **Utility earned:** current-for-scope, resolution-provenance, and
  downstream-for-scope tasks resolve with the resolved doc + resolution
  record in top-B.
- **Trap/forbidden:** the contradicted candidate doc (still asserting the
  superseded claim, `contradicts`-linked) and scope-mismatched lookalikes
  (same subject, different scope). Cluster shape per the Stage-3 design:
  candidate(A) / resolved(B) / resolution-record(R), `contradicts` B→A,
  `derived_from` R→A.

### 5.3 multi_hop_relation (incl. bridge/coreference framing)

- **Substrate must:** encode traversal structure: relation edges (words
  672-799, domain-share-validated — `relationEdgeValid`,
  `src/substrate/retrieval-decoder.ts:904-914`) and/or category lenses that
  route from the query's subject through a BRIDGE doc (which names both
  endpoints but not the answer) to a lexically-distant answer doc
  (`grounding: 'distant'` rows, `src/eval/retrieval-corpus.ts:287`).
  Coreference is framed INSIDE this family: an alias/role hop is one edge of
  the path, not its own family.
- **Utility earned:** the task requires BOTH the bridge doc and the answer doc
  in top-B (`requiredEvidence` = bridge + answer) — pure answer-anchoring
  without the traversal evidence does not pay, which is what makes this
  family's utility a routing reward rather than an indexing reward.
- **Trap/forbidden:** same-category non-path docs — high lexical overlap with
  the query's subject but not on the relation path (the measured
  `co_occurs_with`/`context_of` noise-edge hazard: a lens over generic
  co-occurrence boosts everything and admits a forbidden neighbor).

### 5.4 near_collision / abstention

- **Substrate must:** sharpen discrimination — keep the right entity/attribute
  variant retrievable at small B while near-collision decoys (alias
  collisions, attribute lookalikes) stay out; for abstention variants, resist
  admitting ANY plausible decoy when no answer exists AND express the
  abstention policy (a `MISSING_EVIDENCE` abstention atom, words 640-671).
- **Utility earned:** answerable variant — the exact-match doc in top-B with
  all sibling decoys excluded and no false abstain; abstention variant — zero
  forbidden docs in top-B and the §5.5 abstention signal fires.
- **Trap/forbidden:** the sibling decoy set itself (the near-collisions ARE
  the forbidden list). This family is the anti-gaming counterweight: a
  substrate that blindly boosts everything it has anchored fails here first,
  and a substrate that blindly abstains fails everywhere else (§2.2).

### 5.5 The abstention signal, named exactly

The BMU abstention signal IS the r5 POLICY-ATOM abstention decision — the
miner-movable one — as computed at `src/eval/retrieval-benchmark.ts:2319-2342`:
abstain fires iff policyAtomsMode is on, abstention atoms decode
(`enableAbstentionAtoms !== false`, `decoded.abstentionAtoms.length > 0`),
an atom's `MISSING_EVIDENCE` selector matches with its no-public-evidence-path
flag satisfied, AND the operator-calibrated confidence gate holds (top1 AND
margin below the profile thresholds, `:2326-2335`).

The r5 FALLBACK rule — `top1Score < opts.abstentionThreshold` when no atoms
are decoded (`:3196-3199` else-branch) — is NOT part of BMU u(t). Rationale:
it is not a miner surface, and under BMU it would gift blank/atom-less
substrates free abstention-family utility, distorting the blank-state floor
(G-B1) and the parent baseline. Consequences per lane: blank state → no atoms
→ signal never fires → abstention tasks u = 0 (and no false-abstain penalty,
since the signal can't fire); parent state → whatever atoms the parent
carries.

### 5.6 Family-name mapping across the four namespaces (normative)

Measured on the live epoch-136 corpus, eval_hidden rows [E136] (row counts in
parentheses). This is the table the §4.1 load check points at.

| bmuTask.family | quota stratum (`family=…`, matches bucketed `event.family` via `strataOf`, `hidden-query-pack.ts:163-194`) | corpus `logicalFamily` values [E136] | overlay `familyPriority` entries (matched logicalFamily-FIRST, `hidden-query-pack.ts:381-383`) |
|---|---|---|---|
| `temporal` | `family=temporal` | `temporal_update` (2267) | `temporal_update` |
| `conflict_lifecycle` | `family=conflict_lifecycle` | `conflict_lifecycle` (1246) | `conflict_lifecycle` |
| `multi_hop_relation` | `family=multi_hop_relation`, plus legacy `family=coreference` | `multi_session_bridge` (1310), `causal_memory_chain` (421), `decision_provenance` (417), `coreference_resolution` (857, bucketed `coreference`) | `multi_session_bridge`, `causal_memory_chain`, `decision_provenance`, `coreference_resolution` |
| `near_collision_abstention` | `family=near_collision` | `abstention_missing` (1399), `entity_resolution_atom` (17), `scope_atom` (19), `validity_atom` (22) | `abstention_missing`, `entity_resolution_atom`, `scope_atom`, `validity_atom` |
| — excluded from BMU v1 — | — | `aspect_constraint` (1371; family disabled under the live profile via `disabledHiddenEvalFamiliesFromProfile`, `hidden-query-pack.ts:86-98`) | — |

Two-namespace code reality this table papers over (and A2 hit —
`c677e36` commit message): QUOTAS match the bucketed `event.family` (via
`strataOf`/`eventSatisfiesStratum`), while the overlay's `familyPriority` and
the disabled-family checks match `logicalFamily` FIRST
(`hidden-query-pack.ts:381-383,589`). BMU bundles MUST therefore write quota
strata in bucketed-family names and `familyPriority` in logicalFamily names,
exactly as A2's `liveeval12-allfam-age32` does. New BMU rows MUST stamp both
`family` (bucketed) and `logicalFamily` consistently with this table;
`bmuTask.family` must equal the bucketed mapping — checked at corpus load.

---

## 6. Gate/confirm derivation: seen vs held-out (I6)

This invariant carries the ENTIRE anti-1:1-indexer burden. It is
per-acceptance, not launch-time.

### 6.1 Two-seed flow reused verbatim

Seeds are derived exactly as today, no changes:
`deriveGateEvalSeed` / `deriveConfirmEvalSeed`
(`src/eval/seed-derivation.ts:138-146`) — domain-prefix-separated keccak over
(epochSecret, pinned future blockhash, epochId, patchHash, parentRoot,
corpusRoot, bundleHash), invoked at
`src/coordinator/per-patch-evaluator.ts:385-386`, pinned/injected via
`seedContext`/`injectedSeeds` (`:120-147`) so the keyless scorer stays
secretless and a crash can never re-roll packs. The receipt fields
(`:149-178`) and seed-witness replay are unchanged.

### 6.2 Pack composition — concrete, armable numbers (validated arithmetic)

`packSize = 64`. Quota minimums (bucketed-family strata):

| stratum | minCount |
|---|---|
| `family=temporal` | 10 |
| `family=conflict_lifecycle` | 15 |
| `family=multi_hop_relation` | 15 |
| `family=near_collision` | 10 |

Σ quotas = **50** ⇒ the EXISTING overlay validation
`liveEvalPack.limit ≤ packSize − Σ minCount` (`src/bundle/index.ts:1492-1499`)
yields cap = 64 − 50 = **14**. The BMU bundle pins:

- `epochFrontier.liveEvalPack.limit = 12` (≤ 14 ✓). This adopts Track A2's
  resolution of the same ceiling (A2 measured the live 52-quota profile's cap
  at 12 and shipped `liveeval12-allfam-age32` with limit 12 — `c677e36`);
  rev1's "limit ≥ 16" mandate was un-armable under the validation law and is
  WITHDRAWN. No validation-code change is needed for the limit (§9 site 17).
- `familyPriority` = the ten logicalFamily names of the §5.6 table (round-
  robin admission ⇒ ~3 fresh rows per BMU family per pack).
- `epochFrontier.maxAge = 32`, with A2's canonical retirement semantics
  incorporated by reference (`c677e36`): age-based retirement is a BOUNDED
  per-epoch drain — oldest activation first, capped at `maxRootDeltaPerEpoch`,
  sharing the root-delta budget with churn. UNBOUNDED aged retirement is
  forbidden: on the live epoch-136 frontier state, 9,300 of 9,319 active rows
  share activation epoch 0, and any finite maxAge applied unboundedly would
  have collapsed the active set 9319→19 in one step (A2's measured hazard).
  Bundle validation (A2): maxAge must be null or a positive integer; BMU
  bundle validation ADDITIONALLY requires it finite (non-null) — `maxAge:
  null` (the liveeval8 counterexample) is illegal under
  `coretex-bmu-v1-r5state`.
- Free fill = 64 − 50 − 12 = 2 rows (seeded broad sampling, as today).

Expected composition: temporal 10+3=13, conflict 15+3=18, multi_hop 15+3=18,
near_collision 10+3=13 (=62; +2 fill) → shares 0.203 / 0.281 / 0.281 / 0.203
vs targets 0.20/0.30/0.30/0.20 — within the ±0.03 composition-validation
bound (§2.3). Fresh-frontier share = 12/64 = 18.75% per pack, every pack,
across all four families (I7a).

### 6.3 The derivation function contract

```
deriveBmuDualPacks(input: {
  epochId: number,
  gateSeedHex: string,        // deriveGateEvalSeed output
  confirmSeedHex: string,     // deriveConfirmEvalSeed output
  corpus: ProductionCorpus,
  profile: HiddenPackProfile, // BMU pack profile (§6.2)
  activeLiveEval: { activeIds, law },   // REQUIRED under BMU (§6.5)
}): { gate: QueryPack, confirm: QueryPack }
```

1. **Gate pack (seen motifs):**
   `gate = deriveScoredQueryPack(epochId, gateSeedHex, corpus, profile,
   activeLiveEval)` over BMU-eligible rows (§4.3), with the overlay admission
   law of §6.4 (seeded draw, gate side).
2. **Exclusion key set:** `X = { motifGroupId(e) } ∪ { subjectEntityId(e) } ∪
   { templateId(e) }` for every `e` in the gate pack. All three fields have
   schema anchors: `subjectEntityId` on the event
   (`retrieval-corpus.ts:248`), `motifGroupId`/`templateId` on `bmuTask`
   (§4.1).
3. **Confirm pack (held-out motifs):**
   the SAME derivation with `confirmSeedHex`, over the BMU-eligible pool
   MINUS every row whose `motifGroupId`, `subjectEntityId`, or `templateId`
   is in `X` — same family quotas, same overlay law (confirm side, §6.4).
   HELD-OUT means: same motif FAMILIES, disjoint entities AND disjoint
   surface templates (template disjointness guaranteed at mint time, §4.1).
4. **Fail-closed:** if the residual pool cannot satisfy the quotas, the
   evaluation REFUSES (maps to `stale_context` externally only if caused by a
   frontier transition; otherwise it is an operator alarm — the generator is
   obligated to mint ≥ 2 clusters per family per epoch precisely so both
   packs and both overlay draws can always fill; see G-B9).

Gate-before-confirm ordering is part of the law (the exclusion is asymmetric
and deterministic).

### 6.4 Overlay admission under BMU: seed-dependent + excluded (the one modified mechanism)

The inherited overlay is seed-INDEPENDENT: `admitActiveLiveEvalEvents` admits
newest-epoch-first per family (`src/eval/hidden-query-pack.ts:364-479`, sort
`:392-399`). Kept verbatim, gate and confirm would admit the SAME predictable
fresh rows, and any per-row exploit on them would clear `min(gate,confirm)`
— defeating I6 exactly where the headroom is. BMU therefore changes overlay
admission (this is named delta (1) of §1):

- **Fresh cohort:** active `zz_e*` BMU-eligible rows with age ≤
  `freshWindow` (bundle-pinned, default 2 epochs); if a family's cohort is
  thinner than its round-robin share, it falls back to newest-first within
  the active set (deterministic).
- **Seeded draw:** each overlay slot's row is drawn from its family cohort by
  the same `digestU256` pattern the quota draws use
  (`hidden-query-pack.ts:279-296`), domain-tagged `liveEval`, keyed by the
  pack's seed — gateSeed for the gate pack, confirmSeed for the confirm pack.
  Which fresh rows appear is thus unpredictable pre-blockhash, while the
  fresh SHARE stays guaranteed (I7a: freshness is a cohort property, not a
  row-identity property).
- **Exclusion:** the confirm-side draw additionally excludes rows whose
  motifGroupId/subjectEntityId/templateId ∈ X (§6.3) — the exclusion applies
  to overlay and broad rows alike.
- **Contract deltas:** `deriveScoredQueryPack(…)` gains an optional
  `exclude?: ReadonlySet<string>` (composite keys); `admitActiveLiveEvalEvents`
  opts gain `{ seedHex?, freshWindow?, excludeKeys? }`. ALL new parameters
  absent ⇒ byte-identical current behavior — r5 bundles and every epoch ≤
  the flip replay unchanged (the same replay-safety pattern the overlay
  itself used, `hidden-query-pack.ts:59-84`).
- **Determinism/replay:** both packs remain pure functions of
  (seeds, corpus, active set, profile); post-reveal recomputation per §6.6.

**Why this kills the exact-anchor miner, structurally:** a patch that only
anchors specific hidden docs (a) earns no u(t) even when its rows are sampled
— the forbidden-trap veto requires the real memory operation (§2.2, G1
indexing-only Δ0); (b) cannot target the fresh rows deterministically — the
overlay draw is seed-dependent and the seeds hang on a future blockhash; and
(c) even a patch hardcoding exact INSTANCES of the operation dies on confirm,
whose instances are disjoint in entity AND template. A patch encoding the
motif OPERATION transfers, because the scorer applies it to whatever
instances the packs sampled. This resolves Stage 1's 1-query-per-subject
soundness problem from the other side: instead of focusing packs onto the
patch's one target row (gaming hazard), BMU makes clusters dense enough
(typed clusters + guaranteed fresh share) that family utility is movable, and
makes transfer — not presence — the acceptance test.

### 6.5 Label-visibility reality, adversary tiers, and retirement (replaces rev1's privacy premise)

**Verified architecture facts.** The production corpus is ONE root-pinned
file; splits are hash-bucket labels on rows, not file partitions
(`loadProductionCorpus`, `src/eval/retrieval-corpus.ts:844-909`; split
verification `:901-909`; `splitForRecord` `:359-382`). Validators materialize
the FULL labeled corpus — eval_hidden rows with qrels and, under BMU,
`bmuTask` bodies — via the published, signature-verified corpus-delta chain
(`src/validator-sync-cli.ts:1419` load; delta-chain walk `:2060-2087`;
operator-supplied corpus `:2212`), because post-reveal score replay requires
it. Nothing in `hiddenPackEventEligible` (`hidden-query-pack.ts:587-592`)
excludes previously exposed rows. Therefore:

**Two-tier adversary model (normative).** Tier-P (public-endpoint miners):
see public motif docs, never labels. Tier-V (validator-grade actors): hold
ALL row labels, live — label secrecy against Tier-V DOES NOT EXIST in this
architecture, under r5 today or under BMU, and no BMU mechanism may assume
it. The true secrecy boundary is pack SAMPLING (epochSecret + future
blockhash + patchHash-keyed seeds). I9's "hidden qrels/answers/seeds stay
private" is normative for the Tier-P surface (public endpoints) only; §16
carries a clarifying note.

**Defense in depth against Tier-V (three coupled parts):**

1. **Task construction (primary, per-row):** label knowledge alone earns
   nothing — u(t) demands trap EVICTION, which demands the real operation
   (§2.2). Knowing labels degrades to search-cost savings on WHERE headroom
   is; performing the operation there is legitimate mining.
2. **Frontier-aware eligibility + retirement (lifecycle):** under
   `coretex-bmu-v1-r5state`, BROAD-pack eligibility requires active-frontier
   membership: `hiddenPackEventEligible` additionally requires
   `activeFrontierIds.has(event.id)` (the delta at
   `hidden-query-pack.ts:587-592`; this is the unstall plan's original
   Stage-4 §A5 `deriveQueryPack(…, activeIds?)` design, now mandatory —
   today's broad pack ignores the frontier entirely, so retirement never
   touches scored packs). Fail-closed pairing both directions, mirroring
   `production-evaluator.ts:770-790`. On top of that active set:
   - **retire-on-exposure:** every row referenced by the packs of an
     ACCEPTED published artifact (screener pass or state advance) is queued
     for retirement at the next evolve, drained with priority AHEAD of aged
     rows through A2's bounded oldest-first drain, within the same
     `maxRootDeltaPerEpoch` budget (`c677e36` — never a mass flush; the
     measured 9319→19 collapse is the forbidden failure mode);
   - **retire-by-age:** `maxAge = 32` bounds every row's total exposure
     lifetime (§6.2).
   Both are frontier operations ⇒ replayable through the EXISTING on-chain
   `activeFrontierRoot` pin + root-verified id-set artifact — ZERO new pins
   or wire fields.
3. **Artifact telemetry redaction:** the published artifact carries
   per-family aggregates and the exclusion-set digest ONLY; per-row u(t)
   detail (rev1's bitmaps — a per-row label-correlated leak) is REMOVED from
   the published artifact and lives in the coordinator's private spool lane
   (§8.3).

**Rejected alternative (recorded):** label commit-reveal — rows carry only a
`taskCommit` hash; task bodies distributed post-epoch. Escalation path for v2
if shadow-mode red-team (G-B15) defeats parts 1–3; not v1, because it forks
the corpus distribution channel (a second artifact stream, new sync/ack
fields, validator changes) to protect against a tier that must hold labels
anyway to replay.

**Residual-risk arithmetic (honest).** The integrity residual is lucky
dual-pack sampling of a non-operation exploit set. Acceptance needs ≥ 2 net
flips per pack on BOTH packs (§2.4). For j exploitable rows in distinct
motif groups in the ~9.3k-row broad pool [E136]: E[in one 64-row pack] =
j·64/9346; at j = 8, λ ≈ 0.055, P(≥2 in a pack) ≈ 1 − e^{−λ}(1+λ) ≈ 1.5e-3;
both packs ≈ 2.2e-6 per attempt; × 50 attempts/epoch (per-miner cap,
`coretex-coordinator-core.ts:952,1266`) ≈ **1.1e-4 per miner-epoch**, before
the §2.2 requirement that the flips be real operations. Overlay rows are
higher-probability per row but are seed-drawn (§6.4) and fast-retired
(exposure + age); the P4 control suite MUST include a Tier-V exact-anchor
attack (labels granted) and G-B15 red-team owns beating it.

### 6.6 Replayability post-epoch-reveal

Everything in §6.3–6.5 is a pure function of
`(epochId, epochSecret, blockhash, patchHash, parentRoot, corpusRoot,
bundleHash, corpus, profile, activeFrontierIds)`. After epoch reveal,
validators re-derive both seeds from the revealed secret (the existing
post-reveal re-derivation backstop, `per-patch-evaluator.ts:138-146` comment)
and recompute both packs byte-identically — `motifGroupId`/`templateId`/
`subjectEntityId` are on the validator-held rows, the exclusion set and
overlay draws are recomputed, the active set is root-verified against the
on-chain pin. The validator replay path (`src/validator-sync-cli.ts`)
verifies pack composition exactly as it does today for the overlay law.

---

## 7. Rejection taxonomy (I9)

### 7.1 Friction findings this redesign answers

Documented friction with the current taxonomy (handoff
`CORETEX_VNEXT_BMU_E2E_HANDOFF.md` §5.1-I9, and the coordinator memory notes
it cites): (a) **202-vanish** — a submission acknowledged 202 whose evaluation
ran on a detached promise could vanish with no queryable outcome; (b)
**dup-temporal** — a missing canonical duplicate check surfaced duplicates as
confusing generic rejects; (c) **render-trace ambiguity** — miners read the
public render-trace as a scoring oracle, but structural visibility with a
real scorer reject is by-design, and the reason strings
(`no_retrieval_improvement` / `gate-acceptance-floor`) taught nothing about
WHICH stage failed or what would change the outcome.

Normative consequences: every accepted-for-processing submission MUST resolve
to a queryable terminal status (no detached-promise terminal states);
duplicates MUST be detected canonically and reported as such; miner docs MUST
state render-trace is diagnostic, never scoring proof.

### 7.2 The external taxonomy (closed set, exactly six)

| external reason           | meaning to the miner                                             |
|---------------------------|------------------------------------------------------------------|
| `malformed_patch`         | your bytes never scored: decode/structural/grammar/admission failure |
| `duplicate_or_capped`     | already seen (dedup) or per-miner cap reached this epoch          |
| `below_gate`              | scored on seen motifs; improvement below threshold                |
| `failed_holdout_transfer` | passed/approached gate but did not transfer to held-out instances of the same families — the anti-indexing signal |
| `safety_regression`       | improvement somewhere, but a floor tripped (structural / protected / regression budget) |
| `stale_context`           | parent root or epoch context advanced mid-flight; resubmit against live root |

### 7.3 Mapping from internal stages (each internal failure → exactly ONE external reason)

The mapping consumes BOTH the outer `rejectionReason` AND the
`innerRejectionReason` (the outer codes distinguish threshold-vs-floor per
pack — `per-patch-evaluator.ts:399-414,422-424` — while the inner reason
carries the specific floor, e.g. `protected_regression:<id>`; the
production-evaluator default outer code is `no_retrieval_improvement`,
`production-evaluator.ts:665`).

| internal (outer code + inner reason where relevant) | external |
|---|---|
| `structurally-invalid`, `admit-malformed-input`, apply_failed E0x, policy-region violations, `SCORER_RESULT_MALFORMED`/`SCORER_ARTIFACT_MALFORMED` | `malformed_patch` |
| `cached`, `duplicate-key-collapsed`, `per-miner-cap-reached`, `CoreTexScreenerCapExceeded` | `duplicate_or_capped` |
| `gate-below-threshold`; `no_retrieval_improvement` (default outer code when the dual evaluator rejects without a floor-specific reason, `production-evaluator.ts:665`); `SCORER_BELOW_THRESHOLD` (gate side) | `below_gate` |
| `confirm-below-threshold` (gate cleared) | `failed_holdout_transfer` |
| `gate-acceptance-floor` / `confirm-acceptance-floor` where the inner reason names a floor (structural / protected / regression budget) | `safety_regression` |
| `W02_STALE_PARENT`, `SCORER_STALE_CONTEXT`, §9 stale-root re-check | `stale_context` |
| scorer-integrity refusals (`SCORER_JOB_ID_MISMATCH`, health/pin/seed-commit/echo mismatches) | never miner-visible as a reject: coordinator-internal retry/alarm; the miner sees only a still-pending or `stale_context` outcome |

Internal reasons remain in the private audit lane; the wire response carries
the external reason and — unchanged anti-oracle stance — redacted (zero)
scores on rejection. `below_gate` vs `failed_holdout_transfer` is a
deliberate information grant: it tells a miner WHETHER their patch is inert
or overfit.

**Oracle-channel bound (honest):** `failed_holdout_transfer` is a 1-bit
oracle per attempt, and because `patchHash` participates in seed derivation
(`seed-derivation.ts:124-134`), each patch VARIANT re-rolls both packs — a
grinding channel. Bounds: per-miner screener cap 50/epoch
(`coretex-coordinator-core.ts:952,1266`) + patch-level dedup + every attempt
is a real submission ⇒ ≤ ~50 bits of pack-membership-correlated signal per
miner-epoch. rev1's "leaks no per-row information" is WITHDRAWN as
overclaimed; the P6 red-team owns quantifying what those bits buy (expected:
nothing actionable — the next attempt re-rolls the packs the bits described).

---

## 8. Wire-contract deltas (ONE coordinated coretex+coordinator change)

Per handoff §2.5, any BMU wire change touches job shapes, all 8 verify
checks, the artifact hash domain, and `/score-state` — shipped as one
coordinated change on both sides. Enumeration (each item = its delta; "none"
means byte-compatible):

### 8.1 Job request shapes

- `ScorerJobRequest` (`src/scorer-server-cli.ts:125-155`): **no new fields.**
  The law rides entirely in the pinned bundle (`bundleHash` →
  `pipelineVersion: 'coretex-bmu-v1-r5state'`). `thresholdPpm`, `policyHash`,
  `packedParentStateHex`, pins: unchanged semantics.
- `ScorerPublicEvalContext` (`:103-123`): none.
- `ScorerStateJobRequest` (`:164-179`): none.
- Scorer boot: the scorer's loaded-bundle validation MUST accept the new
  pipelineVersion (its payload attestation version
  `'coretex-scorer-payload-v1'` at `:77` is a separate domain — code-payload
  attestation, not scoring law — and is unchanged).

### 8.2 All 8 `verifyScorerResult` checks
(`src/coordinator/remote-scorer-verify.ts:146-322`; the docstring at
`:140-145` still says "six" — see §15 contradictions)

1. jobId / outstanding-job (`:158-167`): none.
2. context freshness incl. activeFrontierRoot pairing (`:173-205`): none in
   mechanism; under BMU the activeFrontierRoot pin is ALWAYS present (§6.5
   makes the frontier mandatory), so the "no overlay armed" branches are
   unreachable for BMU bundles.
3. result schema (`:170-171`): extended to accept the new proof kind
   `'coretex-bmu-dual-pack-v1'` (§8.3) and to REFUSE it unless the active
   bundle pins `coretex-bmu-v1-r5state` (and vice versa — an r5 bundle never
   accepts a BMU proof; both directions fail closed, mirroring the overlay
   pairing precedent at `production-evaluator.ts:770-790`).
4. threshold logic on returned scores (`:287-302`): none — same
   `min(gate,confirm) ≥ threshold` over BMU scalars.
5. scorer health incl. dtype/tf32/cuda + code hashes (`:207-225`): none in
   mechanism; `ScorerCodeHealth` expected hashes now cover the BMU evaluator
   modules (the Phase-1 code-attestation guard extends automatically since it
   hashes the shipped payload).
6. pins echo incl. proof pins + seed commits (`:227-265`): none in mechanism;
   applies to the new proof kind's identical pin fields.
7. threshold + policy echo (`:267-285`): none.
8. artifact-bytes hash (`:304-322`): none in mechanism; operates on the new
   artifact version (§8.3).

### 8.3 Artifact hash domain

- New proof kind: `'coretex-bmu-dual-pack-v1'` — same shape as
  `PerPatchDualPackEvaluationProof` (`per-patch-evaluator.ts:180-209`: seed
  commits, pins, optional `activeFrontierRoot` — mandatory under BMU — and
  the per-pack `gate: { domain: 'gate', seedCommit, accepted, scorePpm }` /
  `confirm: { domain: 'confirm', … }` blocks including their `domain`
  discriminants) with `kind` changed. Descends from `'coretex-dual-pack-v1'`
  and supersedes the never-shipped `'coretex-surface-aware-v2'` (§14.1).
- New artifact version: `'coretex-bmu-post-reveal-eval-report-v1'` (vs
  `'coretex-post-reveal-eval-report-v1'`,
  `src/coordinator/production-evaluator.ts:679`), hashed by the SAME
  canonical hasher (`hashPostRevealEvalReportArtifact`), same spool-before-
  sign rule. `scoreDelta` remains canonicalized OUT of the eval/hash domain
  (handoff §2.1, `coretex-coordinator-core` `:822-828` in the vendored dist).
- PUBLISHED artifact body adds ONLY per-family aggregates: `U_f` for
  gate/confirm on parent and candidate, per-family regressed-row counts, and
  the §6.3 exclusion-set digest — this feeds the G-B8 family-collapse alarm
  and replay audit. Per-row u(t) detail is NOT published (rev1's per-task
  bitmaps are withdrawn — a per-row label-correlated leak, §6.5 part 3); it
  lives in the coordinator's private spool lane.

### 8.4 `/score-state` result fields

- `ScorerStateJobResult` (`src/scorer-server-cli.ts:243-254`):
  `parentScorePpm`/`variancePpm` semantics become the BMU scalar (no rename).
  ONE additive optional field: `familyUtilitiesPpm?: Record<family, number>`
  — the per-family baseline decomposition the two-pass rebaseline (§10) and
  the coverage-collapse alarm need. Absent on r5-law responses; coordinators
  MUST tolerate absence.
- `evaluator.scoreState` (`production-evaluator.ts:870-880`): same
  composition guarantee — it MUST derive the state pack with the SAME BMU
  pack law (§6.2–6.4 gate-side composition with the caller-provided
  deterministic seed and an empty exclusion set) so baselines are measured
  under exactly the law patches are scored under.

---

## 9. pipelineVersion gate-site checklist (`coretex-bmu-v1-r5state`)

r5 decode law unchanged (I2). Every site below was VERIFIED at commit
`20412b5`. For each: what must change when the new version is introduced.
Sites marked **[STATE]** must treat the new version exactly as r5
(set-membership); sites marked **[LAW]** must route scoring/validation to BMU.

1. **[LAW]** `src/eval/retrieval-benchmark.ts:541-547` —
   `CORETEX_PIPELINE_VERSION_R5` + `CORETEX_PIPELINE_VERSIONS_SUPPORTED`; add
   the new version constant + set entry; `assertPipelineVersionMatches`
   (`:74-82`, enforced at `:3071`) then admits it. The BMU objective replaces
   the composite only under the new pin.
2. **[STATE]** `src/bundle/index.ts:187` — the `pipelineVersion` union type:
   add `'coretex-bmu-v1-r5state'`.
3. **[STATE]** `src/bundle/index.ts:1014` — `policyAtomsMode` hard-wire from
   pipelineVersion: must become set-membership (BMU state law IS policy-atoms
   law).
4. **[STATE]** `src/bundle/index.ts:1457-1458` — "r5 PolicyAtom enables
   require pipelineVersion = …" validation: set-membership.
5. **[STATE]** `src/replay-cli.ts:150` (+ the fail-closed derivation flow
   `:112-147`) — `derivePolicyAtomsMode` manifest check: set-membership; the
   refuse-to-default posture (`:147`) is unchanged.
6. **[STATE]** `src/validator-sync-cli.ts:429-430` —
   `policyAtomsModeFromManifest`: set-membership; consumed at `:1568` and
   applied at `:1874` (`applyPatch(walkState, …, policyAtomsMode)`), reported
   at `:2397`.
7. **[STATE]** `src/state/patch.ts:512` — `buildAllowedPatchTypes` r5 check
   (doc at `:447`): set-membership, so KEY_UPDATE/CODEBOOK_UPDATE/
   HEADER_UPDATE stay suppressed under BMU.
8. **[STATE]** `src/state/patch.ts:222,244` — `applyPatch` policyAtomsMode
   semantics: no change (boolean already flows from the sites above).
9. **[STATE]** `src/reducer/reducer.ts:184,241` — `reduce(…, policyAtomsMode)`
   threading: no change (boolean).
10. **[STATE]** `src/reducer/accept-core.ts:44,53` — accept-path apply:
    no change (boolean).
11. **[STATE]** `src/reducer/live-epoch.ts:70-71,118` — live-epoch reward
    options `policyAtomsMode`: no change (boolean; "set from the pinned
    profile" comment now covers both versions).
12. **[STATE]** `src/replay/coretex-registry.ts:186,228` — registry replay
    apply: no change (boolean).
13. **[STATE]** `src/cli.ts:94,198,280` — dev CLI `--policy-atoms-mode|--r5`
    flags: no change required; SHOULD gain a `--bmu` alias for operator
    clarity.
14. **[LAW]** `src/substrate/retrieval-decoder.ts:312` — the "NEW PROTOCOL
    EPOCH — bump pipelineVersion before launch" marker on the decoder: the
    decoder itself is UNCHANGED (I2); the marker's obligation is discharged by
    this spec's new version string.
15. **[LAW]** `src/scorer-server-cli.ts` bundle-load validation + healthz
    pins: accept the new version; `pipelineVersion:
    'coretex-scorer-payload-v1'` at `:77` is the scorer CODE-payload
    attestation domain — explicitly out of scope, unchanged.
16. **[STATE]** `scripts/launch-preflight.mjs:142,149` — both preflight
    branches hard-check `profile.pipelineVersion ===
    'coretex-retrieval-v2-policy-r5'` ("pipelineVersion pins r5
    (policyAtomsMode derives true)"): set-membership, check-label updated.
17. **[LAW]** `src/eval/hidden-query-pack.ts:587-592` —
    `hiddenPackEventEligible`: under BMU adds the `bmuTask`-present AND
    active-frontier-membership requirements (§4.3, §6.5); `deriveQueryPack`
    gains the active-ids threading (Stage-4 §A5 design). r5 bundles:
    byte-identical behavior (parameters absent). The overlay-limit validation
    at `src/bundle/index.ts:1490-1506` needs NO change for the §6.2 numbers
    (12 ≤ 64−50); BMU-bundle validation ADDS: finite `maxAge` required,
    `liveEvalPack` required with the §6.2 minimums, composition validation
    (§2.3), and the seeded-overlay/exclusion law flags (§6.4).

Rule for implementers: introduce a single
`isR5StateLaw(pipelineVersion): boolean` helper and replace every literal
`=== 'coretex-retrieval-v2-policy-r5'` STATE check with it in one commit, so
site 1's law routing is the only place the two versions diverge. Any site
discovered later that still string-compares the r5 literal for a state
decision is a bug with a failing-closed symptom (BMU bundle refused), never a
silent misdecode — this asymmetry is why I2 pins BMU to the r5 state law.

---

## 10. Baseline semantics across the transition

- **Two-pass rebaseline is MANDATORY and is the ONLY sanctioned law-transition
  path** (I7e): probe evolve → root-verify → `/score-state` rescore of the
  BARE PARENT under the NEW law → real evolve with the recomputed baseline
  baked into the signed rotation manifest (coordinator
  `coretex-baseline-recompute.ts:2-19`; proven live since ~epoch 133). The
  A2 precedent applies doubly here: even a pack-law-only change (liveeval12)
  requires rebaseline before pinning (`c677e36` commit note); BMU changes
  pack law AND objective.
- **The blank-state trap is the reason:** blank-state ≠ parent baseline —
  measured 549,235 ppm blank vs the pinned parent baseline at the epoch-133
  transition. Under BMU the gap direction is not predictable a priori — and
  BMU baselines will start LOW by design (traps sit in top-B for bare
  substrates; blank earns no abstention utility, §5.5) — headroom is the
  point. NO BMU bundle may be armed with a baseline that was not produced by
  scoring the actual parent substrate under the BMU law.
- **scoreState lanes:** both lanes ride the existing keyless machinery —
  blank-state lane (anti-cheat floor measurement; G-B1 evidence) and
  parent-baseline lane (the number acceptance thresholds are derived from),
  via `evaluator.scoreState` (`production-evaluator.ts:870-880`) and
  `POST /score-state` (`scorer-server-cli.ts:157-179`), deterministic
  caller-derived `baselineSeedHex` (never a future blockhash), bounded
  `samples`, variance reported. The §8.4 `familyUtilitiesPpm` addition makes
  the per-family baseline decomposition auditable at rebaseline time, and
  the measured `variancePpm` feeds `baselineVariancePpm` under the
  `rotating_pack` source rule (§2.1).
- **Historical replay:** epochs scored under r4/r5 replay under their pinned
  profiles forever (G-B12); the BMU transition adds a new pin, removes
  nothing.

---

## 11. Research grounding

Design motivation, one line each (per handoff §5.2; re-verify any claim
before it becomes load-bearing anywhere else):

- **MemReranker** — generic rerankers over-rely on semantic similarity and
  miss temporal/causal/coreference memory reasoning → BMU scores
  family-structured memory tasks, not generic rerank quality.
- **BRIGHT** — standard retrievers collapse on reasoning-intensive retrieval →
  hardness certification against trivial baselines (I8, G-B1/G-B3).
- **LIMIT** (+ multi-vector expressivity results) — single-vector embedding
  expressivity ceiling → the r6 multi-vector key question; explicitly DEFERRED
  behind an offline A/B (v2).
- **MemoryArena / MemoryAgentBench** — memory as compressed evolving state
  across sessions, not raw recall → the budget constraint (I4) and the §2.3
  re-homing of the compression weight onto structured-state families.
- **Experience Compression Spectrum** — memory-as-compressed-state framing
  (`specs/research_brief.md:260-277`) → supports the (deferred) compression
  family and Phase-0's compression weighting intent.
- **ReasonIR** — synthetic hard-query generation for reasoning retrieval →
  generator design patterns for the four families (P2).
- **NoLiMa** — retrieval beyond literal/lexical matching → the
  anti-lexical-shortcut trap construction (§5.1) and certification screens.
- **SmartSearch** — cited in the prior research pass for agentic search
  behavior; **VERIFY BEFORE CITING AS LOAD-BEARING** — not relied on anywhere
  in this spec.

No quantitative claims from these works are load-bearing in this spec; they
motivate design shape only.

---

## 12. DEFER list (normative; anti-over-engineering, handoff §8)

Anything not in I1-I10 that adds a subsystem needs an explicit operator
decision — default is DEFER. The following are PRE-DEFERRED and MUST NOT
appear in v1 implementation:

- r6 multi-vector key layout (any state-layout change at all);
- compression, coreference-as-family, and causal-chain families;
- token metering (any tokenizer in the reward path);
- LLM judges (any live model judgment in the reward path);
- production adversarial corpus poisoning (offline hard-case discovery only);
- utility-proportional rewards (work-unit tiers stay);
- any second live scoring law (shadow mode is comparison, not payout);
- graded/partial per-task utility (§2.2 keeps u binary);
- per-patch surface-claim classification (V2's classifier — dropped, §14.1);
- a separate third broad-safety pack (§14.1);
- label commit-reveal corpus distribution (§6.5 — v2 escalation path only).

Also standing: no r5 tuning beyond the single A2 unbrick transition
(`c677e36`, built NOT armed); prefer deleting a proposed mechanism over
adding a compensating one; every silent cap or sampling bound in any harness
must be logged, never implied as full coverage.

---

## 13. Determinism (I5) — honesty clause, reranker status, and the deterministic judge

### 13.1 The reranker survives v1

Qwen3-Reranker-0.6B stays in stage-2, UNCHANGED (model, revision,
promptTemplateHash pins, fp32/tf32-off/cuda health checks,
`remote-scorer-verify.ts:207-225`). Removing it would be a second
simultaneous law change and would invalidate the CPU↔GPU tolerance
calibration. What changes is its ROLE: under r5 the reranker's output ranks
ARE the reward (nDCG@10 at 0.70+ weight); under BMU it is retrieval plumbing
whose ordering feeds a set-membership judge. I6's verbatim phrase "once the
LLM reranker is gone" (§16) is to be read as the reranker losing its
REWARD-CARRYING role from v1 day one (and possibly the pipeline in some
future version) — I6 carries the anti-indexer burden NOW, not after a future
removal.

### 13.2 The deterministic judge ranking rule (fixes the quantization/replay conflict at the law level)

Binary utilities on a 15,625-ppm lattice cannot hide inside a 250-ppm replay
band: ONE fp-jitter-induced task flip at replay would be a guaranteed
mismatch (rev1's flaw). BMU removes the jitter at the decision, not the gate:

- **Quantized-score ranking:** the judge ranks candidates by reranker scores
  QUANTIZED to a bundle-pinned grid `judgeScoreGrid` (default 1e-3 in
  normalized rerank-score space), ties broken by `codePointCompare(docId)`.
  Rank order — hence every top-B membership decision — is then invariant to
  any cross-implementation score deviation < grid/2, except when a true
  score lies within grid/2 of a grid boundary with a within-one-cell
  neighbor.
- **Certification margin screen (P2, mandatory):** a task is certified only
  if, on the blank-state, parent, AND oracle-solved substrates, every
  required/forbidden doc's quantized-score gap to the rank-B boundary is
  ≥ 3 grid cells. Boundary flips become certified-rare, not structural.
  (rev1 screened only the no-substrate baseline; replay re-scores the
  CANDIDATE, so the oracle-solved state must be screened too.)
- **Evaluated alternatives (review options):** (i) multi-instance tasks —
  already the design (a motifGroup's rows are its instances) but does not
  change the per-ROW quantum, so it is not a granularity fix; (ii) Phase-0
  staircase grading — adopted at the CALIBRATION level (§2.4), rejected as
  per-task partial credit (any graded credit below the forbidden-veto
  reopens rank-shaving reward); (iii) rank-margin epsilon rule — folded in
  as quantization+certification (a per-decision epsilon band is itself
  boundary-unstable; a total order from grid+tiebreak is deterministic);
  (iv) flip-tolerant replay (±1 flip) — REJECTED: it hands the scorer a
  15,625-ppm unrefutable ambiguity band, larger than the entire acceptance
  threshold — validators could never refute a one-flip-inflated signing.

### 13.3 Tolerance bands restated

- 250-ppm replay band and 5-ppm CPU↔GPU band SURVIVE unchanged as the
  verifier gates; under BMU they are satisfied by ZERO row flips (any flip =
  15,625 ppm = loud failure, which is the correct outcome given §13.2 makes
  flips certified-rare). G-B11 is read as: replay/validator runs reproduce
  identical u(row) decisions; the underlying score-space comparison harness
  keeps the 5-ppm band. P3 MUST include a ≥10k-replay zero-flip soak gate.
- No gate, test, or verifier may assert bit-identical replay of raw reranker
  SCORES (stage-1/stage-2 float math is still float math). Determinism is
  claimed for DECISIONS, not scores.
- Validators remain CPU-only by contract.

---

## 14. Deltas from ancestors

### 14.1 vs Acceptance Rule V2 (`.ops/coretex-production-scoring-gap-fix-plan.md`, Phase 4)

Inherited verbatim:
- the seen/confirm/independent-seeds discipline and future-blockhash
  anti-indexing (V2 "Seeded Pack Selection" → §6.1);
- "pack metadata can be hidden, but the selection rule must be replayable
  after epoch reveal from committed corpus/profile data" → §6.6, verbatim as
  a requirement;
- the fail-closed verifier posture: seed echo, focused-scores==proof-scores,
  threshold-fields match, artifact spooled before signing → §8.2/8.3;
- "introduce a new proof kind rather than overloading old semantics
  silently" → `'coretex-bmu-dual-pack-v1'`;
- floors-as-safety (protected / regression / structural) → §2.5, re-based
  quantization-aware.

Changed:
- V2's FOCUSED positive packs (drawn by claimed surface/motif class) become
  full-breadth family-quota'd packs whose positive signal is
  composition-weighted utility. V2 shrank the positive lens to the patch's
  claimed surface; BMU instead makes the corpus dense enough (typed clusters
  + guaranteed fresh-frontier share, §6.2) that a real patch moves pack
  utility. Rationale: the Stage-1 measurement showed surface/subject focusing
  collapses to ~1 row on this corpus — "score the patch on the row it
  targets" — the gaming hazard V2's own non-negotiables warn about ("No
  hidden doc-id targeting in production pack selection").
- V2's confirm = second draw of the same focused law; BMU's confirm =
  HELD-OUT motif instances (disjoint entities/templates, §6.3) — confirm
  changes meaning from "repeatability" to "transfer".
- V2's ratio floors → absolute row-count regression budgets (§2.5).

Dropped (deliberately, with reason):
- the deterministic patch-claim surface CLASSIFIER — under BMU no claim is
  needed; every patch is scored on all four families every time. Removing it
  deletes a public-schema parsing surface and its gaming margin.
- the separate BROAD SAFETY pack — V2 needed it because its positive packs
  were narrow; BMU's gate/confirm are already 64-row all-family broad, so the
  safety floors run on those same packs (§2.5). One less pack per evaluation
  (~33% scorer cost saving per acceptance) and one less pack law to attest.
- the `coretex-surface-aware-v2` proof kind — never shipped; superseded by
  `'coretex-bmu-dual-pack-v1'`.

### 14.2 vs Stage-4 / typed clusters (`.tmp-coretex-mining-unstall-plan.md`) and Track A2 (`c677e36`)

Inherited verbatim:
- the frontier overlay ATTESTATION machinery as landed (Stage 4:
  `EpochFrontierPin.liveEvalPack`, root-verified active-id artifact,
  fail-closed both-direction pairing at `production-evaluator.ts:770-790`,
  scorer/verify/replay threading, on-chain `activeFrontierRoot`);
- A2's bounded-drain retirement semantics (`c677e36`: oldest-activation-first
  aged drain capped at `maxRootDeltaPerEpoch`, budget shared with churn; the
  9319→19 mass-flush hazard is the forbidden mode) — BMU §6.2/§6.5 build the
  retire-on-exposure queue on the same bounded drain;
- A2's namespace resolution (quota strata in bucketed-family names,
  familyPriority in logicalFamily names — §5.6);
- typed-cluster generation as the substrate of mineability
  (`buildTypedTemporalClusterSpec`, `scripts/lib/evolve-corpus.mjs:114-188`),
  the capability schedule + escalation (`:199-215`), attribute rotation
  (`temporalAttributeForEpochSlot`, `:71-81`) and the motif-amplification
  law it manages (an attribute is one-shot headroom; rotation is the
  anti-exhaustion mechanism);
- the real-model validation discipline: the deterministic reranker is NOT a
  mineability oracle (the G0B proxy-artifact lesson); every family enters the
  capability schedule only behind its own real-model G1-style gate;
- Stage 1's conclusion, adopted as designed: cluster-aware acceptance is only
  sound once a patch-derived focus maps to MULTIPLE hidden rows — BMU's
  composition-weighted aggregation over cluster-dense packs is that design,
  matured.

Changed:
- the overlay ADMISSION rule: newest-first seed-independent
  (`admitActiveLiveEvalEvents`, `hidden-query-pack.ts:392-399`) → seeded
  per-slot draw from the fresh cohort with confirm-side exclusion (§6.4) —
  the ONE inherited pack mechanism BMU modifies, replay-safe when the new
  parameters are absent;
- broad-pack eligibility: frontier-blind (today's `deriveQueryPack` samples
  all eval_hidden; the unstall plan's A4 finding) → frontier-aware (Stage-4
  §A5 `activeIds` design made mandatory, §6.5) — this is what makes A2's
  retirement machinery bite on scored packs;
- Stage-3 clusters were minted to be liftable under the r5 composite
  (nDCG-graded golds, trap as graded negative, wording tuned to Qwen
  headroom); BMU clusters carry explicit `bmuTask`
  required/forbidden/budget/template fields, and the trap becomes a hard
  veto (§4/§5). The "Qwen-headroom wording" constraint DISSOLVES: hardness
  certification (I8/G-B1) replaces wording-vs-reranker tuning as the
  admission bar;
- liveeval8's `{limit: 8, temporal-only, maxAge: null}` and ANY null-maxAge
  arming become ILLEGAL for BMU bundles (§6.2); the concrete BMU pins
  (limit 12 under 50-row quotas, all-family priority, maxAge 32) supersede
  rev1's un-armable "limit ≥ 16" mandate.

Dropped:
- K-of-N broad-pack acceptance (measurement instrument only; structurally
  rewards one-query fishing — R2 violation, per the operator decision
  framework);
- subject-motif focused packs (diagnostic only; ~1-row scope, gaming hazard);
- relation category-lens as a LEAD surface (measured zero headroom on the r5
  law; under BMU the multi_hop_relation family re-enters through generated
  bridge tasks + hardness certification instead of lens re-tuning).

---

## 15. Contradictions and citation drift found while verifying (for the record)

1. **verifyScorerResult check count:** the handoff says "8 checks"; the code
   comment says "The six checks"
   (`src/coordinator/remote-scorer-verify.ts:140-145`) while the body
   enumerates (1)-(8) (`:158-322`). The CODE has 8; the docstring is stale.
   This spec follows the code.
2. **Hidden-pack quota citation:** handoff §2.3 cites quotas
   temporal(14)/near_collision(12)/multi_hop_relation(16)/conflict_lifecycle(10)
   at `bundle/index.ts:857-865`. At commit `20412b5` that location is
   `DEFAULT_HIDDEN_PACK_PROFILE` with four `minCount: 4` quotas over strata
   including `long_horizon` (not conflict_lifecycle)
   (`src/bundle/index.ts:857-865`). The 14/12/16/10 quotas are real but live
   in the PINNED bundle manifest
   (`release/calibration/2026-06-04-memory-atom-v16/bundle-manifest-…-liveeval8.json:161-180`),
   not in the code default.
3. **Composite weights:** code default is 0.75/0.08/0.07/0.05/0.05
   (`src/eval/retrieval-benchmark.ts:57-63`, assembled `:3246-3251`); the
   unstall plan's Appendix A6 records 0.70/0.13/0.07/0.05/0.05 — that is the
   live BUNDLE profile, not the code default. Not a real conflict, but any
   BMU doc quoting "the r5 weights" must say which.
4. **Dual-seed citation:** `per-patch-evaluator.ts:160-174` is the RECEIPT's
   gate/confirm fields; the derivation itself is `:385-386` via
   `src/eval/seed-derivation.ts:138-146`. Same flow, drifted line pointer.
5. **Decoder path:** cited as `eval/retrieval-decoder.ts`; the file is
   `src/substrate/retrieval-decoder.ts` (line ranges were accurate).
6. **work-units citations** (`rewards/work-units.js:34,54-57,86`) are into
   the built dist; source equivalents are `src/rewards/work-units.ts` —
   tier table `:105-110`, screener-threshold controller `:207-266`,
   `MAX_CORETEX_WORK_BPS` `:21`, qualification reasons `:143-149`.
7. **(rev2) Handoff §5.1-I9 "hidden qrels/answers/seeds stay private":** true
   at the public-endpoint (Tier-P) surface only. The corpus distribution
   architecture necessarily exposes all row labels to validator-tier actors
   (§6.5 verified facts). SEEDS stay private pre-reveal at every tier. The
   invariant text is kept verbatim in §16 with this reading noted.

---

## 16. Invariants I1-I10 (NORMATIVE — copied verbatim from `CORETEX_VNEXT_BMU_E2E_HANDOFF.md` §5.1)

Violating any of these = scope error; stop and re-read.

- **I1 — Single scalar.** BMU emits one scalar ppm in [0, 1e6] compared
  against a parent baseline with `candidate − parent ≥ threshold` acceptance.
  Internally stage-aware; externally one number + ONE rejection reason. This
  preserves screener math, work-unit tiers, EIP-712 receipts, on-chain
  registry, and baseline restore UNCHANGED.
- **I2 — Ships on the existing r5 STATE layout.** No r6 region reclaim, no
  multi-vector key carve-out in v1. New pipelineVersion (working name
  `coretex-bmu-v1-r5state`), new decode law = r5 decode law. One law change
  per transition, never a state-layout + scoring-law change together.
- **I3 — Four families, no more:** the existing quota families —
  temporal (current/stale/supersession), conflict_lifecycle,
  multi_hop_relation (incl. bridge/coreference framing), near_collision/
  abstention. Coreference-as-family, causal-chain, and
  compression-under-budget are DEFERRED to v2, contingent on v1 shadow
  results.
- **I4 — Budget = top-B evidence items, not tokens.** Each hidden task
  specifies required evidence atoms, forbidden (stale/decoy) evidence, an
  accepted answer id/value, and a small fixed B. Utility is earned iff the
  answer is recoverable from the top-B retrieved items with no forbidden item
  admitted. No tokenizer metering (that adds a determinism surface for ~zero
  discriminative gain). "Retrieve everything and rerank" fails by construction
  because B is small.
- **I5 — Deterministic structured judges** (qrels/atoms per task), no live
  LLM judge in the reward path. HONESTY CLAUSE: stage-1 dense retrieval is
  still float math, so full bit-exactness is NOT achievable — the 250-ppm
  replay and 5-ppm CPU/GPU tolerance bands survive. Do not write gates that
  assume bit-identical replay.
- **I6 — Anti-gaming core = repurposed dual pack.** Gate pack = seen motif
  instances; confirm pack = HELD-OUT instances of the same motif families
  (disjoint entities/templates). A patch that only anchors exact hidden docs
  passes gate and structurally dies on confirm, every time. This is
  per-acceptance, not a launch-time check, and reuses
  `per-patch-evaluator`'s two-seed flow verbatim. This invariant carries the
  entire anti-1:1-indexer burden once the LLM reranker is gone — it is not
  optional.
- **I7 — Pack-lifecycle invariants (ported Track A concepts, now spec-level):**
  (a) every scored pack contains a guaranteed fresh-frontier share across ALL
  active families (promoted from tuning knob to invariant); (b) retirement by
  age on by default; (c) `maintenance_due` forcing; (d) headroom
  watermarks → evolve coupling; (e) two-pass rebaseline is the ONLY sanctioned
  law-transition path.
- **I8 — Frontier admission = base-stack failure.** Evolve admits a candidate
  task only if: no-substrate BGE(+Qwen where applicable) fails or has low
  margin at the same budget; an oracle structural solver succeeds; and
  false-negative screens pass. Adversarial corpus poisoning is an OFFLINE
  hard-case discovery tool only — never a production generator.
- **I9 — Miner contract:** public motif families, relation/supersession/
  conflict structures, and worked examples via the EXISTING public-corpus
  endpoints; hidden qrels/answers/seeds stay private. One scalar + one
  rejection reason from a redesigned, small rejection taxonomy (the current
  taxonomy — no_retrieval_improvement / render-trace ambiguity /
  gate-acceptance-floor — is a documented friction source; taxonomy design is
  part of spec freeze, it is miner-facing API).
- **I10 — Don't parallel-invent.** BMU spec documents descend from Acceptance
  Rule V2 (`.ops/coretex-production-scoring-gap-fix-plan.md`) and Stage-4
  (`.tmp-coretex-mining-unstall-plan.md`) — inherit their mechanisms
  explicitly, cite them, and state deltas.

**Clarifying notes (spec-level, OUTSIDE the verbatim text above):**
(a) I6's "reuses per-patch-evaluator's two-seed flow verbatim" holds — the
SEED flow is untouched (§6.1); the overlay ADMISSION rule beneath it is the
one named modification (§1, §6.4). (b) I6's "once the LLM reranker is gone"
is read per §13.1: the reranker loses its reward-carrying role in v1 and I6
carries the burden immediately; the model itself survives. (c) I9's "hidden
qrels/answers/seeds stay private" is read per the §6.5 two-tier model:
labels are private at the Tier-P (public endpoint) surface; validator-tier
label visibility is architectural fact under r5 and BMU alike; seeds are
private pre-reveal at every tier.

---

## 17. Changelog rev1 → rev2 (adversarial-review response)

- **B1 (un-armable overlay mandate):** rev1's `limit ≥ 16` violated the
  existing validation `limit ≤ packSize − Σquotas`
  (`bundle/index.ts:1492-1499`). rev2 pins concrete armable numbers: quotas
  10/15/15/10 = 50 ⇒ cap 14; limit 12 (adopting A2's measured resolution,
  `c677e36`); maxAge 32 with A2's bounded oldest-first drain (mass-flush
  9319→19 hazard forbidden). No validation-code change needed for the limit;
  §9 site 17 lists the BMU-bundle validation additions.
- **B2 (false privacy premise):** rev2 verifies and documents that validators
  hold the full labeled corpus (single root-pinned file, delta-chain
  distribution — `validator-sync-cli.ts:1419,2060-2087,2212`), defines the
  Tier-P/Tier-V adversary model, and replaces the premise with three coupled
  mechanisms: forbidden-trap task construction (label knowledge alone earns
  nothing), frontier-aware broad-pack eligibility + retire-on-exposure +
  retire-by-age through A2's bounded drain (zero new pins), and published-
  artifact per-row telemetry redaction. Commit-reveal recorded as the v2
  escalation path. Residual-risk arithmetic included (~1.1e-4/miner-epoch
  lucky-dual-sample channel, pre-operation-requirement).
- **B3 (seed-independent overlay defeats I6 on fresh rows):** rev2 makes BMU
  overlay admission a seeded per-slot draw from the fresh cohort (gateSeed /
  confirmSeed) with confirm-side motif/entity/template exclusion; contract
  deltas to `deriveScoredQueryPack`/`admitActiveLiveEvalEvents` specified,
  absent-parameter behavior byte-identical (replay-safe); §1's "verbatim"
  claim amended to name this delta.
- **B4 (binary quantization vs tolerance bands):** rev2 replaces per-family
  arithmetic weights with composition weighting — uniform per-row quantum
  1e6/64 = 15,625 ppm — pins `minImprovementPpm = 20,000` (1 flip = screener,
  ≥2 flips = advance; honest cluster patches 3–5 flips = 2.3–3.9× floor),
  and fixes replay at the decision level: quantized-score ranking with
  docId tiebreak + P2 certification margins on blank/parent/oracle states;
  flip-tolerant replay explicitly rejected (unrefutable 15,625-ppm signing
  ambiguity). Tolerance bands survive; G-B11 = zero-flip decisions.
- **M5 (floors on a binary lattice):** ratio floors replaced by absolute
  regression budgets (≤1 row/family, ≤2 total; protected rows zero-tolerance
  hard veto — the BMU meaning of `retrieval-benchmark.ts:3322-3341`).
- **M6 (abstention):** the signal is named — the r5 policy-atom decision
  (`:2319-2342,:3191-3200`); the atom-less fallback threshold rule excluded
  from u(t) (no free blank-state abstention utility); false-abstain
  counterweight added to answerable u(t) with the always-abstain control in
  P4/G-B5; Qwen retained in v1 stage-2, §13 hedge fixed.
- **M7 (schema-less exclusion key):** `templateId` added to bmuTask
  (REQUIRED, generator-stamped) with a mint-time template-partition law;
  exclusion key = motifGroupId ∪ subjectEntityId ∪ templateId, all
  schema-anchored.
- **M8 (family namespaces):** §5.6 adds the four-namespace mapping table,
  measured on the live epoch-136 corpus (11 logicalFamily values enumerated,
  incl. the disabled `aspect_constraint` and the quota-less `coreference`
  bucket), plus the quota-vs-familyPriority namespace split A2 hit.
- **Minors:** launch-preflight gate sites added (§9 site 16);
  `no_retrieval_improvement` + innerRejectionReason wired into the taxonomy
  mapping (§7.3); the holdout 1-bit oracle + patchHash seed re-roll channel
  acknowledged and bounded (§7.3); citation fixes (`:3071`; proof `domain`
  fields; `baselineVariancePpm` source rule).
