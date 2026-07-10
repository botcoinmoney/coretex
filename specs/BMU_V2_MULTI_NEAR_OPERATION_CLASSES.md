# BMU v2 multi-hop and near-collision operation classes

Status: generator design decision, pre-certification.

## Decision

Both families mint the operation actually available to the BMU v2 scorer:
a lexical anchor points **outgoing** to one or two neutral sinks, then the
second step enumerates **incoming** branches at each sink. A sink has exactly
four incoming branches. Truth and textual decoys use the same incoming edge type,
label, in/out degree, timestamp, stale flag, entity envelope, kind, and shape.
Only document id and text differ, so a structural, recency, id/metadata, or
role selector ties; Qwen must read the branch assertions.

The dual-sink profile is a real topology variation: every branch points to
both sinks. It is not a label alias. The branch fan-out remains within the v2
law's uniform Qwen bound.

## Class banks and capacity margin

Multi-hop has 80 classes:

- five truthful semantics: endpoint, authority, provenance, dependency,
  custody;
- eight disjoint public edge programs: two outgoing first-step types
  (`causes`, `derived_from`) paired with four incoming second-step types
  (`supports`, `supersedes`, `coreference_of`, `co_occurs_with`);
- one- or two-sink topology.

This exceeds the conservative 32-class state capacity (128 relation words at
four words per class).

Near-collision has 48 classes:

- three truthful collision semantics: duplicate holder, scope variant,
  attribute variant;
- the same eight disjoint outgoing/incoming edge programs;
- one- or two-sink topology.

This exceeds the conservative eight-class abstention capacity (32 words at
four words per class). Every class retains answerable rows and a genuinely
missing-scope abstention row.

## Rotation and repeat support

Class rotation uses a persistent minted-cluster cursor, not epoch modulo the
bank size. Adjacent cursor slots intentionally share a class. This gives every
class two entity-, alias-, and template-disjoint clusters while both are
simultaneously active, allowing one operation patch to be evaluated in gate
and confirm partitions. Callers that mint across evolves must persist and
thread `operationClassSlotOffset`; the sample emitters, cross-family checks,
and P5 lifecycle world do so.

The focused 48-evolve census uses the production P5 cadence (arm epoch, then
`+8`) and steady cycle `{multi:1,2,1,2; near:1,1,1,1}`. It observes 36
multi-hop classes and 24 near-collision classes, proves repeat support,
balanced branches for every realized class, and a clean global m=1/I6 census.

## Preserved laws

- global m=1 and alias-aware I6 holdout keys remain hidden judge data;
- template partitions and k=5 atomic clusters are unchanged;
- near-collision remains 4:1 answerable/abstain with an uncovered absent
  scope;
- public documents serialize one neutral envelope; internal audit roles are
  non-enumerable and never enter corpus JSON;
- no bank materialization or scoring result follows from this design alone;
  real-Qwen and operation-general certification remain mandatory.
