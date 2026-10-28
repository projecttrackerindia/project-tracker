import { orgApi, teamApi, workspaceApi } from '../../api/endpoints';
import type { Member, Role, Team } from '../../api/types';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { queryClient, useAuth, useModule } from '../../stores/auth';

/** Access levels from most to least privileged, with what each means in one line. */
export const LEVELS: { id: Role; blurb: string }[] = [
  { id: 'Owner', blurb: 'Everything, always. Exactly one; cannot be changed here.' },
  { id: 'Admin', blurb: 'Everything; a job role never narrows it.' },
  { id: 'Manager', blurb: 'Runs projects and teams; their job role can narrow or widen it.' },
  { id: 'Member', blurb: 'Does the work; their job role decides the details.' },
  { id: 'Guest', blurb: 'Only projects they are added to.' },
];
export const RANK: Record<Role, number> = { Guest: 1, Member: 2, Manager: 3, Admin: 4, Owner: 5 };
export const MODULE_LEVEL: Record<number, string> = { 0: 'None', 1: 'View', 2: 'Edit', 3: 'Full' };
/** Modules where the top level lets someone change who can do what (or money): shown as "High privilege". */
export const SENSITIVE_MODULES = ['members', 'organization', 'billing', 'audit'];

export const isSuspended = (m: Pick<Member, 'status'> | null | undefined) => m?.status === 'Suspended';
/** Who can be picked for new work: not suspended, not deactivated on the platform. */
export const canPick = (m: Pick<Member, 'isActive'>) => m.isActive !== false;

export function useMembers() {
  return useWsQuery(['members'], () => workspaceApi.members(), { staleTime: 30_000 });
}

export function useTeams() {
  const mTeams = useModule('teams');
  return useWsQuery(['teams'], teamApi.list, { enabled: mTeams > 0, retry: false, staleTime: 60_000 });
}

export function useOrgStructure(enabled = true) {
  const mOrg = useModule('organization');
  return useWsQuery(['org'], orgApi.get, { enabled: enabled && mOrg > 0, retry: false });
}

/** After any change to a person: the roster, the chart, profiles and access tables are read again. */
export function refreshPeople(wid: string | null | undefined) {
  void invalidateWorkspace(wid, 'members');
  void invalidateWorkspace(wid, 'org');
  void invalidateWorkspace(wid, 'teams');
  void invalidateWorkspace(wid, 'people');
  void queryClient.invalidateQueries({ queryKey: ['member-profile'] });
}

/** The top-level team a team sits under (its department), or the team itself. */
export function departmentOf(team: Team | undefined, byId: Map<string, Team>): Team | undefined {
  let t = team; let guard = 0;
  while (t?.parentTeamId && byId.has(t.parentTeamId) && guard++ < 20) t = byId.get(t.parentTeamId);
  return t;
}

/** Whether I may change this person's access level / suspend / remove them: same rules as the server (never the Owner, never myself, only below my level unless I am the Owner). */
export function useCanActOn() {
  const me = useAuth((s) => s.ctx?.current?.role ?? null);
  const myId = useAuth((s) => s.ctx?.user.id ?? null);
  return (target: { userId: string; role: Role }) =>
    !!me && target.role !== 'Owner' && target.userId !== myId && (me === 'Owner' || RANK[target.role] < RANK[me]);
}
