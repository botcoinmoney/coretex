// Thin re-export shim. The CANONICAL EpochFrontier implementation now lives in
// packages/coretex/src/coordinator/epoch-frontier.ts (shipped in the bundle-attested library and used
// by the production launch coordinator). Scripts import it from here for path stability, but there is
// ONE implementation — do NOT reimplement frontier logic in this file. (Per the launch discipline:
// calibration scripts observe/wrap the canonical launch path; they never duplicate launch policy.)
import { distIndex } from '../_repo-root.mjs';

const m = await import(distIndex);

export const makeEpochFrontier = m.makeEpochFrontier;
export const makeLaunchFrontier = m.makeLaunchFrontier;
export const DEFAULT_EPOCH_FRONTIER_PROFILE = m.DEFAULT_EPOCH_FRONTIER_PROFILE;
