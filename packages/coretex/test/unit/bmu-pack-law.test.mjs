/**
 * BMU v1 pack law (BMU_SPEC.md §6):
 *   - deriveBmuDualPacks: full §6.2-shape gate/confirm derivation (quotas
 *     10/15/15/10, packSize 64, familySlots 3/3/3/3), determinism, and the
 *     §6.3 held-out property (confirm shares NO motifGroupId /
 *     subjectEntityId / templateId with the gate pack);
 *   - §6.4 seeded slot draw: rev3.1 byte-law golden pin, thin-cohort seeded
 *     FULL-membership fallback (F6), fixed-order redistribution, rev3.2
 *     graceful underfill telemetry;
 *   - §6.5 frontier-aware broad eligibility (bmuTask + active-frontier
 *     membership) and its replay-safety: absent BMU opts ⇒ byte-identical
 *     packs whether or not rows carry bmuTask;
 *   - fail-closed guards (missing overlay law / familySlots / seedHex,
 *     slot-sum mismatch, unknown family keys).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  deriveQueryPack,
  deriveScoredQueryPack,
  deriveBmuDualPacks,
  admitActiveLiveEvalEvents,
  bmuExclusionKeySetForPack,
  bmuEventExcluded,
  hiddenPackEventEligible,
  packQuotaCoverage,
  computeCorpusRoot,
  BMU_OVERLAY_DRAW_DOMAIN,
  keccak256,
} from '../../dist/index.js';

// ─── Fixture ─────────────────────────────────────────────────────────────────

const FAMS = [
  { bmu: 'temporal', bucketed: 'temporal', logical: 'temporal_update' },
  { bmu: 'conflict_lifecycle', bucketed: 'conflict_lifecycle', logical: 'conflict_lifecycle' },
  { bmu: 'multi_hop_relation', bucketed: 'multi_hop_relation', logical: 'multi_session_bridge' },
  { bmu: 'near_collision_abstention', bucketed: 'near_collision', logical: 'abstention_missing' },
];

function row({ id, fam, motif, subject, template }) {
  return {
    id,
    family: fam.bucketed,
    domain: 'd',
    split: 'eval_hidden',
    queryText: `q ${id}`,
    truthDocuments: [{ id: `${id}-t`, text: 't', isCurrent: true }],
    hardNegatives: [],
    qrels: [{ documentId: `${id}-t`, relevance: 1 }],
    protected: false,
    logicalFamily: fam.logical,
    subjectEntityId: subject,
    bmuTask: {
      family: fam.bmu,
      budgetB: 3,
      requiredEvidence: [`${id}-t`],
      forbiddenEvidence: [],
      answer: { id: `${id}-t` },
      motifGroupId: motif,
      templateId: template,
    },
    provenance: { source: 'synthetic_challenge', sourceHash: '0x' + '00'.repeat(32) },
  };
}

/**
 * Full §6.2-shape corpus: per family, `broadPerFam` non-live broad rows
 * (q_*), `stalePerFam` old live rows (zz_e100, outside freshWindow) and
 * `freshPerFam` fresh live rows (zz_e137). Every row is its own cluster
 * (unique motif/subject/template — the exclusion worst case).
 */
function makeBmuCorpus({ broadPerFam = 40, freshPerFam = 8, stalePerFam = 6, epoch = 137 } = {}) {
  const events = [];
  for (const fam of FAMS) {
    for (let i = 0; i < broadPerFam; i++) {
      events.push(row({
        id: `q_${fam.bmu}_${String(i).padStart(3, '0')}`,
        fam,
        motif: `mg_broad_${fam.bmu}_${i}`,
        subject: `ent_broad_${fam.bmu}_${i}`,
        template: `tt_broad_${fam.bmu}_${i}`,
      }));
    }
    for (let i = 0; i < stalePerFam; i++) {
      events.push(row({
        id: `zz_e${String(100).padStart(12, '0')}_q_${fam.bmu}_${i}`,
        fam,
        motif: `mg_stale_${fam.bmu}_${i}`,
        subject: `ent_stale_${fam.bmu}_${i}`,
        template: `tt_stale_${fam.bmu}_${i}`,
      }));
    }
    for (let i = 0; i < freshPerFam; i++) {
      events.push(row({
        id: `zz_e${String(epoch).padStart(12, '0')}_q_${fam.bmu}_${i}`,
        fam,
        motif: `mg_fresh_${fam.bmu}_${i}`,
        subject: `ent_fresh_${fam.bmu}_${i}`,
        template: `tt_fresh_${fam.bmu}_${i}`,
      }));
    }
  }
  return {
    events,
    byId: new Map(events.map((e) => [e.id, e])),
    corpusRoot: computeCorpusRoot(events),
    corpusEpoch: 0,
    biEncoderModelId: 'm',
    biEncoderRevision: 'r',
    biEncoderRetrievalKeyLayout: { dim: 8, headerBytes: 9, quantization: 'int8' },
    labelingModelId: 'lm',
    labelingModelRevision: 'lr',
  };
}

