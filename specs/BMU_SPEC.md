# BMU v1 — Budgeted Memory Utility: the permanent CoreTex scoring law

**Status:** SPEC FREEZE candidate (Track B, phase P1 B-lane). No production code
accompanies this document. Nothing here arms, pins, or deploys anything.

**Pinned code baseline:** every `file:line` citation below is into THIS
repository at commit `20412b5` (branch `coretex-c1-work-policy`), verified
2026-07-06. Paths are relative to the repo root (`packages/coretex/src/…`
abbreviated `src/…`; epoch-runner scripts under `scripts/…`).

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
overlay). §14 states exactly what is inherited, changed, and dropped.

---

## 1. Scope and non-scope

BMU v1 REPLACES the r5 scoring law: the objective function, the judge, and the
composite currently assembled at `src/eval/retrieval-benchmark.ts:3246-3251`
(`0.75·nDCG@10 + 0.08·temporal + 0.07·relation_recall + 0.05·abstention +
0.05·structural_sanity`, weights hard-floored to `w_retrieval ≥ 0.70` by
`assertValidWeights`, `src/eval/retrieval-benchmark.ts:84-93`). That floor is
the codified drift away from the Phase-0 intent (`specs/research_brief.md`
§4, lines 318-334) and CANNOT be rebalanced within r5; BMU does not try.

BMU v1 KEEPS, verbatim and unmodified in mechanism:

- dual-pack seed machinery (`src/coordinator/per-patch-evaluator.ts:385-386`;
  `src/eval/seed-derivation.ts:112-146` — domain-prefixed gate/confirm seeds
  from one pinned future blockhash + epoch secret);
- pack derivation and the frontier overlay
  (`deriveQueryPack` `src/eval/hidden-query-pack.ts:254-316`,
  `deriveScoredQueryPack` `:68-84`, `admitActiveLiveEvalEvents` `:364-479`);
- dedup/admission/per-miner caps, SQLite-authoritative on the coordinator;
- replay / validator / attestation machinery, including the fail-closed
  overlay pairing (`src/coordinator/production-evaluator.ts:770-790`);
- the no-substrate baseline lane and keyless `scoreState`
  (`src/coordinator/production-evaluator.ts:870-880`,
  `src/scorer-server-cli.ts:157-179,238-254`);
- the r5 STATE layout and decode law in full (I2; §3.2);
- work-unit tiers, screener-threshold controller, EIP-712 receipts, on-chain
  registry (`src/rewards/work-units.ts:105-110` tiers, `:207-266` screener
  threshold, `:21` max bps) — the scalar contract (I1) exists precisely so
  none of these change.

r5 survives as a replay-only law for historical artifacts: profile pins keep
old receipts replayable forever (`CORETEX_PIPELINE_VERSIONS_SUPPORTED`,
`src/eval/retrieval-benchmark.ts:544-547`). Standing rule restated: **no r5
composite/weight/surface-admission tuning, ever.**

---

## 2. The scalar law

### 2.1 One number, one reason (I1)

BMU emits ONE scalar in ppm, integer, clamped to `[0, 1_000_000]`. Acceptance
is `candidate − parent ≥ threshold`, evaluated per pack, with the state-advance
rule unchanged from today: `min(gateΔppm, confirmΔppm) ≥ threshold`
(`src/coordinator/production-evaluator.ts:676-677`). The acceptance threshold
formula is UNCHANGED: `minImprovementPpm + replayTolerancePpm +
baselineVariancePpm` (`computeAcceptanceThresholdPpm`,
`src/eval/retrieval-benchmark.ts:107-121`; live values 500 + 250 +
variance). The screener threshold controller consumes the BMU scalar exactly
as it consumes the r5 scalar (`src/rewards/work-units.ts:207-266`); no field,
tier, bound, or W0x qualification reason changes.

Externally a rejected submission carries exactly ONE reason from the §7
taxonomy. Internal stage telemetry is recorded in the post-reveal artifact
only (§8.3), never in the miner-facing response.

### 2.2 Per-task utility (budget-B, I4)

Every BMU-scored hidden row is a TASK (schema in §4). For a task `t` with
budget `B_t`, required evidence set `R_t`, forbidden evidence set `F_t`, and
accepted answer id `a_t`:

