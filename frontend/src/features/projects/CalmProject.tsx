import { useMemo, useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { documentApi, insightApi, projectApi, taskApi } from '../../api/endpoints';
import type { ProjectDetail, Stage, Task } from '../../api/types';
import { AuraLine, CalmAv, CalmCard, CalmJourney, CalmPills, CalmRailRow, CalmSplit, type CalmStep } from '../../components/calm';
import { Icon } from '../../components/Icon';
import { projectColor } from '../../lib/calm';
import { daysUntil, todayISO } from '../../lib/format';
import { useWsQuery } from '../../lib/hooks';
import { shiftIsoDate } from '../../lib/zone';
import { queryClient, useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { DotsMenu, type DotsItem } from '../talk/DotsMenu';
import { CalmTaskSheet } from '../tasks/CalmTaskSheet';
import { refreshWork } from '../work/workUi';
import { dayText } from '../work/workActions';
import { CalmCreateHost, openCalmNew, ProjectSheet, shortDay } from '../calm/createSheets';
import { healthOf } from './CalmProjects';
import '../calm/calm-pages.css';

type Tab = 'tasks' | 'people' | 'files';
const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.errors[0]?.message ?? e.message : fallback);
const ago = (iso: string) => { const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000)); return m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`; };
const isDone = (t: Task) => t.statusCategory === 'Done' || t.statusCategory === 'Cancelled';

/**
 * One project (calm, shots 09, 34, 36): "Name · Due Fri. / N overdue." with Plan sheet ›, + Task and ⋯; the journey of its phases;
 * Tasks · People · Files with three numbers; the tasks grouped by phase (each with its bar) on a curved tree, ticked off in place; and the
 * right panel: people, the next meeting, files, health with Why ›, recent activity and one Aura line. A task opens the task sheet.
 */
export function CalmProject({ detail, menu, canEdit, addWork, onHealth, onFullTask }: {
  detail: ProjectDetail; menu: DotsItem[]; canEdit: boolean; addWork: boolean; onHealth: () => void; onFullTask: (id: string) => void;
}) {
  const p = detail.project;
  const wid = useWorkspaceId();
  const color = projectColor(p.id);
  const [tab, setTab] = useState<Tab>('tasks');
  const [taskId, setTaskId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const tq = useWsQuery(['project', p.id, 'tasks', 'calm'], () => taskApi.listForProject(p.id), { staleTime: 30_000 });
  const tasks = useMemo(() => (tq.data?.items ?? []).filter((t) => !t.parentTaskId && t.statusCategory !== 'Cancelled'), [tq.data]);
  const [done, setDone] = useState<Set<string>>(new Set());
  const stages = useMemo(() => [...detail.stages].sort((a, b) => a.order - b.order), [detail.stages]);
  const cur = stages.findIndex((s) => s.effectiveStatus !== 'Completed');
  const steps: CalmStep[] = stages.map((s, i) => ({ key: s.id, label: s.name, state: s.effectiveStatus === 'Completed' ? 'done' : i === cur ? 'current' : 'next',
    sub: s.plannedEnd && i >= cur ? shortDay(s.plannedEnd) : undefined }));
  const openTasks = tasks.filter((t) => !isDone(t));
  const overdue = openTasks.filter((t) => t.isOverdue);
  const days = p.dueDate ? daysUntil(p.dueDate) : null;
  const dueDow = p.dueDate ? shortDay(p.dueDate).split(' ')[0] : null;
  const title = `${p.name}${p.dueDate ? ` · ${days != null && days < 0 ? 'Was due' : 'Due'} ${days != null && days >= 0 && days < 7 ? dueDow : shortDay(p.dueDate)}` : ''}.`;
  const second = p.status === 'Completed' ? 'Finished.' : overdue.length ? `${overdue.length} overdue.` : openTasks.length ? `${openTasks.length} open task${openTasks.length === 1 ? '' : 's'}.` : 'Nothing open.';

  const tick = async (t: Task) => {
    const to = [...detail.statuses].sort((a, b) => a.order - b.order).find((s) => s.category === 'Done');
    if (!to) { toast('This project has no done column.', 'error'); return; }
    setDone((s) => new Set(s).add(t.id));
    try { await taskApi.move(t.id, { statusId: to.id }); refreshWork(wid); void queryClient.invalidateQueries({ queryKey: [wid, 'project', p.id] }); }
    catch (e) { setDone((s) => { const x = new Set(s); x.delete(t.id); return x; }); toast(errText(e, 'Could not mark it done.'), 'error'); }
  };

  const byStage = new Map<string, Task[]>();
  for (const t of tasks) { const k = t.stageId ?? ''; byStage.set(k, [...(byStage.get(k) ?? []), t]); }
  const phases: { key: string; name: string; pct: number; items: Task[] }[] = [
    ...stages.map((s: Stage) => ({ key: s.id, name: s.name, pct: s.taskTotal ? Math.round((s.taskDone / s.taskTotal) * 100) : s.effectiveStatus === 'Completed' ? 100 : 0, items: byStage.get(s.id) ?? [] })),
    ...(byStage.get('')?.length ? [{ key: 'none', name: stages.length ? 'Not in a phase' : 'Tasks', pct: 0, items: byStage.get('')! }] : []),
  ].filter((ph) => ph.items.length > 0 || stages.length <= 8);

  const crumb = (
    <>
      <span><Link to="/work/projects">Projects</Link> › {p.name}</span><span style={{ flex: 1 }} />
      <Link className="cp-lk" to="/work/projects?view=portfolio&mode=sheet">Plan sheet ›</Link>
      {addWork && <button type="button" className="pd-pill" onClick={() => openCalmNew({ type: 'task', project: { id: p.id, name: p.name } })}><Icon name="plus" size={12} /> Task</button>}
      <DotsMenu label="More on this project" listClassName="wide" items={[{ label: 'Edit project', icon: 'edit', hidden: !canEdit, onSelect: () => setEditing(true) }, ...menu]} />
    </>
  );
  return (
    <CalmSplit crumb={crumb} label={p.name}>
      <header className="cp-hero sm" data-testid="project-hero"><h1>{title}<em>{second}</em></h1></header>
      {steps.length > 0 && <CalmCard className="pd-journey" aria-label="Journey"><CalmJourney steps={steps} color={color} label={`${p.name} journey`} /></CalmCard>}
      <div className="pd-bar">
        <CalmPills label="Show" size="lg" value={tab} onChange={setTab} options={[{ value: 'tasks', label: 'Tasks' }, { value: 'people', label: 'People' }, { value: 'files', label: 'Files' }]} />
        <span className="sp" />
        <div className="cp-num" aria-label="Numbers">
          <div><b>{p.progress}</b><small>% done</small></div>
          <div><b>{p.stats.total - p.stats.done - p.stats.cancelled}</b><small>open tasks</small></div>
          <div><b>{days == null ? '—' : Math.abs(days)}</b><small>{days != null && days < 0 ? 'days late' : 'days to due'}</small></div>
        </div>
      </div>
      <div className="pd-grid">
        {tab === 'tasks' ? (
          <CalmCard className="pd-tree" aria-label="Tasks by phase">
            {tq.isLoading ? <p className="mw2-empty">Loading tasks…</p> : tasks.length === 0 ? (
              <div className="mw2-empty">No tasks yet.{addWork && <div style={{ marginTop: 12 }}><button type="button" className="cp-go-sm" onClick={() => openCalmNew({ type: 'task', project: { id: p.id, name: p.name } })}>+ Task</button></div>}</div>
            ) : phases.map((ph) => (
              <div key={ph.key} role="group" aria-label={ph.name}>
                <div className="pd-phase"><span><b>{ph.name}</b><small>{ph.pct}%</small></span><span className="calm-bar" style={{ '--calm-dot': color } as CSSProperties}><i style={{ width: `${ph.pct}%` }} /></span></div>
                <ul className="pd-kids">
                  {ph.items.map((t) => {
                    const off = isDone(t) || done.has(t.id);
                    const late = !off && t.isOverdue && t.dueDate ? `${Math.abs(daysUntil(t.dueDate) ?? 0)}d late` : null;
                    return (
                      <li key={t.id} className={`pd-kid${off ? ' done' : ''}`}>
                        <button type="button" className={`cp-ring${off ? ' done' : ''}`} aria-pressed={off} aria-label={`Done: ${t.title}`} disabled={off || !t.canEdit} onClick={() => void tick(t)} />
                        <button type="button" className="pd-kid-t" onClick={() => setTaskId(t.id)}>{t.title}</button>
                        <span className="pd-kid-o">{t.assignee?.name.split(' ')[0] ?? ''}</span>
                        <span className={`pd-kid-d${late || (!off && t.dueDate === todayISO()) ? ' hot' : ''}`}>{off ? 'Done' : late ?? dayText(t.dueDate)}</span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </CalmCard>
        ) : tab === 'people' ? (
          <CalmCard className="pd-people" aria-label="People">
            {detail.members.map((m) => {
              const mine = openTasks.filter((t) => t.assignee?.id === m.userId);
              return <CalmRailRow key={m.userId} lead={<CalmAv name={m.name} size={30} />} title={m.name} sub={m.role ?? m.email} right={`${mine.length} open`} to={`/work?tab=team&person=${m.userId}`} />;
            })}
          </CalmCard>
        ) : <FilesList projectId={p.id} />}
        <ProjectRail detail={detail} onHealth={onHealth} onTask={setTaskId} overdue={overdue} />
      </div>
      <CalmTaskSheet taskId={taskId} onClose={() => setTaskId(null)} onFull={(id) => { setTaskId(null); onFullTask(id); }} />
      <ProjectSheet open={editing} project={p} onClose={() => setEditing(false)} />
      <CalmCreateHost project={{ id: p.id, name: p.name }} />
    </CalmSplit>
  );
}

function FilesList({ projectId }: { projectId: string }) {
  const q = useWsQuery(['documents', 'project', projectId, 'calm'], () => documentApi.list({ projectId, limit: 30 }), { staleTime: 60_000, retry: false });
  const items = q.data?.items ?? [];
  return (
    <CalmCard className="pd-files" aria-label="Files">
      {q.isLoading ? <p className="mw2-empty">Loading…</p> : items.length === 0 ? <p className="mw2-empty">No files yet. <Link to={`/library/p/${projectId}`}>Open the library ›</Link></p>
        : items.map((d) => <CalmRailRow key={d.id} lead={<Icon name="note" size={16} />} title={d.title} sub={`${d.typeName} · ${d.owner.name}`} right={ago(d.updatedAt)} to={`/library/p/${projectId}/d/${d.id}`} />)}
    </CalmCard>
  );
}

function ProjectRail({ detail, onHealth, onTask, overdue }: { detail: ProjectDetail; onHealth: () => void; onTask: (id: string) => void; overdue: Task[] }) {
  const p = detail.project;
  const today = todayISO();
  const meets = useWsQuery(['calendar', 'project', p.id, today], () => insightApi.calendar(today, shiftIsoDate(today, 14), p.id), { staleTime: 60_000, retry: false });
  const files = useWsQuery(['documents', 'project', p.id, 'count'], () => documentApi.list({ projectId: p.id, limit: 3 }), { staleTime: 60_000, retry: false });
  const act = useWsQuery(['project', p.id, 'activity'], () => projectApi.activity(p.id), { staleTime: 60_000, retry: false });
  const next = (meets.data ?? []).filter((e) => e.type === 'meeting' && e.startsAt && Date.parse(e.startsAt) > Date.now() - 30 * 60_000).sort((a, b) => (a.startsAt ?? '').localeCompare(b.startsAt ?? ''))[0];
  const h = healthOf(p);
  const fileNames = (files.data?.items ?? []).slice(0, 2).map((d) => d.title).join(', ');
  const late = overdue[0];
  const when = next?.startsAt ? new Date(next.startsAt) : null;
  return (
    <CalmCard className="pd-side" aria-label="Project details">
      <div className="pd-line"><span>People</span><span className="pd-avs">{detail.members.slice(0, 5).map((m) => <CalmAv key={m.userId} name={m.name} size={26} />)}</span><span className="cp-lk">{detail.members.length} ›</span></div>
      <div className="pd-line"><span>Next</span><span>{next ? `${next.title} · ${when!.getHours()}:${String(when!.getMinutes()).padStart(2, '0')}` : 'No meeting booked'}</span>
        {next?.joinUrl ? <a className="calm-join" href={next.joinUrl} target="_blank" rel="noreferrer">Join</a> : <Link className="cp-lk" to={`/meetings?s=upcoming&project=${p.id}`}>›</Link>}</div>
      <div className="pd-line"><span>Files</span><span>{fileNames || 'None yet'}</span><Link className="cp-lk" to={`/library/p/${p.id}`}>{files.data?.total ?? files.data?.items.length ?? ''} ›</Link></div>
      <div className="pd-line"><span>Due</span><span>{p.dueDate ? shortDay(p.dueDate) : 'No date'}</span><span /></div>
      <div className="pd-line"><span>Health</span><span className={`calm-tone-${h.tone}`} style={{ fontWeight: 600 }}>{h.label}</span><button type="button" className="cp-lk" onClick={onHealth}>Why ›</button></div>
      <h5>Recent</h5>
      {(act.data?.items ?? []).slice(0, 4).map((a) => <CalmRailRow key={a.id} lead={<CalmAv name={a.actor?.name ?? 'System'} size={24} />} title={a.summary} right={ago(a.createdAt)} />)}
      {act.data && act.data.items.length === 0 && <p className="calm-week-note">Nothing yet.</p>}
      <AuraLine text={late ? `${late.title} is ${late.assignee ? `${late.assignee.name.split(' ')[0]}’s and ` : ''}late.` : undefined} action="Open it" onAction={() => late && onTask(late.id)} />
    </CalmCard>
  );
}