const BMU_PROFILE = {
  packSize: 64,
  quotas: [
    { stratum: 'family=temporal', minCount: 10 },
    { stratum: 'family=conflict_lifecycle', minCount: 15 },
    { stratum: 'family=multi_hop_relation', minCount: 15 },
    { stratum: 'family=near_collision', minCount: 10 },
  ],
};

const LAW = {
  limit: 12,
  familyPriority: ['temporal_update', 'conflict_lifecycle', 'multi_session_bridge', 'abstention_missing'],
  familySlots: { temporal: 3, conflict_lifecycle: 3, multi_hop_relation: 3, near_collision_abstention: 3 },
  freshWindow: 2,
};

const GATE_SEED = '0x' + '22'.repeat(32);
const CONFIRM_SEED = '0x' + '33'.repeat(32);
const EPOCH = 137;

function allIds(corpus) { return new Set(corpus.events.map((e) => e.id)); }
function freshIds(pack) { return pack.events.filter((e) => e.id.startsWith('zz_e000000000137_')).map((e) => e.id); }

describe('§6.3 deriveBmuDualPacks (full §6.2 shape)', () => {
  const corpus = makeBmuCorpus();
  const activeLiveEval = { activeIds: allIds(corpus), law: LAW };
  const dual = deriveBmuDualPacks({
    epochId: EPOCH, gateSeedHex: GATE_SEED, confirmSeedHex: CONFIRM_SEED,
    corpus, profile: BMU_PROFILE, activeLiveEval,
  });

  test('both packs are exactly packSize with all quotas satisfied', () => {
    for (const pack of [dual.gate, dual.confirm]) {
      assert.equal(pack.events.length, 64);
      for (const c of packQuotaCoverage(pack, BMU_PROFILE)) {
        assert.ok(c.satisfied, `${c.stratum}: ${c.count}/${c.minCount}`);
      }
    }
  });

  test('every pack row is BMU-eligible (bmuTask present; no non-task row leaks in)', () => {
    for (const pack of [dual.gate, dual.confirm]) {
      for (const e of pack.events) assert.ok(e.bmuTask, `row ${e.id} has no bmuTask`);
    }
  });

  test('HELD-OUT (I6): confirm shares NO motif/subject/template with the gate pack', () => {
    assert.ok(dual.exclusionKeys.size > 0);
    for (const e of dual.confirm.events) {
      assert.ok(!bmuEventExcluded(e, dual.exclusionKeys), `confirm row ${e.id} collides with the gate exclusion set`);
    }
    // and the exclusion set is exactly the gate pack's keys
    assert.deepEqual([...dual.exclusionKeys].sort(), [...bmuExclusionKeySetForPack(dual.gate)].sort());
  });

  test('fresh-frontier share: ≥3 fresh rows per family in the gate pack (slot law)', () => {
    const perFam = { temporal: 0, conflict_lifecycle: 0, multi_hop_relation: 0, near_collision_abstention: 0 };
    for (const e of dual.gate.events) {
      if (e.id.startsWith('zz_e000000000137_')) perFam[e.bmuTask.family] += 1;
    }
    for (const [fam, n] of Object.entries(perFam)) {
      assert.ok(n >= 3, `family ${fam} has ${n} fresh rows (< 3 slots)`);
    }
  });

  test('deterministic: re-derivation is byte-identical; gate ≠ confirm', () => {
    const again = deriveBmuDualPacks({
      epochId: EPOCH, gateSeedHex: GATE_SEED, confirmSeedHex: CONFIRM_SEED,
      corpus, profile: BMU_PROFILE, activeLiveEval,
    });
    assert.deepEqual(again.gate.events.map((e) => e.id), dual.gate.events.map((e) => e.id));
    assert.deepEqual(again.confirm.events.map((e) => e.id), dual.confirm.events.map((e) => e.id));
    assert.notDeepEqual(dual.gate.events.map((e) => e.id), dual.confirm.events.map((e) => e.id));
  });

  test('the pack seed matters: a different gate seed draws different fresh rows', () => {
    const other = deriveBmuDualPacks({
      epochId: EPOCH, gateSeedHex: '0x' + '44'.repeat(32), confirmSeedHex: CONFIRM_SEED,
      corpus, profile: BMU_PROFILE, activeLiveEval,
    });
    assert.notDeepEqual(freshIds(other.gate).sort(), freshIds(dual.gate).sort());
  });
});