Let `top-B` be the first `B_t` documents of the FINAL reranked ordering — the
same stage-2 output ordering whose head `rerankerTopK` (10, live profile)
already defines scored ranks. `B_t ≤ 8 < rerankerTopK` always (§4.2), so the
budget is a strict tightening of the existing cap, not a new pipeline stage.

```
u(t) = 1  iff  R_t ⊆ top-B  AND  F_t ∩ top-B = ∅  AND  a_t ∈ top-B
u(t) = 0  otherwise
```

For abstention-variant tasks (`abstain: true`; `R_t = ∅`, `a_t` absent):

```
u(t) = 1  iff  F_t ∩ top-B = ∅  AND  the evaluator's abstention signal fires
              (the existing abstention decision the r5 abstention component
               already computes; BMU reuses that signal, not a new one)
u(t) = 0  otherwise
```

Utility is BINARY. No partial credit, no graded margins in v1 (a margin term
is a tuning surface and a gaming surface; DEFER, §12). "Retrieve everything
and rerank" fails by construction: `B` is small and forbidden items are
planted adjacent to required ones, so indiscriminate recall admits a forbidden
item. There is NO tokenizer metering (I4).

### 2.3 Family aggregation and weights

For each of the four families `f` (I3, §5), over the tasks of family `f`
present in the scored pack:

```
U_f = (Σ_{t ∈ pack, family(t)=f} u(t)) / |{t ∈ pack : family(t)=f}|
BMU_ppm = clamp( round( 1_000_000 · Σ_f w_f · U_f ), 0, 1_000_000 )
```

Family presence is guaranteed by pack quotas (§6.2), so no `U_f` is ever
0/0; an unsatisfiable quota fails pack derivation closed, exactly as today
(`deriveQueryPack` throws, `src/eval/hidden-query-pack.ts:292-296,306-308`).

**Weights (v1 pinned):**

| family                      | w_f  |
|-----------------------------|------|
| temporal                    | 0.20 |
| conflict_lifecycle          | 0.30 |
| multi_hop_relation          | 0.30 |
| near_collision / abstention | 0.20 |

**Reconciliation with Phase-0 (the three-vs-four family question).** Phase-0
LOCKED 60/20/20 = long-horizon compression 0.60 / near-collision 0.20 /
temporal-revocation 0.20 (`specs/research_brief.md:318-334`), with the
explicit rationale that 0.60 goes to the one family that does not saturate.
BMU v1 has FOUR families and — per I3 and the DEFER list — no compression
family yet. The mapping chosen here:

