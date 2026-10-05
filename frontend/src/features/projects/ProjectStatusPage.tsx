import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { actionItemApi, projectApi, statusApi } from '../../api/endpoints';
import type { ProjectHealth, ProjectStatusReport, StatusGroup, StatusTask, TimelineChange } from '../../api/types';
import { Icon } from '../../components/Icon';
import { activeShare, Avatar, ErrorState, HealthBadge, PageLoader, Progress, ProjectStatusBadge, ProjectTypeBadge } from '../../components/ui';
import { formatDate, formatDateTime } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useTeamLens } from '../../lib/teamLens';
import { useModule, useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { TaskModal } from '../tasks/TaskModal';
import { ActionItemsPanel } from './ActionItemsPanel';
import { PortfolioBriefPanel, ProjectInsight } from './PortfolioInsights';

const HEALTH_LABEL: Record<ProjectHealth, string> = { OnTrack: 'On track', AtRisk: 'At risk', Delayed: 'Delayed', Completed: 'Completed', Cancelled: 'Cancelled', Archived: 'Archived' };
const days = (n: number) => `${Math.abs(n)} day${Math.abs(n) === 1 ? '' : 's'}`;

/**
 * Portfolio (formerly Project Status), the presentation page: the projects organized by group on the left (collapsed accordions), and for the selected project a clear
 * status view on the right: its dates, its tasks, and every change of a delivery date with who / when / from / to / why / what it depended on.
 */
export function ProjectStatusPage() {
  const [params, setParams] = useSearchParams();
  const selected = params.get('project');
  const { teamId, team } = useTeamLens();
  const groups = useWsQuery(['project-status', 'groups', teamId], () => statusApi.groups(teamId), { refetchInterval: 60_000, placeholderData: (prev) => prev });
  const [openId, setOpenId] = useState<string | null>(null);            // one group open at a time; they all start collapsed
  const [listOpen, setListOpen] = useState(true);                       // small screens: the list, or just the chosen project
  const openedFor = useRef<string | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);          // the task whose details are open
  const actionsOpen = params.get('actions') === '1' && !!selected;
  const setActionsOpen = (on: boolean) => { const n = new URLSearchParams(params); if (on) n.set('actions', '1'); else n.delete('actions'); setParams(n, { replace: true }); };

  const current = useMemo(() => groups.data?.flatMap((g) => g.projects).find((p) => p.id === selected) ?? null, [groups.data, selected]);

  // A project chosen from a link opens its group (only that one), so the highlighted row is visible. This happens once per chosen project:
  // the list refreshes by itself every minute, and that must not re-open a group the person has since closed or replaced with another.
  useEffect(() => {
    if (!selected || !groups.data || openedFor.current === selected) return;
    const g = groups.data.find((x) => x.projects.some((p) => p.id === selected));
    openedFor.current = selected;
    if (g) setOpenId(g.id);
  }, [selected, groups.data]);
  useEffect(() => { if (selected) setListOpen(false); }, [selected]);

  // Opening a group closes the one that was open; clicking the open group closes it.
  const toggle = (id: string) => setOpenId((cur) => (cur === id ? null : id));
  const goHome = () => { const n = new URLSearchParams(params); n.delete('project'); n.delete('actions'); setParams(n, { replace: true }); setListOpen(true); };
  const pick = (id: string) => { const n = new URLSearchParams(params); n.set('project', id); setParams(n, { replace: true }); setListOpen(false); };

  if (groups.isLoading) return <PageLoader />;
  if (groups.isError || !groups.data) return <ErrorState error={groups.error} retry={() => groups.refetch()} />;
  const total = groups.data.reduce((n, g) => n + g.count, 0);

  return (
    <div className={`ps ${selected && !listOpen ? 'has-panel' : ''}`}>
      <aside className="ps-side" aria-label="Projects">
        <div className="ps-side-head">
          <div><h2>Projects</h2><span>{total} in {groups.data.length} group{groups.data.length === 1 ? '' : 's'}{team ? ` · ${team.name}` : ''}</span></div>
          {selected && <button type="button" className="ps-side-toggle btn btn-ghost btn-sm" aria-expanded={listOpen} onClick={() => setListOpen((v) => !v)}>
            {listOpen ? 'Hide list' : `${current?.name ?? 'Projects'}`} <Icon name="chevronD" size={14} /></button>}
        </div>
        <button type="button" className={`ps-home ${selected ? '' : 'active'}`} aria-current={selected ? undefined : 'page'} onClick={goHome}><Icon name="monitor" size={15} /> Portfolio today</button>
        <div className={`ps-groups ${selected && !listOpen ? 'tucked' : ''}`}>
          {groups.data.length === 0 && <p className="ps-empty-list">No projects yet. Create one from the Projects page.</p>}
          {groups.data.map((g) => <GroupSection key={g.id} group={g} open={openId === g.id} selected={selected} onToggle={() => toggle(g.id)} onPick={pick} />)}
        </div>
      </aside>

      <section className="ps-main" aria-live="polite">
        {selected ? <StatusPanel key={selected} projectId={selected} onOpenTask={setTaskId} onActionItems={() => setActionsOpen(true)} /> : <PortfolioBriefPanel onPick={pick} />}
      </section>

      {selected && <ActionItemsPanel open={actionsOpen} projectId={selected} projectName={current?.name ?? 'Project'} onClose={() => setActionsOpen(false)} />}
      {taskId && <TaskModal taskId={taskId} onClose={() => setTaskId(null)} />}
    </div>
  );
}

