/**
 * BMU G-B8 family-concentration CONTINUOUS alarm (BMU_SPEC.md rev3.3 §2.3 /
 * handoff §7 G-B8).
 *
 * Law: no single BMU family may hold > 50% of the ACHIEVABLE score on any
 * derived pack. Beyond the launch-time check, G-B8 mandates a continuous
 * production alarm. This module extends the coverage-indexing alarm precedent
 * (`COVERAGE_INDEXING_ALARM_EPOCHS = 8` + consecutive-streak counter,
 * coordinator `coretex-epoch-cutover.ts detectCoverageIndexing`): a telemetry
 * counter that fires a structured alarm when the SAME family's achievable
 * share breaches the bound for `alarmPacks` CONSECUTIVE observed packs.
 *
 * Consecutive-same-family streaks (not any-breach streaks) mirror the
 * precedent's same-capability semantics: a one-pack sampling excursion is
 * telemetry; a persistent single-family concentration is the alarm.
 *
 * Pure + deterministic (no Date/random); the caller supplies observations.
 * Production wiring (feeding it per-accept pack telemetry inside the
 * coordinator) is a P7 master-gate-lane item; this module is the law +
 * mechanism, exercised by the P5 lifecycle simulation.
 */

/** The G-B8 bound: max achievable-score share for any single family. */
export const BMU_FAMILY_CONCENTRATION_MAX_SHARE = 0.5;

/** Consecutive breaching packs before the alarm fires (precedent:
 *  COVERAGE_INDEXING_ALARM_EPOCHS = 8). */
export const BMU_FAMILY_CONCENTRATION_ALARM_PACKS = 8;

/**
 * Achievable-score shares per family for one pack.
 * `achievableByFamily`: rows (or ppm mass — shares are scale-invariant) of
 * achievable score per family. Returns { shares, total, maxFamily, maxShare }.
 * A pack with ZERO total achievable score has no defined concentration; the
 * caller should treat that as its own (starvation) alarm — here it reports
 * maxFamily null and breach false.
 */
export function familyConcentration(achievableByFamily) {
  let total = 0;
  for (const v of Object.values(achievableByFamily)) {
    if (!(Number.isFinite(v) && v >= 0)) throw new Error(`familyConcentration: non-finite/negative mass ${String(v)}`);
    total += v;
  }
  if (total === 0) return { shares: {}, total: 0, maxFamily: null, maxShare: 0 };
  const shares = {};
  let maxFamily = null;
  let maxShare = -1;
  for (const [f, v] of Object.entries(achievableByFamily).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    shares[f] = v / total;
    if (shares[f] > maxShare) { maxShare = shares[f]; maxFamily = f; }
  }
  return { shares, total, maxFamily, maxShare };
}

/**
 * Create the continuous alarm. `observePack` per derived (gate or confirm)
 * pack, in derivation order. Returns per-observation telemetry:
 *   { breach, family, share, streak, alarm, alarmedFamily }
 * `alarm` latches true on the observation where the same-family breach streak
 * reaches `alarmPacks`, and stays true while the streak persists (re-arming
 * after the streak breaks, like the precedent's per-window re-evaluation).
 */
export function createFamilyConcentrationAlarm({
  maxShare = BMU_FAMILY_CONCENTRATION_MAX_SHARE,
  alarmPacks = BMU_FAMILY_CONCENTRATION_ALARM_PACKS,
} = {}) {
  if (!(maxShare > 0 && maxShare < 1)) throw new Error(`createFamilyConcentrationAlarm: maxShare must be in (0,1), got ${String(maxShare)}`);
  if (!Number.isInteger(alarmPacks) || alarmPacks < 1) throw new Error(`createFamilyConcentrationAlarm: alarmPacks must be a positive integer, got ${String(alarmPacks)}`);
  let streakFamily = null;
  let streak = 0;
  let packsObserved = 0;
  let breachesObserved = 0;
  let alarmsFired = 0;
  const alarmEvents = [];
  return {
    observePack(achievableByFamily, packLabel = null) {
      packsObserved += 1;
      const { shares, total, maxFamily, maxShare: observedMax } = familyConcentration(achievableByFamily);
      const breach = maxFamily !== null && observedMax > maxShare;
      if (breach) {
        breachesObserved += 1;
        if (streakFamily === maxFamily) streak += 1;
        else { streakFamily = maxFamily; streak = 1; }
      } else {
        streakFamily = null;
        streak = 0;
      }
      const alarm = breach && streak >= alarmPacks;
      if (alarm && streak === alarmPacks) {
        alarmsFired += 1;
        alarmEvents.push({ packIndex: packsObserved - 1, packLabel, family: maxFamily, share: observedMax, streak });
      }
      return { breach, family: breach ? maxFamily : null, share: observedMax, shares, total, streak, alarm };
    },
    state() {
      return { packsObserved, breachesObserved, alarmsFired, currentStreak: streak, currentStreakFamily: streakFamily, alarmEvents: [...alarmEvents] };
    },
  };
}
