import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

const rewards = await import('../../dist/index.js');

const {
  liveEvalAdmissionDecision,
  computeCoreTexWorkUnitsBps,
  OUTCOME_CORETEX_SCREENER_PASS,
  OUTCOME_CORETEX_STATE_ADVANCE,
} = rewards;

const MINER_A = `0x${'aa'.repeat(20)}`;
const MINER_B = `0x${'bb'.repeat(20)}`;

function bytes32(fillByte) {
  return `0x${fillByte.repeat(64)}`;
}

function makeAdmissionInput(overrides = {}) {
  return {
    minerAddress: MINER_A,
    patchHash: bytes32('1'),
    dedupKey: bytes32('2'),
    dedupedKeysThisEpoch: new Set(),
    minerAdmissionsThisEpoch: 0,
    perMinerCap: 5,
    structurallyValid: true,
    ...overrides,
  };
}

function reconstructQualifiedPassCounter(outcomes) {
  let counter = 0n;
  const snapshots = [];
  for (const outcome of outcomes) {
    if (outcome === OUTCOME_CORETEX_SCREENER_PASS) counter += 1n;
    if (outcome === OUTCOME_CORETEX_STATE_ADVANCE) counter = 0n;
    snapshots.push(counter);
  }
  return snapshots;
}

describe('a) replay admission against fabricated dedup-key sets', () => {
  test('duplicate fabricated dedup keys are collapsed on replay', () => {
    const deduped = new Set([bytes32('a')]);
    const first = liveEvalAdmissionDecision(makeAdmissionInput({ dedupKey: bytes32('b'), dedupedKeysThisEpoch: deduped }));
    const second = liveEvalAdmissionDecision(makeAdmissionInput({ dedupKey: bytes32('a'), dedupedKeysThisEpoch: deduped }));
    assert.deepEqual(first, { admit: true, reason: 'OK' });
    assert.deepEqual(second, { admit: false, reason: 'duplicate-key-collapsed' });
  });
});

describe('b) per-miner caps via watcher reconstruction', () => {
  test('watcher-style reconstruction shows cap-respecting qualified passes', () => {
    const perMinerCap = 3;
    const seen = new Set();
    const attempts = [bytes32('1'), bytes32('2'), bytes32('3'), bytes32('4'), bytes32('5')];
    let admissions = 0;
    for (const dedupKey of attempts) {
      const decision = liveEvalAdmissionDecision(
        makeAdmissionInput({
          dedupKey,
          dedupedKeysThisEpoch: seen,
          minerAdmissionsThisEpoch: admissions,
          perMinerCap,
        }),
      );
      if (decision.admit) {
        admissions += 1;
        seen.add(dedupKey);
      }
    }
    assert.equal(admissions, perMinerCap);
    assert.equal(seen.size, perMinerCap);
  });
});

describe('c) structural and dedup collapse with synthesized collisions', () => {
  test('different patch hashes that collide on dedup key collapse to one admission', () => {
    const sharedDedup = bytes32('9');
    const seen = new Set();
    const first = liveEvalAdmissionDecision(
      makeAdmissionInput({ patchHash: bytes32('3'), dedupKey: sharedDedup, dedupedKeysThisEpoch: seen }),
    );
    if (first.admit) seen.add(sharedDedup);
    const second = liveEvalAdmissionDecision(
      makeAdmissionInput({ patchHash: bytes32('4'), dedupKey: sharedDedup, dedupedKeysThisEpoch: seen }),
    );
    const malformed = liveEvalAdmissionDecision(makeAdmissionInput({ patchHash: '0xdeadbeef' }));

    assert.deepEqual(first, { admit: true, reason: 'OK' });
    assert.deepEqual(second, { admit: false, reason: 'duplicate-key-collapsed' });
    assert.equal(malformed.reason, 'malformed-input');
  });
});

describe('d) qualified counter resets on each state advance', () => {
  test('state advances zero the reconstructed counter', () => {
    const outcomes = [
      OUTCOME_CORETEX_SCREENER_PASS,
      OUTCOME_CORETEX_SCREENER_PASS,
      OUTCOME_CORETEX_STATE_ADVANCE,
      OUTCOME_CORETEX_SCREENER_PASS,
      OUTCOME_CORETEX_STATE_ADVANCE,
    ];
    const snapshots = reconstructQualifiedPassCounter(outcomes);
    assert.deepEqual(snapshots, [1n, 2n, 0n, 1n, 0n]);
  });
});

