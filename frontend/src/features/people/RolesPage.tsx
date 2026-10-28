import { useMemo, useState } from 'react';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { orgApi } from '../../api/endpoints';
import type { AccessMatrix, Member, Role, RoleAccess } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Select } from '../../components/Select';
import { Avatar, EmptyState, ErrorState, PageLoader, Segmented } from '../../components/ui';
import { useWsQuery } from '../../lib/hooks';
import { useIsMobile } from '../../lib/mobile';
import { useCan, useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { AccessLevelMatrix } from '../members/MembersPage';
import { EffectiveAccessTable } from '../organization/RolesAccess';
import { ImpactDialog } from './ImpactDialog';
import { LEVELS, MODULE_LEVEL, SENSITIVE_MODULES, canPick, isSuspended, refreshPeople, useMembers, useOrgStructure } from './peopleData';

type Kind = 'level' | 'job';
interface Draft { modules: Record<string, number>; overrides: Record<string, boolean> }

function implied(matrix: AccessMatrix, modules: Record<string, number>) {
  const s = new Set<string>();
  for (const m of matrix.modules) for (const k of m.grants[modules[m.id] ?? 0] ?? []) s.add(k);
  return s;
}
const actionOn = (matrix: AccessMatrix, d: Draft, key: string) => (key in d.overrides ? d.overrides[key] : implied(matrix, d.modules).has(key));
function toDraft(matrix: AccessMatrix, r: RoleAccess): Draft {
  const imp = implied(matrix, r.modules);
  const overrides: Record<string, boolean> = {};
  for (const a of matrix.actions) { const v = !!r.actions[a.key]; if (v !== imp.has(a.key)) overrides[a.key] = v; }
  return { modules: { ...r.modules }, overrides };
}
const actionsOf = (matrix: AccessMatrix, d: Draft) => Object.fromEntries(matrix.actions.map((a) => [a.key, actionOn(matrix, d, a.key)]));

/** Full on People, Organization, Billing or Audit, or any action that lets someone hand out access. */
export function isHighPrivilege(matrix: AccessMatrix, modules: Record<string, number>, actions: Record<string, boolean>) {
  return matrix.modules.some((m) => SENSITIVE_MODULES.includes(m.id) && (modules[m.id] ?? 0) >= Math.max(...m.levels) && Math.max(...m.levels) > 0)
    || matrix.actions.some((a) => a.delegable && actions[a.key]);
}

/**
 * People › Roles & access: the access levels (system roles; Owner locked) and the job roles (custom), with how many people hold each, which
 * are unused and which carry high privilege. A role opens to its module levels and actions, its members, and every change shows who gains or
 * loses what before it is saved. "Effective access" lists what each person can do and why.
 */
export function RolesPage() {
  const { kind, id } = useParams<{ kind?: Kind; id?: string }>();
  const [params, setParams] = useSearchParams();
  const phone = useIsMobile();
  const canAccess = useCan('access.manage');
  const canPermissions = useCan('permissions.manage');
  const canLevels = useCan('org.manage');
  const tab = params.get('tab') === 'effective' && (canAccess || canPermissions) ? 'effective' : 'roles';
  const legacyView = params.get('view');
  if (legacyView === 'people') return <Navigate to="/people/roles?tab=effective" replace />;
  if (!canAccess && !canPermissions && !canLevels) {
    return <EmptyState icon="lock" title="You can’t manage roles" text="Ask an Owner or Admin. You can see your own access on your profile." action={<Link className="btn btn-ghost" to="/people">Back to People</Link>} />;
  }
  return (
    <div className="pr-roles">
      {(canAccess || canPermissions) && (
        <div className="pr-org-head">
          <Segmented label="Roles view" value={tab} onChange={(v) => { const n = new URLSearchParams(params); if (v === 'roles') n.delete('tab'); else n.set('tab', v); setParams(n, { replace: true }); }}
            options={[{ id: 'roles', label: 'Roles' }, { id: 'effective', label: 'Effective access' }]} />
        </div>
      )}
      {tab === 'effective' ? <EffectiveAccessTable /> : (
        <div className={`pr-split${kind ? ' has-detail' : ''}`}>
          {(!phone || !kind) && <RoleList selected={kind && id ? `${kind}:${id}` : null} />}
          {kind && id ? <RoleDetail kind={kind} id={id} /> : !phone && <div className="pr-detail-empty"><EmptyState icon="shield" title="Choose a role" text="See what it allows, who holds it, and change it with a preview of who is affected." /></div>}
        </div>
      )}
    </div>
  );
}

function useMatrix() {
  const canAccess = useCan('access.manage');
  return useWsQuery(['org', 'access'], orgApi.access, { enabled: canAccess, retry: false });
}

function RoleList({ selected }: { selected: string | null }) {
  const members = useMembers();
  const matrix = useMatrix();
  const org = useOrgStructure();
  const [term, setTerm] = useState('');
  const t = term.trim().toLowerCase();
  const levelCount = (r: Role) => (members.data ?? []).filter((m) => m.role === r).length;
  const jobCounts = useMemo(() => { const c = new Map<string, number>(); for (const m of members.data ?? []) if (m.orgRoleId) c.set(m.orgRoleId, (c.get(m.orgRoleId) ?? 0) + 1); return c; }, [members.data]);
  const jobs = (matrix.data?.roles.map((r) => ({ id: r.roleId, name: r.name, color: r.color, high: isHighPrivilege(matrix.data!, r.modules, r.actions), own: r.hasProfile }))
    ?? (org.data?.roles ?? []).filter((r) => !r.isDeleted).map((r) => ({ id: r.id, name: r.name, color: r.color, high: false, own: r.hasAccess })))
    .filter((r) => !t || r.name.toLowerCase().includes(t)).sort((a, b) => a.name.localeCompare(b.name));
  const levels = LEVELS.filter((l) => !t || l.id.toLowerCase().includes(t));

  return (
    <aside className="pr-rolelist" aria-label="Roles">
      <div className="pr-search"><Icon name="search" size={15} /><input type="search" placeholder="Search roles" value={term} onChange={(e) => setTerm(e.target.value)} aria-label="Search roles" data-testid="roles-search" /></div>
      <h3>Access levels <small>System</small></h3>
      <div className="pr-grp">
        {levels.map((l) => (
          <Link key={l.id} to={`/people/roles/level/${l.id}`} className={`pr-rolerow${selected === `level:${l.id}` ? ' on' : ''}`} data-testid="role-row-level">
            <span className={`pr-role-dot lv-${l.id.toLowerCase()}`} aria-hidden="true"><Icon name={l.id === 'Owner' ? 'lock' : 'shield'} size={13} /></span>
            <span className="pr-rolerow-main"><b>{l.id}</b><small>{l.blurb}</small></span>
            {(l.id === 'Owner' || l.id === 'Admin') && <span className="pr-badge hi">High privilege</span>}
            <span className="pr-count-chip">{members.data ? levelCount(l.id) : '…'}</span>
          </Link>
        ))}
      </div>
      <h3>Job roles <small>Custom</small></h3>
      {matrix.isError && org.isError ? <ErrorState error={matrix.error} /> : (
        jobs.length === 0 ? <p className="muted pr-note">{t ? 'No job role matches.' : 'No job roles yet. Add them on the Organization canvas.'}</p> : (
          <div className="pr-grp">
            {jobs.map((r) => {
              const n = jobCounts.get(r.id) ?? 0;
              return (
                <Link key={r.id} to={`/people/roles/job/${r.id}`} className={`pr-rolerow${selected === `job:${r.id}` ? ' on' : ''}`} data-testid="role-row-job">
                  <span className="pr-role-dot" style={{ background: r.color }} aria-hidden="true" />
                  <span className="pr-rolerow-main"><b>{r.name}</b><small>{r.own ? 'Own access settings' : 'Uses access level defaults'}</small></span>
                  {n === 0 && <span className="pr-badge" data-testid="badge-unused">Unused</span>}
                  {r.high && <span className="pr-badge hi" data-testid="badge-high">High privilege</span>}
                  <span className="pr-count-chip">{n}</span>
                </Link>
              );
            })}
          </div>
        ))}
    </aside>
  );
}

function RoleDetail({ kind, id }: { kind: Kind; id: string }) {
  const phone = useIsMobile();
  const [tab, setTab] = useState<'access' | 'members'>('access');
  return (
    <section className="pr-roledetail" data-testid="role-detail">
      {phone && <Link className="pr-crumbs" to="/people/roles"><Icon name="chevronL" size={14} /> Roles</Link>}
      {kind === 'level' ? <LevelDetail level={id as Role} tab={tab} setTab={setTab} /> : <JobDetail id={id} tab={tab} setTab={setTab} />}
    </section>
  );
}

function Tabs2({ tab, setTab, count }: { tab: 'access' | 'members'; setTab: (t: 'access' | 'members') => void; count: number }) {
  return <Segmented label="Role sections" value={tab} onChange={setTab} options={[{ id: 'access', label: 'Access' }, { id: 'members', label: 'Members', count }]} />;
}

function LevelDetail({ level, tab, setTab }: { level: Role; tab: 'access' | 'members'; setTab: (t: 'access' | 'members') => void }) {
  const def = LEVELS.find((l) => l.id === level);
  const members = useMembers();
  const canLevels = useCan('org.manage');
  if (!def) return <EmptyState icon="shield" title="No such access level" />;
  const holders = (members.data ?? []).filter((m) => m.role === level);
  return (
    <>
      <header className="pr-rolehead">
        <span className={`pr-role-dot big lv-${level.toLowerCase()}`} aria-hidden="true"><Icon name={level === 'Owner' ? 'lock' : 'shield'} size={18} /></span>
        <div><h2>{level}</h2><p>{def.blurb}</p>
          <div className="pr-id-tags"><span className="pr-badge">System role</span><span className="pr-badge">Protected</span>{level === 'Owner' && <span className="pr-badge warn">Locked</span>}{(level === 'Owner' || level === 'Admin') && <span className="pr-badge hi">High privilege</span>}</div>
        </div>
      </header>
      <Tabs2 tab={tab} setTab={setTab} count={holders.length} />
      {tab === 'access' ? (
        level === 'Owner' || level === 'Admin'
          ? <p className="pr-note muted">{level === 'Owner' ? 'The Owner can do everything, always. This cannot be changed; ownership moves only by transferring it.' : 'Admins can do everything; a job role never narrows them. The workspace always keeps at least one active Owner or Admin.'}</p>
          : canLevels ? <AccessLevelMatrix /> : <p className="pr-note muted">Only Owners and Admins can change access-level defaults.</p>
      ) : <MemberList people={holders} empty={`Nobody is ${level === 'Admin' || level === 'Owner' ? 'an' : 'a'} ${level}.`} hint="Change a person’s access level from their profile." />}
    </>
  );
}

function JobDetail({ id, tab, setTab }: { id: string; tab: 'access' | 'members'; setTab: (t: 'access' | 'members') => void }) {
  const wid = useWorkspaceId();
  const nav = useNavigate();
  const matrix = useMatrix();
  const org = useOrgStructure();
  const members = useMembers();
  const canAccess = useCan('access.manage');
  const canStructure = useCan('org.structure');
  const role = matrix.data?.roles.find((r) => r.roleId === id);
  const orgRole = org.data?.roles.find((r) => r.id === id);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dialog, setDialog] = useState<'save' | 'reset' | { assign: string } | { unassign: Member } | null>(null);
  const [assignee, setAssignee] = useState('');

  if ((canAccess && matrix.isLoading) || (!canAccess && org.isLoading)) return <PageLoader />;
  if (canAccess && matrix.isError) return <ErrorState error={matrix.error} retry={() => matrix.refetch()} />;
  if (!role && !orgRole) return <EmptyState icon="shield" title="This job role no longer exists" action={<button className="btn btn-ghost" onClick={() => nav('/people/roles')}>Back to roles</button>} />;
  const name = role?.name ?? orgRole!.name;
  const holders = (members.data ?? []).filter((m) => m.orgRoleId === id);
  const m = matrix.data;
  const base: Draft | null = m && role ? toDraft(m, role) : null;
  const d = draft ?? base;
  const dirty = !!(draft && base && JSON.stringify(draft) !== JSON.stringify(base));
  const editable = !!m && canAccess && m.canEdit;
  const high = m && role ? isHighPrivilege(m, d!.modules, actionsOf(m, d!)) : false;
  const done = () => { setDraft(null); refreshPeople(wid); void matrix.refetch(); };

  return (
    <>
      <header className="pr-rolehead">
        <span className="pr-role-dot big" style={{ background: role?.color ?? orgRole?.color }} aria-hidden="true" />
        <div><h2>{name}</h2><p>{orgRole?.description || 'A job role on the organization chart.'}</p>
          <div className="pr-id-tags">
            <span className="pr-badge">Custom</span>
            {holders.length === 0 && <span className="pr-badge">Unused</span>}
            {high && <span className="pr-badge hi">High privilege</span>}
            <span className="pr-badge">{role?.hasProfile ?? orgRole?.hasAccess ? 'Own access settings' : 'Uses access level defaults'}</span>
          </div>
        </div>
      </header>
      <Tabs2 tab={tab} setTab={setTab} count={holders.length} />
      {tab === 'access' ? (
        !m || !d ? <p className="pr-note muted">You can see who holds this role. Changing what it allows needs “Manage job-role access”.</p> : (
          <div className="pr-accessedit">
            {!m.planAllows && <div className="form-warn">Custom access for job roles is part of the Business plan. <Link className="link" to="/settings/billing">View plans</Link></div>}
            <div className="pr-grp" role="table" aria-label="Module levels">
              {m.modules.map((mod) => (
                <div key={mod.id} className="pr-modrow" role="row">
                  <span className="pr-modrow-main" role="rowheader"><b>{mod.label}</b><small>{mod.hints[String(d.modules[mod.id] ?? 0)] ?? mod.description}</small></span>
                  <span role="cell">
                    <Segmented label={`${mod.label} level`} value={String(d.modules[mod.id] ?? 0)}
                      onChange={(v) => editable && setDraft({ ...d, modules: { ...d.modules, [mod.id]: Number(v) } })}
                      options={mod.levels.map((l) => ({ id: String(l), label: MODULE_LEVEL[l] ?? String(l) }))} />
                  </span>
                </div>
              ))}
            </div>
            <h3 className="pr-subhead">Actions</h3>
            <div className="pr-grp">
              {m.actions.map((a) => {
                const on = actionOn(m, d, a.key);
                return (
                  <label key={a.key} className="pr-actrow">
                    <span><b>{a.label}{a.delegable && <span className="pr-badge hi sm">Delegable</span>}</b><small>{a.description}</small></span>
                    <input type="checkbox" role="switch" className="pr-switch" checked={on} disabled={!editable}
                      onChange={() => setDraft({ ...d, overrides: { ...d.overrides, [a.key]: !on } })} aria-label={a.label} />
                  </label>
                );
              })}
            </div>
            {editable && (
              <div className="pr-savebar">
                {role?.hasProfile && <button type="button" className="btn btn-ghost" onClick={() => setDialog('reset')}>Use access level defaults</button>}
                <span className="grow" />
                {dirty && <button type="button" className="btn btn-ghost" onClick={() => setDraft(null)}>Discard</button>}
                <button type="button" className="btn btn-primary" disabled={!dirty} onClick={() => setDialog('save')} data-testid="review-changes">Review changes</button>
              </div>
            )}
          </div>
        )
      ) : (
        <>
          {canStructure && (
            <div className="pr-assign">
              <Select className="select" value={assignee} onChange={(e) => setAssignee(e.target.value)} aria-label="Assign a person">
                <option value="">Assign a person…</option>
                {(members.data ?? []).filter((x) => x.orgRoleId !== id && canPick(x)).sort((a, b) => a.displayName.localeCompare(b.displayName)).map((x) => <option key={x.userId} value={x.userId}>{x.displayName}{x.jobRole ? ` (now ${x.jobRole})` : ''}</option>)}
              </Select>
              <button type="button" className="btn btn-primary" disabled={!assignee} onClick={() => setDialog({ assign: assignee })}>Assign</button>
            </div>
          )}
          <MemberList people={holders} empty="Nobody holds this job role yet." onRemove={canStructure ? (x) => setDialog({ unassign: x }) : undefined} />
        </>
      )}

      {dialog === 'save' && m && d && (
        <ImpactDialog title={`Save access for ${name}?`} request={{ kind: 'roleAccess', roleId: id, modules: d.modules, actions: actionsOf(m, d) }} confirmText="Save access"
          onConfirm={async () => { await orgApi.setAccess(id, { modules: d.modules, actions: actionsOf(m, d) }); toast('Access saved.', 'success'); done(); }} onClose={() => setDialog(null)} />
      )}
      {dialog === 'reset' && (
        <ImpactDialog title={`Use access level defaults for ${name}?`} request={{ kind: 'roleAccess', roleId: id, modules: null }} confirmText="Use defaults"
          onConfirm={async () => { await orgApi.resetAccess(id); toast('Back to access level defaults.', 'success'); done(); }} onClose={() => setDialog(null)} />
      )}
      {dialog && typeof dialog === 'object' && 'assign' in dialog && (
        <ImpactDialog title={`Make ${members.data?.find((x) => x.userId === dialog.assign)?.displayName ?? 'them'} a ${name}?`} request={{ kind: 'jobRole', userId: dialog.assign, orgRoleId: id }} confirmText="Assign"
          onConfirm={async () => { await orgApi.assign(dialog.assign, id); setAssignee(''); toast('Job role assigned.', 'success'); done(); }} onClose={() => setDialog(null)} />
      )}
      {dialog && typeof dialog === 'object' && 'unassign' in dialog && (
        <ImpactDialog title={`Remove ${dialog.unassign.displayName} from ${name}?`} request={{ kind: 'jobRole', userId: dialog.unassign.userId, orgRoleId: null }} confirmText="Unassign" danger
          onConfirm={async () => { await orgApi.assign(dialog.unassign.userId, null); toast('Job role removed.', 'success'); done(); }} onClose={() => setDialog(null)} />
      )}
    </>
  );
}

function MemberList({ people, empty, hint, onRemove }: { people: Member[]; empty: string; hint?: string; onRemove?: (m: Member) => void }) {
  if (!people.length) return <p className="pr-note muted">{empty}</p>;
  return (
    <>
      {hint && <p className="pr-note muted">{hint}</p>}
      <div className="pr-grp" data-testid="role-members">
        {people.slice().sort((a, b) => a.displayName.localeCompare(b.displayName)).map((m) => (
          <div key={m.userId} className="pr-memrow">
            <Avatar name={m.displayName} userId={m.userId} hasAvatar={m.hasAvatar} />
            <Link to={`/people/${m.userId}`} className="pr-memrow-main"><b>{m.displayName}</b><small>{[m.jobRole, m.role].filter(Boolean).join(' · ')}</small></Link>
            {isSuspended(m) && <span className="pr-badge warn">Suspended</span>}
            {onRemove && <button type="button" className="btn btn-ghost btn-sm" onClick={() => onRemove(m)}>Unassign</button>}
          </div>
        ))}
      </div>
    </>
  );
}

