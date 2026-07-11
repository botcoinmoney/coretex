// Portable INFERENCE entrypoint (G-B16 / §19 / invariant I11).
//
// This is the coordinator-free surface an external LLM/agent integration needs
// to run CoreTex as a standalone memory-IR harness: ingest → CortexState →
// decodeSubstrate → scoreSubstrateAgainstQuery → bmuJudgeTopB →
// computeBmuTaskUtility. It re-exports ONLY the inference subtree
// (canonical/ + state/ + eval/ + substrate/ + bundle/ + corpus/ +
// pipeline-versions) and pulls in NONE of coordinator/reducer/rewards/
// validator/shards/workers/upgrade/verify-epoch/replay.
//
// Contrast the entrypoints:
//   "@botcoin/coretex"            (dist/validator.js) — validator/client surface
//   "@botcoin/coretex/coordinator"(dist/coordinator.js) — CoreTexCoordinatorCore
//   "@botcoin/coretex/full"       (dist/index.js) — the whole barrel
//   "@botcoin/coretex/inference"  (dist/inference.js) — THIS: portable, no coordinator
//
// ADDITIVE ONLY: this file adds a surface; it modifies nothing in the barrel or
// any inference/era module. The inference subtree it re-exports is verified
// (source-graph + module-load trace) to import zero coordinator/validator/chain
// code — importing this entrypoint does not load CoreTexCoordinatorCore.
export { CORTEX_CLIENT_VERSION as VERSION } from './version.js';
export { CORTEX_CLIENT_VERSION } from './version.js';

// THE canonical-JSON serializer for hash/signature surfaces (one copy, no drift).
// Explicit re-export so it shadows the frozen phase-3 EvalReport serializer of
// the same name star-exported from eval/index.js (matches the barrel).
export { canonicalJson, bytesToBareHex, type CanonicalJsonOptions } from './canonical/json.js';
export * from './state/index.js';
export * from './eval/index.js';
export * from './bundle/index.js';
export * from './eval/seed-derivation.js';
export * from './eval/live-eval-admission.js';
export * from './eval/reranker.js';
export * from './eval/bi-encoder.js';
export * from './eval/retrieval-corpus.js';
export * from './eval/public-corpus-index.js';
export * from './eval/retrieval-benchmark.js';
export * from './pipeline-versions.js';
export * from './eval/bmu-task.js';
export * from './eval/bmu-operation-program.js';
export * from './eval/bmu-benchmark.js';
export * from './eval/memory-ir-render.js';
export * from './eval/ir-metrics.js';
export * from './eval/hidden-query-pack.js';
export * from './eval/relation-qrels.js';
export * from './corpus/admission.js';
export * from './corpus/delta.js';
export * from './corpus/logical-delta-bridge.js';
export * from './corpus/epoch-rotation.js';
export * from './substrate/slot-policy.js';
export {
  type DecodedSubstrate,
  type SubstrateFamily,
  type DecoderOptions,
  type RelationEdge,
  type RelationCategoryLens,
  type TemporalRecord,
  decodeMemoryIndex,
  decodeRetrievalKeys,
  decodeRelations,
  decodeTemporal,
  decodeCodebook,
  decodeSubstrate,
  encodeMemoryIndexSlot,
  encodeRetrievalKeySlot,
  encodeRelationEdge,
  encodeRelationCategoryLens,
  encodeTemporalRecord,
  encodeCodebookEntry,
  biEncoderModelIdHash,
  checkLensDiversity,
  relationEdgeValid,
  // r5 PolicyAtoms
  type PolicyAtom,
  type PolicyAtomFamily,
  type PolicyAction,
  type PolicyScope,
  type BmuPublicPathProgram,
  type BmuPublicPathProgramStep,
  decodePolicyAtomRegion,
  decodeBmuPublicPathPrograms,
  encodePolicyAtom,
  encodeBmuPublicPathProgram,
  encodeBmuPublicPathProgramWords,
  policyReservedNonZeroWords,
  POLICY_REGIONS,
  POLICY_SELECTOR,
  POLICY_EVIDENCE_FEATURE,
  POLICY_FLAG,
  POLICY_TARGET_NONE,
  BMU_PATH_PROGRAM_SELECTOR,
  BMU_PATH_PROGRAM_EVIDENCE_FEATURE,
  BMU_PATH_PROGRAM_VERSION,
  BMU_PATH_PROGRAM_INERT_TARGET_SLOT,
} from './substrate/retrieval-decoder.js';
export { validatePolicyRegions, validateReservedBits, hasNonZeroReservedBits } from './state/validate.js';
export type {
  MemoryIndexSlot as RetrievalMemoryIndexSlot,
  RetrievalKeySlot as RetrievalKeySlotV2,
  CodebookEntry as RetrievalCodebookEntry,
  RelationEdgeType as SubstrateRelationEdgeType,
  LensDiversityCheck,
} from './substrate/retrieval-decoder.js';
export * from './substrate/structural-validity.js';