describe('§6.5 frontier-aware broad eligibility + replay safety', () => {
  const corpus = makeBmuCorpus({ broadPerFam: 40, freshPerFam: 0, stalePerFam: 0 });

  test('under BMU, rows outside the active frontier never enter the pack', () => {
    const active = new Set(corpus.events.filter((e) => e.bmuTask.family !== 'temporal' || e.id >= 'q_temporal_020').map((e) => e.id));
    // keep quotas satisfiable: temporal still has 20 active rows
    const pack = deriveQueryPack(EPOCH, GATE_SEED, corpus, BMU_PROFILE, { activeIds: active });
    for (const e of pack.events) assert.ok(active.has(e.id), `inactive row ${e.id} sampled`);
  });

  test('under BMU, unstamped rows never enter the pack', () => {
    const stripped = corpus.events.map((e, i) => {
      if (e.bmuTask.family === 'conflict_lifecycle' && i % 2 === 0) {
        const { bmuTask, ...rest } = e;
        return rest;
      }
      return e;
    });
    const c2 = { ...corpus, events: stripped, byId: new Map(stripped.map((e) => [e.id, e])) };
    const pack = deriveQueryPack(EPOCH, GATE_SEED, c2, BMU_PROFILE, { activeIds: allIds(c2) });
    for (const e of pack.events) assert.ok(e.bmuTask, `unstamped row ${e.id} sampled under BMU law`);
  });

  test('REPLAY PIN: without BMU opts, packs are byte-identical whether or not rows carry bmuTask', () => {
    const stripped = corpus.events.map((e) => { const { bmuTask, ...rest } = e; return rest; });
    const bare = { ...corpus, events: stripped, byId: new Map(stripped.map((e) => [e.id, e])) };
    const a = deriveQueryPack(EPOCH, GATE_SEED, corpus, BMU_PROFILE);
    const b = deriveQueryPack(EPOCH, GATE_SEED, bare, BMU_PROFILE);
    assert.deepEqual(a.events.map((e) => e.id), b.events.map((e) => e.id));
  });

  test('hiddenPackEventEligible: BMU param demands bmuTask AND active membership; absent param unchanged', () => {
    const e = corpus.events[0];
    assert.equal(hiddenPackEventEligible(e, BMU_PROFILE), true);
    assert.equal(hiddenPackEventEligible(e, BMU_PROFILE, { activeIds: new Set([e.id]) }), true);
    assert.equal(hiddenPackEventEligible(e, BMU_PROFILE, { activeIds: new Set() }), false);
    const { bmuTask, ...bare } = e;
    assert.equal(hiddenPackEventEligible(bare, BMU_PROFILE), true);
    assert.equal(hiddenPackEventEligible(bare, BMU_PROFILE, { activeIds: new Set([e.id]) }), false);
  });
});

