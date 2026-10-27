import { useCallback, useEffect, useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { projectApi, teamApi, workApi, workspaceApi } from '../../api/endpoints';
import type { WorkItem, WorkItemKind } from '../../api/types';
import type { WorkListFilters, WorkRow } from '../../api/workItemsApi';
import { Icon } from '../../components/Icon';
import { PageHead, Segmented } from '../../components/ui';
import { openNew } from '../../components/v2/state';
import { useWsQuery } from '../../lib/hooks';
import { useAuth, useCan, useIsPersonal, useModule } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { saveOfflineSnapshot } from '../offline/storage';
import { DotsMenu, type DotsItem } from '../talk/DotsMenu';
import { WorkloadPage } from '../workitems/WorkloadPage';
import { AutomationsPage } from './Automations';
import { WorkItemPanel } from './WorkItemPanel';
import { WorkList } from './WorkList';
import { ProjectWorkTab } from './ProjectWorkTab';
import { WorkTasksPage, type OpsView } from './WorkTasksPage';
import { useWorkKinds, useWorkList } from './workUi';
import './work.css';

type Tab = 'mine' | 'team' | 'tickets' | 'automations';
/** The ticket desk's own views (the queue with SLA views and bulk edit, the board, insights, channels, settings), kept one ··· away. */
const OPS_VIEWS: OpsView[] = ['queue', 'board', 'insights', 'whatsapp', 'voice', 'settings'];
const KIND_V1: Record<WorkRow['kind'], WorkItemKind> = { task: 'Task', issue: 'Issue', action: 'ActionItem', ticket: 'Operational' };

/**
 * Work (V2-SPEC §3.3): My work · Team · Tickets, and Projects › as a link (a tab never leaves the place). Each tab is one list of every kind
 * of work on /work-items; a row opens the item in the side panel, which /work?item=<id> opens directly. What the old pages offered stays one
 * ··· away: Team's workload per person and capacity & cost (?s=), the ticket desk's queue, board, insights, channels and settings (?view=).
 */
export function WorkPage() {
  const [params, setParams] = useSearchParams();
  const personal = useIsPersonal();
  const mWork = useModule('work'), mProjects = useModule('projects') > 0;
  const broad = useCan('reports.broad');
  const hasReports = (useAuth((s) => s.ctx?.current?.reportCount) ?? 0) > 0;
  const seesWorkload = !personal && (hasReports || broad);
  const kinds = useWorkKinds();
  const me = useAuth((s) => s.ctx);

  const tabs = useMemo(() => [
    { id: 'mine' as const, label: 'My work' },
    ...(!personal ? [{ id: 'team' as const, label: 'Team' }] : []),
    ...(mWork > 0 ? [{ id: 'tickets' as const, label: 'Tickets' }] : []),
    ...(mProjects ? [{ id: 'automations' as const, label: 'Automations' }] : []),
  ], [personal, mWork, mProjects]);
  const asked = params.get('tab') as Tab | null;
  const tab: Tab = asked && tabs.some((t) => t.id === asked) ? asked : 'mine';
  const item = params.get('item');
  const view = params.get('view') as OpsView | null;
  const opsView = tab === 'tickets' && view && OPS_VIEWS.includes(view) ? view : null;
  const section = tab === 'team' && seesWorkload ? (params.get('s') === 'capacity' ? 'capacity' : params.get('s') === 'workload' ? 'workload' : null) : null;
  // One project's work (/work?project=<id>): the same Work tab its project page shows.
  const scope = tab !== 'tickets' && mProjects ? params.get('project') : null;
  const scoped = useWsQuery(['project', scope], () => projectApi.get(scope!), { enabled: !!scope, staleTime: 30_000 });

  // Old addresses: ?task= (Operations, WhatsApp chats) is the item; ?new=1 makes a ticket with + New.
  useEffect(() => {
    const n = new URLSearchParams(params);
    let changed = false;
    if (n.get('task') && !n.get('item')) { n.set('item', n.get('task')!); n.delete('task'); changed = true; }
    if (n.get('new') === '1') { n.delete('new'); changed = true; openNew(mWork >= 2 ? 'ticket' : 'task'); }
    if (changed) setParams(n, { replace: true });
  }, [params, setParams, mWork]);

  const go = (next: Record<string, string | null>, replace = false) => setParams((p) => {
    const n = new URLSearchParams(p);
    for (const [k, v] of Object.entries(next)) { if (v === null) n.delete(k); else n.set(k, v); }
    return n;
  }, { replace });
  const setTab = (t: Tab) => setParams(() => { const n = new URLSearchParams(); if (t !== 'mine') n.set('tab', t); if (item) n.set('item', item); return n; });
  const open = useCallback((id: string) => go({ item: id, full: null }, true), []); // eslint-disable-line react-hooks/exhaustive-deps
  const close = useCallback(() => go({ item: null, full: null }, true), []); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------- what each tab lists
  const person = tab === 'team' ? params.get('person') : null;
  const team = tab === 'team' ? params.get('team') ?? 'mine' : null;
  const overdue = params.get('overdue') === '1';
  const filters: WorkListFilters = tab === 'mine' ? { mine: true, overdue: overdue || undefined }
    : tab === 'team' ? (person ? { assigneeId: person, overdue: overdue || undefined } : { team: team ?? 'mine', overdue: overdue || undefined })
    : { kind: ['ticket'], overdue: overdue || undefined };
  const teams = useWsQuery(['teams'], teamApi.list, { enabled: tab === 'team' && !person, staleTime: 5 * 60_000, retry: false });
  const members = useWsQuery(['members'], () => workspaceApi.members(), { enabled: !!person, staleTime: 5 * 60_000 });
  const personName = person ? members.data?.find((m) => m.userId === person)?.displayName ?? 'one person' : null;

  // The installed app's offline view keeps the open "My work" list on this device.
  const mine = useWorkList({ mine: true }, tab === 'mine' && !overdue);
  useEffect(() => {
    if (tab !== 'mine' || overdue || !mine.data || !me?.current) return;
    saveOfflineSnapshot(mine.items.map((w) => ({ ...w, kind: KIND_V1[w.kind] }) as unknown as WorkItem), me.user.displayName, me.current.name);
  }, [mine.data, mine.items, tab, overdue, me]);

  // ---------------------------------------------------------------- ··· per tab
  const canNew = useCan('work.create') && mWork >= 2;
  const opsItem = (v: OpsView, label: string, icon: DotsItem['icon'], hint?: string): DotsItem => ({ label, icon, hint, onSelect: () => go({ view: v, item: null }) });
  const dots: DotsItem[] = tab === 'tickets' ? [
    { label: 'New ticket', icon: 'plus', hidden: !canNew, onSelect: () => openNew('ticket') },
    opsItem('queue', 'Queue', 'list', 'SLA views, saved views and bulk edit'),
    opsItem('board', 'Board', 'kanban', 'Tickets by status; drag to move'),
    opsItem('insights', 'Insights', 'chart', 'SLA, aging, satisfaction'),
    opsItem('whatsapp', 'WhatsApp desk', 'message', 'Chats that become tickets'),
    opsItem('voice', 'Voice agent', 'phone', 'Calls that become tickets'),
    opsItem('settings', 'Desk settings', 'settings', 'Business hours, rules, service levels'),
    { label: 'Export CSV', icon: 'download', onSelect: () => void workApi.exportCsv({ open: true }).catch((e) => toast(e instanceof ApiError ? e.message : 'Could not export the list.', 'error')) },
  ] : tab === 'automations' ? [
    { label: 'New task', icon: 'plus', onSelect: () => openNew('task') },
  ] : tab === 'team' ? [
    { label: 'Workload by person', icon: 'users', hint: 'Open, overdue and done per person', hidden: !seesWorkload, onSelect: () => go({ s: 'workload', item: null }) },
    { label: 'Capacity & cost', icon: 'gauge', hint: 'Logged time against capacity', hidden: !seesWorkload, onSelect: () => go({ s: 'capacity', item: null }) },
  ] : [
    { label: 'New task', icon: 'plus', onSelect: () => openNew('task') },
    { label: 'Only what is overdue', icon: 'alert', hidden: overdue, onSelect: () => go({ overdue: '1' }) },
  ];

  const head = (
    <PageHead eyebrow="Tasks, issues, actions and tickets — one list" title="Work">
      <div className="wk-heads">
        <Segmented label="Work" value={tab} onChange={setTab} options={tabs} />
        {mProjects && <Link className="wk-projects" to="/work/projects">Projects <span aria-hidden="true">›</span></Link>}
        <DotsMenu label={`More in ${tabs.find((t) => t.id === tab)?.label ?? 'Work'}`} items={dots} />
      </div>
    </PageHead>
  );

  const back = (label: string, clear: Record<string, null>) => (
    <button type="button" className="wk-back" onClick={() => go(clear)}><Icon name="chevronL" size={14} />{label}</button>
  );
  const panel = item && <WorkItemPanel id={item} onClose={close} />;
  // A drill-down (the ticket desk's views, Team's workload): its own page under Work, with the way back above it.
  if (opsView) return <div className="wk wk-sub">{back('Work · Tickets', { view: null, item: null })}<WorkTasksPage embedded onOpenItem={open} />{panel}</div>;
  if (section) return <div className="wk wk-sub">{back('Work · Team', { s: null, scope: null })}<WorkloadPage section={section} />{panel}</div>;
  if (scope) return (
    <div className="wk wk-sub">
      {back('Work', { project: null, view: null, kind: null, item: null })}
      <PageHead eyebrow={scoped.data ? `${scoped.data.project.key} · ${scoped.data.project.status === 'Active' ? 'Active' : scoped.data.project.status}` : 'Project'} title={scoped.data?.project.name ?? 'Project work'}>
        <Link className="wk-projects" to={`/work/projects/${scope}`}>Open project <span aria-hidden="true">›</span></Link>
      </PageHead>
      <ProjectWorkTab projectId={scope} />
    </div>
  );

  const narrowing = (person || overdue) && (
      <div className="wk-narrow" role="status">
        {person && <span className="wk-tag">Owned by {personName}<button type="button" aria-label="Show the whole team" onClick={() => go({ person: null })}><Icon name="close" size={12} /></button></span>}
        {overdue && <span className="wk-tag late">Overdue only<button type="button" aria-label="Show everything" onClick={() => go({ overdue: null })}><Icon name="close" size={12} /></button></span>}
      </div>
    );
    const teamPick = tab === 'team' && !person && (teams.data?.length ?? 0) > 0 ? (
      <label className="wk-pick team"><span>Team: <b>{team === 'mine' ? 'my teams' : teams.data!.find((t) => t.id === team)?.name ?? 'my teams'}</b></span>
        <select aria-label="Team" value={team ?? 'mine'} onChange={(e) => go({ team: e.target.value === 'mine' ? null : e.target.value })}>
          <option value="mine">My teams</option>{teams.data!.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select></label>
    ) : null;
  const body = tab === 'automations' ? <AutomationsPage /> : (
      <>
        {narrowing}
        <WorkList key={tab} viewKey={tab} filters={filters} kinds={tab === 'tickets' ? ['ticket'] : kinds} showKinds={tab !== 'tickets'} selectedId={item} onOpen={open} headExtra={teamPick}
          defaults={tab === 'tickets' ? { group: 'status', sort: 'priority' } : tab === 'team' ? { group: 'owner', sort: 'priority' } : undefined}
          empty={tab === 'mine' ? { title: 'Nothing is assigned to you', text: 'Tasks, issues, action items and tickets given to you show up here.', action: <button type="button" className="btn btn-primary" onClick={() => openNew()}><Icon name="plus" size={15} /> New</button> }
            : tab === 'team' ? { title: person ? 'Nothing open for this person' : 'Your teams have nothing open', text: person ? undefined : 'Work owned by the people in your teams shows up here. Teams are set up in People › Teams.',
              action: seesWorkload ? <button type="button" className="btn btn-ghost" onClick={() => go({ s: 'workload' })}>Workload by person ›</button> : undefined }
            : { title: 'No open tickets', text: 'Support requests, bugs and other operational work show up here, from the app, e-mail, WhatsApp and calls.', action: canNew ? <button type="button" className="btn btn-primary" onClick={() => openNew('ticket')}><Icon name="plus" size={15} /> New ticket</button> : undefined }} />
      </>
    );

  return (
    <div className="wk">
      {head}
      {body}
      {panel}
    </div>
  );
}
