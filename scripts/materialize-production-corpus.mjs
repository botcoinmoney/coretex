#!/usr/bin/env node
/**
 * Forwarding shim — the CANONICAL materializer lives in
 * packages/coretex/scripts/materialize-production-corpus.mjs (shipped inside the
 * @botcoin/coretex package). Same CLI surface; argv/env pass through unchanged.
 */
await import('../packages/coretex/scripts/materialize-production-corpus.mjs');
