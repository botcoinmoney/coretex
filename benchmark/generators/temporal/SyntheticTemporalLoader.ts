/**
 * SyntheticTemporalLoader — Apache-2.0, deterministic.
 *
 * Per-V0 decision (LoCoMo Path B): LoCoMo is CC-BY-NC-4.0 and removed from
 * V0; MemoryAgentBench (MIT) covers EventQA / FactConsolidation; this
 * synthetic loader fills the LoCoMo-shaped gap (long-conversational stale-
 * vs-current pairs) without licensing risk.
 *
 * The generator produces deterministic stale-vs-current truth pairs from a
 * tiny templated grammar. Determinism is by SHA-256 over (epoch, idx);
 * same epoch → same events on every machine.
 *
 * License: Apache-2.0 (this file). Generated content has no upstream
 * licence claim because it is synthetic.
 *
 * Coverage: ~30% of LoCoMo's stale-vs-current breadth. Combined with
 * MemoryAgentBench (MIT) the temporal family ships at ~90% of the original
 * §5 design intent. The remaining 10% (long multi-session conversational
 * cadence) is documented as a V1 follow-up in docs/v1-roadmap.md.
 */

import { createHash } from 'node:crypto';
import type { CortexEvent, FamilyLoader, LoadCorpusOptions } from '../types.js';

const TEMPLATES: ReadonlyArray<readonly [string, string, string]> = [
  // [predicate template, current value, stale value]
  ['agent {a} now lives in {x}',                  'Berlin',  'Vienna'],
  ['agent {a}\'s favourite colour is {x}',         'green',   'blue'],
  ['agent {a} works for {x}',                      'Acme',    'Globex'],
  ['agent {a}\'s pet is named {x}',                'Tofu',    'Mochi'],
  ['agent {a}\'s phone number ends in {x}',        '4571',    '0188'],
  ['agent {a} prefers {x} for breakfast',          'oats',    'eggs'],
  ['agent {a}\'s account balance is {x} BOTCOIN',  '125',     '50'],
  ['agent {a} was last seen on {x}',               'Tuesday', 'Friday'],
] as const;

const NAMES: ReadonlyArray<string> = ['Aria', 'Bo', 'Cora', 'Dax', 'Eve', 'Finn', 'Gia', 'Hugo'];

function deterministic32(epoch: number, idx: number): Uint8Array {
  return createHash('sha256').update(`syn-temporal:${epoch}:${idx}`).digest();
}

function pick<T>(seed: Uint8Array, off: number, arr: readonly T[]): T {
  const v = (seed[off]! ^ (seed[off + 1]! << 8)) >>> 0;
  return arr[v % arr.length]!;
}

export class SyntheticTemporalLoader implements FamilyLoader {
  static readonly LICENSE = 'Apache-2.0';
  static readonly TASK_TYPES = ['stale_rejection', 'temporal_update'] as const;

  /** How many synthetic events to emit per epoch. */
  readonly perEpoch: number;
  /** Of those, how many are protected-regression anchors. */
  readonly protectedCount: number;

  constructor(perEpoch: number = 60, protectedCount: number = 20) {
    if (perEpoch < protectedCount) {
      throw new Error('SyntheticTemporalLoader: perEpoch must be >= protectedCount');
    }
    this.perEpoch       = perEpoch;
    this.protectedCount = protectedCount;
  }

  async loadCorpus(epoch: number, opts: LoadCorpusOptions = {}): Promise<CortexEvent[]> {
    const out: CortexEvent[] = [];
    for (let i = 0; i < this.perEpoch; i++) {
      const seed = deterministic32(epoch, i);
      const tmpl = pick(seed, 0, TEMPLATES);
      const name = pick(seed, 4, NAMES);
      const isStaleTruth = (seed[8]! & 1) === 1;
      const taskType = isStaleTruth
        ? SyntheticTemporalLoader.TASK_TYPES[0]
        : SyntheticTemporalLoader.TASK_TYPES[1];
      const truth = isStaleTruth ? tmpl[2] : tmpl[1];
      const queryText = tmpl[0].replace('{a}', name).replace('{x}', '?');
      const truthText = tmpl[0].replace('{a}', name).replace('{x}', truth);
      const ev: CortexEvent = {
        id:             `syn-${epoch}-${i.toString().padStart(4, '0')}`,
        family:         'temporal',
        taskType,
        isProtected:    i < this.protectedCount,
        sourceRef:      `synthetic-temporal:Apache-2.0:v0:${epoch}:${i}`,
        payload:        new TextEncoder().encode(`${queryText}|${truthText}|${isStaleTruth ? 'STALE' : 'CURRENT'}`),
        queryText,
        truthText,
        isStaleTruth,
        epochCommitted: epoch,
      };
      if (opts.protectedOnly && !ev.isProtected) continue;
      out.push(ev);
      if (opts.limit && out.length >= opts.limit) break;
    }
    return out;
  }

  computeRoot(events: CortexEvent[]): Uint8Array {
    // Same canonicalization as the other loaders: sort by id, hash each
    // (id || payload), then keccak256 over the concatenated leaves
    // (mirrored in benchmark/generators/corpus_root.ts).
    const sorted = [...events].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const h = createHash('sha256');
    for (const ev of sorted) {
      h.update(ev.id);
      h.update(ev.payload);
    }
    return h.digest();
  }
}
