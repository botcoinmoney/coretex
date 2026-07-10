# BMU — Budgeted Memory Utility: versioned CoreTex scoring laws

**Revision:** rev4.1 (BMU v2 candidate-executable operation era and keyed opaque ids; changelog in §17).
**Status:** PRE-ARM implementation candidate. Code and offline evidence may
accompany this document; nothing here arms, pins, or deploys anything.

**Hard stop:** BMU v1 remains useful as a replay/evidence identity and MUST
NOT be armed from this document. rev4.1 defines the only successor candidate:
a 36-program candidate-executable era with paired I6-disjoint transfer and
four-program headroom over the 32-program resident region. This design is
still unarmable until keyed document-id integration survives G-B17, and the
full v2 bank, real-Qwen gate/confirm, P5, variance, margin, watermark,
portability, and shadow proof chain is regenerated on one pinned context.

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
(1) the live-eval overlay admission becomes seed-dependent, per-BMU-family
slot-allocated, with confirm-side exclusion (rev1 kept
`admitActiveLiveEvalEvents` verbatim, which is seed-INDEPENDENT —
newest-epoch-first per family, `src/eval/hidden-query-pack.ts:392-399` — and
would have injected the SAME fresh rows into gate and confirm, defeating I6
on exactly the fresh-headroom rows); (2) broad-pack eligibility becomes
active-frontier-aware (the designed-but-never-armed Stage-4 §A5 mechanism),
which is what makes retirement real for scored packs (§6.5). One
generator-side prerequisite (not a pack-law change): the logical-delta
bridge passes `bmuTask` through its field allowlist (§6.7a). Everything else
listed above is inherited byte-for-byte. The full mechanism-delta list is
§8.5.

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
the pinned quotas Q_f and the pinned per-BMU-family overlay SLOT ALLOCATION
O_f (§6.4 slot law — O_f is a pinned integer per family, not an emergent
round-robin outcome), it asserts `| (Q_f + O_f) / packSize − w_f | ≤ 0.03`
for every family, and exactly the four v1 families present. The 2 free-fill
rows are EXCLUDED from the validator: they are seeded, family-unbiased
sampling noise, bounding per-pack REALIZED deviation at ±2/64 ≈ ±0.031 in
the worst case — the ±0.03 bound governs the pinned expectation, not each
realized pack. r5's `assertValidWeights` (`retrieval-benchmark.ts:84-93`) is
untouched for r5 replay.

**Per-family utility** `U_f = mean of u(t) over family-f rows in the pack` is
still computed — it drives the floors (§2.5), the G-B8 family-collapse alarm,
and the `/score-state` decomposition (§8.4) — it just no longer multiplies
into the scalar.

### 2.4 Threshold arithmetic (row-flip semantics)

BMU bundle pins:

- `patchAcceptanceFloors.minImprovementPpm = 20_000`
- `replayTolerancePpm = 250` (unchanged; satisfies the bundle validation
  `replayTolerancePpm ≤ minImprovementPpm`, `src/bundle/index.ts:1508-1509`)
- **`baselineVarianceSource = 'unavailable'` ⇒ the variance term is ZERO by
  the existing source rule (`computeAcceptanceThresholdPpm` counts variance
  only for `rotating_pack`/`broad_sampling`,
  `retrieval-benchmark.ts:114-117`).** The BMU variance law: cross-pack
  parent variance MUST NOT enter the acceptance threshold. Justification:
  the accept comparison is SAME-PACK (`scoreAgainstSeed` computes
  before/after on one pack, `production-evaluator.ts:846-858`), so parent
  variance across rotated packs never touches Δ; r5's variance term
  compensated continuous-composite sampling noise, which the §13.2 quantized
  judge eliminates. Under quantization a rotating-pack variance measurement
  would read ≥ 1 flip = 15,625+ ppm and silently rewrite the flip law to
  3–4 flips — exactly the failure this pin forbids. The protection variance
  used to provide moves to an ARM-GATE certification (§6.7): measured
  `scoreState` variance across the certified pack rotation MUST be
  ≤ 7,811 ppm — the integer pin for strict < q/2 = 7,812.5 (parent utility
  flip-stable) — else certification failed
  and the bundle MUST NOT arm.

Acceptance threshold = 20_000 + 250 + 0 = **20_250 ppm, exactly**. In
row-flip units (q = 15_625):

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
- **Screener staircase (controller inputs pinned for BMU):** the screener
  controller is mechanically unchanged (`computeCoreTexScreenerThresholdPpm`,
  `work-units.ts:207-266`), but one input MUST be clamped: the coordinator's
  BMU work-policy wiring clamps `recentNoiseFloorPpm` to ≤ 7,811 ppm (the integer pin for
  strict < q/2 = 7,812.5)
  before calling the controller (under quantization a "noise" reading is
  itself flip-denominated; unclamped, `noiseFloorMultiplierBps = 20000` (2×)
  would push `noiseDelta` ≥ 15,625+ and pin the screener at its
  20,250 dynamic ceiling, killing the 1-flip lane). With the clamp, the term
  arithmetic is: `minDelta` 50; `stateAdvanceFloorDelta` =
  ceil(20,250 × 2000/10000) = 4,050; `headroomDelta` = remaining ×
  1 bps ≤ 100 ppm; `noiseDelta` = 2 × (≤ 7,811) ≤ 15,622 < q. So
  screener ∈ [4,050, 15,624] < q = 15,625 in all normal regimes — **1 flip =
  screener pass, ≥ 2 flips = state advance**: the pass-rate staircase intent
  (`specs/research_brief.md:281-308,338-354`) re-emerges denominated in
  row-flips. CAVEAT (by design, not a staircase break): under active probe
  attacks the anti-gaming multiplier (up to ×6,
  `work-units.ts:256-263`) may legitimately raise the screener to the
  20,250 ceiling — the 1-flip lane closes while probes persist and reopens
  when they stop. The Phase-0 staircase percentages (random ~0% / weak
  5–10% / strong 20–30%) are P4/P5 calibration targets, not per-task
  grading.

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
  "templateId": "tt_supersession_q7_v3",        // REQUIRED — generator-stamped
                                                //   surface-form template id;
                                                //   held-out partition key (§6.3)
  "entityHoldoutKeys": [                         // REQUIRED for arm-eligible
    "id:e_subject_0042",                         //   new BMU mints; hidden
    "alias:canonical subject name",              //   canonical id + normalized
    "alias:subject alias"                        //   canonical-name aliases only
  ]
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
row; `templateId` non-empty. `entityHoldoutKeys`, when present, MUST contain
1..32 unique non-empty strings, MUST include `id:<subjectEntityId>`, and each
entry is capped at 256 characters. It is optional at corpus LOAD only so
historical pre-hardening stamped rows remain readable; the ARM and BOOT
censuses MUST reject every BMU pool containing a row where it is absent.
New generators MUST stamp the canonical subject id, normalized canonical
name, and all normalized subject-name aliases. They MUST NOT copy broad doc
`entityIds` into this field: shared owner/universe ids would exclude unrelated
confirm rows. **Charset law (rev3.4):** `subjectEntityId`, `templateId`, and
every `entityHoldoutKeys` entry MUST contain no control characters (U+0000–U+001F,
U+007F — including `'\n'`), rejected at corpus load AND at mint-time lint —
this kills join-injection into the §8.3 exclusion-set digest (a crafted id
containing the join separator could alias two distinct key sets to one
digest). Length-prefixing the digest was the considered alternative; the
implementation chose charset rejection, pinned here. `motifGroupId` is
generator-minted under the same lint.

**Template mint law (P2 generator obligation):** template banks are
partitioned per (family, epoch) so that any two clusters of the same family
minted for the same epoch carry DISJOINT `templateId` sets; two rows share a
`templateId` iff they instantiate the same surface-form template. This is
what makes §6.3's template-disjoint confirm derivation well-defined.

**Multiplicity mint law (m = 1, GLOBAL — rev3.4 extends identity to aliases;
rev3.1's per-family scope
was insufficient):** a `subjectEntityId` and a `templateId` each appear in
AT MOST ONE ACTIVE cluster GLOBALLY — across ALL families — within the
maxAge(32)-epoch active window. Every `entityHoldoutKeys` entry likewise
appears in at most one active cluster, so two nominal subject ids sharing a
canonical name/alias cannot straddle gate and confirm. Per-family scoping does not suffice because
§6.3's confirm exclusion set X is GLOBAL across families: a subject reused
in a different family's active cluster would silently spill exclusions
between families and re-open the confirm-refusal DoS this pin exists to
prevent (the §6.7b E_f_min arithmetic assumes ZERO cross-family spill).
Enforced at mint time (the generator MUST NOT mint a cluster whose subject,
canonical alias identity, or template collides with ANY still-active cluster,
any family) and checked
by the §6.7 arm-gate census, which is likewise GLOBAL. Consequence: the
§6.3 exclusion keys (motifGroupId, subjectEntityId, templateId, canonical
entity/alias identities) are
COEXTENSIVE with the cluster — excluding a gate row excludes exactly its own
cluster (5 rows), never a second one, in any family. Without this pin,
multiplicity m > 1 multiplies worst-case confirm exclusion by m (at m = 2 a
gate pack's ~13 temporal rows could exclude ~130 rows > the arm-gate
minimum — routine confirm-derivation refusal = lane DoS). m > 1 was
considered and REJECTED: it buys no v1 design capability and costs m× in
E_f_min (§6.7b arithmetic). This constrains the inherited attribute
rotation — see §14.2.

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
  BMU-generated stale docs MUST retain their `validFrom`/`validUntil`/
  `observedAt` interval and the public structural `supersedes` relation, but
  MUST NOT publish `validity.supersededBy`: that field is an exact answer-doc
  pointer and therefore a proposer-visible shortcut, not validity semantics.
