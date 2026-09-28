import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { projectApi } from '../../api/endpoints';
import { Icon } from '../../components/Icon';
import { ErrorState, HealthBadge, PageLoader, PriorityBadge, Progress, ProjectStatusBadge, ProjectTypeBadge, Tabs } from '../../components/ui';
import { daysUntil, formatDate } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useAuth, useCan, useModule, useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
import { TaskModal } from '../tasks/TaskModal';
import { Board, ListView } from './Board';
import { ProjectFormModal } from './ProjectFormModal';
import { Attachments } from '../files/Attachments';
import { MilestonesPanel } from '../planning/MilestonesPanel';
import { AutomationPanel } from '../automation/AutomationPanel';
import { SprintsPanel } from '../sprints/SprintsPanel';
import { ImportModal } from '../import/ImportModal';
import { ProjectTime } from '../time/ProjectTime';
import { ActivityTab, TeamTab, WorkflowTab } from './ProjectTabs';
import { Timeline } from './Timeline';
import { ProjectChatButton, useProjectChat } from '../chat/ProjectChat';
import { IssueDetailModal, ReportIssueModal } from '../issues/IssueModals';
import { IssuesPanel } from '../issues/IssuesPanel';

type Tab = 'board' | 'list' | 'issues' | 'milestones' | 'team' | 'files' | 'workflow' | 'sprints' | 'automation' | 'time' | 'activity';

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
  const allowedTabs: Tab[] = ['board', 'list', 'issues', 'milestones', 'team', 'files', 'workflow', 'sprints', 'automation', 'time', 'activity'].filter((t) =>
    t === 'board' || t === 'list' || t === 'issues' || t === 'sprints' ? seeTasks : t === 'activity' ? seeActivity : t === 'time' ? canReports && seeTasks : true) as Tab[];
  const wanted = (params.get('tab') as Tab) || 'board';
  const [tab, setTab] = useState<Tab>(allowedTabs.includes(wanted) ? wanted : allowedTabs[0]);
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

  if (q.isLoading) return <PageLoader />;
  if (q.isError || !q.data) {
    const notFound = q.error instanceof ApiError && q.error.status === 404;
    return <ErrorState error={notFound ? new ApiError(404, 'This project does not exist or you do not have access to it.', []) : q.error} retry={notFound ? undefined : () => q.refetch()} />;
  }

  const detail = q.data;
  const p = detail.project;
  const canEdit = canEditPerm || (p.owner?.id === me);
  const days = daysUntil(p.dueDate);
  const archived = p.status === 'Archived';
  const openIssues = detail.stages.reduce((n, s) => n + s.openIssues, 0);
  const reportable = canReportIssue && seeTasks && !archived;
  const setTabAndUrl = (t: Tab) => { setTab(t); const n = new URLSearchParams(params); n.set('tab', t); n.delete('task'); setParams(n, { replace: true }); };
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
          <Link className="btn btn-ghost btn-sm" to="/projects" style={{ marginBottom: 12 }}><Icon name="arrowLeft" /> Back to Projects</Link>
          <h1 className="page-title">{p.name}</h1>
          <p className="page-sub">{p.key}{p.teamName ? ` · ${p.teamName}` : ''}</p>
        </div>
        <div className="page-actions">
          <ProjectChatButton projectId={p.id} name={p.name} label />
          {canEdit && <button className="btn btn-ghost" onClick={() => setEditing(true)}><Icon name="edit" /> Edit</button>}
          {canDelete && <button className="btn btn-ghost" onClick={remove}><Icon name="trash" /> Delete</button>}
          {canCreate && seeTasks && !archived && <button className="btn btn-ghost" onClick={() => setImporting(true)}><Icon name="upload" /> Import</button>}
          {seeWork && <Link className="btn btn-ghost" to={`/work?project=${p.id}`} title="Work tasks (bug fixes, support, analysis) that refer to this project"><Icon name="bolt" /> Work tasks</Link>}
          <Link className="btn btn-ghost" to={`/project-status?project=${p.id}`} title="See this project on the Project Status page"><Icon name="monitor" /> Go To Project Status</Link>
          {canCreate && seeTasks && !archived && <button className="btn btn-primary" onClick={() => setNewTask({})}><Icon name="plus" /> Add Task</button>}
        </div>
      </div>

      {archived && <div className="form-warn"><Icon name="alert" size={14} /> This project is archived and read-only. Edit it and change the status to restore it.</div>}

      <div className="detail-hero">
        <div className="dh-top">
          <div style={{ minWidth: 0 }}>
            <div className="dh-sub"><ProjectStatusBadge status={p.status} /><PriorityBadge priority={p.priority} /><HealthBadge health={p.health} /><ProjectTypeBadge type={p.projectType} /></div>
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
          <div className="dh-cell"><label>Team members</label><b>{p.memberCount}</b></div>
          <div className="dh-cell"><label>Start date</label><b>{formatDate(p.startDate)}</b></div>
          <div className="dh-cell"><label>Due date</label><b>{formatDate(p.dueDate)}</b></div>
        </div>
      </div>

      <div style={{ marginBottom: 18 }}><Timeline projectId={p.id} projectName={p.name} stages={detail.stages} canEdit={canEdit && !archived} canReportIssue={reportable}
          onShowIssues={showIssues} onReportIssue={(stageId) => setReporting({ stageId })} /></div>

      <div style={{ marginBottom: 18 }}>
        <Tabs<Tab> value={tab} onChange={setTabAndUrl} tabs={[
          { id: 'board' as Tab, label: 'Board', icon: 'kanban' as const }, { id: 'list' as Tab, label: 'List', icon: 'list' as const }, { id: 'issues' as Tab, label: 'Issues', icon: 'bug' as const, badge: openIssues },
          { id: 'milestones' as Tab, label: 'Milestones', icon: 'target' as const }, { id: 'team' as Tab, label: 'Team', icon: 'users' as const }, { id: 'workflow' as Tab, label: 'Workflow', icon: 'layers' as const },
          { id: 'files' as Tab, label: 'Files', icon: 'paperclip' as const },
          { id: 'sprints' as Tab, label: 'Sprints', icon: 'target' as const },
          { id: 'automation' as Tab, label: 'Automation', icon: 'bolt' as const }, { id: 'time' as Tab, label: 'Time', icon: 'clock' as const },
          { id: 'activity' as Tab, label: 'Activity', icon: 'activity' as const },
        ].filter((t) => allowedTabs.includes(t.id))} />
      </div>

      {tab === 'board' && <Board projectId={p.id} statuses={detail.statuses} stages={detail.stages} archived={archived} canCreate={canCreate && !archived} onOpenTask={openTask} onAddTask={(statusId) => setNewTask({ statusId })} />}
      {tab === 'list' && <ListView projectId={p.id} stages={detail.stages} archived={archived} canCreate={canCreate && !archived} onOpenTask={openTask} onAddTask={() => setNewTask({})} />}
      {tab === 'issues' && <IssuesPanel projectId={p.id} stages={detail.stages} canReport={reportable} stageFilter={issueStage} onStageFilter={setIssueStage} onOpen={openIssue} onReport={(stageId) => setReporting({ stageId })} />}
      {tab === 'team' && <TeamTab detail={detail} canEdit={canEdit && !archived} />}
      {tab === 'workflow' && <WorkflowTab projectId={p.id} statuses={detail.statuses} />}
      {tab === 'milestones' && <MilestonesPanel projectId={p.id} canEdit={canEdit && !archived} />}
      {tab === 'sprints' && <SprintsPanel projectId={p.id} canEdit={canEdit && !archived} canPlan={canPlanSprints && !archived} onOpenTask={openTask} />}
      {tab === 'automation' && <AutomationPanel projectId={p.id} statuses={detail.statuses} canEdit={canEdit && !archived} />}
      {tab === 'time' && <ProjectTime projectId={p.id} />}
      {tab === 'files' && <Attachments projectId={p.id} canEdit={canEdit && !archived} />}
      {tab === 'activity' && <ActivityTab projectId={p.id} />}

      {importing && <ImportModal projectId={p.id} onClose={() => setImporting(false)} />}
      {editing && <ProjectFormModal project={p} onClose={() => setEditing(false)} />}
      {newTask && <TaskModal projectId={p.id} statusId={newTask.statusId} onClose={() => setNewTask(null)} />}
      {openTaskId && <TaskModal taskId={openTaskId} onClose={closeTask} />}
      {reporting && <ReportIssueModal projectId={p.id} stages={detail.stages} members={detail.members} defaultStageId={reporting.stageId} onClose={() => setReporting(null)} onCreated={(id) => { setReporting(null); openIssue(id); }} />}
      {openIssueId && <IssueDetailModal projectId={p.id} issueId={openIssueId} stages={detail.stages} members={detail.members} onClose={closeIssue} />}
    </>
  );
}
