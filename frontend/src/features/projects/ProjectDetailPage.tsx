import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { projectApi } from '../../api/endpoints';
import { Icon } from '../../components/Icon';
import { Badge, ErrorState, HealthBadge, PageLoader, PriorityBadge, Progress, ProjectStatusBadge, ProjectTypeBadge, Tabs } from '../../components/ui';
import { daysUntil, formatDate } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useAuth, useCan, useModule, useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
import { TaskModal } from '../tasks/TaskModal';
import { Board, ListView } from './Board';
import { ProjectFormModal } from './ProjectFormModal';
import { Attachments } from '../files/Attachments';
import { PlanPanel, deliveryLabel } from '../planning/PlanPanel';
import { ImportModal } from '../import/ImportModal';
import { ProjectTime } from '../time/ProjectTime';
import { ActivityTab } from './ProjectTabs';
import { ActionItemsTab } from './ActionItemsPanel';
import { ProjectSettingsModal, type ProjectSettingsTab } from './ProjectSettingsModal';
import { Timeline } from './Timeline';
import { ProjectChatButton, useProjectChat } from '../chat/ProjectChat';
import { IssueDetailModal, ReportIssueModal } from '../issues/IssueModals';
import { IssuesPanel } from '../issues/IssuesPanel';
import { RiskButton } from '../ai/Assistant';

type Tab = 'board' | 'list' | 'plan' | 'issues' | 'actions' | 'files' | 'time' | 'activity';
/** Addresses from before the tabs were regrouped: planning tabs open Plan, configuration tabs open Project settings. */
const LEGACY_TAB: Record<string, { tab?: Tab; settings?: ProjectSettingsTab }> = {
  milestones: { tab: 'plan' }, sprints: { tab: 'plan' }, team: { settings: 'members' }, workflow: { settings: 'workflow' }, automation: { settings: 'automation' },
};

/** A small menu behind a "More" button, for the actions that are not needed every day. */
function MoreMenu({ children }: { children: (close: () => void) => React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', h); document.addEventListener('keydown', k);
    return () => { document.removeEventListener('mousedown', h); document.removeEventListener('keydown', k); };
  }, [open]);
  return (
    <div className="menu-wrap" ref={ref}>
      <button type="button" className="btn btn-ghost" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}><Icon name="more" /> More</button>
      {open && <div className="menu-pop" role="menu">{children(() => setOpen(false))}</div>}
    </div>
  );
}

