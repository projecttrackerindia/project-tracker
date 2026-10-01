import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { orgApi } from '../../api/endpoints';
import type { AccessMatrix, RoleAccess } from '../../api/types';
import { Icon, type IconName } from '../../components/Icon';
import { EmptyState, ErrorState, PageLoader } from '../../components/ui';
import { PERMISSION_LABELS } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { queryClient, useAuth, useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
import { subtreeIds } from './orgLayout';
import { useOrg } from './orgState';
import { Select } from '../../components/Select';

/** What is being edited for one role: a level per module, plus yes/no overrides where they differ from what the levels imply. */
interface Draft { modules: Record<string, number>; overrides: Record<string, boolean> }

const LEVEL_NAME: Record<number, string> = { 0: 'None', 1: 'View', 2: 'Edit', 3: 'Full' };
const LEVEL_OVERRIDE: Record<string, Record<number, string>> = { teams: { 2: 'Manage' }, members: { 2: 'Invite', 3: 'Manage' }, billing: { 3: 'Manage' } };
const levelName = (module: string, level: number) => LEVEL_OVERRIDE[module]?.[level] ?? LEVEL_NAME[level] ?? String(level);
const levelLetter = (module: string, level: number) => (level === 0 ? '–' : levelName(module, level)[0]);

/** Menu items each module controls (Dashboard and Settings are always there). */
const MENU: { module: string; label: string; icon: IconName }[] = [
  { module: 'tasks', label: 'My Tasks', icon: 'check' }, { module: 'projects', label: 'Projects', icon: 'folder' }, { module: 'calendar', label: 'Calendar', icon: 'calendar' },
  { module: 'teams', label: 'Teams', icon: 'users' }, { module: 'members', label: 'Members', icon: 'user' }, { module: 'organization', label: 'Organization', icon: 'org' },
  { module: 'reports', label: 'Reports', icon: 'chart' }, { module: 'activity', label: 'Activity', icon: 'activity' }, { module: 'audit', label: 'Audit log', icon: 'shield' },
  { module: 'billing', label: 'Billing', icon: 'card' },
];

function impliedBy(matrix: AccessMatrix, modules: Record<string, number>): Set<string> {
  const set = new Set<string>();
  for (const m of matrix.modules) for (const key of m.grants[modules[m.id] ?? 0] ?? []) set.add(key);
  return set;
}

function toDraft(matrix: AccessMatrix, modules: Record<string, number>, actions: Record<string, boolean>): Draft {
  const implied = impliedBy(matrix, modules);
  const overrides: Record<string, boolean> = {};
  for (const a of matrix.actions) { const v = !!actions[a.key]; if (v !== implied.has(a.key)) overrides[a.key] = v; }
  return { modules: { ...modules }, overrides };
}

const isOn = (matrix: AccessMatrix, d: Draft, key: string) => (key in d.overrides ? d.overrides[key] : impliedBy(matrix, d.modules).has(key));
const sameDraft = (a: Draft, b: Draft) => JSON.stringify([a.modules, Object.entries(a.overrides).sort()]) === JSON.stringify([b.modules, Object.entries(b.overrides).sort()]);

export function AccessPanel() {
  const wid = useWorkspaceId();
  const meId = useAuth((s) => s.ctx!.user.id);
  const myPerms = useAuth((s) => s.ctx?.current?.permissions ?? []);
  const q = useWsQuery(['org', 'access'], orgApi.access);
  const org = useOrg();
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [mode, setMode] = useState<'edit' | 'overview'>('edit');
  const [copyFrom, setCopyFrom] = useState('');
  const [busy, setBusy] = useState(false);
  const m = q.data;

  const role = m?.roles.find((r) => r.roleId === selected) ?? null;
  const server = useMemo(() => (m && role ? toDraft(m, role.modules, role.actions) : null), [m, role]);
  const dirty = !!(draft && server && !sameDraft(draft, server));

  const choose = (r: RoleAccess, matrix: AccessMatrix) => { setSelected(r.roleId); setDraft(toDraft(matrix, r.modules, r.actions)); setCopyFrom(''); };
  useEffect(() => { if (m && !selected && m.roles.length) choose(m.roles[0], m); }, [m, selected]);
  // If the server copy of the selected role changes (saved elsewhere) and there is nothing unsaved, follow it.
  useEffect(() => { if (server && !dirty) setDraft(server); }, [server]); // eslint-disable-line react-hooks/exhaustive-deps

  // Delegates can only change roles below their own in the chart; organization admins can change all of them.
  const editable = useMemo(() => {
    if (!m || !org.data) return new Set<string>();
    if (m.isOrgAdmin) return new Set(m.roles.map((r) => r.roleId));
    const mine = org.data.people.find((p) => p.userId === meId)?.roleId;
    if (!mine) return new Set<string>();
    const below = subtreeIds(mine, org.data.roles); below.delete(mine);
    return below;
  }, [m, org.data, meId]);

  if (q.isLoading) return <PageLoader />;
  if (q.isError || !m) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  if (m.roles.length === 0) return <div className="card"><div className="card-body"><EmptyState icon="shield" title="No job roles yet" text="Add job roles under People → Org chart first, then decide what each one can see and do here." /></div></div>;

  const canEditRole = !!role && m.canEdit && editable.has(role.roleId);
  const my = m.myLevels;
  const levelLocked = (module: string, level: number) => !canEditRole || (!m.isOrgAdmin && level > (my[module] ?? 0));

  const switchTo = async (r: RoleAccess) => {
    if (r.roleId === selected) return;
    if (dirty && !(await confirmDialog({ title: 'Discard changes?', message: `You have unsaved changes for “${role?.name}”.`, confirmText: 'Discard', danger: false }))) return;
    choose(r, m);
  };

  const setLevel = (module: string, level: number) => draft && setDraft({ ...draft, modules: { ...draft.modules, [module]: level } });
  const setAction = (key: string, value: boolean) => {
    if (!draft) return;
    const overrides = { ...draft.overrides };
    if (value === impliedBy(m, draft.modules).has(key)) delete overrides[key]; else overrides[key] = value;
    setDraft({ ...draft, overrides });
  };
  const fill = (source: { modules: Record<string, number>; actions: Record<string, boolean> }) => setDraft(toDraft(m, source.modules, source.actions));

  const finish = (res: AccessMatrix, name: string, message: string) => {
    queryClient.setQueryData([wid, 'org', 'access'], res);
    void invalidateWorkspace(wid, 'org');
    const updated = res.roles.find((r) => r.roleId === selected);
    if (updated) setDraft(toDraft(res, updated.modules, updated.actions));
    toast(message.replace('{name}', name));
  };
  const fail = (e: unknown, fallback: string) => toast(e instanceof ApiError ? e.message : fallback, 'error');

  const save = async () => {
    if (!role || !draft) return;
    setBusy(true);
    try {
      const actions = Object.fromEntries(m.actions.map((a) => [a.key, isOn(m, draft, a.key)]));
      finish(await orgApi.setAccess(role.roleId, { modules: draft.modules, actions }), role.name, 'Access for “{name}” saved.');
    } catch (e) { fail(e, 'Could not save the access.'); } finally { setBusy(false); }
  };

  const reset = async () => {
    if (!role) return;
    if (!(await confirmDialog({ title: 'Use default access?', confirmText: 'Use defaults', danger: false,
      message: `People in “${role.name}” will go back to the defaults of their access level (Member, Manager…) instead of this role's own settings.` }))) return;
    setBusy(true);
    try { finish(await orgApi.resetAccess(role.roleId), role.name, '“{name}” now uses default access.'); } catch (e) { fail(e, 'Could not reset the access.'); } finally { setBusy(false); }
  };

  const visibleMenus = draft ? MENU.filter((x) => (draft.modules[x.module] ?? 0) > 0) : [];
  const grantsOthers = m.actions.filter((a) => a.delegable);
  const everyday = m.actions.filter((a) => !a.delegable);

  return (
    <>
      {!m.planAllows && <div className="form-warn">Editing job-role access is part of the Business plan. What is shown here is what people can do today. <Link className="link" to="/settings/billing">View plans</Link></div>}

      <div className="acc-top">
        <div className="seg" role="group" aria-label="Access view">
          <button type="button" className={mode === 'edit' ? 'active' : ''} aria-pressed={mode === 'edit'} onClick={() => setMode('edit')}><Icon name="edit" /><span>Edit a role</span></button>
          <button type="button" className={mode === 'overview' ? 'active' : ''} aria-pressed={mode === 'overview'} onClick={() => setMode('overview')}><Icon name="grid" /><span>All roles at a glance</span></button>
        </div>
        <p className="muted acc-note">Organization Owners and Admins are never limited by a job role. Everyone else gets exactly what their job role allows; a role without its own settings uses the defaults of the person's access level.</p>
      </div>

      {mode === 'overview' ? (
        <div className="card"><div className="table-wrap"><table className="acc-overview">
          <thead><tr><th>Role</th>{m.modules.map((x) => <th key={x.id} title={x.description}>{x.label}</th>)}<th style={{ textAlign: 'right' }}> </th></tr></thead>
          <tbody>{m.roles.map((r) => (
            <tr key={r.roleId} className="clickable" onClick={() => { setMode('edit'); void switchTo(r); }}>
              <td><div className="row" style={{ gap: 9 }}><span className="org-dot big" style={{ '--node': r.color } as CSSProperties} /><div><div className="td-title">{r.name}</div><div className="td-sub">{r.people} {r.people === 1 ? 'person' : 'people'}</div></div></div></td>
              {m.modules.map((x) => <td key={x.id}><span className={`acc-cell l${r.modules[x.id] ?? 0}`} title={`${x.label}: ${levelName(x.id, r.modules[x.id] ?? 0)}`}>{levelLetter(x.id, r.modules[x.id] ?? 0)}</span></td>)}
              <td style={{ textAlign: 'right' }}>{r.hasProfile ? <span className="badge badge-purple">Custom</span> : <span className="badge badge-neutral">Default</span>}</td>
            </tr>
          ))}</tbody>
        </table></div>
          <div className="card-body acc-legend"><span className="acc-cell l0">–</span> None <span className="acc-cell l1">V</span> View <span className="acc-cell l2">E</span> Edit / invite / manage <span className="acc-cell l3">F</span> Full</div>
        </div>
      ) : (
        <div className="acc-shell">
          <aside className="card acc-roles" aria-label="Job roles">
            <div className="card-head"><div><h3>Job roles</h3><p>Pick one to see and change what it can do.</p></div></div>
            <div className="acc-role-list">
              {m.roles.map((r) => (
                <button key={r.roleId} className={`acc-role ${r.roleId === selected ? 'active' : ''}`} onClick={() => void switchTo(r)} style={{ '--node': r.color } as CSSProperties}>
                  <span className="org-dot big" />
                  <span className="acc-role-text"><b>{r.name}</b><span>{r.people} {r.people === 1 ? 'person' : 'people'}</span></span>
                  {r.hasProfile ? <span className="badge badge-purple">Custom</span> : <span className="badge badge-neutral">Default</span>}
                </button>
              ))}
            </div>
          </aside>

          {role && draft && (
            <section className="card acc-editor" aria-label={`Access for ${role.name}`}>
              <div className="card-head">
                <div className="row" style={{ minWidth: 0 }}><span className="org-dot big" style={{ '--node': role.color } as CSSProperties} /><div style={{ minWidth: 0 }}><h3>{role.name}</h3>
                  <p>{role.people} {role.people === 1 ? 'person has' : 'people have'} this role{role.hasProfile ? ' · custom access' : ' · uses default access (shown as a plain Member)'}</p></div></div>
                <div className="acc-actions">
                  {canEditRole && role.suggested && <button className="btn btn-ghost btn-sm" onClick={() => fill(role.suggested!)} title="Fill in a sensible starting point for this role"><Icon name="star" /> Use suggested</button>}
                  {canEditRole && m.roles.length > 1 && (
                    <Select className="select acc-copy" aria-label="Copy access from another role" value={copyFrom} onChange={(e) => { const src = m.roles.find((r) => r.roleId === e.target.value); if (src) fill(src); setCopyFrom(''); }}>
                      <option value="">Copy from…</option>{m.roles.filter((r) => r.roleId !== role.roleId).map((r) => <option key={r.roleId} value={r.roleId}>{r.name}</option>)}
                    </Select>
                  )}
                  {canEditRole && role.hasProfile && <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void reset()}><Icon name="undo" /> Use defaults</button>}
                  {canEditRole && <button className="btn btn-primary btn-sm" disabled={busy || (!dirty && role.hasProfile)} onClick={() => void save()}>{busy && <span className="spinner" />}{role.hasProfile ? 'Save changes' : 'Save as custom access'}</button>}
                </div>
              </div>

              {!canEditRole && m.planAllows && <div className="card-body" style={{ paddingBottom: 0 }}><div className="form-warn">{m.isOrgAdmin ? 'This role cannot be edited.' : 'You can only change roles below your own role in the organization chart.'}</div></div>}

              <div className="table-wrap"><table className="acc-table">
                <thead><tr><th>Menu / area</th><th>Access</th><th>What this allows</th></tr></thead>
                <tbody>{m.modules.map((x) => {
                  const lvl = draft.modules[x.id] ?? 0;
                  return (
                    <tr key={x.id}>
                      <td><div className="td-title">{x.label}</div><div className="td-sub">{x.description}</div></td>
                      <td><div className="seg acc-seg" role="radiogroup" aria-label={`${x.label} access`}>
                        {x.levels.map((l) => (
                          <button key={l} type="button" role="radio" aria-checked={lvl === l} className={`l${l} ${lvl === l ? 'active' : ''}`} disabled={levelLocked(x.id, l)} onClick={() => setLevel(x.id, l)}
                            title={x.hints[l]}>{levelName(x.id, l)}</button>
                        ))}
                      </div></td>
                      <td className="cell-muted">{x.hints[lvl] ?? ''}</td>
                    </tr>
                  );
                })}</tbody>
              </table></div>

              <div className="card-body acc-extras">
                <div className="acc-group">
                  <h4>Extra permissions</h4>
                  <p className="muted">Fine-tune what this role can do on top of the levels above.</p>
                  {everyday.map((a) => {
                    const on = isOn(m, draft, a.key);
                    return <label key={a.key} className={`acc-toggle ${!canEditRole ? 'off' : ''}`}>
                      <input type="checkbox" checked={on} disabled={!canEditRole || (!m.isOrgAdmin && !on && !myPerms.includes(a.key))} onChange={(e) => setAction(a.key, e.target.checked)} />
                      <span><b>{a.label}</b><small>{a.description}</small></span>
                    </label>;
                  })}
                </div>
                <div className="acc-group">
                  <h4><Icon name="lock" size={14} /> Lets people give access to others</h4>
                  <p className="muted">{m.isOrgAdmin ? 'Only organization admins can switch these on. Someone who holds “Manage job-role access” can then only change roles below theirs, and never grant more than they have.' : 'Only organization admins can change these.'}</p>
                  {grantsOthers.map((a) => {
                    const on = isOn(m, draft, a.key);
                    return <label key={a.key} className="acc-toggle">
                      <input type="checkbox" checked={on} disabled={!canEditRole || !m.isOrgAdmin} onChange={(e) => setAction(a.key, e.target.checked)} />
                      <span><b>{a.label}</b><small>{a.description}</small></span>
                    </label>;
                  })}
                </div>
              </div>

              <div className="card-body acc-preview">
                <h4>Menu this role will see</h4>
                <div className="acc-chips">
                  <span className="acc-chip fixed"><Icon name="dashboard" size={14} /> Dashboard</span>
                  {visibleMenus.map((x) => <span key={x.module} className="acc-chip"><Icon name={x.icon} size={14} /> {x.label}<small>{levelName(x.module, draft.modules[x.module])}</small></span>)}
                  <span className="acc-chip fixed"><Icon name="settings" size={14} /> Settings</span>
                </div>
                {dirty && <p className="muted" style={{ marginTop: 10 }}>Unsaved changes. People see menu changes the next time they open or reload the app; the server applies the new permissions straight away.</p>}
                <p className="muted" style={{ marginTop: 6, fontSize: 11.5 }}>Also affects: {Object.keys(draft.overrides).length ? Object.keys(draft.overrides).map((k) => `${PERMISSION_LABELS[k] ?? k} (${draft.overrides[k] ? 'on' : 'off'})`).join(', ') : 'nothing beyond the levels above'}.</p>
              </div>
            </section>
          )}
        </div>
      )}
    </>
  );
}
