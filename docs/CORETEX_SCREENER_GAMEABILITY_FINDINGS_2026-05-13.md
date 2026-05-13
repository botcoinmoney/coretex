# CoreTex Screener Admission Gameability Findings (2026-05-13)

## Scope

Task #6 required an exhaustive adversarial suite for screener-admission gameability around:

- `packages/cortex/src/eval/live-eval-admission.ts`
- `packages/cortex/src/rewards/work-units.ts`

Implemented test file:

- `packages/cortex/test/unit/screener-admission-gameability.test.mjs`

## Coverage results

All six required axes are covered as separate describe blocks:

1. replay admission against fabricated dedup-key sets
2. per-miner cap enforcement via watcher-style counter reconstruction
3. structural rejection + dedup collapse for synthesized colliding patches
4. `qualifiedScreenerPassesSinceLastStateAdvance` reset on state advance
5. state-advance ramp behavior (tier progression + hard cap)
6. economic extraction simulation

The suite is fail-closed (strict assertions, no warnings-only behavior).

## Economic simulation number (required output)

Synthetic epoch model in the test:

- one high-throughput miner saturates screener admissions to 500 passes before state advance
- 24 blind submitters each perform 1 screener pass + 1 state advance
- current policy tiers from `work-units.ts` are used directly

Result:

- high-throughput miner share = **84.21%** of epoch work credits in this scenario
- uncapped baseline comparison = **98.12%**
- measured cap impact = **13.91 percentage points** extracted share reduction

Interpretation: per-miner caps materially reduce extraction, but saturation still yields majority-share risk in adversarial throughput scenarios.

## Validation

Unit test suite status after adding this file:

- `npm run test:unit --workspace @botcoin/cortex` -> pass (`369/369`)
