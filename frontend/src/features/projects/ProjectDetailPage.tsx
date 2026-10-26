import { useEffect, useRef, useState } from 'react';
import { ProjectCodeTab } from '../github/GitHubApp';
import { useGitHubApp } from '../github/github';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { projectApi } from '../../api/endpoints';
import { Icon } from '../../components/Icon';
import { Badge, ErrorState, HealthBadge, PageLoader, PriorityBadge, ProjectStatusBadge, ProjectTypeBadge, Ring, Tabs } from '../../components/ui';
import { daysUntil, formatDate, labelize } from '../../lib/format';
import './projects.css';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useAuth, useCan, useModule, useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
import { TaskModal } from '../tasks/TaskModal';
import { QuickAdd } from '../tasks/QuickAdd';
import { Board, ListView } from './Board';
import { ProjectFormModal } from './ProjectFormModal';
import { Attachments } from '../files/Attachments';
import { PlanPanel, deliveryLabel } from '../planning/PlanPanel';
import { ImportModal } from '../import/ImportModal';
import { ProjectTime } from '../time/ProjectTime';
import { ActivityTab } from './ProjectTabs';
import { DocumentList } from '../documents/DocumentList';
import { DocumentWizard } from '../documents/DocumentWizard';
import { TargetDocuments } from '../documents/LinkedWork';
import { ActionItemsTab } from './ActionItemsPanel';
import { ProjectSettingsModal, type ProjectSettingsTab } from './ProjectSettingsModal';
import { Timeline } from './Timeline';
import { StageScheduleStudio } from './StageScheduleStudio';
import { ProjectChatButton, useProjectChat } from '../chat/ProjectChat';
import { IssueDetailModal, ReportIssueModal } from '../issues/IssueModals';
import { IssuesPanel } from '../issues/IssuesPanel';
import { RiskButton } from '../ai/Assistant';
import { ProjectAgentTab } from '../agent/ProjectAgentTab';
import { agentApi } from '../../api/endpoints';

