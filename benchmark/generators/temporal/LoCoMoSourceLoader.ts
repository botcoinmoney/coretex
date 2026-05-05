/**
 * LoCoMoSourceLoader — LICENSE_BLOCKED stub.
 *
 * LoCoMo (Evaluating Very Long-Term Conversational Memory of LLM Agents,
 * Maharana et al., arXiv:2402.17753, ACL 2024) is licensed CC-BY-NC-4.0.
 * The NonCommercial clause makes it incompatible with Botcoin Cortex as a
 * commercial mining protocol.
 *
 * This loader MUST NOT be used to load real LoCoMo data until a commercial
 * use license is obtained from Snap Research
 * (contact: adymaharana@cs.unc.edu).
 *
 * See specs/license_audit.md §4 for the full audit and resolution options.
 * See benchmark/sources.json entry for LoCoMo for the pinned commit hash.
 *
 * Implementing TemporalLoader for the LoCoMo path is BLOCKED.
 * The temporal family falls back to MemoryAgentBenchLoader (MIT) for V0.
 *
 * RESOLUTION OPTIONS (human decision required before enabling this loader):
 *   Option A — obtain commercial license from Snap Research
 *   Option B — replace LoCoMo with a permissive alternative (CC-BY / Apache-2.0)
 *   Option C — derive synthetic LoCoMo-format records under Apache-2.0
 */

import type { CortexEvent, FamilyLoader, LoadCorpusOptions } from '../types.js';
import { LoaderError } from '../types.js';

export class LoCoMoSourceLoader implements FamilyLoader {
  // Pinned hash from benchmark/sources.json — kept here for reference.
  static readonly PINNED_HASH = '3eb6f2c585f5e1699204e3c3bdf7adc5c28cb376';
  static readonly LICENSE_SPDX = 'CC-BY-NC-4.0';
  static readonly PAPER_ARXIV = '2402.17753';
  static readonly CONTACT = 'adymaharana@cs.unc.edu';
  static readonly AUDIT_DOC = 'specs/license_audit.md §4';

  async loadCorpus(_epoch: number, _opts?: LoadCorpusOptions): Promise<CortexEvent[]> {
    throw new LoaderError(
      'LICENSE_BLOCKED',
      [
        'LoCoMoSourceLoader: LICENSE_BLOCKED — see specs/license_audit.md §4.',
        `LoCoMo is licensed ${LoCoMoSourceLoader.LICENSE_SPDX} (NonCommercial).`,
        'Botcoin Cortex is a commercial protocol; embedding LoCoMo data is prohibited',
        'until a commercial use exception is obtained or a permissive replacement is chosen.',
        `Contact: ${LoCoMoSourceLoader.CONTACT}`,
        'Temporal family V0 uses MemoryAgentBenchLoader (MIT) as the operative loader.',
      ].join('\n'),
    );
  }

  computeRoot(_events: CortexEvent[]): Uint8Array {
    throw new LoaderError(
      'LICENSE_BLOCKED',
      'LoCoMoSourceLoader: LICENSE_BLOCKED — computeRoot unavailable until license is resolved.',
    );
  }
}
