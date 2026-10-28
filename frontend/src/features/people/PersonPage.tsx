import { useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { chatApi, orgApi, teamApi, workspaceApi } from '../../api/endpoints';
import { ApiError } from '../../api/client';
import type { MemberProfile, Role } from '../../api/types';
import { Face } from '../../components/Face';
import { Icon } from '../../components/Icon';
import { Select } from '../../components/Select';
import { EmptyState, ErrorState, PageLoader } from '../../components/ui';
import { formatDate, initials } from '../../lib/format';
import { useWsQuery } from '../../lib/hooks';
import { avatarBg, meshOf, themeOf } from '../../lib/personTheme';
import { useAuth, useCan, useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { ImpactDialog } from './ImpactDialog';
import { LEVELS, MODULE_LEVEL, RANK, canPick, departmentOf, refreshPeople, useCanActOn, useMembers, useOrgStructure, useTeams } from './peopleData';
import '../people/profileCard.css';

const MODULE_ORDER = ['projects', 'tasks', 'work', 'documents', 'calendar', 'teams', 'members', 'organization', 'reports', 'activity', 'audit', 'billing'];
const MODULE_LABEL: Record<string, string> = {
  projects: 'Projects', tasks: 'Tasks', work: 'Operations', documents: 'Documents', calendar: 'Calendar', teams: 'Teams', members: 'People',
  organization: 'Organization', reports: 'Reports', activity: 'Activity', audit: 'Audit log', billing: 'Billing',
};

type Action = 'level' | 'jobRole' | 'manager' | 'teams' | 'suspend' | 'reactivate' | 'remove';

/**
 * A person's profile (People › a person): the Messages card header (their theme's mesh, face, team pill), where they sit (department,
 * teams, manager, direct reports), what they can do (access level, job role, and module by module for viewers allowed to see access), how
 * their work is going, and the changes the viewer may make. Every change shows who gains or loses what before it is confirmed.
 */
export function PersonPage() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const wid = useWorkspaceId();
  const q = useWsQuery(['people', 'profile', id], () => workspaceApi.memberProfile(id), { retry: false });
  const members = useMembers();
  const teams = useTeams();
  const org = useOrgStructure();
  const canAccessManage = useCan('access.manage');
  const canPermissions = useCan('permissions.manage');
  const canSeeAccess = canAccessManage || canPermissions;
  const effective = useWsQuery(['org', 'access', 'effective'], orgApi.effectiveAccess, { enabled: canSeeAccess, retry: false });
  const canManage = useCan('members.manage');
  const canStructure = useCan('org.structure');
  const canTeams = useCan('teams.manage');
  const canActOn = useCanActOn();
  const [action, setAction] = useState<Action | null>(null);

  if (q.isLoading) return <PageLoader />;
  if (q.isError) {
    const status = q.error instanceof ApiError ? q.error.status : 0;
    return status === 404
      ? <EmptyState icon="user" title="This person is not in the workspace" text="They may have been removed." action={<Link className="btn btn-ghost" to="/people">Back to People</Link>} />
      : <ErrorState error={q.error} retry={() => q.refetch()} />;
  }
  const p = q.data!;
  const theme = themeOf(p.userId, p.theme);
  const suspended = p.status === 'Suspended';
  const teamById = new Map((teams.data ?? []).map((t) => [t.id, t]));
  const dept = p.teams.length ? departmentOf(teamById.get(p.teams[0].id), teamById) : undefined;
  const access = effective.data?.people.find((x) => x.userId === p.userId);
  const target = { userId: p.userId, role: p.role };
  const mayLevel = canManage && canActOn(target);
  const after = () => { refreshPeople(wid); void q.refetch(); };
  const message = async () => {
    try { const c = await chatApi.openDirect(p.userId); nav(`/messages/${c.id}`); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Could not open the chat.', 'error'); }
  };

  return (
    <div className="pr-person" data-testid="person-page">
      <nav className="pr-crumbs" aria-label="Breadcrumb"><Link to="/people"><Icon name="chevronL" size={14} /> People</Link></nav>
      <header className={`pr-hero t-${theme}`} data-testid="person-hero">
        <div className="pr-hero-mesh" style={{ background: meshOf(theme) } as CSSProperties} />
        {(p.teams[0]?.name ?? p.jobRole) && <span className="pcard-pill"><Icon name={p.teams.length ? 'users' : 'tag'} size={12} />{p.teams[0]?.name ?? p.jobRole}</span>}
      </header>
      <div className="pr-id">
        <div className="pcard-av-ring pr-av-ring"><Face userId={p.userId} hasAvatar={p.hasAvatar} className="pcard-av" style={{ background: avatarBg(theme) }} text={initials(p.displayName)} /></div>
        <div className="pr-id-text">
          <h1>{p.displayName}{p.isMe && <small> · You</small>}</h1>
          <p>{p.jobRole ?? 'No job title'}{dept ? ` · ${dept.name}` : ''}</p>
          <div className="pr-id-tags">
            <span className={`pr-level lv-${p.role.toLowerCase()}`}>{p.role}</span>
            {suspended ? <span className="pr-badge warn" data-testid="profile-status">Suspended{p.deactivatedAt ? ` · ${formatDate(p.deactivatedAt)}` : ''}</span>
              : <span className="pr-badge ok" data-testid="profile-status">Active</span>}
          </div>
        </div>
        <div className="pr-id-actions">
          {p.canMessage && <button type="button" className="btn btn-primary" onClick={() => void message()}><Icon name="message" size={15} /> Message</button>}
          {p.isMe && <Link className="btn btn-ghost" to="/settings/profile"><Icon name="edit" size={15} /> Edit profile</Link>}
        </div>
      </div>

      <div className="pr-cols">
        <div>
          <Group title="Organization">
            <Line icon="building" label="Department" value={dept?.name ?? '—'} />
            <Line icon="users" label="Teams" value={p.teams.length ? <span className="pr-chips">{p.teams.map((t) => <span key={t.id} className="pr-chip">{t.name}{t.isLead && <em> · Lead</em>}</span>)}</span> : '—'}
              action={canTeams ? () => setAction('teams') : undefined} actionLabel="Change teams" />
            <Line icon="user" label="Manager" value={p.reportsTo ? <Link to={`/people/${p.reportsTo.id}`} data-testid="manager-link">{p.reportsTo.name}</Link> : 'No manager'}
              action={canStructure ? () => setAction('manager') : undefined} actionLabel="Change manager" />
            <Line icon="org" label="Direct reports" value={p.directReports?.length
              ? <span className="pr-chips">{p.directReports.map((r) => <Link key={r.id} className="pr-chip link" to={`/people/${r.id}`}>{r.name}</Link>)}</span> : 'None'} />
            {p.email && <Line icon="mail" label="Email" value={<a href={`mailto:${p.email}`}>{p.email}</a>} />}
            <Line icon="calendar" label="Joined" value={formatDate(p.joinedAt)} />
          </Group>

          <Group title="Work">
            <div className="pr-stats">
              <div><b>{p.open}</b><small>Open</small></div>
              <div className={p.overdue ? 'late' : ''}><b>{p.overdue}</b><small>Overdue</small></div>
              <div><b>{p.doneLast30Days}</b><small>Done 30 days</small></div>
              <div><b>{p.doneTotal}</b><small>Done in total</small></div>
            </div>
          </Group>
        </div>

        <div>
          <Group title="Access">
            <Line icon="shield" label="Access level" value={<span className={`pr-level lv-${p.role.toLowerCase()}`}>{p.role}</span>}
              action={mayLevel ? () => setAction('level') : undefined} actionLabel="Change access level" testId="change-level" />
            <Line icon="tag" label="Job role" value={p.jobRole ? <Link to={`/people/roles/job/${p.orgRoleId}`}>{p.jobRole}</Link> : 'None'}
              action={canStructure ? () => setAction('jobRole') : undefined} actionLabel="Change job role" testId="change-job" />
            {canSeeAccess && (
              access ? (
                <div className="pr-access" data-testid="effective-summary">
                  <p className="muted">{access.source === 'Owner' ? 'Owners can do everything.' : access.source === 'Admin' ? 'Admins can do everything; a job role never narrows it.' : access.source === 'JobRole' ? `Decided by the job role ${access.jobRole}.` : `Decided by the ${access.accessLevel} access level’s defaults.`}</p>
                  <div className="pr-modgrid">
                    {Object.keys(access.modules).sort((a, b) => MODULE_ORDER.indexOf(a) - MODULE_ORDER.indexOf(b)).map((m) => (
                      <div key={m}><span>{MODULE_LABEL[m] ?? m}</span><span className={`access-cell l${access.modules[m]}`}>{MODULE_LEVEL[access.modules[m]] ?? access.modules[m]}</span></div>
                    ))}
                  </div>
                </div>
              ) : effective.isLoading ? <div className="pr-access"><PageLoader /></div> : null
            )}
          </Group>

          {(mayLevel && canManage) && (
            <Group title="Membership">
              {suspended
                ? <button type="button" className="pr-action" onClick={() => setAction('reactivate')} data-testid="reactivate"><Icon name="refresh" size={16} /><span><b>Reactivate</b><small>Let them open the workspace again.</small></span></button>
                : <button type="button" className="pr-action warn" onClick={() => setAction('suspend')} data-testid="suspend"><Icon name="lock" size={16} /><span><b>Suspend</b><small>Sign them out and stop access. History, assignments and reporting lines stay.</small></span></button>}
              <button type="button" className="pr-action danger" onClick={() => setAction('remove')} data-testid="remove"><Icon name="trash" size={16} /><span><b>Remove from workspace</b><small>Ends their project and team memberships.</small></span></button>
            </Group>
          )}
          {p.isMe && <p className="muted pr-note">You can’t change your own access level or suspend yourself. Ask another Admin.</p>}
        </div>
      </div>

      {action === 'level' && <LevelDialog p={p} onClose={() => setAction(null)} onDone={after} />}
      {action === 'jobRole' && <JobRoleDialog p={p} roles={(org.data?.roles ?? []).filter((r) => !r.isDeleted)} onClose={() => setAction(null)} onDone={after} />}
      {action === 'manager' && <ManagerDialog p={p} candidates={(members.data ?? []).filter((m) => m.userId !== p.userId && canPick(m))} onClose={() => setAction(null)} onDone={after} />}
      {action === 'teams' && <TeamsDialog p={p} teams={teams.data ?? []} onClose={() => setAction(null)} onDone={after} />}
      {action === 'suspend' && <ImpactDialog title={`Suspend ${p.displayName}?`} request={{ kind: 'suspend', userId: p.userId }} confirmText="Suspend" danger
        onConfirm={async () => { await workspaceApi.suspendMember(p.userId); toast(`${p.displayName} is suspended.`, 'success'); after(); }} onClose={() => setAction(null)} />}
      {action === 'reactivate' && <ImpactDialog title={`Reactivate ${p.displayName}?`} request={null} confirmText="Reactivate"
        extra={<p className="muted">They can sign in and open the workspace again with their {p.role} access{p.jobRole ? ` and the ${p.jobRole} job role` : ''}.</p>}
        onConfirm={async () => { await workspaceApi.reactivateMember(p.userId); toast(`${p.displayName} is active again.`, 'success'); after(); }} onClose={() => setAction(null)} />}
      {action === 'remove' && <ImpactDialog title={`Remove ${p.displayName}?`} request={{ kind: 'remove', userId: p.userId }} confirmText="Remove" danger
        onConfirm={async () => { await workspaceApi.removeMember(p.userId); toast(`${p.displayName} was removed.`, 'success'); refreshPeople(wid); nav('/people'); }} onClose={() => setAction(null)} />}
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return <section className="pr-group"><h2>{title}</h2><div className="pr-grp">{children}</div></section>;
}

function Line({ icon, label, value, action, actionLabel, testId }: { icon: Parameters<typeof Icon>[0]['name']; label: string; value: ReactNode; action?: () => void; actionLabel?: string; testId?: string }) {
  return (
    <div className="pr-line">
      <span className="pr-line-ic"><Icon name={icon} size={14} /></span>
      <span className="pr-line-label">{label}</span>
      <span className="pr-line-value">{value}</span>
      {action && <button type="button" className="btn btn-ghost btn-sm" onClick={action} aria-label={actionLabel} data-testid={testId}>Change</button>}
    </div>
  );
}

function LevelDialog({ p, onClose, onDone }: { p: MemberProfile; onClose: () => void; onDone: () => void }) {
  const mine = useAuth((s) => s.ctx?.current?.role ?? 'Guest');
  const options = LEVELS.filter((l) => l.id !== 'Owner' && (mine === 'Owner' || RANK[l.id] < RANK[mine]));
  const [level, setLevel] = useState<Role>(p.role);
  return (
    <ImpactDialog title={`Change ${p.displayName}’s access level`} ready={level !== p.role} request={{ kind: 'accessLevel', userId: p.userId, role: level }} confirmText="Change access level"
      onConfirm={async () => { await workspaceApi.setRole(p.userId, level); toast(`${p.displayName} is now ${level}.`, 'success'); onDone(); }} onClose={onClose}>
      <div className="pr-choices" role="radiogroup" aria-label="Access level">
        {options.map((l) => (
          <label key={l.id} className={`pr-choice${level === l.id ? ' on' : ''}`}>
            <input type="radio" name="level" checked={level === l.id} onChange={() => setLevel(l.id)} />
            <span><b>{l.id}{l.id === p.role && <small> · current</small>}</b><small>{l.blurb}</small></span>
          </label>
        ))}
      </div>
    </ImpactDialog>
  );
}

function JobRoleDialog({ p, roles, onClose, onDone }: { p: MemberProfile; roles: { id: string; name: string }[]; onClose: () => void; onDone: () => void }) {
  const [roleId, setRoleId] = useState<string>(p.orgRoleId ?? '');
  const sorted = useMemo(() => roles.slice().sort((a, b) => a.name.localeCompare(b.name)), [roles]);
  return (
    <ImpactDialog title={`Change ${p.displayName}’s job role`} ready={(roleId || null) !== (p.orgRoleId ?? null)} request={{ kind: 'jobRole', userId: p.userId, orgRoleId: roleId || null }}
      confirmText="Change job role"
      onConfirm={async () => { await orgApi.assign(p.userId, roleId || null); toast('Job role changed.', 'success'); onDone(); }} onClose={onClose}>
      <label className="field"><span className="field-label">Job role</span>
        <Select className="select" value={roleId} onChange={(e) => setRoleId(e.target.value)} aria-label="Job role" data-testid="job-role-select">
          <option value="">No job role</option>{sorted.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </Select>
      </label>
    </ImpactDialog>
  );
}

function ManagerDialog({ p, candidates, onClose, onDone }: { p: MemberProfile; candidates: { userId: string; displayName: string }[]; onClose: () => void; onDone: () => void }) {
  const [boss, setBoss] = useState<string>(p.reportsToUserId ?? '');
  const name = candidates.find((c) => c.userId === boss)?.displayName;
  return (
    <ImpactDialog title={`Change who ${p.displayName} reports to`} ready={(boss || null) !== (p.reportsToUserId ?? null)} request={null} confirmText="Change manager"
      extra={(boss || null) !== (p.reportsToUserId ?? null) && <p className="muted" data-testid="manager-impact">{p.displayName} will report to {name ?? 'nobody'}{p.reportsTo ? ` instead of ${p.reportsTo.name}` : ''}. Access does not change; {name ? `${name} sees their work in My team.` : 'they leave their manager’s team view.'}</p>}
      onConfirm={async () => { await orgApi.reportsTo(p.userId, boss || null); toast('Manager changed.', 'success'); onDone(); }} onClose={onClose}>
      <label className="field"><span className="field-label">Reports to</span>
        <Select className="select" value={boss} onChange={(e) => setBoss(e.target.value)} aria-label="Reports to">
          <option value="">Nobody</option>{candidates.slice().sort((a, b) => a.displayName.localeCompare(b.displayName)).map((c) => <option key={c.userId} value={c.userId}>{c.displayName}</option>)}
        </Select>
      </label>
    </ImpactDialog>
  );
}

function TeamsDialog({ p, teams, onClose, onDone }: { p: MemberProfile; teams: { id: string; name: string }[]; onClose: () => void; onDone: () => void }) {
  const had = new Set(p.teams.map((t) => t.id));
  const [picked, setPicked] = useState<Set<string>>(new Set(had));
  const adds = [...picked].filter((t) => !had.has(t));
  const drops = [...had].filter((t) => !picked.has(t));
  const nameOf = (id: string) => teams.find((t) => t.id === id)?.name ?? 'a team';
  return (
    <ImpactDialog title={`${p.displayName}’s teams`} ready={adds.length + drops.length > 0} request={null} confirmText="Save teams"
      extra={adds.length + drops.length > 0 && <ul className="pr-impact-list">
        {adds.map((t) => <li key={t} className="gain">Joins {nameOf(t)}: sees its projects when projects are limited to teams.</li>)}
        {drops.map((t) => <li key={t} className="lose">Leaves {nameOf(t)}: loses its projects when projects are limited to teams.</li>)}
      </ul>}
      onConfirm={async () => {
        for (const t of adds) await teamApi.addMember(t, { userId: p.userId, isLead: false });
        for (const t of drops) await teamApi.removeMember(t, p.userId);
        toast('Teams saved.', 'success'); onDone();
      }} onClose={onClose}>
      {teams.length === 0 ? <p className="muted">There are no teams yet.</p> : (
        <div className="pr-choices" role="group" aria-label="Teams">
          {teams.slice().sort((a, b) => a.name.localeCompare(b.name)).map((t) => (
            <label key={t.id} className={`pr-choice${picked.has(t.id) ? ' on' : ''}`}>
              <input type="checkbox" checked={picked.has(t.id)} onChange={() => setPicked((s) => { const n = new Set(s); if (n.has(t.id)) n.delete(t.id); else n.add(t.id); return n; })} />
              <span><b>{t.name}</b></span>
            </label>
          ))}
        </div>
      )}
    </ImpactDialog>
  );
}
