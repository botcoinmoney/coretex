#!/usr/bin/env node
/**
 * Forwarding shim — the CANONICAL materializer lives in
 * packages/cortex/scripts/materialize-production-corpus.mjs (shipped inside the
 * @botcoin/cortex package). Same CLI surface; argv/env pass through unchanged.
 */
await import('../packages/cortex/scripts/materialize-production-corpus.mjs');
