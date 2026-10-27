import { useQueries } from '@tanstack/react-query';
import { motion, useReducedMotion } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { agentApi, documentApi, projectApi, timeApi } from '../../api/endpoints';
import { releaseApi, type Release } from '../../api/qualityApi';
import type { DocumentStatus, Project, ProjectDetail, Stage } from '../../api/types';
import { Icon } from '../../components/Icon';
import { openNew } from '../../components/v2/state';
import { ErrorState, PageLoader, Segmented } from '../../components/ui';
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
import { pinItem, usePins } from '../../components/v2/pins';
import { TaskModal } from '../tasks/TaskModal';
import { ProjectTime } from '../time/ProjectTime';
import { ProjectWorkTab } from '../work/ProjectWorkTab';
import { usePortfolioBrief, WhatIf } from './PortfolioInsights';
import { ProjectDocs } from './ProjectDocs';
import { ProjectFormModal } from './ProjectFormModal';
import { ProjectSettingsModal, type ProjectSettingsTab } from './ProjectSettingsModal';
import { ActivityTab } from './ProjectTabs';
import { dayMonth, errText, Initials, isFinished, passGradient, passStatus } from './projectParts';
import { HealthBanner, HealthSheet } from './ProjectHealth';
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
  const pins = usePins();
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
  const [healthOpen, setHealthOpen] = useState(false);
  const [scheduling, setScheduling] = useState(false);
  const [importing, setImporting] = useState(false);
  const [risk, setRisk] = useState(false);
  const [whatIf, setWhatIf] = useState(false);
  const [reporting, setReporting] = useState<{ stageId?: string } | null>(null);
  const still = useReducedMotion();
  const signOff = useSignOff(id);
  const [plan, setPlanState] = useState(() => { try { return localStorage.getItem('pm_pp_plan') === '1'; } catch { return false; } });
  const setPlan = (v: boolean) => { setPlanState(v); try { localStorage.setItem('pm_pp_plan', v ? '1' : '0'); } catch { /* storage unavailable */ } };

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
    return <Navigate to={`/messages?f=meetings&s=upcoming&project=${id}${m ? `&open=p:${m}` : ''}`} replace />;
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
  const grad = passGradient(p);
  const share = async () => {
    const url = window.location.href.split('?')[0];
    try { await navigator.clipboard.writeText(url); toast('Link copied. Anyone with access to the project can open it.'); }
    catch { toast(url, 'info'); }
  };

  return (
    <div className="pp">
      <header className="pp-head">
        <motion.span className="pp-keytile" layoutId={still ? undefined : `pkey-${p.id}`} style={{ background: `linear-gradient(150deg, ${grad[0]}, ${grad[1]})`, ['--c' as string]: grad[1] }} aria-hidden="true">{p.key}</motion.span>
        <div className="pp-head-main">
          <div className="pa-eyebrow pp-eyebrow">{[group, p.dueDate ? `${isFinished(p) ? 'Was due' : 'Due'} ${dayMonth(p.dueDate)}` : 'No due date'].filter(Boolean).join(' · ')}</div>
          <motion.h1 className="page-title" layoutId={still ? undefined : `pname-${p.id}`}>{p.name}</motion.h1>
        </div>
        <div className="pp-actions">
          <ProjectStatePill p={p} />
          <button type="button" className="pa-btn pp-share" onClick={() => void share()}>Share</button>
          <DotsMenu label="More on this project" listClassName="wide" items={[
            { label: 'Add work', icon: 'plus', hint: '+ New, in this project', hidden: !addWork, onSelect: () => openNew('task', '', { id: p.id, name: p.name }) },
            { label: 'Meet', icon: 'video', hint: 'The project’s calls and meetings', onSelect: () => nav(`/messages?f=meetings&s=upcoming&project=${p.id}`) },
            { label: 'Chat', icon: 'message', hint: 'The project’s team chat', hidden: !chatOn, onSelect: () => openChat(p.id, p.name) },
            { label: canEdit ? 'Settings' : 'Members', icon: canEdit ? 'settings' : 'users', hint: canEdit ? 'Members, task workflow and automation' : 'Who is on this project', onSelect: () => setSettings('members') },
            { label: 'Delay risk', icon: 'sparkle', hint: 'How likely it is to be late, and why', hidden: !ai, onSelect: () => setRisk(true) },
            { label: 'What if…', icon: 'target', hint: 'When it finishes if work slips, people join or scope is cut', hidden: isFinished(p), onSelect: () => setWhatIf(true) },
            { label: 'Weekly report', icon: 'note', hint: 'What moved, what slipped, risks, next week', onSelect: () => nav(`/work/projects/${p.id}/report`) },
            { label: 'Set status…', icon: 'flag', hint: 'On track, at risk or late — with why', hidden: !canEdit || isFinished(p), onSelect: () => setHealthOpen(true) },
            { label: 'Edit details', icon: 'edit', hidden: !canEdit, onSelect: () => setEditing(true) },
            { label: 'Schedule studio', icon: 'calendar', hint: 'Stage lengths and the project end', hidden: !(p.deliveryMethod === 'Agile' && canEdit && !archived), onSelect: () => setScheduling(true) },
            { label: 'Import tasks from CSV', icon: 'upload', hidden: !addWork, onSelect: () => setImporting(true) },
            { label: 'Related operational work', icon: 'bolt', hint: 'Tickets that refer to this project', hidden: !seeWork, onSelect: () => nav(`/work?tab=tickets&project=${p.id}`) },
            pinItem(pins, p.id),
            { label: 'Delete project', icon: 'trash', danger: true, hidden: !canDelete, onSelect: () => void remove() },
          ]} />
        </div>
      </header>

      <HealthBanner projectId={p.id} canEdit={canEdit && !archived} onEdit={() => setHealthOpen(true)} />
      {healthOpen && <HealthSheet projectId={p.id} projectName={p.name} onClose={() => setHealthOpen(false)} />}
      <Journey detail={detail} signOff={signOff} still={!!still} canSign={canEdit && !archived} meId={me} plan={plan} onPlan={setPlan} releases={seeWork} />
      {plan && p.deliveryMethod !== 'Agile' && (
        <div className="pp-plan">
          <Timeline projectId={p.id} projectName={p.name} project={p} stages={detail.stages} canEdit={canEdit && p.status !== 'Archived'} canReportIssue={canReportIssue && seeTasks && !archived}
            taskProgress={p.progress} finished={isFinished(p)} onShowIssues={() => setParams({ tab: 'work', kind: 'issue' })} onReportIssue={(stageId) => setReporting({ stageId })} />
        </div>
      )}

      <div className="pp-tabs">
        <Segmented<ProjectTab> label="Project" value={tab} onChange={setTab} options={[
          { id: 'overview', label: 'Overview' }, ...(allowed.includes('work') ? [{ id: 'work' as const, label: 'Work' }] : []), { id: 'docs', label: 'Docs' },
          ...(allowed.includes('time') ? [{ id: 'time' as const, label: 'Time' }] : []), ...(allowed.includes('activity') ? [{ id: 'activity' as const, label: 'Activity' }] : []),
        ]} />
        <AiLine detail={detail} />
      </div>

      {archived && <div className="form-warn"><Icon name="alert" size={14} /> This project is archived and read-only. Edit it and change the status to restore it.</div>}

      <div className="pp-body" data-tab={tab}>
        {tab === 'overview' && <Overview detail={detail} signOff={signOff} canSign={canEdit && !archived} meId={me} seeTime={canReports && seeTasks} onSettings={() => setSettings('members')} />}
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

/** The honest state beside the title: amber "100% work · N sign-offs pending" when the work is done but stages are unsigned, else the one status. */
function ProjectStatePill({ p }: { p: Project }) {
  const pending = p.pendingSignOffs ?? 0;
  if ((p.progress >= 100 || p.status === 'Completed') && pending > 0)
    return <span className="pp-honest risk" title="Every task is done; the remaining stages still need sign-off">100% work · {plural(pending, 'sign-off')} pending</span>;
  const st = passStatus(p);
  return <span className={`pp-honest ${st.tone}`}>{st.label}</span>;
}

const ordered = (stages: Stage[]) => [...stages].sort((a, b) => a.order - b.order);
const signedOff = (s: Stage) => s.effectiveStatus === 'Completed';
const awaiting = (s: Stage) => s.taskTotal > 0 && s.taskDone >= s.taskTotal;
const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
/** Who signs a stage off: its owner, else its assignee, else the project's owner. */
const signerOf = (s: Stage, p: Project) => s.owner ?? s.assignee ?? p.owner;

/** Sign a stage off: it becomes Completed today, everything else about it unchanged. */
type SignOff = ReturnType<typeof useSignOff>;
function useSignOff(projectId: string) {
  const wid = useWorkspaceId();
  const [signing, setSigning] = useState<string | null>(null);
  const [signed, setSigned] = useState<string[]>([]);
  const sign = async (s: Stage) => {
    if (!(await confirmDialog({ title: `Sign off ${s.name}?`, message: `${s.taskDone} of ${plural(s.taskTotal, 'item')} done${s.openIssues ? `, ${plural(s.openIssues, 'open issue')}` : ''}. Signing off marks the stage complete today.`, confirmText: 'Sign off', danger: false }))) return;
    setSigning(s.id);
    try {
      await projectApi.updateStage(projectId, s.id, {
        name: s.name, status: 'Completed', plannedStart: s.plannedStart, plannedEnd: s.plannedEnd, actualStart: s.actualStart ?? s.plannedStart ?? todayIso(), actualEnd: todayIso(),
        ownerId: s.owner?.id ?? null, assigneeId: s.assignee?.id ?? null, description: s.description, durationDays: s.durationDays ?? null,
      });
      setSigned((x) => [...x, s.id]);
      toast(`${s.name} signed off.`);
      void invalidateWorkspace(wid);
    } catch (e) { toast(errText(e, `Could not sign off ${s.name}.`), 'error'); }
    finally { setSigning(null); }
  };
  return { sign, signing, signed };
}

/**
 * The Journey (s-project): the stages on one line. Signed-off stages are filled with a check, the signer's avatar and the date; the current
 * stage glows ("Awaiting sign-off" once its work is done); later ones are hollow with their start date. Signing off fills the node (200ms),
 * draws the line to it (500ms) and hands the glow to the next stage (300ms).
 */
function Journey({ detail, still, canSign, meId, plan, onPlan, signOff, releases }: { detail: ProjectDetail; signOff: SignOff; still: boolean; canSign: boolean; meId: string; plan: boolean; onPlan: (v: boolean) => void; releases?: boolean }) {
  const p = detail.project;
  const { sign, signing, signed } = signOff;
  const stages = ordered(detail.stages);
  const done = (s: Stage) => signedOff(s) || signed.includes(s.id);
  const curIdx = stages.findIndex((s) => !done(s));
  const cur = curIdx >= 0 ? stages[curIdx] : null;
  let lead = 0; while (lead < stages.length && done(stages[lead])) lead++;
  const n = stages.length;
  const pos = (i: number) => (n > 1 ? (i / (n - 1)) * 100 : 50);
  const signer = cur ? signerOf(cur, p) : null;
  const since = cur ? (curIdx > 0 ? stages[curIdx - 1].actualEnd : null) ?? cur.actualStart ?? cur.plannedStart : null;
  const waitDays = since ? -(daysUntil(since) ?? 0) : null;
  const note = !n ? 'No stages yet' : !cur ? 'Every stage is signed off'
    : awaiting(cur) ? `${cur.name} is waiting on ${signer ? (signer.id === meId ? 'your' : `${signer.name}’s`) : 'a'} sign-off${waitDays && waitDays > 0 ? ` · ${plural(waitDays, 'day')}` : ''}`
    : `${cur.name} · ${cur.taskDone} of ${plural(cur.taskTotal, 'item')} done${cur.plannedEnd ? ` · ends ${dayMonth(cur.plannedEnd)}` : ''}`;
  const ref = useRef<HTMLDivElement>(null);
  return (
    <motion.section className="card pp-journey" aria-label="Journey" layoutId={still ? undefined : `pdots-${p.id}`}>
      <div className="pp-stages-head pp-journey-head">
        <h3>Journey</h3>
        <span className="pp-journey-note">
          {note}
          {p.deliveryMethod !== 'Agile' && <button type="button" className="link-btn" aria-expanded={plan} onClick={() => onPlan(!plan)}>{plan ? 'Hide plan' : 'Plan and dates ›'}</button>}
        </span>
      </div>
      {n > 0 && (
        <div className="pp-jl-scroll">
          <div className="pp-jl" ref={ref} style={{ ['--n' as string]: n }}>
            <div className="pp-rail" />
            <div className="pp-done" style={{ width: lead > 1 ? `${pos(lead - 1)}%` : 0 }} />
            <ol>
              {stages.map((s, i) => {
                const isDone = done(s), isCur = i === curIdx;
                const who = signerOf(s, p);
                const sub = isDone ? dayMonth(signedOff(s) ? s.actualEnd ?? s.plannedEnd : todayIso())
                  : isCur ? (awaiting(s) ? 'Awaiting sign-off' : s.effectiveStatus === 'Delayed' ? 'Late' : s.effectiveStatus === 'InProgress' ? 'In progress' : s.plannedStart ? dayMonth(s.plannedStart) : 'Next')
                  : i === n - 1 && s.plannedEnd ? `to ${dayMonth(s.plannedEnd)}` : dayMonth(s.plannedStart ?? s.plannedEnd);
                return (
                  <li key={s.id} className={`pp-nd ${isDone ? 's' : ''} ${isCur ? 'cur' : ''} ${isCur && awaiting(s) ? 'wait' : ''} ${signing === s.id ? 'press' : ''}`} style={{ left: `${pos(i)}%` }}
                    data-stage={s.name} aria-label={`${s.name}: ${isDone ? `signed off ${sub}` : isCur ? sub : `stage ${i + 1}, ${sub}`}`}>
                    <span className="pp-nd-c">
                      {isDone ? <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg> : i + 1}
                      {isDone && who && <Initials name={who.name} seed={who.id} userId={who.id} className="pp-nd-av" />}
                    </span>
                    <b>{s.name}</b>
                    <small>{sub}</small>
                    {isCur && canSign && awaiting(s) && !s.locked && <button type="button" className="pp-sr" onClick={() => void sign(s)}>Sign off {s.name}</button>}
                  </li>
                );
              })}
            </ol>
          </div>
          {releases && <JourneyReleases projectId={p.id} stages={stages} n={n} pos={pos} />}
        </div>
      )}
      {n === 0 && releases && <div className="pp-jl-scroll"><JourneyReleases projectId={p.id} stages={[]} n={1} pos={() => 50} /></div>}
    </motion.section>
  );
}

const dayNum = (d: string) => Math.floor(new Date(`${d}T00:00:00Z`).getTime() / 86_400_000);
/** Where a date sits on the Journey: between the stage nodes whose dates bracket it (nodes are evenly spaced, so the scale is piecewise). */
function journeyPos(date: string | null, anchors: { day: number; at: number }[], fallback: number): number {
  if (!date || anchors.length === 0) return fallback;
  const d = dayNum(date);
  if (anchors.length === 1 || d <= anchors[0].day) return anchors[0].at;
  for (let k = 1; k < anchors.length; k++) {
    const a = anchors[k - 1], b = anchors[k];
    if (d <= b.day) return b.day === a.day ? b.at : a.at + ((d - a.day) / (b.day - a.day)) * (b.at - a.at);
  }
  return anchors[anchors.length - 1].at;
}

type RelState = { label: string; tone: 'go' | 'nogo' | 'ok' | 'done' };
function relState(r: Release, go: boolean | undefined): RelState {
  if (r.status === 'Shipped') return { label: `Shipped${r.shippedAt ? ` ${dayMonth(r.shippedAt.slice(0, 10))}` : ''}`, tone: 'done' };
  if (r.status === 'Approved') return { label: 'Approved', tone: 'ok' };
  return go === undefined ? { label: 'Planned', tone: 'ok' } : go ? { label: 'Go', tone: 'go' } : { label: 'No go', tone: 'nogo' };
}

/**
 * The project's releases on the Journey: a lane under the stages, each release a flag at its date (shipped ones at the day they shipped)
 * with its go/no-go, linking to the release in Quality. The last two shipped and every one still to come.
 */
function JourneyReleases({ projectId, stages, n, pos }: { projectId: string; stages: Stage[]; n: number; pos: (i: number) => number }) {
  const list = useWsQuery(['quality', 'releases', 'project', projectId], () => releaseApi.list(projectId), { staleTime: 30_000, retry: false });
  const all = list.data ?? [];
  const shipped = all.filter((r) => r.status === 'Shipped').sort((a, b) => (b.shippedAt ?? '').localeCompare(a.shippedAt ?? '')).slice(0, 2);
  const coming = all.filter((r) => r.status !== 'Shipped').slice(0, 4);
  const shown = [...shipped.reverse(), ...coming];
  const planned = coming.filter((r) => r.status === 'Planned').map((r) => r.id);
  const wid = useWorkspaceId();
  const states = useQueries({ queries: planned.map((id) => ({ queryKey: [wid, 'quality', 'release', id], enabled: !!wid, queryFn: () => releaseApi.get(id), staleTime: 30_000, retry: false })) });
  const goOf = (id: string) => { const k = planned.indexOf(id); return k < 0 ? undefined : states[k]?.data?.go; };
  if (shown.length === 0) return null;
  const anchors = stages.map((s, i) => ({ d: i === stages.length - 1 ? s.plannedEnd ?? s.plannedStart : s.plannedStart ?? s.plannedEnd, at: pos(i) }))
    .filter((a): a is { d: string; at: number } => !!a.d).map((a) => ({ day: dayNum(a.d), at: a.at })).sort((a, b) => a.day - b.day);
  const placed = shown.map((r, k) => {
    const when = r.status === 'Shipped' ? r.shippedAt?.slice(0, 10) ?? r.targetDate : r.targetDate;
    return { r, when, at: journeyPos(when ?? null, anchors, shown.length === 1 ? 50 : (k / (shown.length - 1)) * 100) };
  }).sort((a, b) => a.at - b.at);
  // Flags closer than ~a label apart alternate above and below the lane, so their names never sit on each other.
  let last = -Infinity, flip = false;
  const rows = placed.map((x) => { flip = x.at - last < 14 ? !flip : false; last = x.at; return { ...x, low: flip }; });
  return (
    <div className="pp-jr" style={{ ['--n' as string]: n }} aria-label="Releases">
      <span className="pp-jr-rail" aria-hidden="true" />
      <ol>
        {rows.map(({ r, when, at, low }) => {
          const st = relState(r, goOf(r.id));
          return (
            <li key={r.id} className={`pp-rel ${st.tone} ${low ? 'low' : ''} ${at < 6 ? 'start' : at > 94 ? 'end' : ''}`} style={{ left: `${at}%` }}>
              <Link to={`/quality?release=${encodeURIComponent(r.id)}`} aria-label={`Release ${r.name}: ${st.label}${when ? `, ${dayMonth(when)}` : ''}`}>
                <span className="pp-rel-flag" aria-hidden="true" />
                <b>{r.name}</b>
                <small><i>{st.label}</i>{r.status !== 'Shipped' && when ? ` · ${dayMonth(when)}` : ''}</small>
              </Link>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** The one AI line beside the tabs: the gap when the work is done but stages are not, otherwise the summary's first sentence. */
function AiLine({ detail }: { detail: ProjectDetail }) {
  const p = detail.project;
  const ai = useAi();
  const brief = usePortfolioBrief();
  const r = brief.data?.ranked?.find((x) => x.projectId === p.id);
  const live = p.stats.total - p.stats.cancelled, pending = p.pendingSignOffs ?? 0;
  const gap = pending > 0 && (p.progress >= 100 || p.status === 'Completed') && live > 0;
  const text = gap ? `All ${live} items closed — the gap is paperwork, not code.` : firstSentences(summarise({ ...detail, project: { ...p, description: null } }, r), 110);
  const ask = (q: string) => useAssistant.getState().ask(q);
  return (
    <div className="pp-ai" role="note" aria-label="From the assistant">
      <span className="pa-orb" aria-hidden="true" />
      <span className="pp-ai-text">{text}</span>
      {ai && (gap
        ? <button type="button" className="pa-btn sm" onClick={() => ask(`Draft a short message asking for the ${plural(pending, 'pending sign-off')} on project ${p.name} (${p.key}), stage by stage, with who signs each.`)}>Request {plural(pending, 'sign-off')}</button>
        : <button type="button" className="pa-btn sm" onClick={() => ask(`About project ${p.name} (${p.key}): give me a short status summary — what is done, what is late and why, and what to do next.`)}>Ask more</button>)}
    </div>
  );
}

const DOC_SHORT: Record<string, string> = { API: 'API', BRD: 'BRD', ARCH: 'ARCH', TECH: 'TECH', TEST_PLAN: 'TEST', ARTIFACT: 'FILE' };

/** Overview (s-project): Key numbers and People · What's next (with Sign off) · Risks and Docs. */
function Overview({ detail, canSign, meId, seeTime, onSettings, signOff }: { detail: ProjectDetail; signOff: SignOff; canSign: boolean; meId: string; seeTime: boolean; onSettings: () => void }) {
  const p = detail.project;
  const [, setParams] = useSearchParams();
  const brief = usePortfolioBrief();
  const r = brief.data?.ranked?.find((x) => x.projectId === p.id);
  const docsLevel = useModule('documents');
  const docs = useWsQuery(['documents', 'project', p.id], () => documentApi.list({ projectId: p.id, limit: 100 }), { enabled: docsLevel > 0, staleTime: 20_000 });
  const time = useWsQuery(['project', p.id, 'time'], () => timeApi.project(p.id), { enabled: seeTime, retry: false });
  const { sign, signing, signed } = signOff;
  const s = p.stats, live = s.total - s.cancelled;
  const finished = isFinished(p);
  const days = daysUntil(p.dueDate);
  const late = !finished && days !== null && days < 0 && p.progress < 100;
  const pending = p.pendingSignOffs ?? 0;
  const stages = ordered(detail.stages);
  const curIdx = stages.findIndex((x) => !signedOff(x) && !signed.includes(x.id));
  const cur = curIdx >= 0 ? stages[curIdx] : null;
  const openIssues = detail.stages.reduce((n, x) => n + x.openIssues, 0);
  const hours = typeof time.data?.totalMinutes === 'number' ? Math.round(time.data!.totalMinutes / 60) : null;
  const est = time.data?.estimatedHours ?? null;

  const next: { key: string; title: string; sub: string; action?: Stage }[] = [];
  if (cur) {
    const who = signerOf(cur, p);
    if (awaiting(cur)) next.push({ key: cur.id, title: `Sign off ${cur.name}`, sub: `${who ? (who.id === meId ? 'You' : who.name) : 'No owner'} · ${cur.taskDone} of ${plural(cur.taskTotal, 'item')} done`, action: canSign && !cur.locked ? cur : undefined });
    else next.push({ key: cur.id, title: `Finish ${cur.name}`, sub: `${who?.name ?? 'No owner'} · ${cur.taskDone} of ${plural(cur.taskTotal, 'item')} done${cur.plannedEnd ? ` · ends ${dayMonth(cur.plannedEnd)}` : ''}` });
    for (const x of stages.slice(curIdx + 1, curIdx + 5)) {
      const who2 = x.assignee ?? x.owner;
      next.push({ key: x.id, title: x.name, sub: [who2?.name ?? 'Unassigned', x.plannedStart ? `starts ${dayMonth(x.plannedStart)}` : null, x.taskTotal ? plural(x.taskTotal, 'item') : null].filter(Boolean).join(' · ') });
    }
  }

  const risks: { key: string; title: string; sub: string; tone: 'risk' | 'late' }[] = [];
  if (pending > 0 && (p.progress >= 100 || p.status === 'Completed')) risks.push({ key: 'signoffs', title: 'Sign-offs stall go-live', sub: days !== null && days >= 0 ? `${plural(pending, 'stage')} in ${plural(days, 'day')}` : `${plural(pending, 'stage')} unsigned`, tone: 'risk' });
  if (late) risks.push({ key: 'late', title: `Past its due date`, sub: `${plural(-days!, 'day')} over · ${p.progress}% done`, tone: 'late' });
  if (r?.projectedFinish && (r.projectedSlipDays ?? 0) > 0 && !finished) risks.push({ key: 'forecast', title: `Forecast ${dayMonth(r.projectedFinish)}`, sub: `${plural(r.projectedSlipDays!, 'day')} after the due date`, tone: 'risk' });
  if (s.overdue > 0) risks.push({ key: 'overdue', title: `${plural(s.overdue, 'overdue item')}`, sub: 'Open in Work', tone: 'late' });
  if (openIssues > 0) risks.push({ key: 'issues', title: `${plural(openIssues, 'open issue')}`, sub: 'They keep their stages from completing', tone: 'risk' });
  for (const [i, why] of (r?.reasons ?? []).slice(0, 2).entries()) if (p.health !== 'OnTrack') risks.push({ key: `why${i}`, title: `${why[0].toUpperCase()}${why.slice(1)}`, sub: 'From the portfolio forecast', tone: 'risk' });
  const people = [...detail.members].sort((a, b) => (a.userId === p.owner?.id ? -1 : b.userId === p.owner?.id ? 1 : 0));
  const docItems = (docs.data?.items ?? []).slice(0, 3);

  return (
    <div className="pp-ov">
      <div className="pp-col">
        <section className="card pp-box" aria-label="Key numbers">
          <div className="pp-hd"><h3>Key numbers</h3>{p.startDate && <span className="pp-faint">since {dayMonth(p.startDate)}</span>}</div>
          <div className="pp-nums">
            <button type="button" onClick={() => setParams({ tab: 'work' })}><span className="n">{s.done}<span className="pp-faint pp-of"> / {live}</span></span><span className="l">Work items done</span></button>
            <div><span className={`n ${late ? 'late' : ''}`}>{days === null ? '—' : Math.abs(days)}</span><span className="l">{days === null ? 'No due date' : days < 0 ? 'Days past due date' : 'Days to due date'}</span></div>
            <div><span className="n">{hours === null ? '—' : `${hours}h`}</span><span className="l">{hours === null ? 'Logged' : `Logged${est ? ` · ${Math.round((hours / est) * 100)}% of estimate` : ''}`}</span></div>
            <div><span className={`n ${pending ? 'warn' : ''}`}>{pending}</span><span className="l">Sign-offs pending</span></div>
          </div>
        </section>
        <section className="card pp-box" aria-label="People">
          <div className="pp-hd"><h3>People</h3><button type="button" className="pp-faint pp-linkish" onClick={onSettings}>{people.length}</button></div>
          <div className="pp-people-grid">
            {people.slice(0, 8).map((m) => (
              <span key={m.userId} className="pp-person"><Initials name={m.name} seed={m.userId} userId={m.userId} /><span><b>{m.name}</b><span className="pp-faint">{m.userId === p.owner?.id ? 'Owner' : m.role ?? 'Member'}</span></span></span>
            ))}
            {people.length === 0 && <span className="pp-faint">No one yet.</span>}
          </div>
        </section>
      </div>

      <section className="card pp-box" aria-label="What's next">
        <div className="pp-hd"><h3>What’s next</h3></div>
        {next.length === 0 ? <p className="pp-faint pp-none">{stages.length ? 'Every stage is signed off.' : 'No stages yet. Open Plan and dates to add them.'}</p> : next.map((x) => (
          <div key={x.key} className="pp-li">
            <span className="pp-chk" aria-hidden="true" />
            <span className="pp-tx"><b>{x.title}</b><span>{x.sub}</span></span>
            {x.action && <button type="button" className="pa-btn sm pri" disabled={signing === x.action.id} onClick={() => void sign(x.action!)}>Sign off</button>}
          </div>
        ))}
      </section>

      <div className="pp-col">
        <section className="card pp-box" aria-label="Risks">
          <div className="pp-hd"><h3>Risks</h3>{risks.length > 0 && <span className="pp-count">{risks.length}</span>}</div>
          {risks.length === 0 ? <p className="pp-faint pp-none">Nothing stands out.</p> : risks.slice(0, 4).map((x) => (
            <div key={x.key} className="pp-li"><span className={`pp-dt ${x.tone}`} aria-hidden="true" /><span className="pp-tx"><b>{x.title}</b><span>{x.sub}</span></span></div>
          ))}
        </section>
        {docsLevel > 0 && (
          <section className="card pp-box" aria-label="Docs">
            <div className="pp-hd"><h3>Docs</h3><span className="pp-faint">{docs.data?.total ?? docs.data?.items?.length ?? 0}</span></div>
            {docItems.length === 0 ? <p className="pp-faint pp-none">No documents yet.</p> : docItems.map((d) => (
              <Link key={d.id} to={`/library/docs/${d.id}`} className="pp-li pp-docrow">
                <span className="pp-doc" aria-hidden="true">{DOC_SHORT[d.typeCode] ?? d.typeCode.slice(0, 4)}</span>
                <span className="pp-tx"><b>{d.title}</b><span>{DOC_LABEL[d.typeCode] ?? d.typeName} · {DOC_STATUS[d.status]}</span></span>
              </Link>
            ))}
          </section>
        )}
      </div>
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
