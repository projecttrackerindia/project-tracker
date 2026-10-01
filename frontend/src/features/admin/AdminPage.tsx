import { BillingTab, GoLiveNotice, HealthTab, SettingsTab, UsageTab } from './PlatformTabs';
import { useState } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { adminApi } from '../../api/endpoints';
import type { AdminPlan, AdminUser, SubscriptionStatus } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Badge, EmptyState, ErrorState, Field, Modal, PageHead, PageLoader, Pager, RoleBadge, StatCard, SubmitButton } from '../../components/ui';
import { FEATURE_LABELS, currencySymbol, formatDate, formatMoney, limitLabel, timeAgo } from '../../lib/format';
import { invalidateWorkspace, useDebounced, useWsQuery } from '../../lib/hooks';
import { useAuth, useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
import { AuditPage } from '../activity/ActivityPages';
import { Select } from '../../components/Select';

type Tab = 'overview' | 'tenants' | 'users' | 'billing' | 'usage' | 'plans' | 'health' | 'settings' | 'audit';

const TITLES: Record<Tab, { title: string; sub: string }> = {
  overview: { title: 'Platform overview', sub: 'Organizations, users and subscriptions across the product. Customer projects and tasks are never shown here.' },
  tenants: { title: 'Organizations', sub: 'Every workspace on the platform. Create and manage organizations, their owners and their subscriptions.' },
  users: { title: 'Users', sub: 'All accounts on the platform and the workspaces each one belongs to.' },
  plans: { title: 'Plans', sub: 'Prices, limits and feature flags. Changes apply immediately to every organization on the plan.' },
  billing: { title: 'Billing', sub: 'Recurring revenue, collections and trials across all organizations.' },
  usage: { title: 'Usage', sub: 'How much each organization uses (counts only), who is near a plan limit, and plan exceptions.' },
  health: { title: 'System health', sub: 'Database, background workers, queues and traffic. Refreshes every 15 seconds.' },
  settings: { title: 'Platform settings', sub: 'Sign-ups, maintenance mode and the announcement banner.' },
  audit: { title: 'Audit log', sub: 'Security and business events across all organizations.' },
};

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

export function AdminPage() {
  const isAdmin = useAuth((s) => s.ctx?.user.isPlatformAdmin);
  const { tab = 'overview' } = useParams();
  if (!isAdmin) return <Navigate to="/" replace />;
  const t = (['overview', 'tenants', 'users', 'billing', 'usage', 'plans', 'health', 'settings', 'audit'].includes(tab) ? tab : 'overview') as Tab;
  return (
    <>
      <PageHead title={TITLES[t].title} sub={TITLES[t].sub} />
      {t === 'overview' && <Overview />}
      {t === 'tenants' && <Tenants />}
      {t === 'users' && <Users />}
      {t === 'billing' && <BillingTab />}
      {t === 'usage' && <UsageTab />}
      {t === 'plans' && <Plans />}
      {t === 'health' && <HealthTab />}
      {t === 'settings' && <SettingsTab />}
      {t === 'audit' && <AuditPage admin />}
    </>
  );
}

// ------------------------------------------------------------------ overview
function Overview() {
  const q = useWsQuery(['admin', 'stats'], adminApi.stats);
  if (q.isLoading) return <PageLoader />;
  if (q.isError || !q.data) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const s = q.data;
  return (
    <>
      <GoLiveNotice />
      <div className="stat-grid">
        <StatCard icon="users" tone="blue" value={s.users} label="Users" foot={`${s.activeUsers} active`} />
        <StatCard icon="building" tone="purple" value={s.organizations} label="Organizations" foot={`${s.personalWorkspaces} personal workspaces`} />
        <StatCard icon="monitor" tone="green" value={s.activeSessions} label="Active sessions" />
        <StatCard icon="alert" tone="amber" value={s.suspendedTenants} label="Suspended workspaces" />
        <StatCard icon="trash" tone="red" value={s.deletedTenants} label="Deleted organizations" foot="Retained — can be restored" />
      </div>
      <div className="card"><div className="card-head"><h3>Subscriptions by plan</h3></div><div className="card-body">
        <div className="grid-3">{s.subscriptions.map((p) => <StatCard key={p.planCode} value={p.count} label={p.planCode} />)}</div>
      </div></div>
    </>
  );
}

// ------------------------------------------------------------------ organizations
type TenantDialog =
  | { kind: 'create' }
  | { kind: 'view' | 'edit' | 'subscription'; id: string }
  | null;

interface TenantRef { id: string; name: string }

function Tenants() {
  const wid = useWorkspaceId();
  const [q, setQ] = useState('');
  const [type, setType] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [dialog, setDialog] = useState<TenantDialog>(null);
  const dq = useDebounced(q, 300);
  const list = useWsQuery(['admin', 'tenants', dq, page, type, status], () => adminApi.tenants(dq || undefined, page, type || undefined, status || undefined), { placeholderData: (p) => p });
  const refresh = () => invalidateWorkspace(wid, 'admin');

  const toggle = async (t: TenantRef & { status: 'Active' | 'Suspended' }) => {
    const suspend = t.status === 'Active';
    if (!(await confirmDialog({
      title: suspend ? 'Suspend workspace?' : 'Reactivate workspace?', confirmText: suspend ? 'Suspend' : 'Reactivate', danger: suspend,
      message: suspend ? `Members of “${t.name}” will lose access immediately. You can reactivate it at any time.` : `Restore access for “${t.name}”.`,
    }))) return;
    try { await adminApi.setTenantStatus(t.id, suspend ? 'Suspended' : 'Active'); toast('Workspace updated.'); refresh(); }
    catch (e) { toast(errText(e, 'Could not update the workspace.'), 'error'); }
  };

  /** Soft delete: reversible, nothing is erased. */
  const remove = async (t: TenantRef) => {
    if (!(await confirmDialog({
      title: 'Delete organization?', confirmText: 'Delete', danger: true,
      message: `Members of “${t.name}” lose access immediately. Nothing is erased: the organization stays in this list (faded) and you can restore it, with all of its data, at any time.`,
    }))) return;
    try { await adminApi.deleteTenant(t.id); toast(`“${t.name}” was deleted. You can restore it from this list.`, 'warning'); setDialog(null); await refresh(); }
    catch (e) { toast(errText(e, 'Could not delete the organization.'), 'error'); }
  };

  const restore = async (t: TenantRef) => {
    try { await adminApi.restoreTenant(t.id); toast(`“${t.name}” was restored.`); await refresh(); }
    catch (e) { toast(errText(e, 'Could not restore the organization.'), 'error'); }
  };

  return (
    <div className="card">
      <div className="toolbar">
        <div className="search-field"><Icon name="search" /><input className="input" placeholder="Search name or owner…" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} aria-label="Search organizations" /></div>
        <Select className="select filter-input" value={type} onChange={(e) => { setType(e.target.value); setPage(1); }} aria-label="Workspace type">
          <option value="">All workspaces</option><option value="Organization">Organizations</option><option value="Personal">Personal workspaces</option>
        </Select>
        <Select className="select filter-input" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} aria-label="Status">
          <option value="">Any status</option><option value="Active">Active</option><option value="Suspended">Suspended</option><option value="Deleted">Deleted</option>
        </Select>
        <div className="toolbar-spacer" />
        <button className="btn btn-primary" onClick={() => setDialog({ kind: 'create' })}><Icon name="plus" /> New organization</button>
      </div>

      {list.isLoading ? <PageLoader /> : list.isError || !list.data ? <ErrorState error={list.error} retry={() => list.refetch()} />
        : list.data.items.length === 0 ? <div className="card-body"><EmptyState icon="building" title="No workspaces found" text="Try a different search or filter, or create an organization." /></div> : (
        <div className="table-wrap"><table>
          <thead><tr><th>Workspace</th><th>Type</th><th>Owner</th><th>Plan</th><th>Members</th><th>Status</th><th>Created</th><th style={{ textAlign: 'right' }}>Actions</th></tr></thead>
          <tbody>{list.data.items.map((t) => (
            <tr key={t.id} className={`clickable ${t.isDeleted ? 'row-deleted' : ''}`} onClick={() => setDialog({ kind: 'view', id: t.id })}>
              <td><div className="td-title">{t.name}</div><div className="td-sub">{t.isDeleted ? `Deleted ${formatDate(t.deletedAt)}` : t.slug}</div></td>
              <td className="cell-muted">{t.type}</td><td className="cell-muted">{t.ownerEmail ?? '—'}</td>
              <td><Badge tone="purple">{t.planCode}</Badge> <span className="muted" style={{ fontSize: 11 }}>{t.subscriptionStatus}</span></td>
              <td>{t.memberCount}</td>
              <td>{t.isDeleted ? <Badge tone="danger">Deleted</Badge> : <Badge tone={t.status === 'Active' ? 'success' : 'warning'}>{t.status}</Badge>}</td>
              <td className="cell-muted">{formatDate(t.createdAt)}</td>
              <td onClick={(e) => e.stopPropagation()}>
                <div className="td-actions">
                  <button className="btn-icon" title="View details" aria-label={`View ${t.name}`} onClick={() => setDialog({ kind: 'view', id: t.id })}><Icon name="search" /></button>
                  {t.isDeleted ? (
                    <button className="btn btn-ghost btn-sm" onClick={() => restore(t)}><Icon name="refresh" /> Restore</button>
                  ) : (<>
                    <button className="btn-icon" title="Edit" aria-label={`Edit ${t.name}`} onClick={() => setDialog({ kind: 'edit', id: t.id })}><Icon name="edit" /></button>
                    <button className="btn-icon" title={t.status === 'Active' ? 'Suspend' : 'Reactivate'} aria-label={t.status === 'Active' ? `Suspend ${t.name}` : `Reactivate ${t.name}`} onClick={() => toggle(t)}><Icon name={t.status === 'Active' ? 'lock' : 'refresh'} /></button>
                    {t.type === 'Organization' && <button className="btn-icon danger" title="Delete (can be restored)" aria-label={`Delete ${t.name}`} onClick={() => remove(t)}><Icon name="trash" /></button>}
                  </>)}
                </div>
              </td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {list.data && <Pager page={list.data.page} totalPages={list.data.totalPages} totalItems={list.data.totalItems} onPage={setPage} />}

      {dialog?.kind === 'create' && <TenantFormModal onClose={() => setDialog(null)} onSaved={(id) => setDialog({ kind: 'view', id })} />}
      {dialog?.kind === 'view' && <TenantDetailModal id={dialog.id} onClose={() => setDialog(null)} onAction={(kind) => setDialog({ kind, id: dialog.id })} onToggle={toggle} onDelete={remove} onRestore={restore} />}
      {dialog?.kind === 'edit' && <TenantFormModal id={dialog.id} onClose={() => setDialog(null)} onSaved={(id) => setDialog({ kind: 'view', id })} />}
      {dialog?.kind === 'subscription' && <SubscriptionModal id={dialog.id} onClose={() => setDialog({ kind: 'view', id: dialog.id })} />}
    </div>
  );
}

function TenantDetailModal({ id, onClose, onAction, onToggle, onDelete, onRestore }: {
  id: string; onClose: () => void; onAction: (kind: 'edit' | 'subscription') => void;
  onToggle: (t: TenantRef & { status: 'Active' | 'Suspended' }) => void; onDelete: (t: TenantRef) => void; onRestore: (t: TenantRef) => Promise<void>;
}) {
  const q = useWsQuery(['admin', 'tenant', id], () => adminApi.tenant(id));
  if (q.isLoading) return <Modal title="Organization" onClose={onClose}><PageLoader /></Modal>;
  if (q.isError || !q.data) return <Modal title="Organization" onClose={onClose}><ErrorState error={q.error} /></Modal>;
  const d = q.data;
  const t = d.tenant;
  const limitOf = (k: string) => limitLabel(d.limits[k] ?? 0);
  const org = t.type === 'Organization';

  return (
    <Modal size="xl" title={t.name} subtitle={`${org ? 'Organization' : 'Personal workspace'} · ${t.slug}`} onClose={onClose}
      footer={t.isDeleted
        ? <><button className="btn btn-ghost" onClick={onClose}>Close</button><button className="btn btn-primary" onClick={() => onRestore(t)}><Icon name="refresh" /> Restore organization</button></>
        : <>
          {org && <button className="btn btn-danger" style={{ marginRight: 'auto' }} onClick={() => onDelete(t)}><Icon name="trash" /> Delete</button>}
          <button className="btn btn-ghost" onClick={() => onToggle(t)}>{t.status === 'Active' ? 'Suspend' : 'Reactivate'}</button>
          <button className="btn btn-ghost" onClick={() => onAction('subscription')}><Icon name="card" /> Subscription</button>
          <button className="btn btn-primary" onClick={() => onAction('edit')}><Icon name="edit" /> Edit</button>
        </>}>
      {t.isDeleted && (
        <div className="form-warn">
          <b>Deleted on {formatDate(t.deletedAt)}.</b> Its members cannot open it, but nothing was erased — restore it to give everyone their access and data back exactly as it was.
        </div>
      )}
      <div className="dh-grid" style={{ borderTop: 0, paddingTop: 0, marginBottom: 20 }}>
        <div className="dh-cell"><label>Status</label>{t.isDeleted ? <Badge tone="danger">Deleted</Badge> : <Badge tone={t.status === 'Active' ? 'success' : 'warning'}>{t.status}</Badge>}</div>
        <div className="dh-cell"><label>Plan</label><Badge tone="purple">{t.planCode}</Badge> <span className="muted" style={{ fontSize: 12 }}>{t.subscriptionStatus}</span></div>
        <div className="dh-cell"><label>Renews / ends</label><b>{t.periodEnd ? formatDate(t.periodEnd) : '—'}</b></div>
        <div className="dh-cell"><label>Owner</label><b style={{ wordBreak: 'break-all' }}>{t.ownerEmail ?? '—'}</b></div>
        <div className="dh-cell"><label>Created</label><b>{formatDate(t.createdAt)}</b></div>
      </div>
      {d.description && <p className="text-2" style={{ fontSize: 13, marginBottom: 18 }}>{d.description}</p>}

      <h4 style={{ fontSize: 13.5, marginBottom: 10 }}>Usage <span className="muted" style={{ fontWeight: 500 }}>· counts against the plan limits</span></h4>
      <div className="pc-stats" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginBottom: 22 }}>
        <div className="pc-stat"><b>{d.usage.projects}<span className="muted" style={{ fontSize: 12 }}> / {limitOf('PROJECT_LIMIT')}</span></b><span>Projects</span></div>
        <div className="pc-stat"><b>{d.usage.tasks}<span className="muted" style={{ fontSize: 12 }}> / {limitOf('TASK_LIMIT')}</span></b><span>Tasks</span></div>
        <div className="pc-stat"><b>{d.usage.teams}<span className="muted" style={{ fontSize: 12 }}> / {limitOf('MAX_TEAMS')}</span></b><span>Teams</span></div>
        <div className="pc-stat"><b>{d.usage.members}<span className="muted" style={{ fontSize: 12 }}> / {limitOf('MAX_MEMBERS')}</span></b><span>Members{d.usage.pendingInvitations ? ` (+${d.usage.pendingInvitations} invited)` : ''}</span></div>
      </div>

      <h4 style={{ fontSize: 13.5, marginBottom: 10 }}>Members</h4>
      <div className="card" style={{ boxShadow: 'none' }}><div className="table-wrap"><table style={{ minWidth: 480 }}>
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Joined</th></tr></thead>
        <tbody>{d.members.map((m) => (
          <tr key={m.userId}><td className="td-title">{m.displayName}{m.userId === d.ownerUserId && <span className="muted" style={{ fontWeight: 500 }}> · owner</span>}</td><td className="cell-muted">{m.email}</td><td><RoleBadge role={m.role} /></td><td className="cell-muted">{formatDate(m.joinedAt)}</td></tr>
        ))}</tbody>
      </table></div></div>
      <p className="muted" style={{ fontSize: 12, marginTop: 14 }}>Platform administrators can see who belongs to an organization and how much it uses, but never its projects, tasks or comments.</p>
    </Modal>
  );
}

function TenantFormModal({ id, onClose, onSaved }: { id?: string; onClose: () => void; onSaved: (id: string) => void }) {
  const wid = useWorkspaceId();
  const editing = !!id;
  const detail = useWsQuery(['admin', 'tenant', id], () => adminApi.tenant(id!), { enabled: editing });
  const plans = useWsQuery(['admin', 'plans'], adminApi.plans, { enabled: !editing });
  const [form, setForm] = useState<{ name: string; description: string; ownerEmail: string; planCode: string; ownerUserId: string } | null>(
    editing ? null : { name: '', description: '', ownerEmail: '', planCode: 'FREE', ownerUserId: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Prime the form once the organization has loaded.
  if (editing && !form && detail.data)
    setForm({ name: detail.data.tenant.name, description: detail.data.description ?? '', ownerEmail: '', planCode: '', ownerUserId: detail.data.ownerUserId });

  if (editing && (detail.isLoading || !form)) return <Modal title="Edit organization" onClose={onClose}>{detail.isError ? <ErrorState error={detail.error} /> : <PageLoader />}</Modal>;
  const f = form!;
  const set = (k: keyof typeof f, v: string) => { setForm({ ...f, [k]: v }); setErrors((e) => ({ ...e, [k]: '' })); };
  const isOrg = !editing || detail.data?.tenant.type === 'Organization';

  const submit = async () => {
    const er: Record<string, string> = {};
    if (f.name.trim().length < 2) er.name = 'Enter a name (at least 2 characters).';
    if (!editing && !/^\S+@\S+\.\S+$/.test(f.ownerEmail.trim())) er.ownerEmail = "Enter the owner's email address.";
    setErrors(er); setFormError(null);
    if (Object.keys(er).length) return;
    setBusy(true);
    try {
      const res = editing
        ? await adminApi.updateTenant(id!, { name: f.name.trim(), description: f.description.trim() || null, ownerUserId: isOrg ? f.ownerUserId : null })
        : await adminApi.createTenant({ name: f.name.trim(), description: f.description.trim() || undefined, ownerEmail: f.ownerEmail.trim(), planCode: f.planCode });
      toast(editing ? 'Organization updated.' : 'Organization created.');
      await invalidateWorkspace(wid, 'admin');
      onSaved(res.tenant.id);
    } catch (e) {
      if (e instanceof ApiError) {
        const fe: Record<string, string> = {};
        e.errors.forEach((x) => { if (x.field) fe[x.field] = x.message; });
        setErrors(fe);
        if (!Object.keys(fe).length) setFormError(e.message);
      } else setFormError('Could not save the organization.');
    } finally { setBusy(false); }
  };

  return (
    <Modal size="lg" title={editing ? 'Edit organization' : 'New organization'} onClose={onClose}
      subtitle={editing ? 'Rename it, update the description or hand ownership to another member.' : 'Create an organization for an existing user, who becomes its Owner.'}
      onSubmit={(e) => { e.preventDefault(); void submit(); }}
      footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><SubmitButton busy={busy}>{editing ? 'Save changes' : 'Create organization'}</SubmitButton></>}>
      {formError && <div className="form-error" role="alert">{formError}</div>}
      <div className="form-grid">
        <Field label="Name" required error={errors.name}><input className="input" value={f.name} onChange={(e) => set('name', e.target.value)} maxLength={80} placeholder="e.g. Acme Corp" /></Field>
        {editing
          ? (isOrg && (
            <Field label="Owner" error={errors.ownerUserId} hint="The current owner stays on as Admin.">
              <Select className="select" value={f.ownerUserId} onChange={(e) => set('ownerUserId', e.target.value)}>
                {detail.data?.members.map((m) => <option key={m.userId} value={m.userId}>{m.displayName} ({m.email})</option>)}
              </Select>
            </Field>))
          : <Field label="Owner email" required error={errors.ownerEmail} hint="Must be an existing, active user."><input className="input" type="email" value={f.ownerEmail} onChange={(e) => set('ownerEmail', e.target.value)} placeholder="owner@company.com" /></Field>}
        <Field label="Description" full><textarea className="textarea" value={f.description} onChange={(e) => set('description', e.target.value)} maxLength={500} /></Field>
        {!editing && (
          <Field label="Plan" error={errors.planCode} hint="Assigned by an administrator: active with no renewal date and no charge. Change it later under Subscription.">
            <Select className="select" value={f.planCode} onChange={(e) => set('planCode', e.target.value)}>
              {(plans.data?.filter((p) => p.isActive) ?? [{ code: 'FREE', name: 'Free' }]).map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}
            </Select>
          </Field>
        )}
      </div>
    </Modal>
  );
}

function SubscriptionModal({ id, onClose }: { id: string; onClose: () => void }) {
  const wid = useWorkspaceId();
  const q = useWsQuery(['admin', 'tenant', id], () => adminApi.tenant(id));
  const [plan, setPlan] = useState<string | null>(null);
  const [status, setStatus] = useState<SubscriptionStatus | null>(null);
  const [end, setEnd] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!q.data) return <Modal size="sm" title="Override subscription" onClose={onClose}><PageLoader /></Modal>;
  const t = q.data.tenant;
  const cur = { plan: plan ?? t.planCode, status: status ?? t.subscriptionStatus, end: end ?? t.periodEnd?.slice(0, 10) ?? '' };

  return (
    <Modal size="sm" title="Override subscription" subtitle={t.name} onClose={onClose}
      onSubmit={async (e) => {
        e.preventDefault(); setBusy(true); setError(null);
        try { await adminApi.setTenantSubscription(id, { planCode: cur.plan, status: cur.status, periodEnd: cur.end ? `${cur.end}T00:00:00Z` : null }); toast('Subscription updated.'); await invalidateWorkspace(wid, 'admin'); onClose(); }
        catch (err) { setError(errText(err, 'Could not update.')); } finally { setBusy(false); }
      }}
      footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><SubmitButton busy={busy}>Save</SubmitButton></>}>
      {error && <div className="form-error">{error}</div>}
      <div className="form-grid" style={{ gridTemplateColumns: '1fr' }}>
        <Field label="Plan"><Select className="select" value={cur.plan} onChange={(e) => setPlan(e.target.value)}>{['FREE', 'PRO', 'BUSINESS', 'ENTERPRISE'].map((p) => <option key={p}>{p}</option>)}</Select></Field>
        <Field label="Status"><Select className="select" value={cur.status} onChange={(e) => setStatus(e.target.value as SubscriptionStatus)}>{['Trial', 'Active', 'PastDue', 'Cancelled', 'Expired'].map((s) => <option key={s}>{s}</option>)}</Select></Field>
        <Field label="Period end" hint="Leave empty for no end date (e.g. Free or account-managed)."><input className="input" type="date" value={cur.end} onChange={(e) => setEnd(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ users
function Users() {
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);
  const dq = useDebounced(q, 300);
  const list = useWsQuery(['admin', 'users', dq, page], () => adminApi.users(dq || undefined, page), { placeholderData: (p) => p });

  return (
    <div className="card">
      <div className="toolbar"><div className="search-field"><Icon name="search" /><input className="input" placeholder="Search name or email…" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} aria-label="Search users" /></div></div>
      {list.isLoading ? <PageLoader /> : list.isError || !list.data ? <ErrorState error={list.error} retry={() => list.refetch()} /> : (
        <div className="table-wrap"><table>
          <thead><tr><th>User</th><th>Workspaces</th><th>Status</th><th>Last sign-in</th><th>Joined</th><th style={{ textAlign: 'right' }}>Actions</th></tr></thead>
          <tbody>{list.data.items.map((u) => (
            <tr key={u.id} className="clickable" onClick={() => setOpen(u.id)}>
              <td><div className="td-title">{u.displayName} {u.isPlatformAdmin && <Badge tone="purple">Platform admin</Badge>}</div><div className="td-sub">{u.email}{!u.emailVerified && ' · unverified'}</div></td>
              <td><MembershipChips user={u} /></td>
              <td><Badge tone={u.isActive ? 'success' : 'danger'}>{u.isActive ? 'Active' : 'Disabled'}</Badge></td>
              <td className="cell-muted">{u.lastLoginAt ? timeAgo(u.lastLoginAt) : 'Never'}</td>
              <td className="cell-muted">{formatDate(u.createdAt)}</td>
              <td onClick={(e) => e.stopPropagation()}><div className="td-actions"><button className="btn btn-ghost btn-sm" onClick={() => setOpen(u.id)}>Details</button></div></td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {list.data && <Pager page={list.data.page} totalPages={list.data.totalPages} totalItems={list.data.totalItems} onPage={setPage} />}
      {open && <UserDetailModal id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

/** Where a user belongs: organizations (with role) first, then their personal workspace. */
function MembershipChips({ user }: { user: AdminUser }) {
  const shown = user.memberships.slice(0, 3);
  return (
    <div className="task-meta" style={{ gap: 5 }}>
      {shown.map((m) => (
        <span key={m.tenantId} className="chip" title={`${m.tenantName} · ${m.role} · ${m.planCode}${m.isDeleted ? ' · deleted' : ''}`} style={{ fontSize: 11.5, padding: '2px 8px', opacity: m.isDeleted ? 0.5 : 1 }}>
          <Icon name={m.type === 'Organization' ? 'building' : 'user'} size={11} />
          {m.type === 'Organization' ? `${m.tenantName} · ${m.role}` : 'Personal'}{m.isDeleted && ' (deleted)'}
        </span>
      ))}
      {user.memberships.length > shown.length && <span className="muted" style={{ fontSize: 11.5 }}>+{user.memberships.length - shown.length} more</span>}
      {user.memberships.length === 0 && <span className="muted" style={{ fontSize: 12 }}>None</span>}
    </div>
  );
}

function UserDetailModal({ id, onClose }: { id: string; onClose: () => void }) {
  const wid = useWorkspaceId();
  const me = useAuth((s) => s.ctx!.user.id);
  const q = useWsQuery(['admin', 'user', id], () => adminApi.user(id));
  const refresh = () => invalidateWorkspace(wid, 'admin');
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try { await fn(); toast(ok); await refresh(); } catch (e) { toast(errText(e, 'Action failed.'), 'error'); }
  };

  if (q.isLoading) return <Modal title="User" onClose={onClose}><PageLoader /></Modal>;
  if (q.isError || !q.data) return <Modal title="User" onClose={onClose}><ErrorState error={q.error} /></Modal>;
  const { user: u, activeSessions } = q.data;
  const self = u.id === me;

  return (
    <Modal size="lg" title={u.displayName} subtitle={u.email} onClose={onClose}
      footer={self ? <button className="btn btn-ghost" onClick={onClose}>Close</button> : <>
        <button className="btn btn-ghost" style={{ marginRight: 'auto' }} disabled={activeSessions === 0} onClick={async () => {
          if (await confirmDialog({ title: 'Sign out everywhere?', confirmText: 'Sign out', message: `${u.displayName} will be signed out of ${activeSessions} active session${activeSessions === 1 ? '' : 's'}. They can sign in again.` }))
            await act(() => adminApi.signOutUser(u.id), 'User signed out.');
        }}><Icon name="logout" /> Sign out everywhere</button>
        <button className="btn btn-ghost" onClick={() => act(() => adminApi.setPlatformAdmin(u.id, !u.isPlatformAdmin), 'Updated.')}>{u.isPlatformAdmin ? 'Revoke platform admin' : 'Make platform admin'}</button>
        <button className={`btn ${u.isActive ? 'btn-danger' : 'btn-primary'}`} onClick={async () => {
          if (u.isActive && !(await confirmDialog({ title: 'Disable account?', confirmText: 'Disable', message: `${u.displayName} will be signed out and unable to sign in until re-enabled.` }))) return;
          await act(() => adminApi.setUserStatus(u.id, !u.isActive), u.isActive ? 'User disabled.' : 'User enabled.');
        }}>{u.isActive ? 'Disable account' : 'Enable account'}</button>
      </>}>
      <div className="dh-grid" style={{ borderTop: 0, paddingTop: 0, marginBottom: 20 }}>
        <div className="dh-cell"><label>Status</label><Badge tone={u.isActive ? 'success' : 'danger'}>{u.isActive ? 'Active' : 'Disabled'}</Badge> {u.isPlatformAdmin && <Badge tone="purple">Platform admin</Badge>}</div>
        <div className="dh-cell"><label>Email</label><b>{u.emailVerified ? 'Verified' : 'Not verified'}</b></div>
        <div className="dh-cell"><label>Active sessions</label><b>{activeSessions}</b></div>
        <div className="dh-cell"><label>Last sign-in</label><b>{u.lastLoginAt ? timeAgo(u.lastLoginAt) : 'Never'}</b></div>
        <div className="dh-cell"><label>Joined</label><b>{formatDate(u.createdAt)}</b></div>
      </div>

      <h4 style={{ fontSize: 13.5, marginBottom: 10 }}>Workspaces <span className="muted" style={{ fontWeight: 500 }}>· {u.memberships.filter((m) => !m.isDeleted).length}{u.memberships.some((m) => m.isDeleted) ? ` (+${u.memberships.filter((m) => m.isDeleted).length} deleted)` : ''}</span></h4>
      {u.memberships.length === 0 ? <p className="muted" style={{ fontSize: 13 }}>This user does not belong to any workspace.</p> : (
        <div className="card" style={{ boxShadow: 'none' }}><div className="table-wrap"><table style={{ minWidth: 480 }}>
          <thead><tr><th>Workspace</th><th>Type</th><th>Role</th><th>Plan</th><th>Joined</th></tr></thead>
          <tbody>{u.memberships.map((m) => (
            <tr key={m.tenantId} className={m.isDeleted ? 'row-deleted' : ''}>
              <td className="td-title">{m.tenantName} {m.isDeleted && <Badge tone="danger">Deleted</Badge>}</td>
              <td className="cell-muted"><span className="row" style={{ gap: 6 }}><Icon name={m.type === 'Organization' ? 'building' : 'user'} size={13} />{m.type === 'Organization' ? 'Organization' : 'Personal'}</span></td>
              <td><RoleBadge role={m.role} /></td><td><Badge tone="purple">{m.planCode}</Badge></td><td className="cell-muted">{formatDate(m.joinedAt)}</td>
            </tr>
          ))}</tbody>
        </table></div></div>
      )}
      {self && <p className="muted" style={{ fontSize: 12, marginTop: 14 }}>This is your own account, so account actions are hidden.</p>}
    </Modal>
  );
}

// ------------------------------------------------------------------ plans
function Plans() {
  const q = useWsQuery(['admin', 'plans'], adminApi.plans);
  const [edit, setEdit] = useState<AdminPlan | null>(null);
  if (q.isLoading) return <PageLoader />;
  if (q.isError || !q.data) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  return (
    <>
      <div className="plan-grid">
        {q.data.map((p) => (
          <div className="plan-card" key={p.id}>
            <div className="row" style={{ justifyContent: 'space-between' }}><span className="plan-name">{p.name}</span>{!p.isActive && <Badge tone="warning">Inactive</Badge>}</div>
            <div className="plan-price">{formatMoney(p.priceMonthly, p.currency)}{p.priceMonthly !== null && <small> / month</small>}</div>
            <ul className="plan-features">{Object.entries(p.features).map(([k, v]) => <li key={k}><Icon name="tick" />{FEATURE_LABELS[k] ?? k}: <b>{v === -1 ? 'Unlimited' : v}</b></li>)}</ul>
            <button className="btn btn-ghost" style={{ marginTop: 'auto' }} onClick={() => setEdit(p)}><Icon name="edit" /> Edit plan</button>
          </div>
        ))}
      </div>
      {edit && <PlanModal plan={edit} onClose={() => setEdit(null)} />}
    </>
  );
}

function PlanModal({ plan, onClose }: { plan: AdminPlan; onClose: () => void }) {
  const wid = useWorkspaceId();
  const [name, setName] = useState(plan.name);
  const [description, setDescription] = useState(plan.description ?? '');
  const [price, setPrice] = useState(plan.priceMonthly?.toString() ?? '');
  const [active, setActive] = useState(plan.isActive);
  const [features, setFeatures] = useState<Record<string, number>>(plan.features);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const flags = ['ADVANCED_REPORTS', 'CUSTOM_WORKFLOWS', 'ADVANCED_PERMISSIONS', 'AUDIT_LOG', 'ADVANCED_SECURITY', 'RESOURCE_MANAGEMENT', 'SERVICE_LEVELS'];
  return (
    <Modal size="lg" title={`Edit ${plan.code} plan`} subtitle="Limits are enforced immediately for every organization on this plan. Use -1 for unlimited." onClose={onClose}
      onSubmit={async (e) => {
        e.preventDefault(); setBusy(true); setError(null);
        try { await adminApi.updatePlan(plan.id, { name, description: description || null, priceMonthly: price === '' ? null : Number(price), isActive: active, features }); toast('Plan updated.'); await invalidateWorkspace(wid, 'admin'); onClose(); }
        catch (err) { setError(errText(err, 'Could not update the plan.')); } finally { setBusy(false); }
      }}
      footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><SubmitButton busy={busy}>Save plan</SubmitButton></>}>
      {error && <div className="form-error">{error}</div>}
      <div className="form-grid">
        <Field label="Name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label={`Monthly price (${currencySymbol(plan.currency)} ${plan.currency})`} hint="Leave empty for custom pricing (“Contact sales”). The currency is set under Platform settings.">
          <input className="input" type="number" min="0" step="0.01" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="Custom" />
        </Field>
        <Field label="Description" full><input className="input" value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
        {Object.keys(features).filter((k) => !flags.includes(k)).map((k) => (
          <Field key={k} label={FEATURE_LABELS[k] ?? k}><input className="input" type="number" min="-1" value={features[k]} onChange={(e) => setFeatures((f) => ({ ...f, [k]: Number(e.target.value) }))} /></Field>
        ))}
        <Field label="Feature flags" full>
          <div className="row wrap" style={{ gap: 18 }}>{flags.map((k) => (
            <label key={k} className="row" style={{ gap: 6, fontSize: 13 }}><input type="checkbox" checked={features[k] === 1} onChange={(e) => setFeatures((f) => ({ ...f, [k]: e.target.checked ? 1 : 0 }))} />{FEATURE_LABELS[k]}</label>
          ))}</div>
        </Field>
        <Field label="Availability" full><label className="row" style={{ gap: 6, fontSize: 13 }}><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} disabled={plan.code === 'FREE'} /> Plan is available for selection</label></Field>
      </div>
    </Modal>
  );
}
