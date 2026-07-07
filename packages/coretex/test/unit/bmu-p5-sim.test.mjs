/**
 * P5 support-law unit checks. The long-horizon evidence is produced by
 * scripts/coretex-bmu-p5-sim.mjs; this file keeps the small pure laws in CI.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  bmuJudgeTopB,
  computeBmuTaskUtility,
} from '../../dist/index.js';
import {
  oracleTaskUtility,
  packHeadroom,
} from '../../../../scripts/lib/bmu-sim/headroom-accounting.mjs';
import {
  createFamilyConcentrationAlarm,
  familyConcentration,
} from '../../../../scripts/lib/bmu-sim/family-concentration-alarm.mjs';

const judge = { bmuJudgeTopB, computeBmuTaskUtility };

function event({ id = 'row-a', family = 'temporal', motif = 'mg-a', budgetB = 3 } = {}) {
  const truth = `${id}-truth`;
  const trap = `${id}-trap`;
  const filler = `${id}-filler`;
  return {
    id,
    truthDocuments: [{ id: truth, text: 'truth', isCurrent: true }],
    hardNegatives: [{ id: trap, text: 'trap' }, { id: filler, text: 'filler' }],
    qrels: [
      { documentId: truth, relevance: 1 },
      { documentId: trap, relevance: 0 },
      { documentId: filler, relevance: 0 },
    ],
    bmuTask: {
      family,
      budgetB,
      requiredEvidence: [truth],
      forbiddenEvidence: [trap],
      answer: { id: truth },
      motifGroupId: motif,
      templateId: `tt-${id}`,
    },
  };
}

describe('P5 oracle headroom accounting', () => {
  test('oracle achievable utility evicts forbidden evidence below top-B', () => {
    const out = oracleTaskUtility({ event: event(), judge });
    assert.equal(out.achievable, 1);
    assert.equal(out.failure, undefined);
  });

  test('packHeadroom subtracts solved motifs but leaves unsolved headroom', () => {
    const pack = { events: [event({ id: 'a', motif: 'mg-a' }), event({ id: 'b', motif: 'mg-b' })] };
    const h = packHeadroom({ pack, solvedMotifGroups: new Set(['mg-a']), judge });
    assert.equal(h.totals.achievable, 2);
    assert.equal(h.totals.realized, 1);
    assert.equal(h.totals.headroomRows, 1);
    assert.equal(h.headroomPpm, 500_000);
  });
});

describe('P5 G-B8 family concentration alarm', () => {
  test('single-pack concentration reports shares without alarming immediately', () => {
    const c = familyConcentration({ temporal: 3, conflict_lifecycle: 1, multi_hop_relation: 1, near_collision_abstention: 1 });
    assert.equal(c.maxFamily, 'temporal');
    assert.equal(c.maxShare, 0.5);
    const alarm = createFamilyConcentrationAlarm();
    const obs = alarm.observePack({ temporal: 4, conflict_lifecycle: 1, multi_hop_relation: 1, near_collision_abstention: 1 });
    assert.equal(obs.breach, true);
    assert.equal(obs.alarm, false);
    assert.equal(alarm.state().alarmsFired, 0);
  });

  test('eight consecutive same-family breaches fire exactly one alarm event', () => {
    const alarm = createFamilyConcentrationAlarm();
    for (let i = 0; i < 8; i++) {
      alarm.observePack({ temporal: 6, conflict_lifecycle: 1, multi_hop_relation: 1, near_collision_abstention: 1 }, `p${i}`);
    }
    const state = alarm.state();
    assert.equal(state.alarmsFired, 1);
    assert.equal(state.alarmEvents[0].family, 'temporal');
    assert.equal(state.alarmEvents[0].packLabel, 'p7');
  });

  test('alternating breaching families reset the same-family streak', () => {
    const alarm = createFamilyConcentrationAlarm();
    for (let i = 0; i < 12; i++) {
      const temporalHigh = i % 2 === 0;
      alarm.observePack(temporalHigh
        ? { temporal: 6, conflict_lifecycle: 1, multi_hop_relation: 1, near_collision_abstention: 1 }
        : { temporal: 1, conflict_lifecycle: 6, multi_hop_relation: 1, near_collision_abstention: 1 });
    }
    assert.equal(alarm.state().alarmsFired, 0);
    assert.equal(alarm.state().currentStreak, 1);
  });
});
