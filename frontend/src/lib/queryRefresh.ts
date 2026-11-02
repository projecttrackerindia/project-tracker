import type { QueryClient } from '@tanstack/react-query';
/** Refresh visible affected views; unopened views are only marked stale, and other tenants are untouched. */
export function refreshMutationFamilies(client: QueryClient, workspaceId: string, families: ReadonlySet<string>) {
  return client.invalidateQueries({ predicate: (q) => q.queryKey[0] === workspaceId && families.has(String(q.queryKey[1])), refetchType: 'active' }, { cancelRefetch: false });
}
