# BMU_CROSSFAMILY_DISTINCTNESS.md — cross-family operation distinctness (§17.29)

> ## ⚠️ HEADLINE CORRECTION (§17.35) — SIGNATURE distinctness ≠ CREDITED distinctness
>
> The independent verifier established from the real code that the scorer credits
> `u=1` **iff `required ⊆ topB ∧ forbidden ∩ topB = ∅`** (set membership); it does
> **NOT** read the promote/demote signature. So every "144 distinct" / "4
> genuinely-distinct operations" claim below is a **BYTECODE-SIGNATURE** count, not
> an **operation** count. On the metric the scorer actually credits:
> - the four families reduce to **2 credited operation-classes** —
>   **suppress-forbidden-seed@1** (temporal, conflict_lifecycle, near_collision) and
>   **spare-required-seed@1** (multi_hop). The distinguishing axis is the family's
>   **SEED ROLE** (forbidden vs required), not depth/flag bytecode.
> - measured credited cross-family transfer = **216** (the 3 forbidden-seed families
>   mutually earn credited utility: 6 ordered pairs × 36); multi_hop transfers with
>   no one. Own-control is **36/36** per family on the REAL seed.
> - 144 = distinct **cue-bearing** operationClass strings; **72** = distinct
>   **bytecode** step-signatures; **2** = distinct **credited** operation-classes.
>
> §17.29's "72 accepted headroom" was therefore right about the operation reality.
> The era-3 "4 genuinely-distinct operations" framing is **RETRACTED**; the honest
> N1 ceiling under the current utility is **2**. See the §17.35 feasibility verdict
> at the end of this file. (The text below is preserved for history; read it through
> this correction.)

Records the outcome of Fable 5 ruling (2): pursue 144/144 distinct cross-family
canonical step-signatures (4 families = 4 genuinely-distinct memory operations,
the N1 north-star). Verdict: **NOT reachable within the hard constraints; the 72
design is RETAINED as accepted headroom** — with the rigorous rationale below.
Probe: `.ops/coretex-bmu-crossfamily-144-feasibility.mjs`; evidence
`.ops/bmu-evidence/crossfamily-144-feasibility-<commit>/`.

## The target and the constraints
Target: 144 distinct cross-family step-signatures per era (ratio 1.0), both eras.
Hard constraints (ruling): stay within the 6 decoder-known edges; no new edge
types; no decoder / keyed-inversion change; keep the deep-terminal (≥3-step) bank.

## (A) Exhaustive ceiling = 112/144 — 144 is IMPOSSIBLE via flags
The only per-family lever inside the constraints is the suppress overlay: one
mutually-exclusive flag (none / 0x20 suppress / 0x40 offPathSuppress) per
suppressable NON-FINAL INCOMING step (the live generator forbids flags on the
outgoing seed and the terminal step).

- A **3-step** program has exactly ONE suppressable step (step 1) ⇒ **3** flag
  patterns. With 4 families, ≥1 pair MUST collide (pigeonhole).
- A **4-step** program has two (steps 1,2) ⇒ 9 patterns.
- Current bank = **32 three-step + 4 four-step**. Ceiling =
  `32·min(4,3) + 4·min(4,9) = 96 + 16 = 112 < 144`.

So no flag assignment over the current bank reaches 144. (Locked by
`crossFamilyDistinctnessCeiling` + `bmu-v2-era-transition.test.mjs`.)

## (B) The 72 collapse is CORRECTNESS-FORCED, not cosmetic
At depth 1 the deep-terminal law distinguishes exactly **two** correct program
operations, by SEED treatment (verified by executing both over a depth-1-trap
topology):

| operation | forbidden seed | depth-1 decoy | required gold |
|---|---|---|---|
| `suppress@1` (0x20) | DEMOTED (lineage) | demoted | promoted |
| `offPathSuppress@1` (0x40) | spared | demoted (off-path) | promoted |

`temporal`, `conflict_lifecycle`, `near_collision_abstention` all have a
**forbidden seed** (stale base / rejected candidate / collision seed-trap) that
MUST be demoted ⇒ all three correctly use `suppress@1` ⇒ their program
step-signatures are IDENTICAL BY CONSTRUCTION. `multi_hop_relation` has a
**required seed** (the bridge) ⇒ `offPathSuppress@1`. There is no correct 3rd
depth-1 operation. The 3-family collapse is a genuine OPERATIONAL EQUIVALENCE:
at the program-traversal level the benchmark currently expresses ~2 distinct
operations (demote-seed vs spare-seed) over ONE shared 36-route bank
(traversal-signature census = 36 for all four families).