export function ProjectDetailPage() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const wid = useWorkspaceId();
  const [params, setParams] = useSearchParams();
  const me = useAuth((s) => s.ctx!.user.id);
  const canEditPerm = useCan('projects.edit');
  const canDelete = useCan('projects.delete');
  const canCreate = useCan('tasks.create');
  // Sprint planning moves several tasks at once, so (unlike the board/list, which are aware per-task) it needs
  // the blanket edit permission - members restricted to editing just their own assigned tasks don't get this UI.
  const canPlanSprints = useCan('tasks.edit');
  const canReports = useCan('reports.view');
  const [seeTasks, seeActivity] = [useModule('tasks') > 0, useModule('activity') > 0];
  const seeWork = useModule("work") > 0;
  const canReportIssue = useCan('tasks.comment');
  const allowedTabs: Tab[] = (['board', 'list', 'plan', 'issues', 'actions', 'files', 'time', 'activity'] as Tab[]).filter((t) =>
    t === 'board' || t === 'list' || t === 'issues' || t === 'plan' ? seeTasks : t === 'activity' ? seeActivity : t === 'time' ? canReports && seeTasks : true);
  const rawTab = params.get('tab') ?? 'board';
  const legacy = LEGACY_TAB[rawTab];
  const wanted = (legacy?.tab ?? (legacy ? 'board' : rawTab)) as Tab;
  const [tab, setTab] = useState<Tab>(allowedTabs.includes(wanted) ? wanted : allowedTabs[0]);
  const [settings, setSettings] = useState<ProjectSettingsTab | null>(legacy?.settings ?? null);
  const [editing, setEditing] = useState(false);
  const [newTask, setNewTask] = useState<{ statusId?: string } | null>(null);
  const [importing, setImporting] = useState(false);
  const [issueStage, setIssueStage] = useState('');                        // the stage the Issues tab is narrowed to
  const [reporting, setReporting] = useState<{ stageId?: string } | null>(null);

  const q = useWsQuery(['project', id], () => projectApi.get(id));
  const openTaskId = params.get('task');
  const openChat = useProjectChat((s) => s.openChat);
  const chatWanted = params.get('chat');
  const projectName = q.data?.project.name;
  // A link to the chat (from a mention notification) opens the panel, then drops the marker so a reload does not open it again.
  useEffect(() => {
    if (!chatWanted || !projectName) return;
    openChat(id, projectName);
    const n = new URLSearchParams(params); n.delete('chat'); setParams(n, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatWanted, projectName, id]);
  const openIssueId = params.get('issue');
  const actionId = params.get('action');
  // Follow the address when it changes while the page is open (a notification or a search result for this same project).
  useEffect(() => {
    if (!legacy && allowedTabs.includes(rawTab as Tab) && rawTab !== tab) setTab(rawTab as Tab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawTab]);

  if (q.isLoading) return <PageLoader />;
  if (q.isError || !q.data) {
    const notFound = q.error instanceof ApiError && q.error.status === 404;
    return <ErrorState error={notFound ? new ApiError(404, 'This project does not exist or you do not have access to it.', []) : q.error} retry={notFound ? undefined : () => q.refetch()} />;
  }

  const detail = q.data;
  const p = detail.project;
  const canEdit = canEditPerm || (p.owner?.id === me);
  const method = p.deliveryMethod ?? 'Hybrid';
  const days = daysUntil(p.dueDate);
  const archived = p.status === 'Archived';
  const openIssues = detail.stages.reduce((n, s) => n + s.openIssues, 0);
  const reportable = canReportIssue && seeTasks && !archived;
  const setTabAndUrl = (t: Tab) => { setTab(t); const n = new URLSearchParams(params); n.set('tab', t); n.delete('task'); n.delete('action'); setParams(n, { replace: true }); };
  const openTask = (taskId: string) => { const n = new URLSearchParams(params); n.set('task', taskId); setParams(n, { replace: true }); };
  const closeTask = () => { const n = new URLSearchParams(params); n.delete('task'); setParams(n, { replace: true }); };
  const openIssue = (issueId: string) => { setTab('issues'); const n = new URLSearchParams(params); n.set('tab', 'issues'); n.set('issue', issueId); n.delete('task'); setParams(n, { replace: true }); };
  const closeIssue = () => { const n = new URLSearchParams(params); n.delete('issue'); setParams(n, { replace: true }); };
  const showIssues = (stageId: string) => { setIssueStage(stageId); setTabAndUrl('issues'); };

  const remove = async () => {
    if (!(await confirmDialog({ title: 'Delete project?', message: `Deleting “${p.name}” will also remove all of its tasks.` }))) return;
    try { await projectApi.remove(p.id); toast('Project deleted.', 'warning'); await invalidateWorkspace(wid); nav('/projects'); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Could not delete the project.', 'error'); }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <Link className="btn btn-ghost btn-sm" to="/projects" style={{ marginBottom: 12 }}><Icon name="arrowLeft" /> Back to projects</Link>
          <h1 className="page-title">{p.name}</h1>
          <p className="page-sub">{p.key}{p.teamName ? ` · ${p.teamName}` : ''}</p>
        </div>
        <div className="page-actions">
          <RiskButton projectId={p.id} />
          <ProjectChatButton projectId={p.id} name={p.name} label />
          {canEdit && <button className="btn btn-ghost" onClick={() => setSettings('members')} title="Members, task workflow and automation"><Icon name="settings" /> Settings</button>}
          <MoreMenu>{(close) => <>
            {canEdit && <button type="button" role="menuitem" onClick={() => { close(); setEditing(true); }}><Icon name="edit" /> Edit details</button>}
            {canCreate && seeTasks && !archived && <button type="button" role="menuitem" onClick={() => { close(); setImporting(true); }}><Icon name="upload" /> Import tasks from CSV</button>}
            {!canEdit && <button type="button" role="menuitem" onClick={() => { close(); setSettings('members'); }}><Icon name="users" /> Members</button>}
            <Link role="menuitem" to={`/portfolio?project=${p.id}`} onClick={close}><Icon name="monitor" /> Show in Portfolio</Link>
            {seeWork && <Link role="menuitem" to={`/operations?project=${p.id}`} onClick={close} title="Bug fixes, support and analysis that refer to this project"><Icon name="bolt" /> Related operational work</Link>}
            {canDelete && <><hr /><button type="button" role="menuitem" className="danger" onClick={() => { close(); void remove(); }}><Icon name="trash" /> Delete project</button></>}
          </>}</MoreMenu>
          {canCreate && seeTasks && !archived && <button className="btn btn-primary" onClick={() => setNewTask({})}><Icon name="plus" /> Add task</button>}
        </div>
      </div>

      {archived && <div className="form-warn"><Icon name="alert" size={14} /> This project is archived and read-only. Edit it and change the status to restore it.</div>}

      <div className="detail-hero">
        <div className="dh-top">
          <div style={{ minWidth: 0 }}>
            <div className="dh-sub"><ProjectStatusBadge status={p.status} /><PriorityBadge priority={p.priority} /><HealthBadge health={p.health} /><ProjectTypeBadge type={p.projectType} /><span title="Delivery method: decides which planning views the project shows"><Badge tone="neutral">{deliveryLabel(method)} delivery</Badge></span></div>
            {p.description && <p style={{ fontSize: 13, color: 'var(--text-2)', marginTop: 12, maxWidth: 640, lineHeight: 1.6 }}>{p.description}</p>}
          </div>
          <div style={{ textAlign: 'right' }}>
            <div className="dh-cell"><label>Days remaining</label></div>
            <div style={{ fontSize: 28, fontWeight: 750, letterSpacing: '-.03em', color: days !== null && days < 0 && p.progress < 100 ? 'var(--danger)' : days !== null && days <= 7 ? 'var(--warning)' : undefined }}>
              {days === null ? '—' : days < 0 ? `${Math.abs(days)} overdue` : days}
            </div>
          </div>
        </div>
        <div className="big-progress">
          <div className="big-progress-top"><b>{p.progress}%</b><span>{p.stats.done} of {p.stats.total - p.stats.cancelled} tasks completed</span></div>
          <Progress value={p.progress} large />
        </div>
        <div className="dh-grid">
          <div className="dh-cell"><label>Owner</label><b>{p.owner?.name ?? 'Unassigned'}</b></div>
          <div className="dh-cell"><label>Members</label><b><button type="button" className="link" onClick={() => setSettings('members')} title="See who is on this project">{p.memberCount} {p.memberCount === 1 ? 'person' : 'people'}</button></b></div>
          <div className="dh-cell"><label>Start date</label><b>{formatDate(p.startDate)}</b></div>
          <div className="dh-cell"><label>Due date</label><b>{formatDate(p.dueDate)}</b></div>
        </div>
      </div>

      {method !== 'Agile' && <div style={{ marginBottom: 18 }}><Timeline projectId={p.id} projectName={p.name} stages={detail.stages} canEdit={canEdit && !archived} canReportIssue={reportable}
          onShowIssues={showIssues} onReportIssue={(stageId) => setReporting({ stageId })} /></div>}

      <div style={{ marginBottom: 18 }}>
        <Tabs<Tab> value={tab} onChange={setTabAndUrl} tabs={[
          { id: 'board' as Tab, label: 'Board', icon: 'kanban' as const }, { id: 'list' as Tab, label: 'List', icon: 'list' as const },
          { id: 'plan' as Tab, label: method === 'Agile' ? 'Sprints' : method === 'Phased' ? 'Milestones' : 'Plan', icon: 'target' as const },
          { id: 'issues' as Tab, label: 'Issues', icon: 'bug' as const, badge: openIssues },
          { id: 'actions' as Tab, label: 'Actions', icon: 'flag' as const },
          { id: 'files' as Tab, label: 'Files', icon: 'paperclip' as const },
          { id: 'time' as Tab, label: 'Time', icon: 'clock' as const },
          { id: 'activity' as Tab, label: 'Activity', icon: 'activity' as const },
        ].filter((t) => allowedTabs.includes(t.id))} />
      </div>

      {tab === 'board' && <Board projectId={p.id} statuses={detail.statuses} stages={detail.stages} archived={archived} canCreate={canCreate && !archived} onOpenTask={openTask} onAddTask={(statusId) => setNewTask({ statusId })} />}
      {tab === 'list' && <ListView projectId={p.id} stages={detail.stages} archived={archived} canCreate={canCreate && !archived} onOpenTask={openTask} onAddTask={() => setNewTask({})} />}
      {tab === 'issues' && <IssuesPanel projectId={p.id} stages={detail.stages} canReport={reportable} stageFilter={issueStage} onStageFilter={setIssueStage} onOpen={openIssue} onReport={(stageId) => setReporting({ stageId })} />}
      {tab === 'plan' && <PlanPanel projectId={p.id} method={method} stages={detail.stages} canEdit={canEdit && !archived} canPlan={canPlanSprints && !archived} onOpenTask={openTask} />}
      {tab === 'actions' && <ActionItemsTab projectId={p.id} highlightId={actionId} />}
      {tab === 'time' && <ProjectTime projectId={p.id} />}
      {tab === 'files' && <Attachments projectId={p.id} canEdit={canEdit && !archived} />}
      {tab === 'activity' && <ActivityTab projectId={p.id} />}

      {importing && <ImportModal projectId={p.id} onClose={() => setImporting(false)} />}
      {editing && <ProjectFormModal project={p} onClose={() => setEditing(false)} />}
      {settings && <ProjectSettingsModal detail={detail} canEdit={canEdit} initial={settings} onClose={() => {
        setSettings(null);
        if (legacy) { const n = new URLSearchParams(params); n.set('tab', tab); setParams(n, { replace: true }); }
      }} />}
      {newTask && <TaskModal projectId={p.id} statusId={newTask.statusId} onClose={() => setNewTask(null)} />}
      {openTaskId && <TaskModal taskId={openTaskId} onClose={closeTask} />}
      {reporting && <ReportIssueModal projectId={p.id} stages={detail.stages} members={detail.members} defaultStageId={reporting.stageId} onClose={() => setReporting(null)} onCreated={(id) => { setReporting(null); openIssue(id); }} />}
      {openIssueId && <IssueDetailModal projectId={p.id} issueId={openIssueId} stages={detail.stages} members={detail.members} onClose={closeIssue} />}
    </>
  );
}
