import { useEffect } from 'react';
import { create } from 'zustand';
import { insightApi } from '../api/endpoints';
import { queryClient, useWorkspaceId } from '../stores/auth';
import { useWsQuery } from './hooks';
import { readStoredLens, setActiveLens, writeStoredLens } from './lensState';

const useLensStore = create<{ byWs: Record<string, string | null>; set: (wid: string, id: string | null) => void }>((set) => ({
  byWs: {},
  set: (wid, id) => set((s) => ({ byWs: { ...s.byWs, [wid]: id } })),
}));

/**
 * The team the person is looking at across the whole app (null = all teams they can see), the teams they may pick (the server decides, by
 * role and team membership), and how to change it. Changing it re-reads everything for the workspace through the new lens.
 */
export function useTeamLens() {
  const wid = useWorkspaceId() ?? '';
  const stored = useLensStore((s) => s.byWs[wid]);
  const q = useWsQuery(['lens', 'teams'], insightApi.lensTeams, { staleTime: 60_000 });
  const teams = q.data ?? [];
  const wanted = stored === undefined ? readStoredLens(wid) : stored;
  // A saved team that is gone, or that this person may no longer pick, quietly means "all teams".
  const teamId = !q.isSuccess ? wanted : wanted && teams.some((t) => t.id === wanted) ? wanted : null;
  if (wid) setActiveLens(wid, teamId);   // synchronously, so the very first request of the page already carries it

  const setTeam = (id: string | null) => {
    if (!wid) return;
    writeStoredLens(wid, id);
    setActiveLens(wid, id);
    useLensStore.getState().set(wid, id);
    void queryClient.resetQueries({ queryKey: [wid], predicate: (query) => query.queryKey[1] !== 'lens' });
  };
  return { teams, teamId, team: teams.find((t) => t.id === teamId) ?? null, ready: q.isSuccess, setTeam };
}

/** Mounted once in the app shell so the lens is active before any page asks for data. */
export function LensSync() {
  const { teamId, teams, ready } = useTeamLens();
  const wid = useWorkspaceId();
  // A remembered team this person can no longer pick is dropped for good.
  useEffect(() => { if (wid && ready && !teamId && readStoredLens(wid) && !teams.some((t) => t.id === readStoredLens(wid))) writeStoredLens(wid, null); }, [wid, ready, teamId, teams]);
  return null;
}