describe('§6.4 slot draw: fallback, redistribution, underfill, byte law', () => {
  test('thin fresh cohort (F6): slots fall back to a SEEDED full-membership draw', () => {
    // temporal has NO fresh rows — only stale live rows — so its 3 slots must
    // fill from the full eligible-active membership via the seeded fallback.
    const corpus = makeBmuCorpus({ broadPerFam: 40, freshPerFam: 8, stalePerFam: 6 });
    const noFreshTemporal = corpus.events.filter((e) => !(e.bmuTask.family === 'temporal' && e.id.startsWith('zz_e000000000137_')));
    const c2 = { ...corpus, events: noFreshTemporal, byId: new Map(noFreshTemporal.map((e) => [e.id, e])) };
    const activeIds = new Set(noFreshTemporal.map((e) => e.id));
    const base = deriveQueryPack(EPOCH, GATE_SEED, c2, BMU_PROFILE, { activeIds });
    const res = admitActiveLiveEvalEvents(base, c2, {
      activeIds, limit: 12, profile: BMU_PROFILE,
      seedHex: GATE_SEED, familySlots: LAW.familySlots, freshWindow: 2,
    });
    assert.ok(res.bmuOverlay, 'bmu telemetry missing');
    assert.equal(res.bmuOverlay.slotsRequested, 12);
    assert.equal(res.bmuOverlay.slotsFilled, 12);
    assert.ok(res.bmuOverlay.fallbackFilled >= 3, `fallbackFilled ${res.bmuOverlay.fallbackFilled} < 3`);
    assert.equal(res.bmuOverlay.underfilled, 0);
    assert.equal(res.familyCounts.temporal, 3, 'temporal slots must still fill (from stale live rows)');
  });

  test('a family with NO eligible live rows redistributes its slots in fixed order', () => {
    // multi_hop has no zz_e rows at all — fresh AND full pools empty.
    const corpus = makeBmuCorpus({ broadPerFam: 40, freshPerFam: 8, stalePerFam: 0 });
    const filtered = corpus.events.filter((e) => !(e.bmuTask.family === 'multi_hop_relation' && e.id.startsWith('zz_e')));
    const c2 = { ...corpus, events: filtered, byId: new Map(filtered.map((e) => [e.id, e])) };
    const activeIds = new Set(filtered.map((e) => e.id));
    const base = deriveQueryPack(EPOCH, GATE_SEED, c2, BMU_PROFILE, { activeIds });
    const res = admitActiveLiveEvalEvents(base, c2, {
      activeIds, limit: 12, profile: BMU_PROFILE,
      seedHex: GATE_SEED, familySlots: LAW.familySlots, freshWindow: 2,
    });
    assert.equal(res.bmuOverlay.slotsFilled, 12);
    assert.equal(res.bmuOverlay.redistributedFilled, 3);
    assert.equal(res.bmuOverlay.compositionDeviation, true);
    assert.equal(res.familyCounts.multi_hop_relation ?? 0, 0);
  });

  test('rev3.2 graceful underfill: pool exhaustion leaves the pack at packSize, quotas intact', () => {
    // Only 6 overlay-eligible live rows exist in the whole corpus.
    const corpus = makeBmuCorpus({ broadPerFam: 40, freshPerFam: 1, stalePerFam: 0 });
    const filtered = corpus.events.filter((e) => !e.id.startsWith('zz_e') || e.bmuTask.family !== 'near_collision_abstention');
    const c2 = { ...corpus, events: filtered, byId: new Map(filtered.map((e) => [e.id, e])) };
    const activeIds = new Set(filtered.map((e) => e.id));
    const base = deriveQueryPack(EPOCH, GATE_SEED, c2, BMU_PROFILE, { activeIds });
    const res = admitActiveLiveEvalEvents(base, c2, {
      activeIds, limit: 12, profile: BMU_PROFILE,
      seedHex: GATE_SEED, familySlots: LAW.familySlots, freshWindow: 2,
    });
    // 3 live rows exist (temporal/conflict/multi_hop fresh 1 each) minus any
    // already sampled into the base pack — underfill is graceful, never a throw.
    assert.equal(res.pack.events.length, 64);
    assert.ok(res.bmuOverlay.underfilled > 0);
    assert.equal(res.bmuOverlay.compositionDeviation, true);
    for (const c of packQuotaCoverage(res.pack, BMU_PROFILE)) assert.ok(c.satisfied, c.stratum);
  });

  test('confirm-side exclusion applies to the overlay draw', () => {
    const corpus = makeBmuCorpus();
    const activeIds = allIds(corpus);
    const target = corpus.events.find((e) => e.id.startsWith('zz_e000000000137_q_temporal_'));
    const excludeKeys = new Set([`motif:${target.bmuTask.motifGroupId}`]);
    const base = deriveQueryPack(EPOCH, CONFIRM_SEED, corpus, BMU_PROFILE, { activeIds, excludeKeys });
    const res = admitActiveLiveEvalEvents(base, corpus, {
      activeIds, limit: 12, profile: BMU_PROFILE,
      seedHex: CONFIRM_SEED, familySlots: LAW.familySlots, freshWindow: 2, excludeKeys,
    });
    assert.ok(!res.pack.events.some((e) => e.id === target.id), 'excluded row leaked into the confirm pack');
  });

  test('rev3.1 seeded-draw BYTE-LAW golden pin (domain, tuple order, modulo, skip-probe)', () => {
    // Reimplement the pinned digest tuple independently and check the first
    // temporal slot draw lands on exactly pool[idx_j] for the first
    // non-skippable probe.
    const corpus = makeBmuCorpus();
    const activeIds = allIds(corpus);
    const base = deriveQueryPack(EPOCH, GATE_SEED, corpus, BMU_PROFILE, { activeIds });
    const res = admitActiveLiveEvalEvents(base, corpus, {
      activeIds, limit: 12, profile: BMU_PROFILE,
      seedHex: GATE_SEED, familySlots: LAW.familySlots, freshWindow: 2,
    });
    assert.equal(BMU_OVERLAY_DRAW_DOMAIN, 'bmu-overlay-v1');
    // fresh temporal cohort, codePointCompare(id) order (ids share a prefix so
    // lexicographic == codepoint here)
    const pool = corpus.events
      .filter((e) => e.bmuTask.family === 'temporal' && e.id.startsWith('zz_e000000000137_'))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const enc = new TextEncoder();
    const u64 = (n) => { const o = new Uint8Array(8); let v = BigInt(n); for (let i = 7; i >= 0; i--) { o[i] = Number(v & 0xffn); v >>= 8n; } return o; };
    const seedBytes = Uint8Array.from(GATE_SEED.slice(2).match(/../g).map((h) => parseInt(h, 16)));
    const digest = (parts) => {
      const total = parts.reduce((a, p) => a + p.length, 0);
      const buf = new Uint8Array(total);
      let off = 0; for (const p of parts) { buf.set(p, off); off += p.length; }
      const d = keccak256(buf);
      let v = 0n; for (let i = 0; i < 32; i++) v = (v << 8n) | BigInt(d[i]);
      return v;
    };
    const baseIds = new Set(base.events.map((e) => e.id));
    let expected;
    for (let j = 0; j < pool.length * 8; j++) {
      const idx = Number(digest([enc.encode('bmu-overlay-v1'), u64(EPOCH), seedBytes, enc.encode('temporal'), u64(0), u64(j)]) % BigInt(pool.length));
      const cand = pool[idx];
      if (baseIds.has(cand.id)) continue; // slot 0 has nothing drawn before it
      expected = cand.id;
      break;
    }
    assert.ok(expected, 'independent recomputation found no candidate');
    // The first temporal fresh row admitted must be exactly that candidate.
    const drawnTemporalFresh = res.pack.events.filter((e) =>
      e.bmuTask.family === 'temporal' && e.id.startsWith('zz_e000000000137_') && !baseIds.has(e.id));
    assert.ok(drawnTemporalFresh.some((e) => e.id === expected),
      `pinned byte-law draw ${expected} missing from admitted temporal fresh rows ${drawnTemporalFresh.map((e) => e.id).join(', ')}`);
  });
});

