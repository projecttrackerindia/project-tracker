import { useEffect, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { agentApi, documentApi, projectApi } from '../../api/endpoints';
import type { DocumentStatus, ProjectDetail } from '../../api/types';
import { Icon } from '../../components/Icon';
import { AiCard } from '../../components/v2/AiCard';
import { openNew } from '../../components/v2/state';
import { ErrorState, Kpi, PageLoader, Ring, Segmented } from '../../components/ui';
import { daysUntil } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useAuth, useCan, useModule, useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
import { ProjectAgentQueue, ProjectAgentSwitch } from '../agent/ProjectAgentTab';
import type { PortfolioRisk } from '../ai/aiApi';
import { RiskModal, useAi, useAssistant } from '../ai/Assistant';
import { useChatEnabled } from '../chat/ProjectChat';
import { useProjectChat } from '../chat/projectChatStore';
import { ImportModal } from '../import/ImportModal';
import { IssueDetailModal, ReportIssueModal } from '../issues/IssueModals';
import { DotsMenu } from '../talk/DotsMenu';
import { TaskModal } from '../tasks/TaskModal';
import { ProjectTime } from '../time/ProjectTime';
import { ProjectWorkTab } from '../work/ProjectWorkTab';
import { usePortfolioBrief, WhatIf } from './PortfolioInsights';
import { ProjectDocs } from './ProjectDocs';
import { ProjectFormModal } from './ProjectFormModal';
import { ProjectSettingsModal, type ProjectSettingsTab } from './ProjectSettingsModal';
import { ActivityTab } from './ProjectTabs';
import { BackLink, dayMonth, errText, HEALTH, HealthPill, isFinished } from './projectParts';
import { StageScheduleStudio } from './StageScheduleStudio';
import { Timeline } from './Timeline';
import '../agent/agent.css';
import './projects.css';
import './projectsHome.css';
import './projectPage.css';

export type ProjectTab = 'overview' | 'work' | 'docs' | 'time' | 'activity';
const TABS: ProjectTab[] = ['overview', 'work', 'docs', 'time', 'activity'];

/**
 * Where the 11 tabs before v2 live now (with what the new tab opens on): Board, List, Plan, Issues and Action items are views of Work; Documents
 * and Files are Docs (Files with the File chip, Code with the Code chip); Agent is the switch on Activity. Team, Workflow and Automation open
 * the project's settings. Used for ?tab= and for the path forms (/work/projects/:id/board).
 */
const OLD_TABS: Record<string, [ProjectTab, Record<string, string>?]> = {
  board: ['work', { view: 'board' }], list: ['work', { view: 'list' }], tasks: ['work'], plan: ['work', { view: 'timeline' }], timeline: ['work', { view: 'timeline' }],
  milestones: ['work', { view: 'timeline' }], sprints: ['work', { view: 'timeline' }], issues: ['work', { kind: 'issue' }], actions: ['work', { kind: 'action' }],
  'action-items': ['work', { kind: 'action' }], documents: ['docs'], files: ['docs', { type: 'file' }], code: ['docs', { type: 'code' }], agent: ['activity'],
};
const SETTINGS_TABS: Record<string, ProjectSettingsTab> = { team: 'members', members: 'members', workflow: 'workflow', automation: 'automation', settings: 'members' };

/** The address an old tab name (from ?tab= or the path) now means, keeping the rest of the query. Null when it is already a new one. */
export function movedTab(tab: string, search: URLSearchParams): URLSearchParams | null {
  const n = new URLSearchParams(search);
  if (OLD_TABS[tab]) {
    const [to, extra] = OLD_TABS[tab];
    n.set('tab', to);
    for (const [k, v] of Object.entries(extra ?? {})) if (!n.has(k)) n.set(k, v);
    return n;
  }
  if (SETTINGS_TABS[tab]) { n.delete('tab'); n.set('settings', SETTINGS_TABS[tab]); return n; }
  if (tab === 'overview') { n.delete('tab'); return n; }
  return null;
}

/**
 * One project (v2 §3.5): Overview · Work · Docs · Time · Activity, a segmented control under the title. The head has "+ Add work" (+ New, in
 * this project) and ··· (Meet, Chat, Settings, Delay risk, and the rarer actions). The floating "Ask about <project>" (the Ask bar) opens the
 * copilot about it. Every old address of a project's tab lands on the tab that holds it now.
 */
export function ProjectPage() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const loc = useLocation();
  const wid = useWorkspaceId();
  const [params, setParams] = useSearchParams();
  const me = useAuth((s) => s.ctx!.user.id);
  const isGuest = useAuth((s) => s.ctx?.current?.role === 'Guest');
  const canEditPerm = useCan('projects.edit'), canDelete = useCan('projects.delete'), canCreate = useCan('tasks.create'), canReports = useCan('reports.view');
  const canReportIssue = useCan('tasks.comment');
  const seeTasks = useModule('tasks') > 0, seeActivity = useModule('activity') > 0, seeWork = useModule('work') > 0;
  const ai = useAi();
  const chatOn = useChatEnabled();
  const openChat = useProjectChat((s) => s.openChat);
  const q = useWsQuery(['project', id], () => projectApi.get(id));

  const rawTab = params.get('tab') ?? 'overview';
  const [editing, setEditing] = useState(false);
  const [scheduling, setScheduling] = useState(false);
  const [importing, setImporting] = useState(false);
  const [risk, setRisk] = useState(false);
  const [whatIf, setWhatIf] = useState(false);
  const [reporting, setReporting] = useState<{ stageId?: string } | null>(null);

  // A link to the chat (from a mention notification) opens the panel, then drops the marker so a reload does not open it again.
  const chatWanted = params.get('chat');
  const projectName = q.data?.project.name;
  useEffect(() => {
    if (!chatWanted || !projectName) return;
    openChat(id, projectName);
    setParams((p) => { const n = new URLSearchParams(p); n.delete('chat'); return n; }, { replace: true });
  }, [chatWanted, projectName, id, openChat, setParams]);

  // The project's meetings live in Talk: old links (?tab=meetings&meeting=…) open them there.
  if (rawTab === 'meetings') {
    const m = params.get('meeting');
    return <Navigate to={`/talk?f=meetings&s=upcoming&project=${id}${m ? `&open=p:${m}` : ''}`} replace />;
  }
  // An old tab: the tab that holds it now, keeping the query (a task, an issue…) and the #anchor.
  // A proposal from the Home inbox (?finding=) is reviewed on Activity, beside the agent's switch.
  const moved = params.has('finding') && !params.has('tab') ? movedTab('agent', params)
    : !params.has('tab') || (TABS.includes(rawTab as ProjectTab) && rawTab !== 'overview') ? null : movedTab(rawTab, params);
  if (moved) { const s = moved.toString(); return <Navigate to={`${loc.pathname}${s ? `?${s}` : ''}${loc.hash}`} replace state={loc.state} />; }

  if (q.isLoading) return <PageLoader />;
  if (q.isError || !q.data) {
    const notFound = q.error instanceof ApiError && q.error.status === 404;
    return <ErrorState error={notFound ? new ApiError(404, 'This project does not exist or you do not have access to it.', []) : q.error} retry={notFound ? undefined : () => q.refetch()} />;
  }

  const detail = q.data;
  const p = detail.project;
  const canEdit = canEditPerm || p.owner?.id === me;
  const archived = p.status === 'Archived';
  const allowed: ProjectTab[] = TABS.filter((t) => t === 'work' ? seeTasks : t === 'time' ? canReports && seeTasks : t === 'activity' ? seeActivity || !isGuest : true);
  const tab: ProjectTab = allowed.includes(rawTab as ProjectTab) ? rawTab as ProjectTab : 'overview';
  // Switching tabs starts the tab afresh: the views and filters in the address belong to the tab that was open.
  const setTab = (t: ProjectTab) => setParams(t === 'overview' ? {} : { tab: t }, { replace: false });
  const settings = (params.get('settings') as ProjectSettingsTab | null);
  const setSettings = (s: ProjectSettingsTab | null) => setParams((x) => { const n = new URLSearchParams(x); if (s) n.set('settings', s); else n.delete('settings'); return n; }, { replace: true });
  const openTaskId = params.get('task'), openIssueId = params.get('issue');
  const drop = (key: string) => setParams((x) => { const n = new URLSearchParams(x); n.delete(key); return n; }, { replace: true });
  const addWork = canCreate && seeTasks && !archived;
  const remove = async () => {
    if (!(await confirmDialog({ title: 'Delete project?', message: `Deleting “${p.name}” will also remove all of its tasks.` }))) return;
    try { await projectApi.remove(p.id); toast('Project deleted.', 'warning'); await invalidateWorkspace(wid); nav('/work/projects'); }
    catch (e) { toast(errText(e, 'Could not delete the project.'), 'error'); }
  };
  const group = p.projectGroupName ?? p.teamName;

  return (
    <div className="pp">
      <header className="pp-head">
        <div className="pp-head-main">
          <BackLink to="/work/projects" label="Projects" />
          <h1 className="page-title">{p.name}</h1>
          <div className="pp-meta">
            <span className="pp-key">{p.key}{group ? ` · ${group}` : ''}</span>
            <HealthPill health={p.health} />
            <span className="pp-people">{p.owner?.name ?? 'No owner'}{p.memberCount ? ` · ${p.memberCount} ${p.memberCount === 1 ? 'person' : 'people'}` : ''}</span>
          </div>
        </div>
        <div className="pp-actions">
          {addWork && <button type="button" className="btn btn-primary pp-add" onClick={() => openNew('task', '', { id: p.id, name: p.name })}><Icon name="plus" size={16} /> Add work</button>}
          <DotsMenu label="More on this project" items={[
            { label: 'Meet', icon: 'video', hint: 'The project’s calls and meetings', onSelect: () => nav(`/talk?f=meetings&s=upcoming&project=${p.id}`) },
            { label: 'Chat', icon: 'message', hint: 'The project’s team chat', hidden: !chatOn, onSelect: () => openChat(p.id, p.name) },
            { label: canEdit ? 'Settings' : 'Members', icon: canEdit ? 'settings' : 'users', hint: canEdit ? 'Members, task workflow and automation' : 'Who is on this project', onSelect: () => setSettings('members') },
            { label: 'Delay risk', icon: 'sparkle', hint: 'How likely it is to be late, and why', hidden: !ai, onSelect: () => setRisk(true) },
            { label: 'What if…', icon: 'target', hint: 'When it finishes if work slips, people join or scope is cut', hidden: isFinished(p), onSelect: () => setWhatIf(true) },
            { label: 'Edit details', icon: 'edit', hidden: !canEdit, onSelect: () => setEditing(true) },
            { label: 'Schedule studio', icon: 'calendar', hint: 'Stage lengths and the project end', hidden: !(p.deliveryMethod === 'Agile' && canEdit && !archived), onSelect: () => setScheduling(true) },
            { label: 'Import tasks from CSV', icon: 'upload', hidden: !addWork, onSelect: () => setImporting(true) },
            { label: 'Related operational work', icon: 'bolt', hint: 'Tickets that refer to this project', hidden: !seeWork, onSelect: () => nav(`/work?tab=tickets&project=${p.id}`) },
            { label: 'Delete project', icon: 'trash', danger: true, hidden: !canDelete, onSelect: () => void remove() },
          ]} />
        </div>
      </header>

      <div className="pp-tabs">
        <Segmented<ProjectTab> label="Project" value={tab} onChange={setTab} options={[
          { id: 'overview', label: 'Overview' }, ...(allowed.includes('work') ? [{ id: 'work' as const, label: 'Work' }] : []), { id: 'docs', label: 'Docs' },
          ...(allowed.includes('time') ? [{ id: 'time' as const, label: 'Time' }] : []), ...(allowed.includes('activity') ? [{ id: 'activity' as const, label: 'Activity' }] : []),
        ]} />
      </div>

      {archived && <div className="form-warn"><Icon name="alert" size={14} /> This project is archived and read-only. Edit it and change the status to restore it.</div>}

      <div className="pp-body" data-tab={tab}>
        {tab === 'overview' && <Overview detail={detail} canEdit={canEdit} canReportIssue={canReportIssue && seeTasks && !archived}
          onSettings={() => setSettings('members')} onReportIssue={(stageId) => setReporting({ stageId })} />}
        {tab === 'work' && <ProjectWorkTab projectId={p.id} />}
        {tab === 'docs' && <ProjectDocs projectId={p.id} canEdit={canEdit} archived={archived} />}
        {tab === 'time' && <ProjectTime projectId={p.id} />}
        {tab === 'activity' && <Activity projectId={p.id} archived={archived} agent={!isGuest} history={seeActivity} />}
      </div>

      {editing && <ProjectFormModal project={p} onClose={() => setEditing(false)} />}
      {scheduling && <StageScheduleStudio project={p} stages={detail.stages} onClose={() => setScheduling(false)} />}
      {importing && <ImportModal projectId={p.id} onClose={() => setImporting(false)} />}
      {risk && <RiskModal projectId={p.id} onClose={() => setRisk(false)} />}
      {whatIf && <WhatIf projectId={p.id} name={p.name} onClose={() => setWhatIf(false)} />}
      {settings && <ProjectSettingsModal detail={detail} canEdit={canEdit} initial={settings} onClose={() => setSettings(null)} />}
      {openTaskId && <TaskModal taskId={openTaskId} onClose={() => drop('task')} />}
      {openIssueId && <IssueDetailModal projectId={p.id} issueId={openIssueId} stages={detail.stages} members={detail.members} onClose={() => drop('issue')} />}
      {reporting && <ReportIssueModal projectId={p.id} stages={detail.stages} members={detail.members} defaultStageId={reporting.stageId}
        onClose={() => setReporting(null)} onCreated={(issueId) => { setReporting(null); setParams({ tab: 'work', kind: 'issue', issue: issueId }); }} />}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------------------------ Overview

const DOC_LABEL: Record<string, string> = { API: 'API doc', BRD: 'BRD', ARCH: 'Design', TECH: 'Tech design', TEST_PLAN: 'Test plan', ARTIFACT: 'File' };
const DOC_STATUS: Record<DocumentStatus, string> = { Draft: 'draft', InReview: 'in review', ChangesRequested: 'changes asked', Approved: 'approved', Published: 'published', Archived: 'archived' };
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const firstSentences = (text: string, max = 240) => {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return /[.!?]$/.test(t) ? t : `${t}.`;
  const cut = t.slice(0, max); const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return end > 60 ? cut.slice(0, end + 1) : `${cut.slice(0, cut.lastIndexOf(' '))}…`;
};

/** The summary in a few sentences, from the project's own facts and the portfolio's forecast (rules; the copilot goes deeper). */
export function summarise(detail: ProjectDetail, r: PortfolioRisk | undefined): string {
  const p = detail.project, s = p.stats;
  const live = s.total - s.cancelled, issues = detail.stages.reduce((n, x) => n + x.openIssues, 0);
  const lead = p.description ? `${firstSentences(p.description)} ` : '';
  if (p.status === 'Completed') return `${lead}${live ? `All ${plural(live, 'task')} done` : 'Completed'}${p.dueDate ? `; it was due ${dayMonth(p.dueDate)}` : ''}.`;
  if (p.status === 'Cancelled') return `${lead}Cancelled with ${s.done} of ${plural(live, 'task')} done.`;
  if (live === 0) return `${lead}No work has been added yet${p.dueDate ? `; it is due ${dayMonth(p.dueDate)}` : ''}.`;
  const parts = [`${s.done} of ${plural(live, 'task')} done${s.inProgress ? `, ${s.inProgress} in progress` : ''}${s.overdue ? `; ${s.overdue} overdue` : ''}.`];
  if (r?.projectedFinish) {
    const slip = r.projectedSlipDays ?? 0;
    parts.push(`At the pace of the last 4 weeks it finishes ${dayMonth(r.projectedFinish)}${r.projectedSlipDays == null ? '' : slip > 0 ? `, ${plural(slip, 'day')} after the due date` : slip < 0 ? ', before the due date' : ', on the due date'}.`);
  } else if (r && r.openTasks > 0 && p.health !== 'OnTrack') parts.push('Nothing has finished in the last 4 weeks, so there is no forecast yet.');
  if (r?.reasons[0] && p.health !== 'OnTrack') parts.push(`${r.reasons[0][0].toUpperCase()}${r.reasons[0].slice(1)}${/[.!?]$/.test(r.reasons[0]) ? '' : '.'}`);
  if (issues) parts.push(`${plural(issues, 'issue')} open.`);
  return lead + parts.join(' ');
}

function Overview({ detail, canEdit, canReportIssue, onSettings, onReportIssue }: {
  detail: ProjectDetail; canEdit: boolean; canReportIssue: boolean; onSettings: () => void; onReportIssue: (stageId?: string) => void;
}) {
  const p = detail.project;
  const ai = useAi();
  const [, setParams] = useSearchParams();
  const brief = usePortfolioBrief();
  const r = brief.data?.ranked?.find((x) => x.projectId === p.id);
  const docsLevel = useModule('documents');
  const docs = useWsQuery(['documents', 'project', p.id], () => documentApi.list({ projectId: p.id, limit: 100 }), { enabled: docsLevel > 0, staleTime: 20_000 });
  const [plan, setPlanState] = useState(() => { try { return localStorage.getItem('pm_pp_plan') === '1'; } catch { return false; } });
  const setPlan = (v: boolean) => { setPlanState(v); try { localStorage.setItem('pm_pp_plan', v ? '1' : '0'); } catch { /* storage unavailable */ } };
  const s = p.stats, live = s.total - s.cancelled;
  const finished = isFinished(p);
  const days = daysUntil(p.dueDate);
  const late = !finished && days !== null && days < 0 && p.progress < 100;
  const openIssues = detail.stages.reduce((n, x) => n + x.openIssues, 0);
  const tone = HEALTH[p.health].tone;
  const ringTone = tone === 'late' ? 'danger' : tone === 'risk' ? 'warning' : tone === 'ok' || p.status === 'Completed' ? 'success' : undefined;
  const when = p.status === 'Completed' ? { text: 'Completed', cls: 'ok' } : p.status === 'Cancelled' ? { text: 'Cancelled', cls: '' }
    : days === null ? { text: 'No due date', cls: '' } : days < 0 ? { text: `${plural(-days, 'day')} overdue`, cls: 'late' } : days === 0 ? { text: 'Due today', cls: 'risk' }
    : { text: `${plural(days, 'day')} left`, cls: tone === 'ok' ? 'ok' : tone === 'late' ? 'late' : tone === 'risk' ? 'risk' : '' };
  const chips = (docs.data?.items ?? []).slice(0, 3);
  const goWork = (extra: Record<string, string> = {}) => setParams({ tab: 'work', ...extra });
  const askAbout = () => useAssistant.getState().ask(`About project ${p.name} (${p.key}): give me a short status summary — what is done, what is late and why, and what to do next.`);

  return (
    <div className="pp-overview">
      <div className="pp-cards">
        <section className="pp-summary" aria-label="Summary">
          <AiCard title="Summary" action={ai ? { label: p.health === 'AtRisk' || p.health === 'Delayed' ? 'Ask why' : 'Ask more', onClick: askAbout } : undefined}>
            <span className="pp-summary-text">{summarise(detail, r)}</span>
            {chips.length > 0 && (
              <span className="pp-chips">
                {chips.map((d) => <Link key={d.id} className="ds-pill" to={`/library/docs/${d.id}`}>{DOC_LABEL[d.typeCode] ?? d.typeName} · {DOC_STATUS[d.status]}</Link>)}
              </span>
            )}
          </AiCard>
        </section>
        <section className="pp-ring card" aria-label="Progress and dates">
          <Ring value={p.progress} tone={ringTone} size={92} stroke={9} label={`${p.progress}% of the tasks done`} />
          <div className="pp-ring-text">
            <b>{s.done} of {plural(live, 'task')}</b>
            <span>{dayMonth(p.startDate)} → {dayMonth(p.dueDate)}</span>
            <em className={when.cls}>{when.text}</em>
          </div>
        </section>
      </div>

      <div className="ds-kpis pp-kpis">
        <Kpi tile label="Open work" value={Math.max(0, live - s.done)} caption={s.inProgress ? `${s.inProgress} in progress` : undefined} onClick={() => goWork()} />
        <Kpi tile label="Overdue" value={s.overdue} tone={s.overdue ? 'danger' : undefined} onClick={() => goWork()} />
        <Kpi tile label="Open issues" value={openIssues} tone={openIssues ? 'warning' : undefined} onClick={() => goWork({ kind: 'issue' })} />
        <Kpi tile label="People" value={p.memberCount ?? detail.members.length} caption={p.owner ? `Led by ${p.owner.name}` : undefined} onClick={onSettings} />
      </div>

      <section className="card pp-stages" aria-label="Stages">
        <div className="pp-stages-head">
          <h3>Stages</h3>
          {(detail.stages.length > 0 || canEdit) && p.deliveryMethod !== 'Agile' && (
            <button type="button" className="link-btn" aria-expanded={plan} onClick={() => setPlan(!plan)}>{plan ? 'Hide the plan' : canEdit ? 'Plan and dates ›' : 'Dates ›'}</button>
          )}
        </div>
        {detail.stages.length === 0 ? <p className="muted pp-none">No stages yet.{canEdit && p.deliveryMethod !== 'Agile' ? ' Open the plan to add them.' : ''}</p> : (
          <ol className="pp-stage-chips">
            {[...detail.stages].sort((a, b) => a.order - b.order).map((st) => {
              const status = st.effectiveStatus;
              const cls = status === 'Completed' ? 'done' : status === 'InProgress' ? 'now' : status === 'Delayed' ? 'late' : '';
              return (
                <li key={st.id} className={`pp-stage ${cls}`} title={`${st.name}: ${status === 'Pending' ? (st.locked ? `waits for ${st.lockedBy ?? 'the stage before'}` : 'not started') : status === 'InProgress' ? 'in progress' : status.toLowerCase()}${st.openIssues ? ` · ${plural(st.openIssues, 'open issue')}` : ''}`}>
                  {status === 'Completed' ? '✓ ' : ''}{st.name}{st.openIssues > 0 && <em aria-label={`${st.openIssues} open issues`}>{st.openIssues}</em>}
                </li>
              );
            })}
          </ol>
        )}
      </section>
      {plan && p.deliveryMethod !== 'Agile' && (
        <Timeline projectId={p.id} projectName={p.name} project={p} stages={detail.stages} canEdit={canEdit && p.status !== 'Archived'} canReportIssue={canReportIssue}
          taskProgress={p.progress} finished={finished} onShowIssues={() => goWork({ kind: 'issue' })} onReportIssue={onReportIssue} />
      )}
      {late && <p className="pp-late-note"><Icon name="alert" size={14} /> Past its due date with {p.progress}% done. Accept a new date on <Link to="/work/projects?view=portfolio">Portfolio ›</Link></p>}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------------------------ Activity

/** History, and the project agent as one switch (its proposals to review under it; how it behaves is set in Settings › AI). */
function Activity({ projectId, archived, agent, history }: { projectId: string; archived: boolean; agent: boolean; history: boolean }) {
  const a = useWsQuery(['agent', 'project', projectId], () => agentApi.get(projectId), { enabled: agent, retry: false });
  return (
    <div className="pp-activity">
      {agent && <ProjectAgentSwitch projectId={projectId} archived={archived} />}
      {agent && a.data?.enabled && (
        <section className="card pp-proposals" aria-label="From the agent">
          <h3>From the agent{a.data.pending > 0 && <span> · {a.data.pending} to review</span>}</h3>
          <ProjectAgentQueue projectId={projectId} archived={archived} />
        </section>
      )}
      {history && <ActivityTab projectId={projectId} />}
    </div>
  );
}