// ------------------------------------------------------------------ the accordion
function GroupSection({ group, open, selected, onToggle, onPick }: { group: StatusGroup; open: boolean; selected: string | null; onToggle: () => void; onPick: (id: string) => void }) {
  const holdsSelected = group.projects.some((p) => p.id === selected);
  return (
    <div className={`ps-group ${open ? 'open' : ''}`}>
      <button type="button" className={`ps-group-head ${holdsSelected ? 'holds' : ''}`} aria-expanded={open} onClick={onToggle}>
        <Icon name="chevronR" size={15} />
        <span className="ps-group-label"><span className="ps-group-name">{group.name}</span><em>{' '}({group.count})</em></span>
      </button>
      <div className="ps-group-body" aria-hidden={!open}>
        <div className="ps-group-inner">
          {group.projects.map((p) => (
            <button key={p.id} type="button" className={`ps-proj ${p.id === selected ? 'active' : ''}`} onClick={() => onPick(p.id)} tabIndex={open ? 0 : -1}
              aria-current={p.id === selected ? 'true' : undefined} title={`${p.name} · ${HEALTH_LABEL[p.health]}`}>
              <i className={`ps-dot ${p.health}`} aria-hidden="true" />
              <span className="ps-proj-name">{p.name}</span>
              <span className="ps-proj-pct" title={p.active > 0 ? `${p.progress}% done · ${p.active}% in progress` : undefined}>{p.progress}%{p.active > 0 && <small className="ps-proj-act"> +{p.active}</small>}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ the selected project
function StatusPanel({ projectId, onOpenTask, onActionItems }: { projectId: string; onOpenTask: (id: string) => void; onActionItems: () => void }) {
  const q = useWsQuery(['project-status', 'report', projectId], () => statusApi.report(projectId), { refetchInterval: 60_000 });
  if (q.isLoading) return <PageLoader />;
  if (q.isError || !q.data) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  return <Report r={q.data} onOpenTask={onOpenTask} onActionItems={onActionItems} />;
}

function Report({ r, onOpenTask, onActionItems }: { r: ProjectStatusReport; onOpenTask: (id: string) => void; onActionItems: () => void }) {
  const p = r.project;
  const canOpenTasks = useModule('tasks') > 0;
  const items = useWsQuery(['action-items', p.id], () => actionItemApi.list(p.id));
  const openItems = (items.data ?? []).filter((i) => i.status !== 'Completed').length;
  const revised = p.originalDueDate && p.dueDate && p.dueDate !== p.originalDueDate;
  const blocked = r.blockedTasks, overdue = r.tasks.filter((t) => t.overdueDays > 0).length;
  const done = p.stats.done, tasksTotal = p.stats.total - p.stats.cancelled;
  const [view, setView] = useState<PsView>(() => { try { const v = localStorage.getItem('pm_ps_view'); return v === 'changes' || v === 'both' ? v : 'tasks'; } catch { return 'tasks'; } });
  const chooseView = (v: PsView) => { setView(v); try { localStorage.setItem('pm_ps_view', v); } catch { /* storage unavailable */ } };
  const [focus, setFocus] = useState(false);
  const [filter, setFilter] = useState<TaskFilter>('all');
  const shownTasks = r.tasks.filter(FILTERS.find((f) => f.id === filter)!.test);
  // Everything is done: closing the project is a decision, so it is offered, never done by itself.
  const readyToClose = tasksTotal > 0 && done === tasksTotal && (p.status === 'Planning' || p.status === 'Active');
  const wid = useWorkspaceId();
  const close = async () => {
    try { await projectApi.move(p.id, { status: 'Completed' }); toast('Project marked completed.'); void invalidateWorkspace(wid, 'project-status'); void invalidateWorkspace(wid, 'projects'); void invalidateWorkspace(wid, 'dashboard'); }
    catch (e) { toast(e instanceof ApiError ? e.errors[0]?.message ?? e.message : 'Could not complete the project.', 'error'); }
  };

  return (
    <div className="ps-panel">
      <header className="ps-head">
        <div className="ps-title">
          {p.groupName && <span className="ps-tag">{p.groupName}</span>}
          <h1>{p.name}</h1>
          {p.description && <p title={p.description}>{p.description}</p>}
        </div>
        <div className="ps-head-right">
          <div className="ps-badges"><ProjectTypeBadge type={p.projectType} /><ProjectStatusBadge status={p.status} /><HealthBadge health={p.health} /></div>
          <div className="ps-buttons">
            <Link className="btn btn-ghost btn-sm ps-go" to={`/projects/${p.id}`} title="Open the project's details page"><Icon name="arrowRight" size={14} /> Go To Project</Link>
            <button type="button" className="btn btn-soft btn-sm" onClick={onActionItems} title="Follow-ups for this project">
              <Icon name="checkCircle" size={14} /> Action Items{openItems > 0 && <span className="ps-count" aria-label={`${openItems} open`}>{openItems}</span>}
            </button>
          </div>
        </div>
      </header>

      {readyToClose && (
        <div className="ps-ready" role="status">
          <Icon name="checkCircle" size={16} /> <span>All {tasksTotal} task{tasksTotal === 1 ? ' is' : 's are'} done. Mark this project completed?</span>
          <button type="button" className="btn btn-primary btn-sm" onClick={close}>Mark completed</button>
        </div>
      )}

      {focus ? (
        <div className="ps-focusline">
          <b>{p.progress}%</b> done{p.stats.inProgress > 0 && <> · {p.stats.inProgress} in progress</>} · due {formatDate(p.dueDate)}{p.delayedDays > 0 && <em className="ps-pill late">+{days(p.delayedDays)}</em>}
          {overdue > 0 && <em className="ps-pill late">{overdue} overdue</em>}{blocked > 0 && <em className="ps-pill wait">{blocked} blocked</em>}
        </div>
      ) : <>
      <ProjectInsight projectId={p.id} onActionItems={onActionItems} />

      <div className="ps-kpis">
        <div className="ps-kpi"><label>Start date</label><b>{formatDate(p.startDate)}</b></div>
        <div className={`ps-kpi ${p.delayedDays > 0 ? 'late' : ''}`}>
          <label>Current due date</label>
          <b>{formatDate(p.dueDate)}</b>
          {revised && (
            <span className="ps-kpi-note">
              <s title="Original due date">{formatDate(p.originalDueDate)}</s>
              {p.delayedDays > 0 && <em className="ps-pill late">+{days(p.delayedDays)}</em>}
              {p.delayedDays === 0 && <em className="ps-pill early">Brought forward</em>}
            </span>
          )}
        </div>
        <div className="ps-kpi"><label>Progress</label><b>{p.progress}%</b><Progress value={p.progress} active={activeShare(p.stats)} />{p.stats.inProgress > 0 && <small className="ps-kpi-note">{p.stats.inProgress} in progress</small>}</div>
        <div className="ps-kpi">
          <label>Tasks</label><b>{done} <small>of {tasksTotal} done</small></b>
          <span className="ps-kpi-note">
            {overdue > 0 && <em className="ps-pill late">{overdue} overdue</em>}
            {blocked > 0 && <em className="ps-pill wait">{blocked} blocked</em>}
            {overdue === 0 && blocked === 0 && <span className="ps-ok"><Icon name="checkCircle" size={13} /> Nothing overdue or blocked</span>}
          </span>
        </div>
      </div>
      </>}

      <div className="ps-viewbar">
        <div className="seg ps-seg" role="tablist" aria-label="What to look at">
          <button type="button" role="tab" aria-selected={view === 'tasks'} className={view === 'tasks' ? 'on' : ''} onClick={() => chooseView('tasks')}>Tasks <em>{r.tasks.length}</em></button>
          <button type="button" role="tab" aria-selected={view === 'changes'} className={view === 'changes' ? 'on' : ''} onClick={() => chooseView('changes')}>
            Delivery changes <em>{r.changes.length}</em>{(blocked > 0 || p.delayedDays > 0) && <i className="ps-alert" title={blocked > 0 ? 'Something is waiting on a dependency' : 'The delivery date has moved'} />}
          </button>
          <button type="button" role="tab" aria-selected={view === 'both'} className={view === 'both' ? 'on' : ''} onClick={() => chooseView('both')}>Side by side</button>
        </div>
        {view !== 'changes' && (
          <div className="ps-chips" role="group" aria-label="Filter the tasks">
            {FILTERS.map((f) => {
              const n = r.tasks.filter(f.test).length;
              if (f.id !== 'all' && n === 0) return null;
              return <button key={f.id} type="button" className={filter === f.id ? 'on' : ''} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>{f.label} <em>{n}</em></button>;
            })}
          </div>
        )}
        <button type="button" className="btn btn-ghost btn-sm ps-focus" aria-pressed={focus} onClick={() => setFocus((v) => !v)} title={focus ? 'Show the summary again' : 'Hide the summary to give the list the whole page'}>
          <span style={{ display: 'inline-flex', transform: focus ? undefined : 'rotate(180deg)' }}><Icon name="chevronD" size={14} /></span> {focus ? 'Show summary' : 'Focus'}
        </button>
      </div>

      <div className={`ps-body ${view}`}>
        {view !== 'changes' && (
          <section className="ps-tasks" aria-label="Tasks">
            <h3>Tasks <em>{shownTasks.length}</em></h3>
            {r.tasks.length === 0 ? <p className="ps-none">No tasks in this project yet.</p> : shownTasks.length === 0 ? <p className="ps-none">No task matches this filter.</p> : (
              <div className="ps-scroll">
                <table className="ps-table">
                  <thead><tr><th>Task</th><th>Assignee</th><th>Start</th><th>Due</th><th>Status</th></tr></thead>
                  <tbody>{shownTasks.map((t) => <TaskRow key={t.id} t={t} onOpen={canOpenTasks ? () => onOpenTask(t.id) : undefined} />)}</tbody>
                </table>
              </div>
            )}
          </section>
        )}

        {view !== 'tasks' && (
          <section className="ps-changes" aria-label="Delivery changes and dependencies">
            <h3>Delivery changes &amp; dependencies <em>{r.changes.length}</em></h3>
            <div className="ps-scroll">
              {blocked > 0 && <BlockedNow tasks={r.tasks.filter((t) => t.blockedBy.length > 0)} />}
              {r.changes.length === 0 && blocked === 0
                ? <div className="ps-onschedule"><Icon name="checkCircle" size={26} /><b>On schedule</b><span>No delivery date has been changed and nothing is waiting on another task.</span></div>
                : <div className={view === 'changes' ? 'ps-changes-grid' : undefined}>{r.changes.map((c) => <ChangeCard key={c.id} c={c} />)}</div>}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

type PsView = 'tasks' | 'changes' | 'both';
type TaskFilter = 'all' | 'open' | 'overdue' | 'blocked' | 'done';
const FILTERS: { id: TaskFilter; label: string; test: (t: StatusTask) => boolean }[] = [
  { id: 'all', label: 'All', test: () => true },
  { id: 'open', label: 'Open', test: (t) => t.statusCategory !== 'Done' && t.statusCategory !== 'Cancelled' },
  { id: 'overdue', label: 'Overdue', test: (t) => t.overdueDays > 0 },
  { id: 'blocked', label: 'Blocked', test: (t) => t.blockedBy.length > 0 },
  { id: 'done', label: 'Done', test: (t) => t.statusCategory === 'Done' },
];

function TaskRow({ t, onOpen }: { t: StatusTask; onOpen?: () => void }) {
  const shifted = t.originalDueDate && t.dueDate && t.originalDueDate !== t.dueDate;
  return (
    <tr className={`${t.parentTaskId ? 'sub' : ''} ${onOpen ? 'click' : ''}`} onClick={onOpen} tabIndex={onOpen ? 0 : undefined} role={onOpen ? 'button' : undefined}
      onKeyDown={onOpen ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } } : undefined} aria-label={onOpen ? `Open ${t.key} ${t.title}` : undefined}>
      <td>
        <div className="ps-task-title"><span className="task-key">{t.key}</span> {t.title}</div>
        {t.blockedBy.length > 0 && <div className="ps-task-note wait"><Icon name="lock" size={12} /> Waiting on {t.blockedBy.map((b) => `${b.key} ${b.title}`).join(', ')}</div>}
      </td>
      <td className="ps-assignee">{t.assignee ? <><Avatar name={t.assignee.name} size="sm" /> <span>{t.assignee.name}</span></> : <span className="muted">Unassigned</span>}</td>
      <td className="ps-date">{formatDate(t.startDate)}</td>
      <td className="ps-date">
        <span className={t.overdueDays > 0 ? 'overdue' : ''}>{formatDate(t.dueDate)}</span>
        {shifted && <span className="ps-rev"><s>{formatDate(t.originalDueDate)}</s>{t.delayedDays > 0 ? <em className="ps-pill late">+{days(t.delayedDays)}</em> : <em className="ps-pill early">earlier</em>}</span>}
        {t.overdueDays > 0 && <span className="ps-rev"><em className="ps-pill late">{days(t.overdueDays)} overdue</em></span>}
      </td>
      <td><span className="ps-status" style={{ '--c': t.statusColor } as React.CSSProperties}>{t.statusName}</span></td>
    </tr>
  );
}

function BlockedNow({ tasks }: { tasks: StatusTask[] }) {
  return (
    <div className="ps-blocked">
      <h4><Icon name="lock" size={14} /> Waiting on a dependency now</h4>
      <ul>
        {tasks.map((t) => (
          <li key={t.id}>
            <b>{t.key}</b> {t.title}
            <span>is waiting on {t.blockedBy.map((b) => `${b.key} ${b.title} (${b.statusName})`).join(' · ')}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ChangeCard({ c }: { c: TimelineChange }) {
  const later = c.daysShifted === null ? c.revised === null : c.daysShifted > 0;
  return (
    <article className={`ps-change ${later ? 'late' : 'early'}`}>
      <header>
        <span className="ps-scope">{c.scope === 'Project' ? 'Project' : c.taskKey}</span>
        <b>{c.title}</b>
        {c.daysShifted !== null && c.daysShifted !== 0 && <em className={`ps-pill ${later ? 'late' : 'early'}`}>{later ? `+${days(c.daysShifted)} delayed` : `${days(c.daysShifted)} earlier`}</em>}
        {c.daysShifted === null && <em className="ps-pill wait">{c.revised ? 'Date set' : 'Date removed'}</em>}
      </header>
      <div className="ps-dates">
        <span className="ps-prev"><small>Previous due date</small><s>{formatDate(c.previous)}</s></span>
        <Icon name="arrowRight" size={16} />
        <span className="ps-new"><small>Revised due date</small><b>{formatDate(c.revised)}</b></span>
      </div>
      <p className="ps-why"><small>Reason</small>{c.reason ?? <i>No reason was recorded.</i>}</p>
      {c.dependency && <p className="ps-why"><small>Dependency</small>{c.dependency}</p>}
      <footer>
        {c.changedBy && <Avatar name={c.changedBy.name} size="sm" />}
        <span>Changed by <b>{c.changedBy?.name ?? 'someone'}</b> on <time dateTime={c.changedAt}>{formatDateTime(c.changedAt)}</time></span>
        <span className="ps-status" style={{ '--c': c.currentCategory === 'Done' ? '#34d399' : c.currentCategory === 'Active' ? '#8b5cf6' : '#94a3b8' } as React.CSSProperties}>{c.currentStatus}</span>
      </footer>
    </article>
  );
}