- BMU-generated document ids MUST be deterministic HMAC-SHA-256 ids under an
  independent, random, nonzero bytes32 per-epoch `docIdKeyHex`, with domain
  `coretex-bmu-doc-id-v2`. The MAC message commits the public generation seed,
  epoch, motif id, and internal slot; the key MUST NOT be derived from the
  generation seed, epoch secret, gate/confirm seed, blockhash, corpus/bundle
  root, or any committed/public value. The key is a required generator input:
  absent, zero, or malformed keys fail closed and there is no compatibility
  fallback to the refuted seed-only SHA-256 formula. A private master MAY
  derive compartmentalized epoch keys only through the pinned
  `coretex-bmu-doc-id-epoch-key-v1` HMAC domain. Generation manifests MAY
  publish only domain-separated SHA-256 epoch-key commitments, never a key.
  Public ids carry no family, subject, ordinal, answer/trap, or role suffix.
  Generator-side docs MAY retain an internal `role` for construction and
  certification; the production bridge does not publish that role.
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

**v2 shared substrate law (supersedes the family-specific v1 surfaces below):**
under `coretex-bmu-v2-r5state`, every family is mined through the same public
four-word operation program. A generated row publishes a canonical cue and
`{ branchLimit: 4, steps: [outgoing:<edge-1>, incoming:<edge-2>] }`; the miner
encodes that exact cue→program mapping in state words 384–511. The scorer
starts from public stage-1 seeds, follows the two directed steps as a simple
path, and admits only terminal records to Qwen. Family-specific temporal,
conflict, relation, and abstention atoms are disabled by the v2 profile; their
descriptions below explain task semantics and traps, not alternate v2 reward
surfaces.

The executable bank is the DISJOINT-PARTITION DEEP-TERMINAL program bank
(fix 2a of the era iteration): 32 three-step programs (the Cartesian
2 outgoing × 4 incoming × 4 incoming chains) plus 4 pinned four-step programs
— 36 classes in every family. The one outgoing step draws ONLY from
`{causes, derived_from}`; every incoming step draws ONLY from
`{supports, supersedes, coreference_of, co_occurs_with}`. Because the two
vocabularies never intersect, the ambiguous-lineage symmetric route
(`outgoing:X` then `incoming:X`) is inexpressible, and the mint lint
(`assertDisjointPartitionProgram`) refuses any non-conforming program
fail-closed. Topology law: the executed terminal set of a cluster's program
EQUALS the row's operation-required answer terminal(s) — decoys are balanced
depth-1 dead ends beside the neutral chain relay(s), forbidden docs are never
routed, and overflow decoys park in terminal-free side groups (the
single-answer-terminal law the §18 route bonus requires for soundness).
Semantic prose, sink multiplicity, question type, and generator labels are
not class dimensions. A monotone per-family cursor mints adjacent
I6-disjoint pairs with `floor(sequence/2) mod 36`. An operation
era starts on an even cursor and alternates mint cycles
`{temporal:2, conflict:2, multi-hop:1, near-collision:1}` and
`{temporal:1, conflict:1, multi-hop:2, near-collision:2}` for 24 cycles:
72 clusters = 36 supported executable signatures per family, margin `+4`
over the shared resident capacity 32. Era transitions MUST preserve even
alignment (or finish the dangling pair before census); a 72-mint census that
starts on an odd cursor cannot claim adjacent repeat support for both boundary
classes. Cue, uint56 query-key, encoded-program, and signature collisions are
all fail-closed gates.

### 5.1 temporal (current / stale / supersession)

- **Substrate must:** encode the row's public two-step program so the lexical
  stale/review seed reaches its neutral pivot and then the balanced current,
  provenance, and decoy terminals. ZERO_STATE and an obsolete cue cannot
  reach the operation-caused required terminals.
- **Utility earned:** current-value, downstream-application,
  stale-verification, and change-provenance tasks (question types
  `scripts/lib/evolve-corpus.mjs:101-106`) resolve with the current record
  and/or provenance record inside top-B.
- **Trap/forbidden:** the stale doc that CLAIMS currency (`role:
  'stale_trap'`, minted with exact-question vocabulary,
  `scripts/lib/evolve-corpus.mjs:120-123`) plus escalation shadows. Any of
  these in top-B zeroes the task. Under r5 the trap was a graded negative;
  under BMU it is a hard veto — the family's anti-lexical-shortcut screen.
- **Recency/currency shortcut controls (rev3.4):** every BMU temporal cluster
  also mints four same-subject, same-attribute, currently-valid alternative
  records whose public observation times match the scored revision. All four
  are forbidden: leaving non-path controls neutral lets a recency sorter place
  `{gold + neutral controls}` inside top-B without encountering a veto.
  Certification runs two
  public-only attacker lanes — subject-scoped last mention and generic
  validity-current filtering — and rejects a row if either obtains utility
  OR matches the structural oracle's positive-evidence coverage. The pack
  gate is fail-closed unless both attacker lanes remain strictly below the
  oracle. The rankers may read public intent, entity ids, timestamps, and
  validity intervals only; qrels, `bmuTask`, generator roles, and answer ids
  are forbidden inputs.
- **v2 operation semantics:** revision supersession, validity renewal,
  rollback restoration, and effective handoff rotate independently of the
  shared 36-class executable bank. They change proposition text and therefore
  Qwen's reading task, but never inflate the executable census. Every class
  exposes four metadata-identical terminal branches; only branch text
  identifies the authoritative temporal proposition.

### 5.2 conflict_lifecycle

- **Substrate must:** encode the row's public two-step program so the lexical
  conflict seed reaches its neutral pivot and then the balanced resolved,
  resolution-record, and scope-decoy terminals. The program changes retrieval
  admission under distractor pressure; it supplies no answer-shaped bonus.
- **Utility earned:** current-for-scope, resolution-provenance, and
  downstream-for-scope tasks resolve with the resolved doc + resolution
  record in top-B.
- **Trap/forbidden:** the contradicted candidate doc (still asserting the
  superseded claim, `contradicts`-linked) and scope-mismatched lookalikes
  (same subject, different scope). Cluster shape per the Stage-3 design:
  candidate(A) / resolved(B) / resolution-record(R), `contradicts` B→A,
  `derived_from` R→A.
- **v2 operation semantics:** claim reconciliation, authority override,
  quorum ratification, scope precedence, and appeal resolution rotate
  independently of executable identity. Each shared-bank program has a
  balanced outgoing→incoming diamond with resolved/resolution truths and
  scope-lookalike decoys whose public topology and metadata tie.

### 5.3 multi_hop_relation (incl. bridge/coreference framing)

- **Substrate must:** encode the row's public two-step program so the lexical
  route seed reaches one or more neutral sinks and then balanced incoming
  terminal filings, including a lexically distant answer. Coreference remains
  a public edge type inside this family, not a separate reward mechanism.
- **Utility earned:** the task requires BOTH the bridge doc and the answer doc
  in top-B (`requiredEvidence` = bridge + answer) — pure answer-anchoring
  without the traversal evidence does not pay, which is what makes this
  family's utility a routing reward rather than an indexing reward.
- **Trap/forbidden:** same-category non-path docs — high lexical overlap with
  the query's subject but not on the relation path (the measured
  `co_occurs_with`/`context_of` noise-edge hazard: a lens over generic
  co-occurrence boosts everything and admits a forbidden neighbor).

### 5.4 near_collision / abstention

- **Substrate must:** encode the row's public two-step program so the lexical
  collision seed reaches balanced exact-match/disambiguation and lookalike
  terminal filings. At small B, Qwen must retain the right variant and exclude
  siblings; the abstention signal remains the separate deterministic policy
  decision defined in §5.5.
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
- **Overlay slot allocation is per BMU FAMILY, pinned: O_f = 3/3/3/3** (12
  slots). The inherited round-robin unit is the logicalFamily
  (`admitActiveLiveEvalEvents` iterates `familyPriority` names,
  `hidden-query-pack.ts:400-440`), and with the ten §5.6 logicalFamily names
  a 12-slot round-robin would yield ≈ 2/2/4/4 per BMU family — conflict
  share (15+2)/64 = 0.266, |0.266 − 0.30| = 0.034 > ±0.03, REJECTED by the
  §2.3 validator. The BMU law therefore allocates slots per BMU family
  (3 each), each family's slots drawn from the UNION of its mapped
  logicalFamily cohorts per the §5.6 table (so thin logicalFamilies —
  entity_resolution_atom 17 / scope_atom 19 / validity_atom 22 rows [E136] —
  never need their own cohort; they pool into `near_collision_abstention`).
  Draw + fallback + redistribution rules in §6.4. The bundle still writes
  `familyPriority` as the ten logicalFamily names (the row-matching
  namespace); the 3/3/3/3 allocation is a new pinned field of the BMU
  overlay law (`liveEvalPack.familySlots`), validated to sum to `limit`.