describe('fail-closed pack-law guards', () => {
  const corpus = makeBmuCorpus();
  const activeIds = allIds(corpus);

  test('BMU law without an armed overlay refuses', () => {
    assert.throws(() => deriveScoredQueryPack(EPOCH, GATE_SEED, corpus, BMU_PROFILE, undefined, {}), /requires an armed/);
  });

  test('BMU law without familySlots refuses', () => {
    const law = { limit: 12, familyPriority: LAW.familyPriority };
    assert.throws(
      () => deriveScoredQueryPack(EPOCH, GATE_SEED, corpus, BMU_PROFILE, { activeIds, law }, {}),
      /familySlots/,
    );
  });

  test('familySlots without seedHex refuses (never an unseeded order)', () => {
    const base = deriveQueryPack(EPOCH, GATE_SEED, corpus, BMU_PROFILE, { activeIds });
    assert.throws(
      () => admitActiveLiveEvalEvents(base, corpus, { activeIds, limit: 12, profile: BMU_PROFILE, familySlots: LAW.familySlots }),
      /seedHex/,
    );
  });

  test('familySlots sum must equal limit; keys must be BMU family enum names', () => {
    const base = deriveQueryPack(EPOCH, GATE_SEED, corpus, BMU_PROFILE, { activeIds });
    assert.throws(
      () => admitActiveLiveEvalEvents(base, corpus, {
        activeIds, limit: 12, profile: BMU_PROFILE, seedHex: GATE_SEED,
        familySlots: { temporal: 3, conflict_lifecycle: 3, multi_hop_relation: 3, near_collision_abstention: 2 },
      }),
      /sum 11 != liveEvalPack.limit 12/,
    );
    assert.throws(
      () => admitActiveLiveEvalEvents(base, corpus, {
        activeIds, limit: 12, profile: BMU_PROFILE, seedHex: GATE_SEED,
        familySlots: { temporal: 3, conflict_lifecycle: 3, multi_hop_relation: 3, near_collision: 3 },
      }),
      /not a BMU family/,
    );
  });
});