## (C) The only path to 144: an all-4-step multi-depth bank
Genuine 4-way distinctness needs operations at DIFFERENT DEPTHS: an **all-4-step
(depth-3) bank** where each family suppresses at a distinct (depth, flag) and
each depth's suppress correctly evicts a trap placed at that depth. A standalone
proof-of-mechanism (probe part C) confirms this reaches **144/144** with every
signature single-family. It is a real redesign (re-derive four families' trap
topologies to distinct depths + re-prove the certification lanes; high blast
radius vs the proven §18 32/4 bank), so for THIS lane the 72 design is retained.

## §17.30 FEASIBILITY GATE (ruling-3) — the Qwen cap does NOT block era-3
The §17.29 note above worried that an all-4-step bank "likely violates the Qwen
terminal-cap (`seeds·branchLimit^3` = 256 > 128)". **That is CORRECTED.** Real
numbers from the pinned scorer (probe part D,
`.ops/coretex-bmu-crossfamily-144-feasibility.mjs`):

- **Pinned cap = `rerankerInputTopK = 128`** (MemReranker cross-encoder pool;
  bundle DEFAULT + signed launch profiles).
- The **only enforced check** is the RUNTIME mandatory-pool refusal
  (`retrieval-benchmark.ts:2342`): throws iff (publicPath TERMINALS + direct/
  routed anchors) > 128. There is **NO static `seeds·branchLimit^steps`
  precheck** — that formula is a design-time upper bound, never a gate.
- Terminals admitted = FINAL-frontier only, one doc per terminal
  (`retrieval-benchmark.ts:1372`); intermediates are NOT admitted. **Measured
  depth-3 mandatory pool = 1 terminal + 3 promote-path intermediates**; realistic
  worst case (≤4 golds + intermediates + cluster/overlay anchors) ≈ **28**, i.e.
  **~100 slots of headroom**. The 256 figure was the LOOSE b-ary worst-case fan,
  which the controlled single-answer-terminal topology never realizes.

**VERDICT: FEASIBLE.** ≥4 genuinely-distinct operations fit within the cap; depth
3 supports up to **9** distinct operations (2 suppressable steps × 3 flag states),
of which only 4 are needed.

### Recommended era-3 bank (feasibility-validated; implementation = dedicated lane)
- **Shape:** all-4-step (depth-3); 36 distinct base routes/family.
- **Edge partition (cross-era disjoint):** outgoing `{coreference_of,
  co_occurs_with}` (the last unused pair — disjoint from era-1
  `{causes,derived_from}` and era-2 `{supports,supersedes}`), incoming
  `{causes, derived_from, supports, supersedes}`. ⇒ cross-era reuseRatio 0 vs
  BOTH prior eras; six edges = three fully-disjoint outgoing pairs = three eras.
- **Per-family depth/flag (4 genuinely-distinct operations):** temporal
  `suppress@1`, conflict_lifecycle `suppress@2`, near_collision_abstention
  `offPathSuppress@1`, multi_hop_relation `offPathSuppress@2`. Each produces a
  DISTINCT demotion set (mechanically verified) ⇒ **census 144/144, ratio 1.0,
  every signature single-family**.
- **Guards (all validated in probe part E + regression test):** within-family
  reuseRatio 0 (36 distinct/family); cross-era reuseRatio 0; disjoint-partition
  (outgoing∩incoming=∅); Qwen cap OK (pool ≈28 ≪ 128); G-B17 Q1 (state-decoded,
  ZERO_STATE inert), Q2 (144 > capacity 32), Q3 (the (depth,flag) lives in the
  CHECKSUMMED bytecode, not a readable label; family is already public via the
  cue by design; required-evidence topology differs behind the keyed-HMAC/
  deep-terminal blindness — no answer-id leak, no keyed-inversion shortcut).
