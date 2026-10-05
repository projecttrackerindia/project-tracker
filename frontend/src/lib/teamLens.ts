import { create } from 'zustand';
import { insightApi } from '../api/endpoints';
import { useWorkspaceId } from '../stores/auth';
import { useWsQuery } from './hooks';

/** Which team the person is looking at on the dashboard, reports and Portfolio: null = all teams. Remembered per workspace on this device. */
const KEY = (wid: string) => `pm_team_lens_${wid}`;
const read = (wid: string): string | null => { try { return localStorage.getItem(KEY(wid)); } catch { return null; } };
const write = (wid: string, id: string | null) => { try { if (id) localStorage.setItem(KEY(wid), id); else localStorage.removeItem(KEY(wid)); } catch { /* storage unavailable */ } };

const useLensStore = create<{ byWs: Record<string, string | null>; set: (wid: string, id: string | null) => void }>((set) => ({
  byWs: {},
  set: (wid, id) => { write(wid, id); set((s) => ({ byWs: { ...s.byWs, [wid]: id } })); },
}));

/** The teams this person may pick (the server decides by role and team membership), the current pick, and how to change it. */
export function useTeamLens() {
  const wid = useWorkspaceId() ?? '';
  const stored = useLensStore((s) => s.byWs[wid]);
  const setLens = useLensStore((s) => s.set);
  const q = useWsQuery(['lens', 'teams'], insightApi.lensTeams, { staleTime: 60_000 });
  const teams = q.data ?? [];
  const wanted = stored === undefined ? read(wid) : stored;
  // A saved team that is gone, or that this person may no longer pick, quietly means "all teams".
  const teamId = wanted && teams.some((t) => t.id === wanted) ? wanted : null;
  return { teams, teamId, team: teams.find((t) => t.id === teamId) ?? null, ready: q.isSuccess, setTeam: (id: string | null) => setLens(wid, id) };
}
