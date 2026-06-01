# Historical: 9k and Early r5 Synthesis Probes (Oracle Ladder & Family Audits)

**Status**: Archived May 29 2026 (pre-A100 lock)  
**Purpose**: Preserve the bottom-up oracle-ladder and early family probes that produced the structural findings documented in R5_OPERATION_FAMILY_AUDIT.md, R5_POLICYATOM_ORCHESTRATOR_RUNBOOK.md, and the 100k/300k scale-truth verdicts. These tools are no longer the active measurement surface but contain irreplaceable "how we learned the reclaimed slots needed better labeling" history.

## Major Findings These Probes Delivered

- Conflict_lifecycle family on the r5-synthesis corpus had no usable public lifecycle signal for a PolicyAtom because corrections collapsed to `co_occurs_with` (the uninformative production edge). This is why conflict stayed safe-but-not-active at 300k scale.
- Temporal updates were already fully exploited via the shipped supersedes mechanism (current = supersedes-chain head).
- Aspect and abstention families required different corpus design (directional supersedes for conflict, public aspectTags + subject grounding for aspect).
- Evidence-bundle / relation-typed routing showed clean public in-degree signal on the right slices, but entity-only admission was actively harmful at scale.
- The "honest generator" discipline (PUBLIC labels only for policy decisions, qrels used only for measurement) was stress-tested and hardened here.

These probes (especially the two oracle-ladder runs) were the direct source of the "RESERVE / SYNTHESIS REQUIRED" language that shaped the final conservative launch posture and the requirements for future corpus synthesis.

## Files Archived Here (Valuable Provenance)

- probe-r5-oracle-ladder-fam3-fam4-fam5b.mjs
- probe-r5-oracle-ladder-fam5-fam2.mjs
- probe-dgen1-evidence-policy.mjs
- probe-dgen1-lens-thirdclass.mjs

## Files Removed from This Archive Pass (Early Noise)

- diag-dgen1-admission.mjs
- diag-dgen1-bridge-rank.mjs
- diag-layer2-stage1-shape.mjs
- diag-stage1-truth-rank.mjs
- (and similar pre-grounding rank diagnostics that did not survive as architectural findings)

These early diags were scaffolding from before subject grounding and the v2 production bridge contract. They added more confusion than signal once the real fixes landed.

Retention: Keep the archived probes. Future work on conflict or aspect synthesis will likely need to re-read the exact honesty rules and slice construction used here.