- **Implementation caveat (the era-3 lane's work, NOT this gate):** re-derive each
  family's trap topology to place its trap at the family's assigned depth so the
  depth/flag correctly evicts it (suppress@1/@2 and offPathSuppress@1/@2 all
  mechanically proven); keep rendered lineage < `maxRenderedLineageChars` 8192
  (4 path segments — comfortable).

This lane STOPS at the verdict per the ruling; era-3 is a sequenced implementation
lane, no longer runtime-gated.

## Decision
- **Retain the 72 design.** No change to the live grammar/generators/decoder.
- Accepted headroom: 72/144 distinct cross-family sigs (0.500), both eras.
- All other guards hold unchanged: within-family transfer reuseRatio 0
  (distinctStepSigs == 36/family), cross-ERA reuseRatio 0 (era-2 disjoint),
  G-B17 Q1-Q3 (the collapse adds no family-label/keyed-inversion shortcut — the
  cue already publishes the family by design; distinctness would live in
  required-evidence topology behind the HMAC/deep-terminal blindness), and the
  4-family applied-bounded-state exercise (net>0 across rotation, static
  collapse, transfer honest).
- **N1 finding (surfaced):** with only two depth-1 program operations available,
  the 4-family benchmark tests ~2 distinct traversal operations at the program
  level today. Reaching 4 requires new operation PRIMITIVES (multi-depth
  suppression), not a relabel — the strategic input the ruling was after.

---

## §17.35 CREDITED-FEASIBILITY VERDICT (the honest N1 ceiling under the current utility)

**Metric.** The scorer credits `u=1 iff required ⊆ topB ∧ forbidden ∩ topB = ∅`
(`computeBmuTaskUtility`, set membership; it does NOT read the promote/demote
signature). A "genuinely-distinct credited BEHAVIOR" = a cluster configuration on
which a wrong-family operation FAILS credited utility. The distinguishing axes are:

- **SEED ROLE** — forbidden on-route seed (needs `suppress`, evicts on-route
  lineage) vs required on-route seed/bridge (needs `offPathSuppress`, spares it).
  A wrong flag → `forbidden_admitted` or `missing_required`. → 2 classes.
- **TRAP DEPTH d** — a query-competitive forbidden trap PRODUCED at step d is
  demoted ONLY by a `suppress@d`; a `suppress@d'` (d'≠d) leaves it in topB.
  **Verified by real execution:** suppress@1 on a depth-2 forbidden trap →
  `forbidden_admitted`; suppress@2 → pass. So depth is a real credited axis.

**Theoretical maximum** within the depth-3 (4-step) bank = {seedRole:2} ×
{depth:1,2} = **4** credited classes {S@1, S@2, O@1, O@2}, all within the Qwen
mandatory-pool cap (~28 ≤ 128) and the 6-edge decoder (no new edges).

**Achievable under the CURRENT corpus/task design = 2.** Every current generator
emits a DEPTH-1 trap/bridge: temporal (forbidden seed + depth-1 recency decoys),
conflict_lifecycle (forbidden seed + depth-1 scope decoys), near_collision
(forbidden seed + depth-1 collision decoys) → all **S@1**; multi_hop (required
depth-1 bridge + depth-1 off-path decoys) → **O@1**. The depth-2 credited slots
are UNPOPULATED — no current family has a depth-2-only query-competitive trap.
Measured: own-control 36/36 per family; credited cross-family transfer **216**
(the 3 forbidden-seed families mutually transfer, 6 ordered pairs × 36);
credited operation-classes = **{forbidden@1, required@1}**.

**To reach 4 (recommended design — a CORPUS redesign, NOT a flag reassignment):**
author two families whose query-competitive trap genuinely sits at depth 2 (a
2-hop forbidden decoy that a depth-1 suppress cannot reach), assigned:

| family | seed role | trap depth | flag |
|---|---|---|---|
| A (e.g. temporal)            | forbidden | 1 | suppress@1        |
| B (e.g. conflict, re-authored) | forbidden | 2 | suppress@2        |
| C (e.g. multi_hop)           | required  | 1 | offPathSuppress@1 |
| D (e.g. a new deep-bridge family) | required | 2 | offPathSuppress@2 |

Each of B and D needs a new generator topology PLUS a real-Qwen margin proof that
the depth-2 trap is query-competitive (rides into topB unless demoted at depth 2).
This is a generator/corpus authoring task (2 new topologies), gated by real-Qwen
evidence — not achievable by reassigning flags on the current corpus.

**Alternative (orchestrator-level): a "credit-the-operation" v-next utility.** If
`computeBmuTaskUtility` (or a companion term) scored the operation SIGNATURE
directly (which promote/demote sets fired), the existing 4 bytecode-distinct
combos {S@1,S@2,O@1,O@2} would become credited immediately — but that is a
scoring-LAW change (a new BMU version), an orchestrator decision, not a
generator change.

**Bottom line (honest-red):** under the current utility + current corpus the N1
credited ceiling is **2**. 4 is reachable only via (a) a 2-family corpus redesign
with real depth-2 traps, or (b) a credit-the-operation scoring-law version. Both
are separate, greenlight-gated steps.