type Tab = 'overview' | 'board' | 'list' | 'plan' | 'issues' | 'actions' | 'documents' | 'files' | 'time' | 'code' | 'agent' | 'activity';
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
  const seeDocuments = useModule('documents') > 0, canWriteDocs = useModule('documents') >= 2;
  const [newDoc, setNewDoc] = useState(false);
  const canReportIssue = useCan('tasks.comment');
  const isGuest = useAuth((s) => s.ctx?.current?.role === 'Guest');
  const allowedTabs: Tab[] = (['overview', 'board', 'list', 'plan', 'issues', 'actions', 'documents', 'files', 'time', 'code', 'agent', 'activity'] as Tab[]).filter((t) =>
    t === 'board' || t === 'list' || t === 'issues' || t === 'plan' || t === 'code' ? seeTasks : t === 'activity' ? seeActivity : t === 'time' ? canReports && seeTasks : t === 'documents' ? seeDocuments : t === 'agent' ? !isGuest : true);
  // The project opens on its Overview (summary, progress, timeline and quick add); the board is one tab away.
  const rawTab = params.get('tab') ?? 'overview';
  // The project's meetings live in Meet now: old links (?tab=meetings&meeting=…) open them there.
  useEffect(() => {
    if (rawTab !== 'meetings') return;
    const m = params.get('meeting');
    nav(`/talk?f=meetings&s=upcoming&project=${id}${m ? `&open=p:${m}` : ''}`, { replace: true });   // Meet (in Talk), filtered to the project
  }, [rawTab, params, id, nav]);
  const legacy = LEGACY_TAB[rawTab];
  const wanted = (legacy?.tab ?? (legacy ? 'overview' : rawTab)) as Tab;
  const [tab, setTab] = useState<Tab>(allowedTabs.includes(wanted) ? wanted : allowedTabs[0]);
  const [settings, setSettings] = useState<ProjectSettingsTab | null>(legacy?.settings ?? null);
  const [editing, setEditing] = useState(false);
  const [scheduling, setScheduling] = useState(false);
  const [newTask, setNewTask] = useState<{ statusId?: string } | null>(null);
  const [importing, setImporting] = useState(false);
  const [issueStage, setIssueStage] = useState('');                        // the stage the Issues tab is narrowed to
  const [reporting, setReporting] = useState<{ stageId?: string } | null>(null);

  const q = useWsQuery(['project', id], () => projectApi.get(id));
  const gitHub = useGitHubApp();
  // The Agent tab shows how many proposals wait for a decision.
  const agent = useWsQuery(['agent', 'project', id], () => agentApi.get(id), { enabled: !isGuest, retry: false, staleTime: 60_000 });
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
  const finished = p.status === 'Completed' || p.status === 'Cancelled' || p.status === 'Archived';
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

  const doneTasks = p.stats.done, liveTasks = p.stats.total - p.stats.cancelled;
  const late = !finished && days !== null && days < 0 && p.progress < 100;
  const ringTone = p.health === 'Delayed' ? 'danger' : p.health === 'AtRisk' ? 'warning' : p.health === 'OnTrack' ? 'success' : undefined;
  const ringTitle = finished ? labelize(p.status) : days === null ? 'No due date' : days < 0 ? `${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} overdue` : days === 0 ? 'Due today' : `${days} day${days === 1 ? '' : 's'} left`;

  return (
    <div className="pd">
      {/* The head (design p21): a back link, the name, its key with a few pills, the actions on the right, and the tabs right under it. */}
      <header className="pd-head">
        <div className="pd-head-main">
          <Link className="pd-back" to="/projects"><Icon name="chevronL" size={14} /> Projects</Link>
          <h1 className="page-title">{p.name}</h1>
          <div className="pd-meta">
            <span className="pd-key">{p.key}{p.teamName ? ` · ${p.teamName}` : ''}</span>
            {!(['Active', 'Planning'] as string[]).includes(p.status) && <ProjectStatusBadge status={p.status} />}
            <HealthBadge health={p.health} /><PriorityBadge priority={p.priority} /><ProjectTypeBadge type={p.projectType} />
            <span title="Delivery method: decides which planning views the project shows"><Badge tone="neutral">{deliveryLabel(method)} delivery</Badge></span>
          </div>
        </div>
        <div className="page-actions">
          <RiskButton projectId={p.id} />
          {/* Every meeting and call is in Meet; this opens the project's own. */}
          <Link className="btn btn-ghost" to={`/talk?f=meetings&s=upcoming&project=${p.id}`}><Icon name="video" /> Meet</Link>
          <ProjectChatButton projectId={p.id} name={p.name} label />
          {method === 'Agile' && canEdit && !archived && <button className="btn btn-ghost" onClick={() => setScheduling(true)}><Icon name="calendar" /> Schedule studio</button>}
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
      </header>

      <Tabs<Tab> value={tab} onChange={setTabAndUrl} tabs={[
        { id: 'overview' as Tab, label: 'Overview', icon: 'dashboard' as const },
        { id: 'board' as Tab, label: 'Board', icon: 'kanban' as const }, { id: 'list' as Tab, label: 'List', icon: 'list' as const },
        { id: 'plan' as Tab, label: method === 'Agile' ? 'Sprints' : method === 'Phased' ? 'Milestones' : 'Plan', icon: 'target' as const },
        { id: 'issues' as Tab, label: 'Issues', icon: 'bug' as const, badge: openIssues },
        { id: 'actions' as Tab, label: 'Action items', icon: 'flag' as const },
        { id: 'documents' as Tab, label: 'Documents', icon: 'note' as const },
        { id: 'files' as Tab, label: 'Files', icon: 'paperclip' as const },
        { id: 'time' as Tab, label: 'Time', icon: 'clock' as const },
        ...(gitHub.data?.installed || tab === 'code' ? [{ id: 'code' as Tab, label: 'Code', icon: 'git' as const }] : []),
        { id: 'agent' as Tab, label: 'Agent', icon: 'sparkle' as const, badge: agent.data?.enabled ? agent.data.pending || undefined : undefined },
        { id: 'activity' as Tab, label: 'Activity', icon: 'activity' as const },
      ].filter((t) => allowedTabs.includes(t.id))} />

      {archived && <div className="form-warn"><Icon name="alert" size={14} /> This project is archived and read-only. Edit it and change the status to restore it.</div>}

      {tab === 'overview' && (
        <div className="pd-overview">
          <div className="pd-cards">
            <section className="card pd-summary" aria-label="About this project">
              {p.description ? <p className="pd-desc">{p.description}</p> : <p className="pd-desc muted">No description yet.{canEdit && <> <button type="button" className="link-btn" onClick={() => setEditing(true)}>Add one</button></>}</p>}
              <div className="pd-links">
                <button type="button" className="ds-pill accent" onClick={() => setSettings('members')}>{p.memberCount != null ? `${p.memberCount} ${p.memberCount === 1 ? 'member' : 'members'}` : 'Members'}</button>
                {seeTasks && <button type="button" className={`ds-pill ${openIssues ? 'danger' : ''}`} onClick={() => setTabAndUrl('issues')}>{openIssues ? `${openIssues} open issue${openIssues === 1 ? '' : 's'}` : 'No open issues'}</button>}
                <button type="button" className="ds-pill" onClick={() => setTabAndUrl('actions')}>Action items</button>
                <Link className="ds-pill" to={`/portfolio?project=${p.id}`}>Show in Portfolio</Link>
              </div>
            </section>
            <section className="card pd-ringcard" aria-label="Progress and dates">
              <div className="pd-ringrow">
                <Ring value={p.progress} tone={ringTone} label={`${p.progress}% of the tasks done`} />
                <div className="pd-ringtext">
                  <b className={late ? 'late' : ''}>{ringTitle}</b>
                  <span>{doneTasks} of {liveTasks} task{liveTasks === 1 ? '' : 's'} done{p.stats.inProgress > 0 ? ` · ${p.stats.inProgress} in progress` : ''}</span>
                </div>
              </div>
              <dl className="pd-facts">
                <div><dt>Owner</dt><dd>{p.owner?.name ?? 'Unassigned'}</dd></div>
                <div><dt>Members</dt><dd><button type="button" className="link" onClick={() => setSettings('members')} title="See who is on this project">{p.memberCount != null ? `${p.memberCount} ${p.memberCount === 1 ? 'person' : 'people'}` : 'See members'}</button></dd></div>
                <div><dt>Start</dt><dd>{formatDate(p.startDate)}</dd></div>
                <div><dt>Due</dt><dd className={late ? 'late' : ''}>{formatDate(p.dueDate)}</dd></div>
              </dl>
            </section>
          </div>
          {method !== 'Agile' && <Timeline projectId={p.id} projectName={p.name} project={p} stages={detail.stages} canEdit={canEdit && !archived} canReportIssue={reportable}
            taskProgress={p.progress} finished={finished}
            onShowIssues={showIssues} onReportIssue={(stageId) => setReporting({ stageId })} />}
          {seeTasks && canCreate && !archived && <QuickAdd projectId={p.id} />}
        </div>
      )}

      {(tab === 'board' || tab === 'list') && canCreate && !archived && <QuickAdd projectId={p.id} />}
      {tab === 'board' && <Board projectId={p.id} statuses={detail.statuses} stages={detail.stages} archived={archived} canCreate={canCreate && !archived} onOpenTask={openTask} onAddTask={(statusId) => setNewTask({ statusId })} />}
      {tab === 'list' && <ListView projectId={p.id} stages={detail.stages} archived={archived} canCreate={canCreate && !archived} onOpenTask={openTask} onAddTask={() => setNewTask({})} />}
      {tab === 'issues' && <IssuesPanel projectId={p.id} stages={detail.stages} canReport={reportable} stageFilter={issueStage} onStageFilter={setIssueStage} onOpen={openIssue} onReport={(stageId) => setReporting({ stageId })} />}
      {tab === 'plan' && <PlanPanel projectId={p.id} method={method} stages={detail.stages} canEdit={canEdit && !archived} canPlan={canPlanSprints && !archived} onOpenTask={openTask} />}
      {tab === 'actions' && <ActionItemsTab projectId={p.id} highlightId={actionId} />}
      {tab === 'documents' && (
        <>
          <div className="doc-tab-head"><TargetDocuments targetType="Project" targetId={p.id} title="Documents about this project" />{canWriteDocs && !archived && <button className="btn btn-primary btn-sm" onClick={() => setNewDoc(true)}><Icon name="plus" size={15} /> New document</button>}</div>
          <DocumentList projectId={p.id} canCreate={canWriteDocs && !archived} onNew={() => setNewDoc(true)} />
        </>
      )}
      {tab === 'time' && <ProjectTime projectId={p.id} />}
      {tab === 'code' && <ProjectCodeTab projectId={p.id} canWriteDocs={canWriteDocs && !archived} />}
      {tab === 'files' && <Attachments projectId={p.id} canEdit={canEdit && !archived} />}
      {tab === 'agent' && <ProjectAgentTab projectId={p.id} archived={archived} />}
      {tab === 'activity' && <ActivityTab projectId={p.id} />}

      {newDoc && <DocumentWizard projectId={p.id} onClose={() => setNewDoc(false)} onCreated={(docId) => nav(`/documents/${docId}`)} />}
      {importing && <ImportModal projectId={p.id} onClose={() => setImporting(false)} />}
      {editing && <ProjectFormModal project={p} onClose={() => setEditing(false)} />}
      {scheduling && <StageScheduleStudio project={p} stages={detail.stages} onClose={() => setScheduling(false)} />}
      {settings && <ProjectSettingsModal detail={detail} canEdit={canEdit} initial={settings} onClose={() => {
        setSettings(null);
        if (legacy) { const n = new URLSearchParams(params); n.set('tab', tab); setParams(n, { replace: true }); }
      }} />}
      {newTask && <TaskModal projectId={p.id} statusId={newTask.statusId} onClose={() => setNewTask(null)} />}
      {openTaskId && <TaskModal taskId={openTaskId} onClose={closeTask} />}
      {reporting && <ReportIssueModal projectId={p.id} stages={detail.stages} members={detail.members} defaultStageId={reporting.stageId} onClose={() => setReporting(null)} onCreated={(id) => { setReporting(null); openIssue(id); }} />}
      {openIssueId && <IssueDetailModal projectId={p.id} issueId={openIssueId} stages={detail.stages} members={detail.members} onClose={closeIssue} />}
    </div>
  );
}
