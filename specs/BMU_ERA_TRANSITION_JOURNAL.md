# BMU_ERA_TRANSITION_JOURNAL.md — `coretex.bmu.p5.era-transition-journal.v1`

Field contract for the per-evolve TRANSITION JOURNAL emitted by the era-rotation
exercise (`scripts/lib/bmu-sim/era-schedule.mjs` +
`.ops/coretex-bmu-p5-era-transition-sim.mjs`). The coordinator verifier / gate
respec lane consumes this journal to confirm the §18 era-rotation runway is real:
retirement of the prior era makes its residents COSTLESSLY evictable, and net
acceptance stays > 0 ACROSS the era transition.

## Relationship to `P5_V2_SCHEMA.md`

This is a strict SUPERSET of the coordinator's published
`eventJournal.perEvolve` record. The three P5_V2 counters are emitted with the
SAME names so the existing coordinator derivations keep working:

- `acceptedByFamily`            — net accepts per family this evolve
- `gateConfirmAcceptedByFamily` — accepts flipping BOTH gate and confirm
- `evictionsByFamily`           — all resident evictions per family this evolve

`globalCapacityReachedEpoch` is carried at the journal top level exactly as
P5_V2 requires. The era-transition fields below are ADDITIVE; a P5_V2-only
verifier ignores them, a rotation-aware verifier reads them.

> Coordination note (to Fable 5 / gate-respec lane): these era field NAMES are
> defined by this lane because the sibling contract had not been relayed at
> authoring time. If the release-repo `P5_V2_SCHEMA.md` later pins different era
> field names, rename in `ERA_TRANSITION_JOURNAL_FIELDS`
> (`scripts/lib/bmu-sim/era-schedule.mjs`) + here and re-emit — the values are
> unchanged.

## Per-evolve record

| field | type | meaning |
|-------|------|---------|
| `evolve` | int | evolve index (1-based) |
| `epoch` | int | epoch of this evolve |
| `eraId` | int | active MINTING grammar era at this evolve (`activeEraForEpoch`) |
| `frontierId` | string | `era<N>@<activationEpoch>`; changes exactly at a transition |
| `eraTransition` | `null \| {fromEra,toEra,epoch}` | non-null only on the evolve where the minting era flips |
| `inCoexistenceWindow` | bool | prior-era motifs still permitted as active rows |
| `acceptedByFamily` | {family:int} | P5_V2: net accepts per family |
| `gateConfirmAcceptedByFamily` | {family:int} | P5_V2: gate+confirm accepts |
| `evictionsByFamily` | {family:int} | P5_V2: all evictions per family (DERIVED from `evictionDetail`) |
| `costlyEvictionsByFamily` | {family:int} | evictions whose evicted resident STILL covered an active NON-RETIRED motif |
| `retirementsByFamily` | {family:int} | prior-era motif retirements this evolve (the costless-eviction feedstock) |
| `retirementEligiblePriorEra` | `int \| null` | which prior era is dead-resident-eligible now |
| `evictionDetail` | array | `[{residencyKey, family, era, stillCoversActiveMotif}]` — the ground truth the aggregate counters are recomputable from |

## Verifier derivations (all fail-closed on mismatch)

1. `evictionsByFamily[f]` MUST equal `count(evictionDetail where family==f)`.
2. `costlyEvictionsByFamily[f]` MUST equal
   `count(evictionDetail where family==f AND stillCoversActiveMotif==true)`.
3. **Rotation-aware NET** across the transition, per family:
   `Σ (gateConfirmAcceptedByFamily[f] − costlyEvictionsByFamily[f])` over evolves
   with `epoch > eraTransition.epoch` MUST be `> 0` — the store keeps
   net-admitting programs AFTER the grammar rotates, paying only the COSTLESS
   (retired-resident) eviction tax. This is the corrected §17.26 semantics
   (net priced by RESIDUAL ACTIVE utility, evaluated across an era transition),
   NOT the mis-spec'd `accept − ALL evictions`.
4. `frontierId` MUST change exactly once per `eraTransition` (no silent grammar
   swap without a recorded transition).
5. A `costlyEvictionsByFamily` that ever equals `evictionsByFamily` for a family
   over a sustained window (no costless retirements) is the static-frontier
   failure mode (net→0) — the alarm the rotation machinery exists to avoid.

## Top-level journal fields

| field | meaning |
|-------|---------|
| `schedule` | the resolved `makeEraSchedule` entries (era, activationEpoch, windows) |
| `globalCapacityReachedEpoch` | P5_V2: first epoch the shared 32-slot store filled |
| `eraTransitionEpoch` | the activation epoch of era-2 (the rotation under test) |
| `perEvolve` | array of the per-evolve records above |
