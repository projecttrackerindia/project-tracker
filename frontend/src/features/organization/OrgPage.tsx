import { useEffect, useMemo, useState } from 'react';
import { ApiError } from '../../api/client';
import { orgApi } from '../../api/endpoints';
import type { OrgRole } from '../../api/types';
import { Icon } from '../../components/Icon';
import { EmptyState, ErrorState, PageHead, PageLoader, Tabs } from '../../components/ui';
import { formatDate } from '../../lib/format';
import { invalidateWorkspace } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { OrgCanvas, type OrgView } from './OrgCanvas';
import { DeleteRoleModal, RoleModal } from './OrgModals';
import { Inspector, UnassignedTray } from './OrgPanels';
import { useOrg, useOrgActions } from './orgState';
import { Select } from '../../components/Select';
import '../../styles/org.css';

type Tab = 'chart' | 'roles';
type ModalState = { kind: 'role'; role?: OrgRole; parentId?: string | null } | { kind: 'delete'; role: OrgRole } | null;

/** People → Org chart: job roles and who reports to whom. What each job role can access is set in Workspace settings → Roles & access. */
export function OrgPage() {
  const wid = useWorkspaceId();
  const q = useOrg();
  const actions = useOrgActions();
  const [tab, setTab] = useState<Tab>('chart');
  const [view, setView] = useState<OrgView>('roles');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [showDeleted, setShowDeleted] = useState(false);
  const [fitSignal, setFitSignal] = useState(0);
  const [focusSignal, setFocusSignal] = useState(0);
  const [modal, setModal] = useState<ModalState>(null);
  const [busy, setBusy] = useState(false);

  const data = q.data;
  const activeRoles = useMemo(() => data?.roles.filter((r) => !r.isDeleted) ?? [], [data]);
  const deletedCount = (data?.roles.length ?? 0) - activeRoles.length;

  // A selection that no longer exists (deleted, or from the other view) must not linger.
  useEffect(() => {
    if (!data || !selectedId) return;
    if (!data.roles.some((r) => r.id === selectedId) && !data.people.some((p) => p.userId === selectedId)) setSelectedId(null);
  }, [data, selectedId]);

  const restore = async (id: string) => {
    try { const r = await orgApi.restoreRole(id); toast(`Role “${r.name}” restored.`); void invalidateWorkspace(wid, 'org'); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Could not restore the role.', 'error'); }
  };

  const applyTemplate = async () => {
    setBusy(true);
    try {
      const r = await orgApi.template('software');
      toast(r.created ? `Added ${r.created} roles from the template.` : 'All template roles already exist.', r.created ? 'success' : 'info');
      void invalidateWorkspace(wid, 'org');
      setFitSignal((n) => n + 1);
    } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not apply the template.', 'error'); }
    finally { setBusy(false); }
  };

  const autoArrange = async () => {
    if (!data) return;
    await actions.savePositions(data.roles.map((r) => ({ id: r.id, x: null, y: null })));
    setFitSignal((n) => n + 1);
    toast('Chart arranged.', 'info');
  };

  if (q.isLoading) return <PageLoader />;
  if (q.isError || !data) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const canManage = data.canManage;

  return (
    <>
      <PageHead title="Org chart" sub={`${activeRoles.length} job role${activeRoles.length === 1 ? '' : 's'} · ${data.people.length} ${data.people.length === 1 ? 'person' : 'people'}`}>
        <Tabs value={tab} onChange={setTab} tabs={[{ id: 'chart' as Tab, label: 'Chart', icon: 'org' as const }, { id: 'roles' as Tab, label: 'Job roles', icon: 'list' as const }]} />
      </PageHead>

      {tab === 'chart' ? (
        <div className="org-shell">
          <UnassignedTray people={data.people} canManage={canManage} actions={actions} onSelect={(id) => { setView('people'); setSelectedId(id); }} />

          <div className={`org-stage ${selectedId ? 'has-inspector' : ''}`}>
            <div className="org-toolbar" role="toolbar" aria-label="Chart tools">
              <div className="seg" role="group" aria-label="Chart view">
                <button type="button" className={view === 'roles' ? 'active' : ''} aria-pressed={view === 'roles'} onClick={() => { setView('roles'); setSelectedId(null); }}><Icon name="org" /><span>Roles</span></button>
                <button type="button" className={view === 'people' ? 'active' : ''} aria-pressed={view === 'people'} onClick={() => { setView('people'); setSelectedId(null); }}><Icon name="users" /><span>People</span></button>
              </div>
              <div className="search-field org-search"><Icon name="search" /><input className="input" placeholder={view === 'roles' ? 'Find a role or person…' : 'Find a person…'} value={search} aria-label="Search the chart"
                onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') setFocusSignal((n) => n + 1); if (e.key === 'Escape') setSearch(''); }} /></div>
              {view === 'roles' && deletedCount > 0 && (
                <button type="button" className={`btn btn-ghost btn-sm ${showDeleted ? 'on' : ''}`} aria-pressed={showDeleted} onClick={() => setShowDeleted((v) => !v)} title="Show deleted roles"><Icon name="eye" /> Deleted ({deletedCount})</button>
              )}
              {canManage && view === 'roles' && activeRoles.length > 0 && <button type="button" className="btn btn-ghost btn-sm" onClick={() => void autoArrange()} title="Reset the layout"><Icon name="refresh" /> Auto-arrange</button>}
              {canManage && view === 'roles' && <button type="button" className="btn btn-primary btn-sm" onClick={() => setModal({ kind: 'role' })}><Icon name="plus" /> Add role</button>}
            </div>

            <OrgCanvas data={data} view={view} selectedId={selectedId} onSelect={setSelectedId} search={search} showDeleted={showDeleted} actions={actions}
              onAddChild={(parentId) => setModal({ kind: 'role', parentId })} onRestore={(id) => void restore(id)} fitSignal={fitSignal} focusSignal={focusSignal} />

            <Inspector data={data} selectedId={selectedId} actions={actions} onSelect={setSelectedId}
              onEdit={(role) => setModal({ kind: 'role', role })} onAddChild={(parentId) => setModal({ kind: 'role', parentId })}
              onDelete={(role) => setModal({ kind: 'delete', role })} onRestore={(id) => void restore(id)} />

            {!selectedId && activeRoles.length > 0 && <Legend canManage={canManage} view={view} />}

            {activeRoles.length === 0 && view === 'roles' && !showDeleted && (
              <div className="org-empty"><div className="card"><div className="card-body">
                <EmptyState icon="org" title="No roles yet" text={canManage ? 'Build your chart from a ready-made template, or add roles one at a time. You can change everything later.' : 'The organization chart has not been set up yet.'}
                  action={canManage ? <div className="row" style={{ justifyContent: 'center', flexWrap: 'wrap' }}>
                    <button className="btn btn-primary" disabled={busy} onClick={() => void applyTemplate()}>{busy && <span className="spinner" />}Use the software-company template</button>
                    <button className="btn btn-ghost" onClick={() => setModal({ kind: 'role' })}><Icon name="plus" /> Add a role</button>
                  </div> : undefined} />
              </div></div></div>
            )}
          </div>

        </div>
      ) : (
        <RolesTable data={data} onAdd={(parentId) => setModal({ kind: 'role', parentId })} onEdit={(role) => setModal({ kind: 'role', role })}
          onDelete={(role) => setModal({ kind: 'delete', role })} onRestore={(id) => void restore(id)} onTemplate={() => void applyTemplate()} busy={busy} />
      )}

      {modal?.kind === 'role' && <RoleModal role={modal.role} parentId={modal.parentId} roles={data.roles} onClose={() => setModal(null)} onSaved={(id) => { setView('roles'); setSelectedId(id); }} />}
      {modal?.kind === 'delete' && <DeleteRoleModal role={modal.role} roles={data.roles} onClose={() => setModal(null)} onDeleted={() => setSelectedId(null)} />}
    </>
  );
}

// ------------------------------------------------------------------ how-to strip (dismissible, remembered)
const LEGEND_KEY = 'pm_org_legend_closed';
function Legend({ canManage, view }: { canManage: boolean; view: OrgView }) {
  const [closed, setClosed] = useState(() => { try { return localStorage.getItem(LEGEND_KEY) === '1'; } catch { return false; } });
  if (closed) return null;
  const tips = !canManage
    ? ['Click a role or person for details.', 'Only organization admins can change the chart.']
    : view === 'roles'
      ? ['Drag from a role’s bottom dot to another role’s top dot to connect them.', 'Click a line to disconnect it.', 'Drag a person from the left onto a role.']
      : ['Drag from a person’s bottom dot to another person’s top dot to set who they report to.', 'Click a line to disconnect it.'];
  return (
    <div className="org-legend" role="note">
      <span className="org-legend-tips">{tips.map((t) => <span key={t}>{t}</span>)}</span>
      <button className="btn-icon" aria-label="Hide tips" title="Hide tips" onClick={() => { setClosed(true); try { localStorage.setItem(LEGEND_KEY, '1'); } catch { /* ignore */ } }}><Icon name="close" size={14} /></button>
    </div>
  );
}

// ------------------------------------------------------------------ roles table (edit / soft delete / restore)
function RolesTable({ data, onAdd, onEdit, onDelete, onRestore, onTemplate, busy }: {
  data: NonNullable<ReturnType<typeof useOrg>['data']>; onAdd: (parentId?: string | null) => void; onEdit: (r: OrgRole) => void;
  onDelete: (r: OrgRole) => void; onRestore: (id: string) => void; onTemplate: () => void; busy: boolean;
}) {
  const [status, setStatus] = useState<'' | 'active' | 'deleted'>('');
  const [term, setTerm] = useState('');
  const canManage = data.canManage;
  const names = useMemo(() => new Map(data.roles.map((r) => [r.id, r.name])), [data.roles]);
  const rows = data.roles.filter((r) => (status === 'active' ? !r.isDeleted : status === 'deleted' ? r.isDeleted : true)
    && (!term || r.name.toLowerCase().includes(term.toLowerCase())));

  return (
    <div className="card">
      <div className="toolbar">
        <div className="search-field"><Icon name="search" /><input className="input" placeholder="Search roles…" value={term} onChange={(e) => setTerm(e.target.value)} aria-label="Search roles" /></div>
        <Select className="select filter-input" value={status} onChange={(e) => setStatus(e.target.value as typeof status)} aria-label="Status">
          <option value="">Active and deleted</option><option value="active">Active</option><option value="deleted">Deleted</option>
        </Select>
        <div className="toolbar-spacer" />
        {canManage && <button className="btn btn-primary btn-sm" onClick={() => onAdd()}><Icon name="plus" /> Add role</button>}
      </div>
      {data.roles.length === 0
        ? <div className="card-body"><EmptyState icon="org" title="No roles yet" text="Add your first role, or start from the software-company template."
            action={canManage ? <div className="row" style={{ justifyContent: 'center' }}><button className="btn btn-primary" disabled={busy} onClick={onTemplate}>Use the template</button><button className="btn btn-ghost" onClick={() => onAdd()}><Icon name="plus" /> Add a role</button></div> : undefined} /></div>
        : <div className="table-wrap"><table>
            <thead><tr><th>Role</th><th>Reports to</th><th>People</th><th>Sub-roles</th><th>Status</th><th style={{ textAlign: 'right' }}>Actions</th></tr></thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={6} className="cell-muted" style={{ textAlign: 'center', padding: 26 }}>No roles match.</td></tr>}
              {rows.map((r) => (
                <tr key={r.id} className={r.isDeleted ? 'row-deleted' : ''}>
                  <td><div className="row" style={{ gap: 10 }}><span className="org-dot big" style={{ '--node': r.color } as React.CSSProperties} />
                    <div><div className="td-title">{r.name}</div><div className="td-sub">{r.isDeleted ? `Deleted ${formatDate(r.deletedAt)}` : (r.description || '—')}</div></div></div></td>
                  <td className="cell-muted">{r.parentRoleId ? names.get(r.parentRoleId) ?? '—' : 'Top level'}</td>
                  <td>{r.peopleCount}</td>
                  <td>{r.childCount}</td>
                  <td>{r.isDeleted ? <span className="badge badge-danger">Deleted</span> : <span className="badge badge-success">Active</span>}</td>
                  <td><div className="td-actions">
                    {!canManage ? null : r.isDeleted
                      ? <button className="btn btn-ghost btn-sm" onClick={() => onRestore(r.id)}><Icon name="undo" /> Restore</button>
                      : <>
                          <button className="btn-icon" title="Add a sub-role" aria-label={`Add a sub-role under ${r.name}`} onClick={() => onAdd(r.id)}><Icon name="plus" /></button>
                          <button className="btn-icon" title="Edit" aria-label={`Edit ${r.name}`} onClick={() => onEdit(r)}><Icon name="edit" /></button>
                          <button className="btn-icon danger" title="Delete" aria-label={`Delete ${r.name}`} onClick={() => onDelete(r)}><Icon name="trash" /></button>
                        </>}
                  </div></td>
                </tr>
              ))}
            </tbody>
          </table></div>}
    </div>
  );
}
