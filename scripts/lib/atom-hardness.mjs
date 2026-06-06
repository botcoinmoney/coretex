function qrelDocId(q) {
  return q?.docId ?? q?.documentId ?? null;
}

function rankOfDoc(q, docId) {
  const hit = (q?.finalRankingTop20 ?? []).find((r) => r.docId === docId);
  return hit?.rank ?? null;
}

function positiveDocIdsForEvent(ev) {
  const ids = new Set((ev.truthDocuments ?? []).map((d) => d.id).filter(Boolean));
  for (const q of ev.qrels ?? []) {
    const id = qrelDocId(q);
    if (id && (q.relevance ?? 0) > 0) ids.add(id);
  }
  return ids;
}

function hardNegativeDocIdsForEvent(ev) {
  const ids = new Set((ev.hardNegatives ?? []).map((d) => d.id ?? d.docId).filter(Boolean));
  for (const q of ev.qrels ?? []) {
    const id = qrelDocId(q);
    if (id && (q.relevance ?? 0) <= 0) ids.add(id);
  }
  return ids;
}

export function baselineAtomHardness({ targetDocId, targetDocIds, pack, baselineScore }) {
  const targets = [...new Set((targetDocIds ?? [targetDocId]).filter(Boolean))];
  if (targets.length === 0 || !baselineScore) return { hard: true, reason: 'baseline_unavailable', rows: [] };
  const byId = new Map((baselineScore.perQuery ?? []).map((q) => [q.recordId, q]));
  const rows = [];
  for (const ev of pack.events ?? []) {
    const positives = positiveDocIdsForEvent(ev);
    const eventTargets = targets.filter((id) => positives.has(id));
    if (!eventTargets.length) continue;
    const q = byId.get(ev.id);
    for (const target of eventTargets) {
      if (!q) {
        rows.push({ recordId: ev.id, queryText: ev.queryText, targetDocId: target, missingBaseline: true, hard: true });
        continue;
      }
      const targetRank = rankOfDoc(q, target);
      const hardNegativeRanks = [...hardNegativeDocIdsForEvent(ev)]
        .map((docId) => ({ docId, rank: rankOfDoc(q, docId) }))
        .filter((r) => r.rank !== null);
      const hardNegativeAboveTarget = hardNegativeRanks.some((r) => targetRank === null || r.rank < targetRank);
      const targetNdcg = q.nDCG10 ?? 0;
      const hard = targetRank === null || targetRank > 1 || targetNdcg < 0.999999 || hardNegativeAboveTarget;
      rows.push({
        recordId: ev.id,
        family: ev.logicalFamily ?? ev.family ?? null,
        queryText: ev.queryText,
        targetDocId: target,
        targetRank,
        targetNdcg,
        hardNegativeRanks,
        hardNegativeAboveTarget,
        hard,
      });
    }
  }
  if (rows.length === 0) return { hard: false, reason: 'no_active_truth_query_for_candidate', rows };
  if (rows.some((r) => r.hard)) return { hard: true, reason: 'hard_candidate', rows };
  return { hard: false, reason: 'already_solved_by_qwen', rows };
}
