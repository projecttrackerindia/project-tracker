import { useEffect } from 'react';
import { queryClient, useWorkspaceId } from '../stores/auth';
import { MUTATION_COMMITTED, type MutationCommitted } from './mutationEffects';
import { refreshMutationFamilies } from './queryRefresh';
import { createRefreshQueue, type RefreshQueue } from './refreshQueue';

/** Coalesce successful writes, refresh mounted views, and leave unopened views stale until navigation. */
export function MutationSync() {
  const wid = useWorkspaceId();
  useEffect(() => {
    if (!wid) return;
    const pending = new Set<string>();
    const queue: RefreshQueue = createRefreshQueue(async () => {
      const families = new Set(pending); pending.clear();
      const wasFetching = queryClient.getQueryCache().findAll({ predicate: (q) => q.queryKey[0] === wid && families.has(String(q.queryKey[1])) }).some((q) => q.state.fetchStatus === 'fetching');
      await refreshMutationFamilies(queryClient, wid, families);
      if (wasFetching) { for (const f of families) pending.add(f); queue.request(); }
    }, 50);
    const onCommit = (event: Event) => {
      const detail = (event as CustomEvent<MutationCommitted>).detail;
      if (detail.workspaceId !== wid) return;
      for (const family of detail.families) pending.add(family);
      queue.request();
    };
    window.addEventListener(MUTATION_COMMITTED, onCommit);
    return () => { queue.dispose(); window.removeEventListener(MUTATION_COMMITTED, onCommit); };
  }, [wid]);
  return null;
}
