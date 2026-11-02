import { useEffect } from 'react';
import { queryClient, useWorkspaceId } from '../stores/auth';
import { MUTATION_COMMITTED, type MutationCommitted } from './mutationEffects';
import { refreshMutationFamilies } from './queryRefresh';

/** Coalesce successful writes, refresh mounted views, and leave unopened views stale until navigation. */
export function MutationSync() {
  const wid = useWorkspaceId();
  useEffect(() => {
    if (!wid) return;
    const pending = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onCommit = (event: Event) => {
      const detail = (event as CustomEvent<MutationCommitted>).detail;
      if (detail.workspaceId !== wid) return;
      for (const family of detail.families) pending.add(family);
      if (timer !== undefined) return;
      timer = setTimeout(() => {
        const families = new Set(pending); pending.clear(); timer = undefined;
        void refreshMutationFamilies(queryClient, wid, families);
      }, 50);
    };
    window.addEventListener(MUTATION_COMMITTED, onCommit);
    return () => { clearTimeout(timer); window.removeEventListener(MUTATION_COMMITTED, onCommit); };
  }, [wid]);
  return null;
}
