import { useWsQuery } from '../../lib/hooks';
import { activeGrant, vaultApi } from './api';

/** The person's own requests and the ones waiting for them, refreshed now and then (someone may be waiting on an answer). */
export const useVaultRequests = (enabled = true) =>
  useWsQuery(['vault', 'requests'], vaultApi.requests, { staleTime: 20_000, refetchInterval: 60_000, enabled });

/** An approval that is running for this item, if any. */
export function useItemGrant(itemId: string, enabled: boolean) {
  const q = useVaultRequests(enabled);
  const mine = (q.data?.mine ?? []).filter((r) => r.kind === 'Reveal' && r.itemId === itemId);
  return { grant: mine.find(activeGrant) ?? null, pending: mine.find((r) => r.status === 'Pending') ?? null, refetch: q.refetch };
}
