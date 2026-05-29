/**
 * Live-update corpus CLI — drives `evolveCorpusDelta` across epochs so the A100 long-horizon harness
 * can call it as a DYNAMIC per-epoch event (the churn "fuel"). Logical-level + deterministic; the
 * harness embeds the per-epoch `addedDocs` on the pinned bi-encoder and rebuilds the production corpus
 * (buildCorpusDelta → new corpusRoot) at run time.
 *
 *   node scripts/evolve-corpus.mjs --base <logical.json> --epochs N --seed S [--churn 0.1] \
 *        [--out <merged-logical.json>] [--delta-dir <dir>]
 *
 * Cumulative: each epoch supersedes the LATEST held fact (including prior deltas) → real growing chains.
 * Replayable: same (base, epochs, seed, churn) → byte-identical output.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { evolveCorpusDelta } from './lib/evolve-corpus.mjs';

const argv = process.argv.slice(2);
const flag = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const base = flag('base'); if (!base) { console.error('--base <logical.json> required'); process.exit(2); }
const epochs = parseInt(flag('epochs', '6'), 10);
const seed = flag('seed', 'coretex-launch-frontier');
const churn = parseFloat(flag('churn', '0.1'));
const out = flag('out');
const deltaDir = flag('delta-dir');

const cur = JSON.parse(readFileSync(resolve(base), 'utf8'));
cur.docs ??= []; cur.relations ??= []; cur.queries ??= [];
const report = [];
for (let e = 1; e <= epochs; e++) {
  const d = evolveCorpusDelta({ baseLogical: cur, epoch: e, seed, churnFraction: churn });
  cur.docs.push(...d.addedDocs);
  cur.relations.push(...d.addedRelations);
  cur.queries.push(...d.addedQueries);
  if (deltaDir) writeFileSync(resolve(deltaDir, `live-delta-epoch-${e}.json`), JSON.stringify({ epoch: e, seed, churnFraction: churn, addedDocs: d.addedDocs, addedRelations: d.addedRelations, addedQueries: d.addedQueries }));
  report.push({ epoch: e, churnedSubjects: d.churnedSubjects.length, liveChurnRate: +d.liveChurnRate.toFixed(4), addedDocs: d.addedDocs.length, addedQueries: d.addedQueries.length });
}
if (out) writeFileSync(resolve(out), JSON.stringify(cur));
const allLiveDocIds = new Set(cur.docs.filter((d) => d.liveUpdateEpoch !== undefined).map((d) => d.id));
console.log(JSON.stringify({
  base, epochs, seed, churnFraction: churn,
  totalLiveDocsAdded: allLiveDocIds.size,
  totalLiveQueriesAdded: cur.queries.filter((q) => q.liveUpdateEpoch !== undefined).length,
  meanLiveChurnRate: +(report.reduce((s, r) => s + r.liveChurnRate, 0) / report.length).toFixed(4),
  perEpoch: report,
  out: out ?? '(not written)',
}, null, 2));
