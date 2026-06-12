/**
 * Forwarding shim — the CANONICAL V2 logical-corpus → ProductionCorpus mapping
 * lives in packages/coretex/scripts/lib/build-v2-production-corpus.mjs (shipped
 * inside the @botcoin/coretex package). NEVER duplicate the mapping here.
 */
export * from '../../packages/coretex/scripts/lib/build-v2-production-corpus.mjs';
