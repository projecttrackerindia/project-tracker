import { Fragment, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { orgApi } from '../../api/endpoints';
import type { AccessSource, EffectiveAccess } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Select } from '../../components/Select';
import { Avatar, Badge, EmptyState, ErrorState, PageHead, PageLoader, RoleBadge, Tabs } from '../../components/ui';
import { PERMISSION_LABELS, labelize } from '../../lib/format';
import { useWsQuery } from '../../lib/hooks';
import { useCan } from '../../stores/auth';
import { AccessLevelMatrix } from '../members/MembersPage';
import { AccessPanel } from './AccessPanel';

const MODULE_LABEL: Record<string, string> = {
  projects: 'Projects', tasks: 'Tasks', work: 'Operations', calendar: 'Calendar', teams: 'Teams', members: 'People', organization: 'Org chart',
  reports: 'Reports', activity: 'Activity', audit: 'Audit log', billing: 'Billing',
};
const LEVEL: Record<number, string> = { 0: 'None', 1: 'View', 2: 'Edit', 3: 'Full' };
const SOURCE: Record<AccessSource, { label: string; tone: 'purple' | 'info' | 'success' | 'neutral'; hint: string }> = {
  Owner: { label: 'Owner', tone: 'purple', hint: 'Owners can do everything, always.' },
  Admin: { label: 'Admin', tone: 'info', hint: 'Admins can do everything; a job role never narrows it.' },
  JobRole: { label: 'Job role', tone: 'success', hint: 'Their job role has its own access settings, and those decide everything for them.' },
  AccessLevel: { label: 'Access level', tone: 'neutral', hint: 'Their access level’s defaults decide (their job role has no access settings of its own).' },
};

type View = 'people' | 'job-roles' | 'levels';

/**
 * Workspace settings → Roles & access: the one place that decides what people can do. Two rules, applied in order, and a table that
 * shows the result for every person and which rule produced it.
 */
export function RolesAccessPage() {
  const [params, setParams] = useSearchParams();
  const canAccess = useCan('access.manage');
  const canLevels = useCan('org.manage');
  const canPermissions = useCan('permissions.manage');
  const canSeeEffective = canAccess || canPermissions;
  const views = [
    ...(canSeeEffective ? [{ id: 'people' as View, label: 'Who can do what', icon: 'users' as const }] : []),
    ...(canAccess ? [{ id: 'job-roles' as View, label: 'Job roles', icon: 'org' as const }] : []),
    ...(canLevels ? [{ id: 'levels' as View, label: 'Access levels', icon: 'shield' as const }] : []),
  ];
  const wanted = params.get('view') as View | null;
  const view = views.find((v) => v.id === wanted)?.id ?? views[0]?.id;
  const setView = (v: View) => { const n = new URLSearchParams(params); n.set('view', v); setParams(n, { replace: true }); };

  return (
    <>
      <PageHead title="Roles & access" sub="What people can see and do in this workspace, and why." />
      <div className="explainer" role="note">
        <Icon name="info" size={16} />
        <div>
          Two settings decide what someone can do. They are applied in this order:
          <ol>
            <li><b>Owners and Admins</b> can always do everything.</li>
            <li>For anyone else, if their <b>job role</b> (their place on the org chart) has its own access settings, those decide everything for them.</li>
            <li>Otherwise the defaults of their <b>access level</b> (Manager, Member or Guest) apply.</li>
          </ol>
        </div>
      </div>
      {views.length > 1 && <div style={{ marginBottom: 16 }}><Tabs value={view!} onChange={setView} tabs={views} /></div>}
      {view === 'people' && <EffectiveAccessTable />}
      {view === 'job-roles' && <AccessPanel />}
      {view === 'levels' && <AccessLevelMatrix />}
    </>
  );
}

