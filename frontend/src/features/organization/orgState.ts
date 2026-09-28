import { useCallback, useMemo } from 'react';
import { ApiError } from '../../api/client';
import { orgApi } from '../../api/endpoints';
import type { OrgStructure } from '../../api/types';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { queryClient, useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';

/** The organization chart for the current workspace. */
export function useOrg() {
  return useWsQuery(['org'], orgApi.get);
}

/**
 * Mutations for the chart. Every change is applied to the cache immediately (so dragging feels instant),
 * sent to the server, and rolled back with a message if the server refuses it (permission, loop, ...).
 */
export function useOrgActions() {
  const wid = useWorkspaceId();
  const key = useMemo(() => [wid, 'org'], [wid]);

  const run = useCallback(async (optimistic: (d: OrgStructure) => OrgStructure, call: () => Promise<unknown>, fallback: string) => {
    const previous = queryClient.getQueryData<OrgStructure>(key);
    if (previous) queryClient.setQueryData<OrgStructure>(key, optimistic(previous));
    try { await call(); void invalidateWorkspace(wid, 'org'); return true; }
    catch (e) {
      if (previous) queryClient.setQueryData(key, previous);
      toast(e instanceof ApiError ? e.message : fallback, 'error');
      void invalidateWorkspace(wid, 'org');
      return false;
    }
  }, [key, wid]);

  return useMemo(() => ({
    moveRole: (id: string, parentRoleId: string | null) => run(
      (d) => ({ ...d, roles: d.roles.map((r) => (r.id === id ? { ...r, parentRoleId } : r)) }),
      () => orgApi.moveRole(id, parentRoleId), 'Could not change who this role reports to.'),

    assign: (userId: string, roleId: string | null) => run(
      (d) => ({ ...d, people: d.people.map((p) => (p.userId === userId ? { ...p, roleId } : p)) }),
      () => orgApi.assign(userId, roleId), 'Could not change this person’s role.'),

    reportsTo: (userId: string, bossId: string | null) => run(
      (d) => ({ ...d, people: d.people.map((p) => (p.userId === userId ? { ...p, reportsToUserId: bossId } : p)) }),
      () => orgApi.reportsTo(userId, bossId), 'Could not change who this person reports to.'),

    savePositions: (items: { id: string; x: number | null; y: number | null }[]) => run(
      (d) => ({ ...d, roles: d.roles.map((r) => { const p = items.find((i) => i.id === r.id); return p ? { ...r, posX: p.x, posY: p.y } : r; }) }),
      () => orgApi.saveLayout(items), 'Could not save the layout.'),
  }), [run]);
}

export type OrgActions = ReturnType<typeof useOrgActions>;
