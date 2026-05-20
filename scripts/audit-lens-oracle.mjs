#!/usr/bin/env node
/**
 * Oracle audit for the lens-construction cells. Answers: what data does each lens
 * use, and is any of it hidden-eval-only (a benchmark-side oracle a miner could
 * NOT know before the hidden pack is revealed)?
 *
 * Splits: a patch proposer (miner) sees train_visible (+ calibration/canary
 * feedback). The eval-hidden split and the specific sampled query events + their
 * relations/qrels/truths are NOT known when the substrate is built.
 */
import { distIndex } from './_repo-root.mjs';
import { argv, exit } from 'node:process';
function flag(n, fb) { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fb; }
const corpusPath = flag('corpus', '/var/lib/coretex/corpus-epoch-0-calibration-relation-qrels.json');
const packSize = Number(flag('pack-size', '16'));
const seedHex = flag('seed', '0x' + 'c7'.repeat(32));
const targetFamily = flag('family', 'multi_hop_relation');

const { loadProductionCorpus } = await import(distIndex);
const corpus = loadProductionCorpus(corpusPath, { verifyCorpusRoot: false, verifySplits: false });
const eventById = new Map(corpus.events.map((e) => [e.id, e]));

// split distribution
const splitCounts = {};
for (const e of corpus.events) splitCounts[e.split] = (splitCounts[e.split] ?? 0) + 1;
console.log(`[audit] corpus ${corpus.events.length} events; splits:`, splitCounts);

function shaIdx(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) & 0xffffffff; return h >>> 0; }
const cands = corpus.events.filter((e) => e.family === targetFamily && Array.isArray(e.relations) && e.relations.length > 0);
const pack = cands.map((e) => ({ e, s: shaIdx(seedHex + ':' + e.id) })).sort((a, b) => a.s - b.s).slice(0, packSize).map((x) => x.e);

let packHidden = 0, relTargetsTotal = 0, relTargetsResolvable = 0, relTargetsHidden = 0;
const packSplits = {};
const relEntityIds = new Set();
for (const q of pack) {
  packSplits[q.split] = (packSplits[q.split] ?? 0) + 1;
  if (q.split === 'eval_hidden') packHidden++;
  for (const rel of q.relations ?? []) {
    relTargetsTotal++;
    relEntityIds.add(rel.other_id);
    const tgt = eventById.get(rel.other_id);
    if (tgt) { relTargetsResolvable++; if (tgt.split === 'eval_hidden') relTargetsHidden++; }
  }
}
console.log(`[audit] pack=${pack.length} (family=${targetFamily}); pack splits:`, packSplits);
console.log(`[audit] pack-query relation targets: total=${relTargetsTotal} distinct=${relEntityIds.size} resolvable=${relTargetsResolvable} hiddenSplit=${relTargetsHidden}`);
console.log(`[audit] ─ lens-answer-region uses: pack-event TRUTH embeddings (the hidden answer docs)            => ORACLE (bookmark ceiling)`);
console.log(`[audit] ─ lens-relation-centroid uses: pack-event RELATIONS (hidden query's derived_from links)    => ORACLE (uses hidden query structure)`);
console.log(`[audit] A miner cannot know a hidden query's own relations/truths before eval. Both = MECHANISM PROOF, not miner-feasible.`);

// What a miner CAN use: the public corpus graph + visible-split events.
const visible = corpus.events.filter((e) => e.split === 'train_visible');
const calib = corpus.events.filter((e) => e.split === 'calibration');
console.log(`[audit] miner-available pools: train_visible=${visible.length} calibration=${calib.length}`);
// Are the pack answer regions (related entities) reachable from the PUBLIC graph
// without referencing the hidden query? i.e., do those entity events exist in the
// corpus and in non-hidden splits (so a corpus-wide region lens could cover them)?
let entInVisible = 0, entInCalib = 0, entInHidden = 0, entMissing = 0;
for (const id of relEntityIds) {
  const ev = eventById.get(id);
  if (!ev) { entMissing++; continue; }
  if (ev.split === 'train_visible') entInVisible++;
  else if (ev.split === 'calibration') entInCalib++;
  else if (ev.split === 'eval_hidden') entInHidden++;
}
console.log(`[audit] pack answer-entities by split: train_visible=${entInVisible} calibration=${entInCalib} eval_hidden=${entInHidden} missing=${entMissing}`);
console.log(`[audit] => a corpus-wide region lens (built from non-hidden events) can cover answer-entities only insofar as they are non-hidden / cluster with non-hidden docs.`);
exit(0);