describe('e) ramp curve diminishing returns and cap', () => {
  test('state-advance reward tiers saturate at 300000 bps', () => {
    const b0 = computeCoreTexWorkUnitsBps({
      outcome: OUTCOME_CORETEX_STATE_ADVANCE,
      qualifiedScreenerPassesSinceLastStateAdvance: 0,
    });
    const b2 = computeCoreTexWorkUnitsBps({
      outcome: OUTCOME_CORETEX_STATE_ADVANCE,
      qualifiedScreenerPassesSinceLastStateAdvance: 2,
    });
    const b5 = computeCoreTexWorkUnitsBps({
      outcome: OUTCOME_CORETEX_STATE_ADVANCE,
      qualifiedScreenerPassesSinceLastStateAdvance: 5,
    });
    const b10 = computeCoreTexWorkUnitsBps({
      outcome: OUTCOME_CORETEX_STATE_ADVANCE,
      qualifiedScreenerPassesSinceLastStateAdvance: 10,
    });
    const b5000 = computeCoreTexWorkUnitsBps({
      outcome: OUTCOME_CORETEX_STATE_ADVANCE,
      qualifiedScreenerPassesSinceLastStateAdvance: 5000,
    });

    assert.deepEqual([b0, b2, b5, b10], [100_000n, 150_000n, 200_000n, 300_000n]);
    assert.equal(b5000, 300_000n, 'reward curve must cap at the top tier');
  });
});

describe('f) economic extraction simulation', () => {
  test('single high-throughput miner can dominate epoch work credits at saturation', () => {
    const screenerPassBps = computeCoreTexWorkUnitsBps({ outcome: OUTCOME_CORETEX_SCREENER_PASS });
    const attackerStateAdvanceBps = computeCoreTexWorkUnitsBps({
      outcome: OUTCOME_CORETEX_STATE_ADVANCE,
      qualifiedScreenerPassesSinceLastStateAdvance: 500,
    });
    const blindStateAdvanceBps = computeCoreTexWorkUnitsBps({
      outcome: OUTCOME_CORETEX_STATE_ADVANCE,
      qualifiedScreenerPassesSinceLastStateAdvance: 1,
    });

    const attackerCredits = 500n * screenerPassBps + attackerStateAdvanceBps;
    const blindMinerCredits = 1n * screenerPassBps + blindStateAdvanceBps;
    const blindMiners = 24n;
    const totalCredits = attackerCredits + blindMiners * blindMinerCredits;

    const attackerSharePct = Number((attackerCredits * 10_000n) / totalCredits) / 100;
    assert.equal(attackerSharePct, 78.14);
    assert.ok(attackerSharePct > 50, 'saturated miner should extract a majority share in this scenario');
  });

  test('cap materially reduces extraction vs uncapped baseline', () => {
    const screenerPassBps = computeCoreTexWorkUnitsBps({ outcome: OUTCOME_CORETEX_SCREENER_PASS });
    const saturatedStateAdvanceBps = computeCoreTexWorkUnitsBps({
      outcome: OUTCOME_CORETEX_STATE_ADVANCE,
      qualifiedScreenerPassesSinceLastStateAdvance: 500,
    });
    const blindStateAdvanceBps = computeCoreTexWorkUnitsBps({
      outcome: OUTCOME_CORETEX_STATE_ADVANCE,
      qualifiedScreenerPassesSinceLastStateAdvance: 1,
    });

    const blindMiners = 24n;
    const blindMinerCredits = 1n * screenerPassBps + blindStateAdvanceBps;
    const cappedAttacker = 500n * screenerPassBps + saturatedStateAdvanceBps;
    const uncappedAttacker = 5_000n * screenerPassBps + saturatedStateAdvanceBps;

    const cappedSharePct = Number((cappedAttacker * 10_000n) / (cappedAttacker + blindMiners * blindMinerCredits)) / 100;
    const uncappedSharePct = Number((uncappedAttacker * 10_000n) / (uncappedAttacker + blindMiners * blindMinerCredits)) / 100;

    assert.equal(cappedSharePct, 78.14);
    assert.equal(uncappedSharePct, 97.2);
    assert.ok(
      uncappedSharePct - cappedSharePct > 10,
      'per-miner admission caps should significantly reduce attacker extraction',
    );
  });
});