- `epochFrontier.maxAge = 32`, with A2's canonical retirement semantics
  incorporated by reference (`c677e36`): age-based retirement is a BOUNDED
  per-EVOLVE drain (rev3.2 units note: the frontier steps only at real
  evolves) — oldest activation first, capped at `maxRootDeltaPerEpoch`,
  sharing the root-delta budget with churn. UNBOUNDED aged retirement is
  forbidden: on the live epoch-136 frontier state, 9,300 of 9,319 active rows
  share activation epoch 0, and any finite maxAge applied unboundedly would
  have collapsed the active set 9319→19 in one step (A2's measured hazard).
  Bundle validation (A2): maxAge must be null or a positive integer; BMU
  bundle validation ADDITIONALLY requires it finite (non-null) — `maxAge:
  null` (the liveeval8 counterexample) is illegal under
  `coretex-bmu-v1-r5state`.
- Free fill = 64 − 50 − 12 = 2 rows (seeded broad sampling, as today).

**Composition arithmetic, end-to-end (F3 recompute), gate AND confirm:**

| family | Q_f | O_f (slot law) | Q_f+O_f | share /64 | w_f | deviation |
|---|---|---|---|---|---|---|
| temporal | 10 | 3 | 13 | 0.203 | 0.20 | 0.003 ✓ |
| conflict_lifecycle | 15 | 3 | 18 | 0.281 | 0.30 | 0.019 ✓ |
| multi_hop_relation | 15 | 3 | 18 | 0.281 | 0.30 | 0.019 ✓ |
| near_collision/abstention | 10 | 3 | 13 | 0.203 | 0.20 | 0.003 ✓ |

All deviations ≤ ±0.03 ⇒ `assertValidBmuWeights` passes the pinned bundle.
The CONFIRM pack has the identical pinned expectation: the same quotas are
enforced quota-first on the post-exclusion pool and the same 3/3/3/3 slot law
applies to its overlay draw. **Fill feasibility post-exclusion (TRUE worst
case, per family — rev3.1, counting subject + template exclusion under the
§4.1 GLOBAL m = 1 multiplicity pin, including entity-alias identities):** each gate row of family f excludes
exactly its own cluster (global m = 1 makes subject/template exclusion
and alias-identity exclusion coextensive with the motifGroup — no cross-cluster AND no cross-FAMILY
spill); worst case, the N_f = Q_f + O_f gate
rows land in N_f DISTINCT clusters (rev3's "≤ ceil(N_f/5) clusters" was the
minimum-supply count, not the worst case — corrected), excluding up to
N_f · 5 rows: 90 for the 0.30-share families (N_f = 18), 65 for the
0.20-share families (N_f = 13). Confirm then needs N_f more rows. The §6.7b
arm-gate minima are derived from exactly this bound
(E_f_min ≥ N_f·(k+1), cluster-rounded: 110/110/80/80), so the residual pool
is ≥ 110 − 90 = 20 ≥ 18 (resp. 80 − 65 = 15 ≥ 13) rows per family — the
64-row confirm pack always fills, with the cluster rounding as slack.
**Honest corner (rev3.2): in this same worst case the TOTAL residual is
Σ_f (E_f_min − N_f·k) = 20+20+15+15 = 70 rows; after the confirm BASE fills
its 64, at most 70 − 64 = 6 distinct rows remain for the 12 overlay slots —
the confirm overlay may fill as few as 6 slots. This is a graceful
underfill (unreplaced base rows keep the pack at 64; quotas unaffected),
not a refusal — RATIFIED as the terminal semantics by P3-R1 (§6.4) — but it
means the overlay's 12-slot CAPACITY is not
unconditional; see the softened I7(a) reading, §16 note (d).** Free fill
(2 rows) excluded from the validator per §2.3. Fresh-frontier share =
12/64 = 18.75% per pack across all four families when per-family fresh
cohorts suffice (§16 note (d); thin families degrade to seeded-active via
the §6.4 fallback).

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
   { templateId(e) } ∪ { entityHoldoutKeys(e) }` for every `e` in the gate
   pack. All four namespaces have
   schema anchors: `subjectEntityId` on the event
   (`retrieval-corpus.ts:248`), `motifGroupId`/`templateId`/
   `entityHoldoutKeys` on `bmuTask`
   (§4.1).
3. **Confirm pack (held-out motifs):**
   the SAME derivation with `confirmSeedHex`, over the BMU-eligible pool
   MINUS every row whose `motifGroupId`, `subjectEntityId`, `templateId`, or
   canonical entity/alias identity is in `X` — same family quotas, same
   overlay law (confirm side, §6.4).
   HELD-OUT means: same motif FAMILIES, disjoint canonical entities/aliases AND disjoint
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

- **Slot allocation (pinned):** `liveEvalPack.familySlots` = 3/3/3/3 per BMU
  family (§6.2); each family's slots draw from the union of its mapped
  logicalFamily cohorts (§5.6).
- **Fresh cohort:** active `zz_e*` BMU-eligible rows with age ≤
  `freshWindow` (bundle-pinned, default 2 epochs).
- **Seeded draw (byte law, pinned — rev3.1):** for slot i (0-based) of BMU
  family F in a pack with seed S (gateSeed for gate, confirmSeed for
  confirm), the draw pool is F's cohort sorted by `codePointCompare(id)`,
  and candidate indices are probed as
  `idx_j = digestU256([ enc('bmu-overlay-v1'), u64BE(epochId),
  seedBytes(S), enc(F), u64BE(i), u64BE(j) ]) % poolSize` for
  j = 0, 1, 2, …, skipping rows already drawn (any slot, either overlay
  phase), rows in the pack base, and excluded rows — WITHOUT replacement
  (the same skip-probe/dedup pattern as `deriveQueryPack`'s quota draws,
  `hidden-query-pack.ts:279-296`; `enc` = UTF-8, `seedBytes` = the 32-byte
  seed, `F` = the `bmuTask.family` ENUM NAME — also the key namespace of
  `liveEvalPack.familySlots`). **Probe exhaustion (j ≥ poolSize·8) is NOT a
  pack-derivation refusal (rev3.2):** it marks THAT SLOT unfillable from the
  current pool, which then falls through the §6.4 chain — fallback pool
  first, then redistribution to the remaining families; pack derivation
  refuses only if the redistribution chain ALSO cannot fill. (Refusing at
  first exhaustion would add a ~0.7%-per-evaluation stochastic refusal
  channel that the redistribution rule was designed to absorb.) Which fresh
  rows appear is thus unpredictable pre-blockhash, while the fresh SHARE
  stays guaranteed when cohorts suffice (I7a as clarified in §16 note (d)).
- **Fallback (F6 — SEEDED, never newest-first):** if a family's fresh cohort
  cannot fill its slots (routine for confirm post-exclusion), the remaining
  slots draw by the SAME seeded digest over the family's FULL eligible-active
  membership. Rationale: a deterministic newest-first fallback re-opens the
  rev1-B3 predictability hole in exactly the thin case; a minimum-cohort
  precondition was rejected because thinness arises PER-PATCH
  (post-exclusion) and blocking evaluation on it would let corpus state DoS
  the lane. The arm-gate minima (§6.7) + the ≥2-clusters/family/epoch
  generator duty keep cohorts populated in steady state; the fallback
  degrades freshness gracefully without degrading unpredictability.
- **Redistribution (semantics pinned — rev3.3):** if even the
  full-membership draw cannot fill a family's slots, the unfilled slots
  redistribute FIRST-FIT over all four BMU families in fixed order
  restarting at temporal (temporal → conflict_lifecycle →
  multi_hop_relation → near_collision/abstention), and a redistributed slot
  CONTINUES the TARGET family's slot numbering (its draws use the target
  family's name and next slot index in the §6.4 digest tuple). The pack
  emits a composition-deviation telemetry flag. **Terminal semantics
  (ratified, P3-R1):** underfill — overlay slots that no family can fill —
  is GRACEFUL: the pack proceeds at packSize with unreplaced base rows,
  emitting composition/underfill telemetry; overlay shortfall NEVER causes
  pack-derivation refusal (refusal remains reserved for base quota failure,
  `hidden-query-pack.ts:292-296,306-308`). Reviewer-ruled sound and not
  materially gameable.
- **Digest/byte conventions (pinned — rev3.3):**
  `digestU256` = keccak256 over the PLAIN CONCATENATION of the input parts
  (no length prefixes), digest interpreted as a BIG-ENDIAN uint256
  (`hidden-query-pack.ts:235-248`); seed hex is parsed case-insensitively
  into bytes, canonical textual form lowercase `0x`-prefixed (the
  `deriveQueryPack` normalization, `:312`); `bmuQuantize(x) =
  Math.round(x / g)` — JavaScript `Math.round` semantics, ties toward +∞;
  `codePointCompare` ordering = UTF-16 code-unit lexicographic order.
- **Golden vectors (REQUIRED — rev3.3):** the implementation MUST commit
  golden hex vectors (in-repo test fixtures) for the seeded-draw byte law
  above — fixed (epochId, seed, family, slot, probe) tuples with their
  exact digest bytes and drawn row ids — and every independent
  implementation (scorer server, validator replay, replay CLI) MUST
  reproduce them byte-for-byte.
- **Exclusion:** the confirm-side draw additionally excludes rows whose
  motifGroupId/subjectEntityId/templateId ∈ X (§6.3) — the exclusion applies
  to overlay and broad rows alike.
- **Contract deltas:** `deriveScoredQueryPack(…)` gains an optional
  `exclude?: ReadonlySet<string>` (composite keys); `admitActiveLiveEvalEvents`
  opts gain `{ seedHex?, freshWindow?, familySlots?, excludeKeys? }` — the
  per-BMU-family slot allocation replaces the logicalFamily round-robin as
  the admission unit when present (§8.5 wire/mechanism delta list). ALL new
  parameters absent ⇒ byte-identical current behavior — r5 bundles and every
  epoch ≤ the flip replay unchanged (the same replay-safety pattern the
  overlay itself used, `hidden-query-pack.ts:59-84`).
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
2. **Frontier-aware eligibility + bounded age rotation (lifecycle):** under
   `coretex-bmu-v1-r5state`, BROAD-pack eligibility requires active-frontier
   membership: `hiddenPackEventEligible` additionally requires
   `activeFrontierIds.has(event.id)` (the delta at
   `hidden-query-pack.ts:587-592`; this is the unstall plan's original
   Stage-4 §A5 `deriveQueryPack(…, activeIds?)` design, now mandatory —
   today's broad pack ignores the frontier entirely, so retirement never
   touches scored packs). Fail-closed pairing both directions, mirroring
   `production-evaluator.ts:770-790`. Retirement is A2's retire-by-age ONLY:
   `maxAge = 32` via the bounded oldest-first drain (§6.2, `c677e36`).
   Replayable through the EXISTING on-chain `activeFrontierRoot` pin +
   root-verified id-set artifact — ZERO new pins or wire fields.
   **rev2's retire-on-exposure is DELETED** (orchestrator decision on the
   rev2 re-review): it was arithmetically self-contradictory — one accepted
   artifact exposes ~124 pack rows vs a ≤ `maxRootDeltaPerEpoch` = 24
   per-EVOLVE drain SHARED with aged retirement, so the exposure queue
   diverges 10–25×
   under any healthy accept cadence and starves retire-by-age (an I7(b)
   violation); it was also a new subsystem beyond I1-I10 ⇒ default-DEFER
   (handoff §8). It is now on the §12 DEFER list alongside commit-reveal.
   **Honest consequence, stated plainly: a row's labels are Tier-V-visible
   for its entire ≤ 32-epoch active life. Rotation does NOT meaningfully
   limit Tier-V label mining. The forbidden-trap task construction (part 1)
   carries the per-row integrity burden ALONE against Tier-V**, with the
   seeded overlay draw (§6.4) removing row-targeting predictability and the
   ≥2-flip threshold (§2.4) bounding lucky sampling. The P4 Tier-V control
   (labels granted) and G-B15 red-team attack part 1 directly; if it falls,
   the v2 escalations (exposure-based retirement with a dedicated drain
   budget, or label commit-reveal) are the recorded next moves.
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
higher-probability per row but are seed-drawn (§6.4), so an attacker cannot
choose WHICH fresh rows the packs will sample; their exposure lifetime is
nonetheless the full maxAge window (see part 2 — no exposure-retirement
exists). The P4 control suite MUST include a Tier-V exact-anchor attack
(labels granted) and G-B15 red-team owns beating part 1.

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

### 6.7 Transition bootstrap and the ARM-GATE (the flip cannot start on an empty pool)

BMU pack eligibility (§4.3) = `bmuTask` present AND active-frontier member.
At a naive flip that pool is ~EMPTY, and — rev3.2, the structural fact —
STAYS empty no matter how much is minted: activations strictly REPLACE
retirements (`activateNext(ret)` is fed the retirement count,
`src/coordinator/epoch-frontier.ts:186-193,246-248`; the prune backfill is
likewise replacement-only), so the active set NEVER grows after
initialization — minted rows only QUEUE in the reserve (spliced at
`reservePtr`, BMU rows first, `:252-260`). A2's own evidence proves it:
`g-a4-retirement-sim-rework-v2-retire-genesis.json` shows
activeSizeStart = activeSizeEnd = 19 over 80 evolves / 948 mints. Note also
the UNITS: the frontier steps only at REAL EVOLVES, so `maxRootDeltaPerEpoch`
is a per-EVOLVE budget (max 12/evolve via C3 in that sim), not per-epoch.
Meanwhile `deriveQueryPack` THROWS below packSize/quota fill
(`hidden-query-pack.ts:292-296,306-308`), and §10's mandatory two-pass
rebaseline scores the parent under the NEW law at the transition evolve — on
an empty pool that throws at step one (the G-B14 rehearsal would fail
immediately). Without an activation operation the arm-gate would NEVER open.
Three coupled requirements close the gap:

**(a) Pre-flip `bmuTask` minting — SCORING-inert under r5, NOT
validation-inert (rev3.3 wording fix).** Generators MUST stamp full
`bmuTask` fields (incl. motifGroupId/templateId) on every minted eval_hidden
row DURING the r5 era, starting as soon as the stamping lands. Precisely:

- SCORING-inert: the r5 scorer reads only the fields it knows (TypeScript
  structural typing; `deriveQueryPack`/`evaluateRetrievalBenchmarkPatch`
  never touch unknown properties), and the corpus LOADER performs no
  unknown-field rejection — `loadProductionCorpus` validates schemaVersion,
  corpusRoot, split assignment, and embedding pins only
  (`retrieval-corpus.ts:844-914`); event objects pass through as parsed;
- **NOT validation-inert:** the §4.1 `bmuTask` load-time validation
  (structure, cross-references, charset law) is VERSION-INDEPENDENT and
  live from the moment a stamped row exists — an INVALID stamped mint would
  fail corpus load and brick the r5-era lane. Mint-time LINT (the full §4.1
  validation run before publish) is therefore MANDATORY from the first
  stamped cluster, not a nicety deferred to the flip;
- new rows carry `bmuTask` from birth, so their canonical event hashes and
  the corpusRoot commit to it — no retro-mutation of existing rows, no
  replay impact (r5 packs hash the same rows they always did).

TWO named canonical prerequisites (P3/P7 pick both up from here):

1. **Bridge pass-through:** the logical-delta bridge constructs production
   events from an EXPLICIT field allowlist
   (`src/corpus/logical-delta-bridge.ts:355-375` — `qEventBase` +
   field-by-field `Object.assign` for `logicalFamily`/`band`/
   `ownerEntityId`/`subjectEntityId`/…), so an unstamped bridge would
   silently DROP `bmuTask`. The bridge MUST gain a
   `q.bmuTask ? { bmuTask: q.bmuTask } : {}` pass-through BEFORE pre-flip
   minting starts (P3 canonical item; replay-inert for the same
   from-birth-hash reason).
2. **Bulk-activate tool mode (rev3.2):** a `--bulk-activate` mode of
   `scripts/coretex-stagger-frontier-activation.mjs` that activates the
   stamped BMU reserve rows (≥ N_min of them) in PRECOMMITTED RESERVE ORDER
   — offline-only, deterministic, atomic-repin posture identical to A2's
   retire-genesis rewrite (runbook `docs/a2-unbrick-arming.md`), with the
   resulting `activeFrontierRoot` repinned atomically with the BMU bundle
   transition + rebaseline. Required because the frontier NEVER grows the
   active set on its own (§6.7 intro); without this operation the arm-gate
   cannot open. (P3 canonical item; P7 rehearses it, G-B14(ii-b).)

**(b) ARM-GATE precondition with N_min derived from the pack arithmetic
(rev3.1: re-derived from the TRUE worst case under the §4.1 m = 1
multiplicity pin).** The BMU bundle MUST refuse to arm unless the pool of
stamped rows AVAILABLE FOR BULK-ACTIVATION (bmuTask rows in
reserve ∪ active — rev3.2: pre-arm they sit in the RESERVE, §6.7 intro; the
prerequisite-2 bulk-activation is what makes them eligible-active at arm)
satisfies per-family minima. With k = 5 rows per cluster (minimum
typed-cluster size) and
N_f = the §6.2 per-family pack demand (Q_f + O_f): worst case, all N_f gate
rows land in distinct clusters and each excludes its full cluster (exactly
one cluster under m = 1 — subject/template exclusion is coextensive with the
motifGroup), so confirm needs N_f rows from a pool of at least
N_f·k (excluded) + N_f (confirm supply):

```
E_f_min = k · ceil( N_f · (k + 1) / k )        [= N_f·(k+1), cluster-rounded]
temporal:            13·6 = 78 → 16 clusters → 80
conflict_lifecycle:  18·6 = 108 → 22 clusters → 110
multi_hop_relation:  18·6 = 108 → 22 clusters → 110
near_collision/abst: 13·6 = 78 → 16 clusters → 80
N_min = Σ E_f_min = 380 eligible-active rows (= 76 clusters)
```

(rev3's s = 2 safety factor is superseded: m = 1 eliminates the cross-epoch
collision uncertainty it padded for, and the formula is now the exact
worst-case bound plus cluster rounding. At m > 1 the bound becomes
N_f·(m·k+1) — e.g. m = 2 conflict: 18·11 = 198 — which is why m = 1 is
pinned.)

The arm-gate additionally requires: a fresh overlay cohort of ≥ 2 clusters
per family within `freshWindow` (trivially m=1-compatible: 2 distinct
subjects + templates per family per epoch); a GLOBAL m = 1 census (no
subjectEntityId, templateId, or canonical entity/alias holdout key in > 1
cluster across the ENTIRE
reserve ∪ active stamped pool, any family — §4.1); and the
variance certification below. Ordering: the census + count checks run BEFORE
bulk-activation; the variance certification runs AFTER bulk-activation (it
needs the BMU pack law derivable over the post-activation active set), as
part of the rebaseline.

**Boot-vs-arm posture split (rev3.3, P3-R1 ruling):** the FULL gate above —
counts + global census + fresh cohort + variance certification — binds at
the ARM posture ONLY. Boot / evaluator-construction re-checks the
STRUCTURAL census only: per-family eligible-active counts ≥ E_f_min, the
global m = 1 census, and complete/consistent `entityHoldoutKeys` — NEVER
freshness. Thus historical pre-hardening rows remain loadable but are never
arm- or boot-eligible. **Fresh-AGE definition (pinned):**
a row's freshness reads its MINT epoch, embedded in the row id (`zz_eN_…`
prefix, `liveEpochFromEventId`, `hidden-query-pack.ts:318-321`) — NOT the
frontier `activationEpoch`. Liveness rationale: mints occur only at real
evolves (A1 cadence 8) while `freshWindow` = 2, so in ~6 of 8 epochs there
exist NO rows with mint-age ≤ freshWindow — a boot-time freshness check
would fail-closed a healthy lane most epochs (the §6.4 seeded
full-membership fallback is the designed steady-state behavior between
evolves). The structural boot check is fail-closed in the same posture as
the attestation ARM gate, reporting per-family counts on refusal.

**Variance certification procedure (executable; rehearsed by G-B14(iii)):**

1. States: BOTH the parent substrate AND the blank state.
2. Runs: K = 5 `scoreState` calls per state (`samples: 1` each), each with a
   distinct deterministic pack: `baselineSeedHex_i =
   keccak256('bmu-arm-variance' ‖ u64BE(epochId) ‖ stateLabel ‖ u64BE(i))`,
   i ∈ [0,4], stateLabel ∈ {'parent','blank'} — a pinned seed schedule,
   never a future blockhash (the `scoreState` contract,
   `production-evaluator.ts:871-873`).
3. Criterion: per state, the MAX PAIRWISE SPREAD of the K `parentScorePpm`
   values ≤ 7,811 ppm — the INTEGER pin (rev3.3): q/2 = 7,812.5, criterion is
   strict <, so integer spreads pass iff ≤ 7,811 (i.e., zero row flips, since
   any flip = 15,625). Both states MUST pass.
4. Recording: the K seeds, K scores, and both spreads are written into the
   signed rotation manifest's baseline section
   (`armVarianceCertification: { states, K, seeds, scoresPpm, spreadPpm }`)
   AND the arm log; the manifest copy is what G-B14(vi)'s cold sidecar
   reload re-verifies.
5. Golden vectors (REQUIRED — rev3.3): the variance-seed schedule of step 2
   MUST have committed golden hex vectors (fixed epochId/stateLabel/i →
   exact `baselineSeedHex_i` bytes) alongside the §6.4 seeded-draw vectors;
   every independent implementation reproduces them byte-for-byte.

**(c) Frontier state at arm and the A2→BMU sequencing (rev3.2 — corrected
for the replacement-only frontier).** The BMU bundle DOES rewrite frontier
STATE at arm — a one-time bulk-activation (prerequisite 2 of (a)), exactly
as A2's arming applies its one-time retire-genesis rewrite. Root-PIN
continuity is preserved per-epoch thereafter (the rewritten
`activeFrontierRoot` is repinned atomically with the bundle transition +
rebaseline, and every subsequent epoch steps normally). A2 ships TWO
distinct mechanisms (branch `coretex-a2-unbrick`): (i) IN CODE, the bounded
age-drain — retirement capped at `maxRootDeltaPerEpoch` = 24 per EVOLVE
(the frontier steps only at real evolves — per-evolve units, NOT per-epoch;
A2's sim stepped max 12/evolve via C3), oldest-first, budget shared with
churn (`c677e36`); (ii) AT ARM TIME, the one-time retire-genesis
frontier-STATE rewrite applied offline via
`scripts/coretex-stagger-frontier-activation.mjs` + atomic repin (runbook
`docs/a2-unbrick-arming.md`) — it is THIS rewrite, not the drain, that
leaves the post-arm active set at ~19 rows. CRUCIALLY (the rev3 error this
corrects): the in-code pipe is REPLACEMENT-ONLY (§6.7 intro) — it never
grows the active set, so no amount of minting ramps eligibility. The
~16-epoch ramp is therefore a MINT ramp (filling the RESERVE), and the
bulk-activation at arm is what makes those rows eligible. Sequencing:

1. Operator arms A2 (`liveeval12-allfam-age32`, r5 law, incl. the
   retire-genesis state rewrite) + A1 forced evolves.
2. The bridge `bmuTask` pass-through (a.1) lands canonically; generators
   stamp every subsequent mint (GLOBAL m = 1 mint law enforced from the
   first stamped cluster).
3. MINT ramp: generators mint ~25 stamped rows/epoch (≈ 5 clusters/epoch,
   rotating across all four families per the capability schedule). These
   QUEUE in the reserve (spliced BMU-first at `reservePtr`,
   `epoch-frontier.ts:252-260`) — the replacement-only pipe activates only
   a trickle of them; that is expected and fine.
4. Ramp arithmetic: ceil(380 / 25) ≈ **16 epochs minimum** of steady minting
   to accumulate ≥ N_min stamped rows in reserve ∪ active (= 2 A1
   forced-evolve cycles at cadence 8). This is generator THROUGHPUT
   arithmetic, not activation-pipe arithmetic.
5. ARM-GATE (b) count + census checks pass: stamped per-family counts ≥
   {80, 80, 80, 80} in reserve ∪ active (rev4.1 fix-2c recalibration: the
   rev3.1 {80, 110, 110, 80} floors were §6.7c bootstrap-ramp sizing
   artifacts; the executable-era census law mints families EQUALLY, so a
   replacement-only frontier converges to armCount/4 ≈ 107.5 rows/family and
   any floor > ~107 is guaranteed to erode into a permanent boot-census brick
   — measured in the P5 operation-general lane. The binding steady-state
   requirement is dual-pack quota fillability post-§6.3 exclusion, ≤ 2×15
   rows; 80 is 2.6× that bound); GLOBAL m = 1 census clean.
6. One-time BULK-ACTIVATION ((a) prerequisite 2): ≥ 380 stamped reserve rows
   activated in precommitted reserve order; new `activeFrontierRoot`
   repinned atomically with the bundle transition.
7. Two-pass rebaseline under the BMU law (§10) over the post-activation
   active set — now derivable, no throw — incl. the variance certification.
8. Flip (operator decision, outside this program).

**(d) G-B14 rehearsal step list (updated).** The fork rehearsal MUST:
(i) materialize a pre-flip corpus/frontier state with stamped rows BELOW
N_min and assert the arm-gate REFUSES with correct per-family counts;
(ii) advance the simulated mint ramp past N_min (reserve-resident stamped
rows) and assert the count + census checks open;
(ii-b) apply the one-time BULK-ACTIVATION ((a) prerequisite 2) and assert
the ≥ 380 stamped rows activate in precommitted reserve order with the new
`activeFrontierRoot` repinned atomically;
(iii) run the two-pass rebaseline under the BMU law over the
post-activation active set (blank ≠ parent trap explicitly checked; §2.4
variance certification enforced);
(iv) scorer sync of corpus + BMU bundle + active-id artifact;
(v) validator parity incl. §6.3/6.4 pack recomputation post-reveal;
(vi) signed rotation manifest accepted by a cold sidecar reload;
(vii) historical r4/r5 artifact replay unaffected (G-B12 rerun).

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

### 8.5 Pack-law MECHANISM deltas (no wire fields; part of the same coordinated change)

1. Overlay slot-allocation law: `liveEvalPack.familySlots` (per-BMU-family,
   3/3/3/3) replaces the logicalFamily round-robin as the admission unit for
   BMU packs; seeded per-slot draw + seeded full-membership fallback +
   fixed-order redistribution (§6.2, §6.4) — a semantics delta to
   `admitActiveLiveEvalEvents` behind absent-parameter back-compat.
2. Confirm-side exclusion threading through `deriveScoredQueryPack` (§6.4).
3. Frontier-aware broad-pack eligibility (`hiddenPackEventEligible` +
   `deriveQueryPack` activeIds threading, §6.5; §9 site 17).
4. Logical-delta-bridge `bmuTask` pass-through
   (`logical-delta-bridge.ts:355-375` allowlist extension, §6.7a
   prerequisite 1) — must land BEFORE pre-flip minting; replay-inert.
5. BMU arm-gate precondition (per-family stamped-row minima + GLOBAL m = 1
   census + fresh cohort + variance certification, §6.7b).
6. One-time arm-time BULK-ACTIVATION (`--bulk-activate` mode of
   `scripts/coretex-stagger-frontier-activation.mjs`, §6.7a prerequisite 2;
   offline, deterministic, atomic repin with the bundle transition) —
   required because the frontier's activation pipe is replacement-only and
   never grows the active set (§6.7 intro).

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

18. **[LAW]** `src/validator-sync-cli.ts` — the validator SCORE-REPLAY path
    (`buildValidatorScorerContext` `:1414-1439` and the post-reveal
    score-replay drain that rescoring advances flows through, `:2220+`,
    incl. the `scorerForParent` construction): BMU artifacts MUST be
    re-scored under the BMU law — bmuTask eligibility (§4.3),
    `familySlots` overlay slot law (§6.4), and the §6.3 exclusion — routed
    by the artifact's pinned bundle profile. An r5-era artifact keeps the
    r5 path (G-B12).

Rule for implementers: introduce a single
`isR5StateLaw(pipelineVersion): boolean` helper and replace every literal
`=== 'coretex-retrieval-v2-policy-r5'` STATE check with it in one commit, so
the LAW sites are the only places the two versions diverge. Any site
discovered later that still string-compares the r5 literal for a state
decision is a bug with a failing-closed symptom (BMU bundle refused), never a
silent misdecode — this asymmetry is why I2 pins BMU to the r5 state law.
**Fail-closed asymmetry rule for LAW sites (rev3.3):** membership in
`CORETEX_PIPELINE_VERSIONS_SUPPORTED` MUST NEVER imply the r5 SCORING path.
Scoring/validation routing at every [LAW] site switches EXPLICITLY on the
version string and THROWS on any version it does not explicitly route —
adding a version to the supported set makes it replayable-in-principle, not
silently r5-scored. A forgotten LAW site therefore refuses BMU artifacts
loudly rather than mis-scoring them under the wrong law.

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
  the per-family baseline decomposition auditable at rebaseline time. The
  measured `variancePpm` does NOT feed the acceptance threshold (BMU pins
  `baselineVarianceSource = 'unavailable'` — the §2.4 variance law); instead
  it is the §6.7 ARM-GATE flip-stability certification input (must be
  ≤ 7,811 ppm (integer pin for strict < q/2 = 7,812.5), else do not arm).
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
- label commit-reveal corpus distribution (§6.5 — v2 escalation path only);
- exposure-based row retirement (rev2's retire-on-exposure, DELETED in rev3:
  ~124 exposed rows per accepted artifact vs the ≤24 per-evolve shared drain
  diverges 10–25× and starves retire-by-age (I7b violation), and it is a new
  subsystem beyond I1-I10 — v2 escalation path only, with its own dedicated
  drain budget if ever adopted).

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

- **Quantize the COMPOSITE final score, not raw reranker scores.** The final
  ordering the judge consumes is
  `finalReorderingScore = effRerank(docId, rerankerScore) + finalBonus +
  policyBonus` (`retrieval-benchmark.ts:2354`, sort `:2358-2364`) — raw
  reranker scores are only one term, and bonuses push the composite outside
  [0,1]. The judge ranks by `finalReorderingScore` QUANTIZED to a
  bundle-pinned grid `judgeScoreGrid` (default g = 1e-3 in composite-score
  space). **Range analysis:** `effRerank` ∈ [0,1] (normalized reranker
  score; peer inheritance takes a max of in-range values,
  `:2151-2158`); `finalBonus = lensBonus + anchorBonus + temporalBonus +
  categoryLensFinalBonus + aspectBonus` (`:1911`), each term bounded by its
  pinned profile beta (live betas are O(0.1), e.g. `temporalCurrentBoost`
  0.1); `policyBonus` is the bounded query-local nudge
  ±(budget/1000)·UNIT PER ATOM with UNIT = max−min rerankerScore ≤ 1
  (`:2160-2168`). **Honest stacking arithmetic (rev3.3 — rev3's
  per-mechanism "P" undercounted):** multiple atoms can target the SAME doc,
  and with up to 128 atoms per policy region the uncapped worst-case per-doc
  policy contribution is ≈ 77 in composite-score units — nowhere near the
  ≤ 4 bound rev3 asserted. **PINNED FIX: per-doc atom-contribution cap** —
  the BMU judge clamps the SUMMED `policyBonus` per doc to ±1·UNIT
  (P_cap = 1) before quantization. (Chosen over re-deriving an
  honest-but-huge Rmax, which would put ~78,000 cells on the grid and
  dilute the margin semantics.) With the cap the composite lies in
  [−temporalStaleSuppression − P_cap,
  A + lensWeight + anchorWeight + temporalCurrentBoost +
  categoryLensFinalBonusWeight + aspectBoost + P_cap], where
  `A = max(1, categoryLensScoreInheritance, forcedMultiHopAlpha) = 1` after
  validating the configured inheritance alpha is finite and in `[0,1]` (the
  multi-hop law forces alpha to at least 1). BMU bundle validation therefore
  computes the full two-sided range
  `Rmax = A + lensWeight + anchorWeight + temporalCurrentBoost +
  temporalStaleSuppression + categoryLensFinalBonusWeight + aspectBoost +
  2·P_cap` and asserts Rmax ≤ 4. Both temporal sides are additive: using
  only `max(currentBoost, staleSuppression)` would undercount the interval
  whenever both are positive. This remains ≤ ~4,000 grid cells at g = 1e-3.
  Bundle validation also asserts the pinned
  `judgeScoreGrid` ∈ (0, 0.1] (rev3.3 ratified domain).
- **Tiebreak (fully quantized):** (quantized composite desc, quantized
  `rerankerScore` desc, `docId` asc). The FIRST two keys are quantized —
  the existing secondary tiebreak compares RAW rerankerScore
  (`:2362`), which would reintroduce float sensitivity exactly when
  composites tie on the grid. docId comparison unchanged (`:2363`).
- **Certification margin screen (P2, mandatory) — two boundaries, three
  states.** A task is certified only if, on the blank-state, parent, AND
  oracle-solved substrates:
  (1) FINAL-ORDER boundary: every required/forbidden doc's quantized
  composite gap to the rank-B boundary is ≥ 3 grid cells; and
  (2) ADMISSION (cap) boundary: in `preRankScore` space
  (`preRankScore = biCosine + admission bonuses`,
  `retrieval-benchmark.ts:797,839,2433` — the sort that selects the
  `rerankerInputTopK` candidates; live pin 64, see §15.8), every
  required/forbidden doc is ≥ 3 cells (grid g_pre = 1e-3) away from the
  rank-`rerankerInputTopK` admission boundary — ON WHICHEVER SIDE it
  belongs for that state. A doc outside the cap is invisible to the final
  ordering no matter how large its judge margin; `grounding: 'distant'`
  bridge docs (the multi_hop payload) sit at this boundary BY CONSTRUCTION —
  out-of-cap on blank (that IS the headroom; must be out by ≥ 3 cells so
  the miss is deterministic too) and in-cap on the oracle-solved state
  (must be in by ≥ 3 cells; the substrate's routing is what admits them, so
  the oracle-state margin is the binding certification requirement).
  Boundary flips become certified-rare at BOTH boundaries, not structural.
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
  9319→19 mass-flush hazard is the forbidden mode) — adopted as BMU's ONLY
  retirement mechanism (§6.2, §6.5; rev2's retire-on-exposure deleted, §12);
- A2's namespace resolution (quota strata in bucketed-family names,
  familyPriority in logicalFamily names — §5.6);
- typed-cluster generation as the substrate of mineability
  (`buildTypedTemporalClusterSpec`, `scripts/lib/evolve-corpus.mjs:114-188`),
  the capability schedule + escalation (`:199-215`), attribute rotation
  (`temporalAttributeForEpochSlot`, `:71-81`) and the motif-amplification
  law it manages (an attribute is one-shot headroom; rotation is the
  anti-exhaustion mechanism) — WITH one rev3.1 constraint the §4.1 m = 1
  multiplicity pin imposes: the inherited rotation reuses SUBJECTS across
  epochs by design, but under m = 1 a same-subject-new-attribute cluster of
  the same family MUST wait until the subject's prior cluster RETIRES
  (≤ maxAge = 32 epochs). Subject supply makes this cheap (2,121+ temporal
  subjects at the current corpus scale vs ~5 clusters minted per epoch);
  the generator simply rotates subjects as well as attributes;
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
   **OPERATOR RATIFICATION REQUIRED (go/no-go packet item):** this
   reinterpretation of I9's privacy clause is a spec-level reading of an
   handoff invariant and must be explicitly ratified by the operator before
   any BMU arming decision; it is logged ledger-side.
8. **(rev3) `rerankerInputTopK`:** handoff §2.1 cites 128; the LIVE bundle
   pins 64
   (`release/calibration/2026-06-04-memory-atom-v16/bundle-manifest-…-liveeval8.json:212`).
   §13.2's cap-boundary rule is written against the PINNED value, whatever a
   BMU bundle pins.

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
private pre-reveal at every tier. This reading requires OPERATOR
RATIFICATION in the go/no-go packet (§15.7). (d) I7(a)'s "guaranteed
fresh-frontier share" is read per §6.4: the 12-slot overlay share is
guaranteed as CAPACITY in every pack EXCEPT the confirm-side exclusion
worst case (§6.2 honest corner: as few as 6 of 12 slots fillable —
graceful underfill, never refusal); its FRESHNESS is guaranteed only when
per-family fresh cohorts suffice — a family whose fresh cohort is thin
(routine for confirm post-exclusion) degrades to a seeded draw over its
full eligible-active membership, never to a predictable deterministic
order. Tests and gate phrasings MUST NOT assert unconditional capacity or
freshness: assert cohort-conditional freshness, worst-case-bounded
capacity, plus fallback/underfill-engagement telemetry.

---

## 17. Changelog

### rev4.0 → rev4.1 (candidate-executable operation era and keyed opaque ids; 2026-07-10)

**Three-question decision (G-B17 design freeze):**

1. **Where candidate state causally enters.** Every v2 row, task, and cluster
   carries one canonical `bmuOperationCue` and one public
   `bmuOperationProgram { branchLimit: 4, steps }`. The cue selects a decoded
   four-word program in state words 384–511; the interpreter applies its
   ordered directed steps to public stage-1 seeds and admits only fresh
   terminal events to Qwen. ZERO_STATE and an obsolete-key parent have no
   matching program and cannot admit those operation-caused terminals. One
   public four-word patch is sufficient for two I6-disjoint generated rows
   sharing a cue/program; load validation recomputes the exact operation class
   and rejects any cue/program/class drift.
2. **What executable class space exceeds capacity.** All four generators use
   the same enumerated disjoint-partition deep-terminal bank of 36 programs
   (32 three-step + 4 four-step): one `outgoing` step over the causal pair,
   then a 2–3 step `incoming` chain over the evidence quad (fix 2a; the
   original 6×6 two-step matrix minted symmetric-route diagonals the decoder
   refuses and promiscuous multi-terminal routes the §18 bias makes
   unsolvable). Semantic prose, topology diagnostics, and row variants do not count
   as class identity. The executable-era schedule alternates mint counts
   A=`{temporal:2, conflict:2, multi-hop:1, near-collision:1}` and
   B=`{temporal:1, conflict:1, multi-hop:2, near-collision:2}` for 24 A/B
   cycles. It therefore mints 72 clusters and exactly 36 paired executable
   signatures per family, each pair I6-disjoint, giving `36 − 32 = +4`
   resident-capacity margin. Cue, query-key, and executable-signature
   collision censuses MUST all be zero. The era starts on an even per-family
   cursor (or first completes a carried pair); otherwise a 72-mint window has
   two unsupported boundary singletons and cannot claim 36 adjacent pairs.
3. **What inversion and shortcut surfaces remain.** Program cues and bytecode
   are intentionally public; required/forbidden branch semantics are not.
   Under the deep-terminal law the routed-terminal position is public BY
   DESIGN (the program points at the answer; the reward channel is state
   execution, not answer secrecy): the hard blindness gate is that ids and
   metadata alone — WITHOUT executing the public program — solve nothing,
   decoys are mutually indistinguishable depth-1 dead ends, and golds are
   observationally identical to each other. The certification route-closure
   audit executes the actual program and requires terminals == golds with no
   routed decoy/forbidden doc. Document ids MUST be generated from
   a required independent keyed HMAC secret whose artifact exposes only a
   commitment; known public seeds and wrong keys MUST fail the inversion gate.
   Traversal is a simple path: already-visited events are removed before the
   branch cap, preventing diagonal `outgoing:X`→`incoming:X` programs from
   spending capacity by backtracking to their seed. G-B17 remains red until an
   independent refuter confirms all three properties on the integrated tip.

**Miner-facing simplicity sentence:** *Encode the public directed relation
program in four state words so hidden queries can route balanced evidence that
blank state cannot reach.*

- Seed-only SHA-256 document ids are replaced by required keyed
  HMAC-SHA-256 identities across all four generators. Security no longer
  relies on the generation seed remaining private; certification and
  simulation artifacts may continue to pin that seed. Only a key commitment
  may enter evidence.
- A permanent known-seed generator-inversion lane applies at P2 and P6. The
  attacker receives generator source conventions, seed, epoch, motif id, and
  the complete bounded slot vocabulary, but not the HMAC key or hidden labels.
  It tries both the refuted v1 formula and a public seed-derived key guess.
  Passing requires zero public-id matches and zero judged successes in every
  family; a correct-private-key positive control prevents a vacuous harness.
- This identifier lane does not replace the exact-text, relation/metadata,
  recency, selector, BGE, or Qwen shortcut gates. All remain mandatory.

### rev3.4 → rev4.0 (BMU v2 replacement law; 2026-07-10)

**Miner contract (one sentence, §18.3):** *encode directed relational programs
in your substrate state that route AND lift queries the base stack cannot route
— a routed terminal is promoted into the judged answer set only because your
program reached it.*

**Decision:** v1 is retained solely for replay. The replacement pipeline is
`coretex-bmu-v2-r5state`; it preserves the r5 state layout, I1 scalar, I5
deterministic judge, and I6 gate/confirm exclusion, but removes the v1
family-specific scorer assistance that made a one-class miner saturate every
family.

- **One primitive, no family switch:** v2 admits a bounded directed public
  path bundle before reranking. It starts from at most four stage-1 public
  seed events, applies two explicitly ordered edge/direction steps, and takes
  at most four codepoint-sorted public branches per event. Only terminal
  branches are admitted (one document per terminal); intermediate traversal
  nodes are never candidates. The calculated terminal maximum
  (`seeds × branchLimit^steps`) MUST fit the pinned Qwen input cap. After the
  complete candidate pool is known, terminal branches plus every direct or
  otherwise mandatory routed anchor MUST also fit that cap or evaluation
  refuses before Qwen; deterministic slicing is forbidden. This exact check
  corrects the rejected 80-as-64 accounting (`16` intermediate + `64`
  terminal docs) from the first v2 draft. The primitive reads
  neither qrels, `bmuTask`, family, role, timestamps, lifecycle metadata, nor
  `publicIntent`. Every admitted branch is sent to the existing Qwen cap as a
  normal candidate.
- **§18 era-iteration delta (program-derived ranking bias, `4619dad`→ this
  tip):** the first v2 draft gave admitted terminals NO final-score promotion,
  so admission alone could not move utility — real Qwen simply did not rank a
  routed terminal into topB, and every family's gate delta was 0 before confirm
  bound (the gate+confirm NEGATIVE finding). This tip restores candidate-state
  *causality over the judged order* with the minimal, in-doctrine mechanism:
  each routed TERMINAL receives a uniform `BMU_V2_PROGRAM_ROUTE_BONUS_UNITS`
  (=1)·UNIT bias in the SAME clamped `policyBonus` channel (UNIT = max−min
  rerankerScore over the query's reranked list), and a routed terminal wins a
  quantized-composite tie over a non-routed doc. The bias reads no qrel, answer,
  family, motif, id, or metadata — every routed terminal gets the identical
  magnitude. It rides the existing ±1·UNIT summed clamp (P_cap = 1), so **Rmax
  is unchanged** (this is not a new Rmax term). Answers to the three questions:
  **(Q1) causality** — the bias exists ONLY via terminals reached by an
  EXECUTED candidate-state program; ZERO_STATE decodes no programs, admits no
  terminals, and receives exactly zero bias (pinned by the §18 refutation
  regression, including an adversarial-Qwen control where the reranker ranks the
  routed terminal LOWEST yet the bias still promotes it while ZERO_STATE does
  not). **(Q2) executable class space unchanged** — the bias is per-execution,
  not per-class; it adds no operation classes and reads no labels. **(Q3)
  shortcut surface** — uniform magnitude, no labels, capacity-bounded by the
  resident program capacity (≤32 programs × branchLimit terminals) and the same
  ±1·UNIT clamp; keyed-id inversion is unaffected (the bias moves rank, never
  reveals ids). Because the bias promotes EVERY routed terminal uniformly, a
  cue's program that routes decoy or forbidden terminals, or a row whose
  required evidence is not a routed terminal, is UNSOLVABLE by construction —
  the generator MUST mint discriminating single-answer-terminal programs and the
  certification lane MUST reject rows failing the oracle-solved real-margin
  check (§ certification).
- **§18 era-iteration fixes 2+3 (this tip):** (2a) the generators now mint the
  disjoint-partition deep-terminal bank above — the executed terminal set
  equals the operation-required answer terminal(s), enforced by the mint lint,
  the deep-terminal route-closure audit, and the CPU-deterministic
  `oracleSolvedMargin` certification lane (forbidden-terminal routing, non-
  routed non-anchor required evidence, and top-B overflow are per-row
  REJECTIONS); the real-Qwen ≥3-grid-cell solved-state margin half runs on the
  emitted `coretex.bmu-v2.oracle-solved-margin-job.v1` pair manifest (GPU
  lane). (3) pack-density law: family overlay slots group into blocks of
  `BMU_PACK_CLASS_DENSITY` (=3); each block samples ONE operation class via a
  SEED-INDEPENDENT digest (`bmu-overlay-class-density-v2`) over the family
  cohort's sorted class list, so gate and §6.3 excluded-confirm packs sample
  the SAME classes; block draws lock to one motif cluster after the first row
  (the paired I6-disjoint cluster stays available to confirm), and base draws
  exclude sampled-class rows entirely. Acceptance arithmetic: one flip =
  15,625 ppm < the 20,000 ppm floor (single-row classes unacceptable by
  construction); the guaranteed two sparser-side rows give 31,250 ≥ 20,000 +
  11,250 margin. Deterministic, patch-independent, no miner steering;
  pre-executable cohorts draw byte-identically to rev3.1.
- **Free riders removed:** v2 force-disables temporal motif admission,
  conflict scope/classifier promotion, evidence motif admission, query-
  conditioned policy admission, entity/scope atom admission, conflict/evidence
  atom promotion, and relation-intent routing. It scores a query copy with
  `publicIntent` absent, so no `publicIntent.atom` selector can influence the
  law. The remaining substrate operation is generic path/ranking work.
- **Field oracle closed:** temporal and multi-hop generated public document
  envelopes serialize neither `role` nor role-correlated `kind` values. Their
  emitted kind is the neutral `bmu_public_record`; generator-local role
  diagnostics are non-enumerable and never enter canonical JSON, corpus roots,
  or miner-visible documents.
- **Proof obligation unchanged and explicit:** this implementation is not a
  claim of sustainability. v2 requires multiple truthful operation classes and
  balanced same-path decoys per family, a metadata-only P6 failure, one
  same-patch real-Qwen gate + excluded-confirm acceptance per family, then
  `GREEN_SUSTAINABLE` P5, parent/blank K=5, parent/oracle three-state margins,
  watermark horizons, and shadow evidence before any operator action.
- **Generic bank certification:** `certify-v2-bank.mjs` separates public-only
  attackers from an explicitly hidden `bmuTask` solvability oracle. Generic
  gates cover full-bank random-K ≤5%, balanced-terminal indistinguishability,
  id/metadata/path-only failure, role/kind retirement, operation-class
  capacity/repeat census, cross-family doc/query/publicIntent dedup and global
  alias-aware m=1. Temporal registers recency and validity-currency public
  lanes through the adapter API. A commit-bound no-substrate job pins the full
  BGE-all-docs → exact top-K Qwen input/output contract and rejects cache
  rebinding; cheap certification is never a substitute for its fresh full-bank
  real-model output or three-state scorer margins.

### rev3.3 → rev3.4 (pre-arm metadata-integrity hardening)

- **F3 doc-id oracle removed:** all four BMU generators now emit
  deterministic SHA-256-derived opaque document ids. Family/role suffixes
  (`_cur`, `_stale`, `_ans`, `_ca`, `_ne`, etc.) are forbidden on public
  generated ids; construction roles remain generator-internal.
- **F7 exact temporal answer pointer removed:** BMU stale docs no longer
  publish `validity.supersededBy`. Non-leaking interval semantics
  (`validFrom`/`validUntil`/`observedAt`) and the public structural
  `supersedes` relation remain.
- **F8 alias-aware holdout:** `bmuTask.entityHoldoutKeys` adds the canonical
  subject id plus normalized canonical name/aliases to gate→confirm
  exclusion. Historical absence is load-compatible only; ARM/BOOT refuse it.
  The global m=1 census now covers these keys and refuses shared owner ids,
  while broad doc `entityIds` remain outside the holdout field.
- **F7 recency/currency screen:** temporal certification now includes
  subject-scoped last-mention and attribute-aware validity-current attacker
  lanes. Four current same-subject/same-attribute observations per cluster,
  all available no later than query time, make those shortcuts
  non-discriminative without relying on the forbidden veto;
  explicit gold-only “supersession ledger / superseded and replaced” prose is
  removed from the BMU current/provenance documents.

### rev3.2 → rev3.3 (P3-R1 implementation-review backports — documenting decisions already made)

- **(1) Boot-vs-arm posture (blocker fix, orchestrator ruling, §6.7b):**
  fresh-cohort ≥ 2 clusters/family binds at ARM only; boot/evaluator
  construction re-checks the STRUCTURAL census (counts ≥ E_f_min + global
  m = 1), never freshness. Fresh-AGE pinned to the row's MINT epoch
  (id-embedded, `liveEpochFromEventId`), not activationEpoch; liveness
  rationale stated (mints only at evolves, cadence 8, freshWindow 2 ⇒
  boot-time freshness false ~6/8 epochs).
- **(2) §9 site 18 [LAW]:** validator score-replay
  (`validator-sync-cli.ts` `buildValidatorScorerContext`/`scorerForParent`
  path) must score BMU artifacts under the BMU law; fail-closed asymmetry
  rule for LAW sites added (SUPPORTED-set membership never implies the r5
  scoring path; explicit routing, throw on unrouted versions).
- **(3) Terminal semantics ratified (§6.2/§6.4):** graceful underfill with
  composition/underfill telemetry, never refusal (reviewer-ruled sound, not
  materially gameable).
- **(4) Digest/byte conventions pinned (§6.4):** digestU256 =
  plain-concatenation keccak256 read as big-endian u256; seed hex parsed
  case-insensitively, canonical lowercase 0x form; `bmuQuantize(x) =
  Math.round(x/g)` (ties toward +∞); redistribution = first-fit over all
  four families restarting at temporal, redistributed slot continues the
  TARGET family's numbering; codePointCompare = UTF-16 code-unit order.
- **(5) Rmax stacking honesty (§13.2):** per-mechanism P undercounted
  multi-atom same-doc stacking (uncapped worst ≈ 77 vs the asserted ≤ 4
  with 128 atoms/region). PINNED: per-doc atom-contribution cap — summed
  policyBonus clamped to ±1·UNIT per doc before quantization; Rmax =
  1 + B + 2·P_cap ≤ 4 re-validated (cap chosen over an honest-but-huge
  Rmax ⇒ ~78k grid cells).
- **(6) Exclusion-key charset law (§4.1):** subjectEntityId/templateId
  reject control characters (incl. `'\n'`) at corpus load + mint lint —
  kills join-injection into the exclusion-set digest; charset rejection
  chosen over digest length-prefixing (implementation decision).
- **(7) Variance boundary integer (§2.4, §6.7b, §10):** q/2 = 7,812.5 ⇒
  acceptance is spread ≤ 7,811 ppm (strict <), pinned at every normative
  site (incl. the screener noise clamp: ≤ 7,811 ⇒ noiseDelta ≤ 15,622 < q).
- **(8) judgeScoreGrid domain ratified (§13.2):** bundle validation asserts
  g ∈ (0, 0.1].
- **(9) §6.7a wording fix:** pre-flip stamped rows are SCORING-inert under
  r5 but NOT validation-inert — §4.1 bmuTask validation is
  version-independent and live from stamping; mint-time lint is mandatory
  from the first stamped cluster (an invalid stamped mint would brick the
  r5-era corpus load).
- **(10) Golden vectors required (§6.4, §6.7b):** committed golden hex
  vectors for the seeded-draw byte law and the variance-seed schedule;
  every independent implementation reproduces them byte-for-byte.

### rev3.1 → rev3.2 (diff-review re-edits)

- **(A) m = 1 made GLOBAL (§4.1, §6.2, §6.7b):** rev3.1's per-family scope
  left cross-family subject/template reuse spilling exclusions between
  families through the GLOBAL §6.3 exclusion set — re-opening the
  confirm-refusal DoS (E_f_min assumes zero cross-family spill). Now: ≤ 1
  active cluster GLOBALLY per subject/template within the maxAge window;
  arm-gate census global. Honest corner added (§6.2 + softened §16 note
  (d)): in the exclusion worst case the total residual (Σ = 70) minus the
  confirm base fill (64) leaves ≤ 6 rows for the 12 overlay slots — the
  confirm overlay may underfill to 6 slots (graceful, never refusal;
  capacity is no longer stated as unconditional).
- **(B) Replacement-only frontier — the structural correction (§6.7):**
  activations strictly REPLACE retirements (`activateNext(ret)`,
  `epoch-frontier.ts:186-193,246-248`); the active set NEVER grows — A2's
  own evidence (g-a4-retirement-sim-rework-v2-retire-genesis.json:
  activeSizeStart = activeSizeEnd = 19 over 80 evolves / 948 mints) proves
  minting alone can never open the arm-gate. rev3.1's "activation pipe
  ramps eligibility" premise was WRONG. Fix: (i) new named canonical
  prerequisite — one-time arm-time BULK-ACTIVATION (`--bulk-activate` mode
  of `scripts/coretex-stagger-frontier-activation.mjs`; precommitted
  reserve order, offline + deterministic + atomic repin, same posture as
  retire-genesis), listed alongside the bridge pass-through in §6.7a and
  §8.5; (ii) frontier-continuity sentence amended — the BMU bundle DOES
  rewrite frontier state at arm, root-pin continuity per-epoch thereafter;
  (iii) ramp restated as a MINT ramp (~25 rows/epoch generator throughput,
  ceil(380/25) ≈ 16 epochs, filling the RESERVE); all pipe language
  corrected to per-EVOLVE units (frontier steps only at real evolves; max
  12/evolve via C3 in the A2 sim). Arm-gate census now counts stamped rows
  in reserve ∪ active; variance certification ordered AFTER
  bulk-activation; G-B14 gains step (ii-b).
- **(C) Probe-exhaustion semantics (§6.4):** j ≥ poolSize·8 marks the SLOT
  unfillable → fallback → redistribution chain; pack-derivation refusal
  only if redistribution also cannot fill (first-exhaustion refusal would
  have been a ~0.7%/evaluation stochastic refusal channel).

### rev3 → rev3.1 (post-PASS line-item edits)

- **(1) Multiplicity mint law (P2-blocking):** m = 1 PINNED (§4.1): a
  subjectEntityId and a templateId each appear in ≤ 1 active same-family
  cluster within the maxAge window — exclusion keys become coextensive with
  the cluster *(scope broadened to GLOBAL in rev3.2 (A))*. §6.2 fill feasibility restated at the TRUE worst case (N_f
  gate rows in N_f distinct clusters, subject+template counted; rev3's
  ceil(N_f/5) was the minimum-supply count, not worst case). §6.7b minima
  re-derived: `E_f_min = k·ceil(N_f·(k+1)/k)` = {80, 110, 110, 80},
  **N_min = 380** (76 clusters); ramp ceil(380/24) = **16 epochs** (was
  280/12) *(ramp premise corrected in rev3.2 (B): it is a MINT ramp; the
  activation pipe never grows the active set — bulk-activation at arm)*;
  s = 2 superseded (m = 1 removes the collision uncertainty it
  padded). m > 1 rejected: worst case scales as N_f·(m·k+1) (m = 2 conflict:
  198) for zero v1 benefit. §14.2 notes the attribute-rotation constraint
  (same-subject reuse waits for retirement; subject supply makes it cheap).
- **(2) A2 mechanism accuracy:** §6.7c now distinguishes A2's TWO mechanisms
  — the in-code bounded 24/epoch drain (`c677e36`) vs the one-time
  arm-time retire-genesis frontier-state rewrite
  (`scripts/coretex-stagger-frontier-activation.mjs` + atomic repin,
  `docs/a2-unbrick-arming.md`) — the ~19-row post-arm active set is the
  rewrite's doing. Ramp arithmetic premise corrected; pipe unchanged.
- **(3) Variance certification pinned executable (§6.7b):** states = parent
  AND blank; K = 5 scoreState runs per state, `samples: 1`, pinned seed
  schedule `keccak256('bmu-arm-variance' ‖ epochId ‖ stateLabel ‖ i)`;
  criterion = max pairwise spread < q/2 = 7,812 ppm per state; recorded in
  the signed rotation manifest (`armVarianceCertification`) + arm log;
  G-B14(iii)/(vi) rehearse it.
- **(4) I7(a) clarifying note (§16 note (d)):** overlay share is guaranteed
  CAPACITY; freshness is cohort-conditional; thin families degrade to
  seeded-active (never deterministic); tests must not assert unconditional
  freshness.
- **(5) Seeded-draw byte law pinned (§6.4):** domain `'bmu-overlay-v1'`,
  digestU256 tuple (domain, u64BE(epochId), seedBytes, UTF-8 family enum
  name, u64BE(slot), u64BE(probe)), without-replacement skip-probe bounded
  at poolSize·8 then fail-closed, pool sorted by codePointCompare(id);
  `familySlots` keys = `bmuTask.family` enum names.

### rev2 → rev3 (second adversarial-review response)

- **F1 (BLOCKER — transition bootstrap gap):** new §6.7. Pre-flip INERT
  `bmuTask` minting under the r5 era (loader field-inert per
  `retrieval-corpus.ts:844-914`; one canonical prerequisite: the
  logical-delta bridge's explicit field allowlist,
  `logical-delta-bridge.ts:355-375`, must gain a bmuTask pass-through).
  ARM-GATE precondition with derived minima
  `E_f_min = 2·2·ceil(N_f/5)·5` = {60, 80, 80, 60}, **N_min = 280**
  eligible-active rows (≈ 56 clusters) *(minima/N_min/ramp superseded by
  rev3.1 item 1: {80, 110, 110, 80}, N_min = 380, 16 epochs)*; A2→BMU
  sequencing with ramp
  arithmetic (activation pipe ≤ 24/epoch ⇒ ceil(280/24) = 12 epochs minimum
  of saturated minting after A2's retire-genesis ~19-row restart); G-B14
  rehearsal step list updated (arm-gate refusal below N_min is now a
  rehearsed assertion).
- **F2+7 (orchestrator decision):** retire-on-exposure DELETED (queue
  divergence 10–25× vs the shared ≤24/epoch drain; I7b starvation; new
  subsystem ⇒ default-DEFER). §6.5 restated: maxAge-32 bounded rotation +
  seeded overlay + forbidden-trap construction carry the Tier-V defense,
  with the honest statement that trap construction carries the per-row
  burden ALONE (labels visible for a row's whole ≤32-epoch life). Exposure
  retirement AND commit-reveal both on the §12 DEFER list.
- **F3 (composition arithmetic):** overlay slots now allocated per BMU
  FAMILY via a pinned `liveEvalPack.familySlots` = 3/3/3/3 (the inherited
  logicalFamily round-robin would yield ≈2/2/4/4 ⇒ conflict share 0.266,
  deviation 0.034 > ±0.03, validator-rejected). Slots draw from the union of
  each family's mapped logicalFamily cohorts (thin atoms pool into
  near_collision). End-to-end table recomputed for gate AND post-exclusion
  confirm: deviations 0.003/0.019/0.019/0.003 ✓; free fill excluded from the
  validator (±0.031 per-pack realized noise). Added as §8.5 mechanism
  delta 1.
- **F4 (quantize the right object):** §13.2 now quantizes the COMPOSITE
  `finalReorderingScore = effRerank + finalBonus + policyBonus`
  (`retrieval-benchmark.ts:2354,2358-2364`) with range analysis
  (composite ∈ [−P, 1+B+P]; bundle validates Rmax = 1+B+2P ≤ 4; g = 1e-3);
  tiebreak fully quantized (quantized composite, quantized rerankerScore,
  docId) — the raw-rerankerScore secondary tiebreak at `:2362` would
  reintroduce float sensitivity; NEW cap-boundary certification in
  `preRankScore` space at the `rerankerInputTopK` admission boundary
  (± 3 cells on whichever side each doc belongs, per state), binding for
  `grounding:'distant'` bridge docs on the oracle-solved state.
- **F5 (variance law):** `baselineVarianceSource = 'unavailable'` pinned ⇒
  variance term ≡ 0, threshold exactly 20,250 (2-flip law preserved);
  justification: Δ is same-pack, cross-pack parent variance never enters the
  accept comparison; the protection moves to the §6.7 arm-gate (measured
  scoreState variance < q/2 = 7,812 ppm, flip-stability certification).
  Screener controller inputs pinned: `recentNoiseFloorPpm` clamped < q/2 ⇒
  screener ∈ [4,050, 15,624] < q — the 1-flip screener lane survives; the
  anti-gaming ×6 multiplier can still raise it to the 20,250 ceiling under
  active probe attacks (intended defense, noted).
- **F6 (fallback predictability):** the overlay fallback is a SEEDED draw
  over the family's full eligible-active membership — never deterministic
  newest-first (which re-opened rev1-B3 in the thin case); a minimum-cohort
  precondition was rejected because thinness arises per-patch
  post-exclusion and would let corpus state DoS evaluation.
- **Also:** §15.7 I9 reinterpretation marked OPERATOR RATIFICATION REQUIRED
  (go/no-go packet item; mirrored in §16 note (c)); §15.8 added
  (`rerankerInputTopK` 128-vs-64 citation drift); no new mechanisms added
  beyond the review-specified deltas.

### rev1 → rev2 (first adversarial-review response)

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
  lucky-dual-sample channel, pre-operation-requirement). *(rev3:
  retire-on-exposure subsequently DELETED — see rev2→rev3 F2+7 above.)*
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
