# CoreTex Documentation Map

Last updated: 2026-06-08.

This repo has been pruned so auditors do not have to sort through pre-V2 launch plans as if they are current.
The active documentation authority is the consolidated CoreTex production launch handoff plus the launch artifact manifest.

## Read First

- [`../README.md`](../README.md) — current system overview and canonical code path map.
- [`HANDOFFS/PRODUCTION_LAUNCH_HARDENING_HANDOFF.md`](./HANDOFFS/PRODUCTION_LAUNCH_HARDENING_HANDOFF.md) — canonical launch/auditor handoff.
- [`../release/calibration/CURRENT.md`](../release/calibration/CURRENT.md) — authoritative current calibration state.
- [`../release/calibration/2026-05-21-memory-corpus-v2/DIFFICULTY_LONGEVITY_CALIBRATION_RUNBOOK.md`](../release/calibration/2026-05-21-memory-corpus-v2/DIFFICULTY_LONGEVITY_CALIBRATION_RUNBOOK.md) — execution gates and run discipline.
- [`../release/calibration/2026-05-21-memory-corpus-v2/SUBSTRATE_SURFACE_RUNWAY_MATRIX.md`](../release/calibration/2026-05-21-memory-corpus-v2/SUBSTRATE_SURFACE_RUNWAY_MATRIX.md) — substrate surface audit.
- [`../release/calibration/2026-05-21-memory-corpus-v2/SUBSTRATE_VNEXT_COMPOSITION.md`](../release/calibration/2026-05-21-memory-corpus-v2/SUBSTRATE_VNEXT_COMPOSITION.md) — trim/replace audit.

## Specs

- [`../specs/cortex_state.md`](../specs/cortex_state.md) — canonical 1024-word substrate layout.
- [`../specs/coretex_memory_control_plane.md`](../specs/coretex_memory_control_plane.md) — Memory IR / control-plane spec.
- [`../specs/substrate_retrieval_semantics.md`](../specs/substrate_retrieval_semantics.md) — retrieval semantics.
- [`../specs/hidden_query_pack.md`](../specs/hidden_query_pack.md) — hidden-query pack structure.
- [`../specs/determinism.md`](../specs/determinism.md) — determinism requirements.

## Calibration Evidence

Durable findings live under:

```text
release/calibration/2026-05-21-memory-corpus-v2/
```

Use `release/calibration/CALIBRATION_LEDGER.jsonl` as the run registry. Generated scratch output and old `/var/lib`
reports are not current authority.

## Handoffs

`docs/HANDOFFS/PRODUCTION_LAUNCH_HARDENING_HANDOFF.md` is the active handoff. Other handoff files are historical or ignored unless explicitly referenced by the launch handoff.
