import { flagApi } from '../api/endpoints.notifySmart';
import { useWsQuery } from './hooks';

/**
 * Feature flags per workspace, team and person (Settings › General › Feature flags). The keys and their safe defaults are the same as the
 * server's FeatureFlagCatalog: until the answer arrives (or when it cannot), every flag is its default, so nothing half-finished appears.
 */
export const FLAG_DEFAULTS = {
  'smart-grouping': true,
  'whats-new': true,
  'report-problem': true,
  'shake-to-report': false,
} as const;
export type FlagKey = keyof typeof FLAG_DEFAULTS;

export const flagsKey = ['feature-flags', 'mine'];

export function useFlags(): Record<FlagKey, boolean> {
  const q = useWsQuery(flagsKey, flagApi.mine, { staleTime: 5 * 60_000, retry: false });
  const got = q.data?.flags;
  const out = { ...FLAG_DEFAULTS } as Record<FlagKey, boolean>;
  if (got && typeof got === 'object') for (const k of Object.keys(FLAG_DEFAULTS) as FlagKey[]) if (typeof got[k] === 'boolean') out[k] = got[k];
  return out;
}

/** Whether one feature is on for the signed-in person here (its safe default until known). */
export function useFlag(key: FlagKey): boolean {
  return useFlags()[key];
}
