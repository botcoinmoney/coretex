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

## Reframing (added 2026-05-13 after operator review)

The 84.21% extraction number is a **symptom of an upstream screener
information leak**, not the root cause.

### What's actually broken

`liveEvalAdmissionDecision` (`packages/cortex/src/eval/live-eval-admission.ts:55-59`)
returns four distinct rejection reasons:

```typescript
type LiveEvalAdmissionRejectReason =
  | 'malformed-input'
  | 'structurally-invalid'
  | 'duplicate-key-collapsed'    // ← oracle leak
  | 'per-miner-cap-reached';
```

`'duplicate-key-collapsed'` directly reveals which dedupKeys have been
admitted this epoch. An adaptive-probing attacker uses this signal to
enumerate the eval-hidden pack boundary and produce screener-valid
patches at low cost.

The operator's stated design intent is:

> "screener should have a way of identify bogus without revealing why
> exactly as an oracle"

The current implementation directly violates that.

### What actually contains gameability in production

Three defenses, of which the first is currently broken:

1. **Screener oracle property** — return a single opaque 'rejected'
   at the HTTP boundary; log specific reason operator-side only.
   Tracked as task #18.

2. **Rate limit** — 1/min/challenge per miner, enforced by the
   coordinator host via the `rateLimit` route-guard hook. Confirmed
   exposed by the cortex library at
   `coordinator/endpoints.ts:256`. Production calibration value
   tracked as task #19.

3. **Per-miner admissions cap (`perMinerCap`)** — already implemented
   in `live-eval-admission.ts:44`. After cap is hit, patches still
   flow for transparency but earn no additional screener credit.
   Production calibration value tracked as task #19.

### Revised interpretation of the 84.21% number

The simulation models unlimited submission rate AND unlimited
ability to produce screener-valid patches. In reality:

* With rate limit at 1/min and a 24h epoch, max submissions per
  challenge per miner = 1,440.
* With screener returning opaque rejections (task #18 fix), iteration
  becomes much more expensive — attacker can't learn from rejections.
* With `perMinerCap` set tightly (task #19 audit), uncapped credit
  extraction is structurally bounded regardless of submission rate.

The 84.21% should be re-measured after task #18 lands. The test
should also be parameterized to model rate-limit time-budget so the
economic simulation reflects real-world constraints.

### Action items

- Task #18: oracle-collapse screener rejection reasons at HTTP
  boundary (pre-launch gate).
- Task #19: verify production rate-limit + perMinerCap calibration
  values (pre-launch audit).
- Task #20: future per-miner work-share hardcap-if-no-state-advance
  lever (default off; turn on if monitoring detects abuse).
- Parameterize the gameability test to model rate-limit time-budget
  and re-measure after task #18 lands.

The 84.21% finding stands as the documented worst-case under the
current (broken) screener oracle property. Post task-#18, the test
should produce a number close to the natural credit distribution
across honest miners.