/** Every person, what they can open in each area, and which rule decided it. A row opens to list their individual permissions. */
function EffectiveAccessTable() {
  const q = useWsQuery(['org', 'access', 'effective'], orgApi.effectiveAccess);
  const [term, setTerm] = useState('');
  const [source, setSource] = useState<'' | AccessSource>('');
  const [open, setOpen] = useState<string | null>(null);
  const modules = useMemo(() => {
    const keys = new Set<string>();
    for (const p of q.data?.people ?? []) Object.keys(p.modules).forEach((k) => keys.add(k));
    const order = Object.keys(MODULE_LABEL);
    return [...keys].sort((a, b) => (order.indexOf(a) + 100 * +(order.indexOf(a) < 0)) - (order.indexOf(b) + 100 * +(order.indexOf(b) < 0)));
  }, [q.data]);

  if (q.isLoading) return <PageLoader />;
  if (q.isError || !q.data) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const d = q.data;
  const t = term.trim().toLowerCase();
  const rows = d.people.filter((p) => (!source || p.source === source) && (!t || p.name.toLowerCase().includes(t) || p.email.toLowerCase().includes(t) || (p.jobRole ?? '').toLowerCase().includes(t)));

  return (
    <div className="card">
      <div className="card-head">
        <div><h3>Who can do what</h3><p>{d.byJobRole} decided by their job role · {d.byAccessLevel} by their access level · the rest are Owners and Admins</p></div>
      </div>
      <div className="toolbar">
        <div className="search-field"><Icon name="search" /><input className="input" placeholder="Find a person or job role…" value={term} onChange={(e) => setTerm(e.target.value)} aria-label="Find a person" /></div>
        <Select className="select filter-input" value={source} onChange={(e) => setSource(e.target.value as typeof source)} aria-label="Decided by">
          <option value="">Decided by anything</option>{(Object.keys(SOURCE) as AccessSource[]).map((s) => <option key={s} value={s}>Decided by: {SOURCE[s].label}</option>)}
        </Select>
      </div>
      {rows.length === 0 ? <div className="card-body"><EmptyState icon="users" title="Nobody matches" /></div> : (
        <div className="table-wrap">
          <table className="matrix" style={{ minWidth: 760 }}>
            <thead>
              <tr><th>Person</th><th>Access level</th><th>Job role</th><th>Decided by</th>{modules.map((m) => <th key={m}>{MODULE_LABEL[m] ?? labelize(m)}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <Fragment key={p.userId}>
                  <tr className="clickable" tabIndex={0} aria-expanded={open === p.userId} onClick={() => setOpen((o) => (o === p.userId ? null : p.userId))}
                    onKeyDown={(e) => { if (e.key === 'Enter') setOpen((o) => (o === p.userId ? null : p.userId)); }}>
                    <td><div className="row"><Avatar name={p.name} /><div><div className="td-title">{p.name}</div><div className="td-sub">{p.email}</div></div></div></td>
                    <td><RoleBadge role={p.accessLevel} /></td>
                    <td className="cell-muted">{p.jobRole ?? '—'}</td>
                    <td><span title={SOURCE[p.source].hint}><Badge tone={SOURCE[p.source].tone}>{SOURCE[p.source].label}</Badge></span></td>
                    {modules.map((m) => { const l = p.modules[m] ?? 0; return <td key={m}><span className={`access-cell l${l}`}>{LEVEL[l] ?? l}</span></td>; })}
                  </tr>
                  {open === p.userId && <tr><td colSpan={4 + modules.length}><PermissionList person={p} /></td></tr>}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function PermissionList({ person }: { person: EffectiveAccess }) {
  return (
    <div style={{ padding: '4px 4px 8px' }}>
      <p className="muted" style={{ fontSize: 12.5, marginBottom: 8 }}>{SOURCE[person.source].hint}</p>
      {person.permissions.length === 0 ? <p className="muted" style={{ fontSize: 12.5 }}>No actions beyond viewing.</p> : (
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          {person.permissions.map((k) => <span key={k} className="badge badge-neutral" title={k}>{PERMISSION_LABELS[k] ?? k}</span>)}
        </div>
      )}
    </div>
  );
}
