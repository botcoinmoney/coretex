# BMU_CROSSFAMILY_DISTINCTNESS.md — cross-family operation distinctness (§17.29)

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

## (C) The only path to 144, and why it is deferred
Genuine 4-way distinctness needs operations at DIFFERENT DEPTHS: an **all-4-step
(depth-3) bank** where each family suppresses at a distinct (depth, flag) and
each depth's suppress correctly evicts a trap placed at that depth. A standalone
proof-of-mechanism (probe part C) confirms this reaches **144/144** with every
signature single-family. But it is NOT a cheap fix:

- every program becomes depth-3 ⇒ the terminal fan is `seeds·branchLimit^3`
  (= 4·4³ = 256 at branchLimit 4) vs the current `seeds·branchLimit^2` (= 64);
  this likely **violates the pinned Qwen input-cap accounting** (§ "the
  calculated terminal maximum MUST fit the pinned Qwen input cap"), and reducing
  branchLimit breaks the balanced-decoy designs;
- it requires re-deriving all four families' trap topologies to distinct depths
  and re-proving the entire certification lane suite;
- high blast radius against the proven §18 32/4 bank and the 1527-test suite.

Per the ruling's explicit fallback ("if it can't be cheaply fixed, REVERT to the
72 design and document as accepted headroom"), this is deferred to a dedicated
**multi-depth-operation bank redesign lane** (which must first resolve the Qwen
terminal-cap feasibility — that may make 144 infeasible even via redesign, itself
a valuable result).

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