- temporal-revocation 0.20 → `temporal` 0.20 (direct descendant, unchanged);
- near-collision 0.20 → `near_collision/abstention` 0.20 (direct descendant;
  abstention was always this family's trap side);
- long-horizon compression 0.60 → re-homed, split evenly, onto
  `conflict_lifecycle` 0.30 + `multi_hop_relation` 0.30 — the two v1 families
  that exercise persistent STRUCTURED state across the corpus (lifecycle
  resolution chains; bridge/coreference traversal), i.e. the closest v1
  proxies for "memory as compressed evolving state" (MemoryArena framing,
  §11). When the compression family enters in v2 (behind its own G1-style
  gate), it takes its weight back FROM these two, not from the direct
  descendants.

This keeps the Phase-0 *shape* (majority weight on the non-saturating
structural axis, equal minority weights on the two anti-gaming families)
without pretending the deferred family exists. No single family exceeds 0.30,
which under-writes gate G-B8 (no family > 50% of achievable score) by
construction at the weight level.

**Weight validation.** BMU MUST NOT reuse `assertValidWeights`
(`src/eval/retrieval-benchmark.ts:84-93`) — its `w_retrieval ≥ 0.70` floor is
r5 law and must stay untouched for r5 replay. BMU adds a parallel
`assertValidBmuWeights`: weights sum to 1 (±1e-6); every family weight in
`[0.15, 0.35]`; exactly the four v1 families present. The bounds make a
future silent collapse-toward-one-family re-tuning a code change that fails
review, not a config drift.

**Structural sanity is a FLOOR, not a weight.** r5's 5% `w_structural_sanity`
component is dropped; structural validity keeps its existing HARD-floor role
(`structuralFloor: 0.95` in `PatchAcceptanceFloors`,
`src/eval/retrieval-benchmark.ts:3267-3271`, live pin at
`release/calibration/2026-06-04-memory-atom-v16/bundle-manifest-…-liveeval8.json:145-154`).
Paying score for "being structurally valid" was headroom-free filler; failing
closed on invalidity is the correct semantics and already exists.

### 2.4 Floors carried over

On BOTH gate and confirm packs, acceptance additionally requires (reusing the
existing floor machinery and pins, semantics re-based onto family utilities):

- structural validity ≥ `structuralFloor` (unchanged);
- per-family no-catastrophic-regression: for every family `f`,
  `U_f(candidate) ≥ familyCatastrophicFloor · U_f(parent)` (floor value
  inherited, live 0.85);
- protected-record regression floor on protected rows (unchanged mechanism,
  `protectedRegressionFloor` 0.05).

There is NO separate third "broad safety pack" in BMU v1 — see §14.1 for why
this V2 mechanism is deliberately dropped rather than inherited.

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
          | "near_collision_abstention",       // REQUIRED
  "budgetB": 3,                                 // REQUIRED, integer 1..8
  "requiredEvidence": ["d0000157", "d0000158"], // REQUIRED, doc ids, may be []
                                                // only when abstain=true
  "forbiddenEvidence": ["d0000155"],            // REQUIRED, doc ids (stale/decoy)
  "answer": { "id": "d0000157",                 // REQUIRED unless abstain=true
              "value": "vegan" },               //   value: audit-only, optional
  "abstain": false,                             // OPTIONAL, default false
  "motifGroupId": "mg_e137_temporal_0042"       // REQUIRED — held-out partition
                                                //   key (§6.3). Generator-pinned,
                                                //   hidden until epoch reveal like
                                                //   the rest of the eval_hidden row.
}
```

Load-time validation (fail-closed, corpus refuses to load):
`answer.id ∈ requiredEvidence` (when not abstain);
`requiredEvidence ∩ forbiddenEvidence = ∅`; every referenced doc id exists in
the corpus; `|requiredEvidence| ≤ budgetB`; `abstain=true ⇒ requiredEvidence
= [] ∧ answer absent`; `family` matches the row's `logicalFamily` mapping
(§5). `motifGroupId` MUST be non-empty and MUST be shared by every row minted
from the same memory structure (cluster) and by no row minted from a different
one.

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
  id-hash split (`splitForRecord`, `src/eval/retrieval-corpus.ts:359-382`);
  the typed-cluster minter already assigns ids so the split lands correctly
  (unstall plan, Stage-3 G0A).
- `validity` (`:220-221`, type `:172-179`): unchanged and still REQUIRED on
  temporal-family docs — `temporalRecordAppliesToQuery` scoping depends on it.
- `band` (`:279`): unchanged; still generator difficulty metadata feeding
  band strata (`strataOf`, `src/eval/hidden-query-pack.ts:163-194`).
- `logicalFamily` (`:293`): unchanged; BMU pack quotas keep preferring it over
  `family`, as the overlay already does
  (`src/eval/hidden-query-pack.ts:381-383`).
- `qrels` / `truthDocuments` / `hardNegatives`: RETAINED on BMU rows. They are
  (a) the replay substrate for r5-law historical artifacts, (b) the hardness-
  certification input (P2), and (c) the generator's source of truth from which
  `requiredEvidence`/`forbiddenEvidence` are derived. For BMU SCORING they are
  inert: `bmuTask` is authoritative. Consistency rule at mint time (not load
  time — old corpora can't satisfy it): `requiredEvidence ⊆ {qrels with
  relevance ≥ 0.5}` and `forbiddenEvidence ⊆ {qrels with relevance = 0} ∪
  hardNegatives`.
- Pack eligibility: under `coretex-bmu-v1-r5state`, ONLY rows carrying a valid
  `bmuTask` are hidden-pack-eligible (the BMU analog of the existing
  `hiddenPackEventEligible` filter at `src/eval/hidden-query-pack.ts:264`).
  A BMU bundle over a corpus without enough `bmuTask` rows to fill quotas
  fails pack derivation closed.

---

## 5. Family definitions ×4 (I3)

Exactly these four. Coreference-as-family, causal-chain, and
compression-under-budget are DEFERRED to v2, contingent on v1 shadow results.
Each family below states: what the miner's substrate must DO, what utility is
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
  these in top-B zeroes the task. Under r5 the trap was a graded negative; under
  BMU it is a hard veto — this is the family's anti-lexical-shortcut screen.

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
  admitting ANY plausible decoy when no answer exists.
- **Utility earned:** answerable variant — the exact-match doc in top-B with
  all sibling decoys excluded; abstention variant — zero forbidden docs in
  top-B and the existing abstention signal fires (§2.2).
- **Trap/forbidden:** the sibling decoy set itself (the near-collisions ARE
  the forbidden list). This family is the anti-gaming counterweight: a
  substrate that blindly boosts everything it has anchored fails here first.

---

## 6. Gate/confirm derivation: seen vs held-out (I6)

This invariant carries the ENTIRE anti-1:1-indexer burden once the reranker
composite is gone. It is per-acceptance, not launch-time.

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

### 6.2 Pack composition

The BMU hidden-pack profile keeps `packSize: 64` and keeps quota-first
derivation. Quotas MUST cover all four families (the live r5 bundle already
quotas exactly these four: temporal 14 / near_collision 12 /
multi_hop_relation 16 / conflict_lifecycle 10 —
`release/calibration/2026-06-04-memory-atom-v16/bundle-manifest-…-liveeval8.json:161-180`;
BMU v1 SHOULD start from those numbers). Per I7(a), every scored pack MUST
carry a guaranteed fresh-frontier share across ALL active families: the BMU
bundle arms `epochFrontier.liveEvalPack` with `limit ≥ 16` and
`familyPriority` spanning all four families, and — promoted from tuning knob
to invariant — a bundle that arms `coretex-bmu-v1-r5state` with
`liveEvalPack.limit < 16`, a single-family `familyPriority`, or `maxAge: null`
MUST fail bundle validation (the anti-liveeval8-regression rule; the live
bundle's `{limit: 8, temporal-only, maxAge: null}` is the documented
counterexample). Default `maxAge`: 12 epochs.

### 6.3 The derivation function contract

```
deriveBmuDualPacks(input: {
  epochId: number,
  gateSeedHex: string,        // deriveGateEvalSeed output
  confirmSeedHex: string,     // deriveConfirmEvalSeed output
  corpus: ProductionCorpus,
  profile: HiddenPackProfile, // BMU pack profile (quotas over the 4 families)
  activeLiveEval?: { activeIds, law },   // same overlay input as today
}): { gate: QueryPack, confirm: QueryPack }
```

1. **Gate pack (seen motifs):**
   `gate = deriveScoredQueryPack(epochId, gateSeedHex, corpus, profile,
   activeLiveEval)` over the bmuTask-eligible pool — the existing composition
   (`src/eval/hidden-query-pack.ts:68-84`), unchanged.
2. **Exclusion key set:** `X = { motifGroupId(e) } ∪ { subjectEntityId(e) } ∪
   { entity-bank template ids of e }` for every `e` in the gate pack.
3. **Confirm pack (held-out motifs):**
   the SAME derivation with `confirmSeedHex`, over the bmuTask-eligible pool
   MINUS every row whose `motifGroupId`, `subjectEntityId`, or template id is
   in `X` — same family quotas, same overlay law. HELD-OUT means: same motif
   FAMILIES, disjoint entities AND disjoint surface templates.
4. **Fail-closed:** if the residual pool cannot satisfy the quotas, the
   evaluation REFUSES (maps to `stale_context` externally only if caused by a
   frontier transition; otherwise it is an operator alarm — the generator is
   obligated to mint ≥ 2 clusters per family per epoch precisely so both
   packs can always fill; see G-B9).

Gate-before-confirm ordering is part of the law (the exclusion is
asymmetric and deterministic).

**Why this kills the exact-anchor miner, structurally:** a patch that only
anchors the specific hidden docs it has fished for can pass the gate pack
(those motif instances may be sampled) but the confirm pack contains ONLY
different-entity, different-template instances of the same families — its
anchors reference nothing there, `U_f(candidate) = U_f(parent)`, `confirmΔ ≈
0 < threshold`, reject `failed_holdout_transfer`. A patch encoding the motif
OPERATION (supersession record, conflict atom, relation route) transfers,
because the scorer applies the operation to whatever instances the pack
sampled. This resolves Stage 1's 1-query-per-subject soundness problem from
the other side: instead of focusing packs onto the patch's one target row
(gaming hazard), BMU makes clusters dense enough (typed clusters + fresh-
frontier share) that family-level utility is movable, and makes transfer —
not presence — the acceptance test.

### 6.4 Replayability post-epoch-reveal

Everything in §6.3 is a pure function of
`(epochId, epochSecret, blockhash, patchHash, parentRoot, corpusRoot,
bundleHash, corpus, profile, activeFrontier ids)`. After epoch reveal,
validators re-derive both seeds from the revealed secret (the existing
post-reveal re-derivation backstop, `per-patch-evaluator.ts:138-146` comment)
and recompute both packs byte-identically — `motifGroupId` is on the revealed
rows, the exclusion set is recomputed, no coordinator-private state exists.
The validator replay path (`src/validator-sync-cli.ts`) verifies pack
composition exactly as it does today for the overlay law.

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
real scorer reject is by-design, and the reason string
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
| `safety_regression`       | improvement somewhere, but a floor tripped (structural / protected / per-family catastrophic) |
| `stale_context`           | parent root or epoch context advanced mid-flight; resubmit against live root |

### 7.3 Mapping from internal stages (each internal failure → exactly ONE external reason)

| internal (current codes, `per-patch-evaluator.ts:167-176`, `work-units.ts:143-149`, verify codes) | external |
|---|---|
| `structurally-invalid`, `admit-malformed-input`, apply_failed E0x, policy-region violations, `SCORER_RESULT_MALFORMED`/`SCORER_ARTIFACT_MALFORMED` | `malformed_patch` |
| `cached`, `duplicate-key-collapsed`, `per-miner-cap-reached` | `duplicate_or_capped` |
| `gate-below-threshold`, `SCORER_BELOW_THRESHOLD` (gate side) | `below_gate` |
| `confirm-below-threshold` (gate cleared) | `failed_holdout_transfer` |
| `gate-acceptance-floor`, `confirm-acceptance-floor` (floor trip, not composite shortfall) | `safety_regression` |
| `W02_STALE_PARENT`, `SCORER_STALE_CONTEXT`, §9 stale-root re-check | `stale_context` |
| scorer-integrity refusals (`SCORER_JOB_ID_MISMATCH`, health/pin/seed-commit/echo mismatches) | never miner-visible as a reject: coordinator-internal retry/alarm; the miner sees only a still-pending or `stale_context` outcome |

Internal reasons remain in the artifact for audit; the wire response carries
the external reason and — unchanged anti-oracle stance — redacted (zero)
scores on rejection. `below_gate` vs `failed_holdout_transfer` is the one
deliberate information grant: it tells a miner WHETHER their patch is inert
or overfit, which is exactly the pedagogy the lane needs, and it leaks no
per-row information (both packs are 64-row aggregates behind a threshold).

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
   mechanism; the pinned bundleHash is now the BMU bundle.
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
  commits, pins, optional `activeFrontierRoot`, gate/confirm
  {seedCommit, accepted, scorePpm}) with `kind` changed. Descends from
  `'coretex-dual-pack-v1'` and supersedes the planned
  `'coretex-surface-aware-v2'` (never shipped; §14.1).
- New artifact version: `'coretex-bmu-post-reveal-eval-report-v1'` (vs
  `'coretex-post-reveal-eval-report-v1'`,
  `src/coordinator/production-evaluator.ts:679`), hashed by the SAME
  canonical hasher (`hashPostRevealEvalReportArtifact`), same spool-before-
  sign rule. `scoreDelta` remains canonicalized OUT of the eval/hash domain
  (handoff §2.1, `coretex-coordinator-core` `:822-828` in the vendored dist).
- Artifact body ADDS an internal-telemetry block (never wire-exposed to
  miners): per-family utilities `U_f` for gate and confirm on parent and
  candidate, per-task `u(t)` bitmaps, and the exclusion-set digest of §6.3 —
  this is what feeds the G-B8 family-collapse production alarm and replay
  audit.

### 8.4 `/score-state` result fields

- `ScorerStateJobResult` (`src/scorer-server-cli.ts:243-254`):
  `parentScorePpm`/`variancePpm` semantics become the BMU scalar (no rename).
  ONE additive optional field: `familyUtilitiesPpm?: Record<family, number>`
  — the per-family baseline decomposition the two-pass rebaseline (§10) and
  the coverage-collapse alarm need. Absent on r5-law responses; coordinators
  MUST tolerate absence.
- `evaluator.scoreState` (`production-evaluator.ts:870-880`): same
  composition guarantee — it MUST derive the state pack with the SAME BMU
  pack law (`deriveBmuDualPacks`'s gate-side composition with the
  caller-provided deterministic seed) so baselines are measured under exactly
  the law patches are scored under.

---

## 9. pipelineVersion gate-site checklist (`coretex-bmu-v1-r5state`)

r5 decode law unchanged (I2). Every site below was VERIFIED at commit
`20412b5`. For each: what must change when the new version is introduced.
Sites marked **[STATE]** must treat the new version exactly as r5
(set-membership); sites marked **[LAW]** must route scoring/validation to BMU.

1. **[LAW]** `src/eval/retrieval-benchmark.ts:541-547` —
   `CORETEX_PIPELINE_VERSION_R5` + `CORETEX_PIPELINE_VERSIONS_SUPPORTED`; add
   the new version constant + set entry; `assertPipelineVersionMatches`
   (`:74-82`, enforced at `:3070`) then admits it. The BMU objective replaces
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
  `coretex-baseline-recompute.ts:2-19`; proven live since ~epoch 133).
- **The blank-state trap is the reason:** blank-state ≠ parent baseline —
  measured 549,235 ppm blank vs the pinned parent baseline at the epoch-133
  transition. Under BMU the gap direction is not even predictable a priori
  (a blank substrate earns whatever stage-1 recall alone earns at budget B,
  per family). NO BMU bundle may be armed with a baseline that was not
  produced by scoring the actual parent substrate under the BMU law.
- **scoreState lanes:** both lanes ride the existing keyless machinery —
  blank-state lane (anti-cheat floor measurement; G-B1 evidence) and
  parent-baseline lane (the number acceptance thresholds are derived from),
  via `evaluator.scoreState` (`production-evaluator.ts:870-880`) and
  `POST /score-state` (`scorer-server-cli.ts:157-179`), deterministic
  caller-derived `baselineSeedHex` (never a future blockhash), bounded
  `samples`, variance reported. The §8.4 `familyUtilitiesPpm` addition makes
  the per-family baseline decomposition auditable at rebaseline time.
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
- a separate third broad-safety pack (§14.1).

Also standing: no r5 tuning beyond the single Track-A unbrick transition;
prefer deleting a proposed mechanism over adding a compensating one; every
silent cap or sampling bound in any harness must be logged, never implied as
full coverage.

---

## 13. Determinism honesty clause (I5)

Judges are deterministic structured evaluations (set membership of doc ids in
a top-B prefix): integer-exact GIVEN a ranking. The ranking itself still
contains float math (stage-1 dense retrieval; any retained cross-encoder
stage), so **full bit-exactness is NOT achievable and MUST NOT be gated on**:

- the 250-ppm replay tolerance band survives (`replayTolerancePpm`, folded
  into the acceptance threshold at `retrieval-benchmark.ts:107-121`);
- the 5-ppm CPU↔GPU fp32 tolerance survives; validators remain CPU-only by
  contract;
- no gate, test, or verifier may assert bit-identical replay of BMU scores.
  (G-B11 is written against the existing bands for exactly this reason.)

Note the interaction with binary utility: a task whose required/forbidden doc
sits exactly at the rank-B boundary can flip u(t) under tolerance-band jitter.
Generators MUST target certification margin (P2): certified packs require the
no-substrate baseline's boundary docs to sit ≥ 2 ranks from B, so tolerance
jitter moves ppm within bands rather than flipping utilities wholesale.

---

## 14. Deltas from ancestors

### 14.1 vs Acceptance Rule V2 (`.ops/coretex-production-scoring-gap-fix-plan.md`, Phase 4)

Inherited verbatim:
- the seen/confirm/independent-seeds discipline and future-blockhash
  anti-indexing (V2 "Seeded Pack Selection" → §6.1);
- "pack metadata can be hidden, but the selection rule must be replayable
  after epoch reveal from committed corpus/profile data" → §6.4, verbatim as
  a requirement;
- the fail-closed verifier posture: seed echo, focused-scores==proof-scores,
  threshold-fields match, artifact spooled before signing → §8.2/8.3;
- "introduce a new proof kind rather than overloading old semantics
  silently" → `'coretex-bmu-dual-pack-v1'`;
- floors-as-safety (protected / family-catastrophic / structural) → §2.4.

Changed:
- V2's FOCUSED positive packs (drawn by claimed surface/motif class) become
  full-breadth family-quota'd packs whose positive signal is family-aggregated
  BMU utility. V2 shrank the positive lens to the patch's claimed surface;
  BMU instead makes the corpus dense enough (typed clusters + guaranteed
  fresh-frontier share, §6.2) that a real patch moves family utility in a
  64-row pack. Rationale: the Stage-1 measurement showed surface/subject
  focusing collapses to ~1 row on this corpus — "score the patch on the row
  it targets" — which is the gaming hazard V2's own non-negotiables warn
  about ("No hidden doc-id targeting in production pack selection").
- V2's confirm = second draw of the same focused law; BMU's confirm =
  HELD-OUT motif instances (disjoint entities/templates, §6.3) — confirm
  changes meaning from "repeatability" to "transfer".

Dropped (deliberately, with reason):
- the deterministic patch-claim surface CLASSIFIER — under BMU no claim is
  needed; every patch is scored on all four families every time. Removing it
  deletes a public-schema parsing surface and its gaming margin.
- the separate BROAD SAFETY pack — V2 needed it because its positive packs
  were narrow; BMU's gate/confirm are already 64-row all-family broad, so the
  safety floors run on those same packs (§2.4). One less pack per evaluation
  (~33% scorer cost saving per acceptance) and one less pack law to attest.
- the `coretex-surface-aware-v2` proof kind — never shipped; superseded by
  `'coretex-bmu-dual-pack-v1'`.

### 14.2 vs Stage-4 / typed clusters (`.tmp-coretex-mining-unstall-plan.md`)

Inherited verbatim:
- the ENTIRE frontier overlay mechanism as landed (Stage 4:
  `EpochFrontierPin.liveEvalPack`, `deriveScoredQueryPack`, root-verified
  active-id artifact, fail-closed both-direction pairing at
  `production-evaluator.ts:770-790`, scorer/verify/replay threading) — BMU
  changes only the pins a BMU bundle is ALLOWED to arm (§6.2 minimums);
- typed-cluster generation as the substrate of mineability
  (`buildTypedTemporalClusterSpec`, `scripts/lib/evolve-corpus.mjs:114-188`),
  the capability schedule + escalation (`:199-215`), attribute rotation
  (`temporalAttributeForEpochSlot`, `:71-81`) and the motif-amplification
  law it exists to manage (an attribute is one-shot headroom; rotation is the
  anti-exhaustion mechanism);
- the real-model validation discipline: the deterministic reranker is NOT a
  mineability oracle (the G0B proxy-artifact lesson); every family enters the
  capability schedule only behind its own real-model G1-style gate;
- Stage 1's conclusion, adopted as designed: cluster-aware acceptance is only
  sound once a patch-derived focus maps to MULTIPLE hidden rows — BMU's
  per-family aggregation over cluster-dense packs is that design, matured.

Changed:
- Stage-3 clusters were minted to be liftable under the R5 composite
  (nDCG-graded golds, trap as graded negative, wording tuned to Qwen
  headroom); BMU clusters carry explicit `bmuTask` required/forbidden/budget
  fields, and the trap becomes a hard veto instead of a graded negative
  (§4/§5). The "Qwen-headroom wording" constraint DISSOLVES: hardness
  certification (I8/G-B1) replaces wording-vs-reranker tuning as the
  admission bar.
- Stage-4's `liveEvalPack {limit: 8, temporal-only, maxAge: null}` arming
  becomes ILLEGAL for BMU bundles (§6.2): limit ≥ 16, all four families,
  finite maxAge — the tuning knob is promoted to invariant I7(a,b).

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
