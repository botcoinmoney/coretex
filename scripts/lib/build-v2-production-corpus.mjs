/**
 * Forwarding shim — the CANONICAL V2 logical-corpus → ProductionCorpus mapping
 * lives in packages/cortex/scripts/lib/build-v2-production-corpus.mjs (shipped
 * inside the @botcoin/cortex package). NEVER duplicate the mapping here.
 */
export * from '../../packages/cortex/scripts/lib/build-v2-production-corpus.mjs';
