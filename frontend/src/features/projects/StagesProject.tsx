import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { insightApi, taskApi } from '../../api/endpoints';
import type { ProjectDetail, Task } from '../../api/types';
import { CalmCard, CalmOrb } from '../../components/calm';
import { Icon } from '../../components/Icon';
import { todayISO } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { shiftIsoDate } from '../../lib/zone';
import { queryClient, useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { ProjectChatInline } from '../chat/ProjectChat';
import { openSchedule } from '../meet/scheduleStore';
import { CalmTaskSheet } from '../tasks/CalmTaskSheet';
import { ProjectTime } from '../time/ProjectTime';
import { ProjectWorkTab } from '../work/ProjectWorkTab';
import { dayText } from '../work/workActions';
import { refreshWork } from '../work/workUi';
import type { DotsItem } from '../talk/DotsMenu';
import { ProjectDocs } from './ProjectDocs';
import { usePortfolioBrief } from './PortfolioInsights';
import type { PortfolioRisk } from '../ai/aiApi';
import { JourneyForecast } from './JourneyForecast';
import { ProjectEditPanel, type EditTab } from './ProjectEditPanel';
import { currentIndex, dm, errText, isClosed, ordered, sizeOf } from './stagesKit';
import './stagesProject.css';

export type StagesTab = 'plan' | 'board' | 'docs' | 'chat' | 'meet' | 'time' | 'activity';
export const STAGES_TABS: StagesTab[] = ['plan', 'board', 'docs', 'chat', 'meet', 'time', 'activity'];
const LABEL: Record<StagesTab, string> = { plan: 'Plan', board: 'Board', docs: 'Docs', chat: 'Chat', meet: 'Meet', time: 'Time', activity: 'Activity' };
/** ?tab= values the page understands, old ones included (overview → Plan, work → Board). */
export const stagesTabOf = (raw: string | null): StagesTab => raw === 'work' ? 'board' : STAGES_TABS.includes(raw as StagesTab) ? raw as StagesTab : 'plan';
/** Old ?settings= values → the Edit panel's tabs. */
export const editTabOf = (raw: string | null): EditTab | null =>
  raw == null ? null : ({ members: 'people', team: 'people', workflow: 'statuses', automation: 'automation', stages: 'stages', details: 'details', people: 'people', statuses: 'statuses' } as Record<string, EditTab>)[raw] ?? 'stages';

const isDone = (t: Task) => t.statusCategory === 'Done' || t.statusCategory === 'Cancelled';

/**
 * One project, journey first: "Projects ›" and the name with one Edit button; owner · dates · slip · people; the journey bar (owner and
 * date under each stage, the current one centred); then Plan · Board · Docs · Chat · Meet · Time · Activity. No ⋯ menu: everything it
 * held is in Edit (stages, details, people with Share link, statuses, automation, close and delete), the tabs, or the Aura card on Plan
 * (delay risk, What if…, weekly report). Tasks open the task panel beside the page.
 */
export function StagesProject({ detail, canEdit, addWork, allowed, archived, more, onDelete, onShare, onHealth, onRisk, onWhatIf, ai, chatOn, activity, summary }: {
  detail: ProjectDetail; canEdit: boolean; addWork: boolean; allowed: { board: boolean; time: boolean; activity: boolean }; archived: boolean;
  more: DotsItem[]; onDelete?: () => void; onShare: () => void; onHealth: () => void; onRisk: () => void; onWhatIf: () => void; ai: boolean; chatOn: boolean;
  activity: ReactNode;
  /** The project in a few sentences from its facts and the portfolio forecast (summarise in ProjectPage). */ summary: (r: PortfolioRisk | undefined) => string;
}) {
  const p = detail.project;
  const wid = useWorkspaceId();
  const [params, setParams] = useSearchParams();
  const tab = stagesTabOf(params.get('tab'));
  const editTab = editTabOf(params.get('settings'));
  const tabs = STAGES_TABS.filter((t) => (t === 'board' ? allowed.board : t === 'time' ? allowed.time : t === 'activity' ? allowed.activity : t === 'chat' ? chatOn : true));
  const setTab = (t: StagesTab) => setParams(t === 'plan' ? {} : t === 'board' ? { tab: t, view: 'board' } : { tab: t });
  const setEdit = (t: EditTab | null) => setParams((x) => { const n = new URLSearchParams(x); if (t) n.set('settings', t); else n.delete('settings'); return n; }, { replace: true });
  const [taskId, setTaskId] = useState<string | null>(null);
  const tq = useWsQuery(['project', p.id, 'tasks', 'calm'], () => taskApi.listForProject(p.id), { staleTime: 30_000 });
  const tasks = tq.data?.items;
  const brief = usePortfolioBrief();
  const risk = brief.data?.ranked?.find((x) => x.projectId === p.id);
  const finished = p.status === 'Completed' || p.status === 'Cancelled' || p.status === 'Archived';
  const slipping = (risk?.projectedSlipDays ?? 0) > 0;
  const aura = finished ? null : {
    late: slipping || p.health === 'Delayed' || p.health === 'AtRisk',
    text: slipping ? `Likely to slip ${risk!.projectedSlipDays} day${risk!.projectedSlipDays === 1 ? '' : 's'}. ${risk!.reasons[0] ? `${risk!.reasons[0][0].toUpperCase()}${risk!.reasons[0].slice(1).replace(/\.?$/, '.')}` : ''}`.trim()
      : summary(risk).split(/(?<=[.!?])\s/).slice(0, 2).join(' '),
  };

  const slip = p.totalSlipDays ?? 0;
  const meta = [p.owner?.name, p.startDate || p.dueDate ? `${dm(p.startDate) || '…'} → ${dm(p.dueDate) || '…'}` : null].filter(Boolean).join(' · ');

  return (
    <div className="stg-page" data-testid="stages-project">
      <header className="stg-head">
        <div className="stg-title">
          <Link className="stg-crumb" to="/work/projects">Projects ›</Link>
          <h1>{p.name}</h1>
          {canEdit || detail.members.length ? <button type="button" className="stg-edit" onClick={() => setEdit('stages')} data-testid="project-edit">Edit</button> : null}
        </div>
        <p className="stg-meta">
          {meta}{slip > 0 && <> · <span className="stg-late">+{slip} {slip === 1 ? 'day' : 'days'}</span></>} · {detail.members.length} {detail.members.length === 1 ? 'person' : 'people'}
          {archived && <> · <b>Archived, read-only</b></>}
        </p>
      </header>
      <JourneyForecast detail={detail} tasks={tasks} canEdit={canEdit && !archived} />
      <nav className="stg-tabbar" role="tablist" aria-label="Project sections">
        {tabs.map((t) => <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{LABEL[t]}</button>)}
      </nav>
      <div className="stg-body" data-tab={tab}>
        {tab === 'plan' && <>
          {aura && <AuraCard text={aura.text} late={aura.late} ai={ai} onRisk={onRisk} onWhatIf={onWhatIf} projectId={p.id} />}
          <PlanList tasks={tasks} loading={tq.isLoading} detail={detail} onOpen={setTaskId} addWork={addWork}
            onTick={async (t) => {
              const to = [...detail.statuses].sort((a, b) => a.order - b.order).find((s) => s.category === 'Done');
              if (!to) { toast('This project has no done status.', 'error'); return; }
              try { await taskApi.move(t.id, { statusId: to.id }); refreshWork(wid); void queryClient.invalidateQueries({ queryKey: [wid, 'project', p.id] }); }
              catch (e) { toast(errText(e, 'Could not mark it done.'), 'error'); }
            }} />
        </>}
        {tab === 'board' && <ProjectWorkTab projectId={p.id} onOpenTask={setTaskId} />}
        {tab === 'docs' && <ProjectDocs projectId={p.id} canEdit={canEdit} archived={archived} />}
        {tab === 'chat' && <CalmCard className="stg-chat"><ProjectChatInline projectId={p.id} name={p.name} onClose={() => setTab('plan')} /></CalmCard>}
        {tab === 'meet' && <MeetTab projectId={p.id} name={p.name} archived={archived} />}
        {tab === 'time' && <ProjectTime projectId={p.id} />}
        {tab === 'activity' && activity}
      </div>
      <ProjectEditPanel open={!!editTab} initial={editTab ?? 'stages'} detail={detail} tasks={tasks} canEdit={canEdit && !archived} onClose={() => setEdit(null)}
        more={more} onDelete={onDelete} onShare={onShare} onHealth={onHealth} />
      <CalmTaskSheet taskId={taskId} onClose={() => { setTaskId(null); void invalidateWorkspace(wid, 'project', p.id); }}
        onFull={(id) => { setTaskId(null); setParams((x) => { const n = new URLSearchParams(x); n.set('task', id); return n; }); }} />
    </div>
  );
}

function AuraCard({ text, late, ai, onRisk, onWhatIf, projectId }: { text: string; late: boolean; ai: boolean; onRisk: () => void; onWhatIf: () => void; projectId: string }) {
  return (
    <div className={`stg-aura card${late ? ' late' : ''}`} role="note" aria-label="Aura" data-testid="project-aura">
      <CalmOrb />
      <p>{text}{' '}
        <button type="button" className="stg-link" onClick={onWhatIf}>What if… ›</button>
        {ai && <> <button type="button" className="stg-link quiet" onClick={onRisk}>Delay risk ›</button></>}
        {' '}<Link className="stg-link quiet" to={`/work/projects/${projectId}/report`}>Weekly report ›</Link>
      </p>
    </div>
  );
}

function PlanList({ tasks, loading, detail, onOpen, onTick, addWork }: {
  tasks: Task[] | undefined; loading: boolean; detail: ProjectDetail; onOpen: (id: string) => void; onTick: (t: Task) => Promise<void>; addWork: boolean;
}) {
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const stages = useMemo(() => ordered(detail.stages), [detail.stages]);
  const cur = currentIndex(stages);
  // Tasks sit under the stage they belong to, in the stage bar's order: open ones first, then done, then by date. No stage: last.
  const groups = useMemo(() => {
    const rows = (tasks ?? []).filter((t) => !t.parentTaskId && t.statusCategory !== 'Cancelled');
    const sort = (a: Task, b: Task) => Number(isDone(a)) - Number(isDone(b)) || (a.dueDate ?? '9').localeCompare(b.dueDate ?? '9');
    const known = new Set(stages.map((x) => x.id));
    const out = stages.map((st, i) => ({ key: st.id, name: st.name, due: st.plannedEnd, state: isClosed(st) ? 'done' : i === cur ? 'current' : 'next', items: rows.filter((t) => t.stageId === st.id).sort(sort) }));
    const rest = rows.filter((t) => !t.stageId || !known.has(t.stageId)).sort(sort);
    if (rest.length) out.push({ key: 'none', name: 'No stage', due: null, state: 'next', items: rest });
    return out.filter((g) => g.items.length);
  }, [tasks, stages, cur]);
  if (loading) return <CalmCard className="stg-plan"><p className="stg-empty">Loading tasks…</p></CalmCard>;
  if (!groups.length) return <CalmCard className="stg-plan"><p className="stg-empty">No tasks yet.{addWork && ' Add one with the + button.'}</p></CalmCard>;
  return (
    <CalmCard className="stg-plan" aria-label="Plan">
      <ul>
        {groups.map((g) => (
          <Fragment key={g.key}>
            <li className={`stg-sh sc-${g.state}`} data-stage-group={g.name}>
              <span className="stg-sh-dot" aria-hidden="true" />
              <b>{g.name}</b>
              <span className="stg-sh-m">{g.items.length} {g.items.length === 1 ? 'task' : 'tasks'}{g.due ? ` · due ${dm(g.due)}` : ''}</span>
            </li>
            {g.items.map((t, n) => {
              const off = isDone(t) || ticked.has(t.id);
              const right = off ? 'Done' : [t.assignee?.name.split(' ')[0], dayText(t.dueDate), sizeOf(t.estimatedHours)].filter(Boolean).join(' · ');
              return (
                <li key={t.id} className={`stg-task child sc-${g.state}${n === g.items.length - 1 ? ' last' : ''}${off ? ' done' : ''}`}>
                  <span className="stg-elbow" aria-hidden="true" />
                  <button type="button" className={`stg-ring${off ? ' done' : ''}`} aria-pressed={off} aria-label={`Done: ${t.title}`} disabled={off || !t.canEdit}
                    onClick={() => { setTicked((x) => new Set(x).add(t.id)); void onTick(t).catch(() => setTicked((x) => { const y = new Set(x); y.delete(t.id); return y; })); }} />
                  <button type="button" className="stg-task-t" onClick={() => onOpen(t.id)}>{t.title}</button>
                  <span className={`stg-task-m${!off && t.isOverdue ? ' late' : ''}`}>{right}</span>
                </li>
              );
            })}
          </Fragment>
        ))}
      </ul>
    </CalmCard>
  );
}

function MeetTab({ projectId, name, archived }: { projectId: string; name: string; archived: boolean }) {
  const today = todayISO();
  const q = useWsQuery(['calendar', 'project', projectId, today, 'meet'], () => insightApi.calendar(shiftIsoDate(today, -14), shiftIsoDate(today, 45), projectId), { staleTime: 60_000, retry: false });
  const meets = (Array.isArray(q.data) ? q.data : []).filter((e) => e.type === 'meeting').sort((a, b) => (a.startsAt ?? a.date).localeCompare(b.startsAt ?? b.date));
  const now = Date.now();
  const upcoming = meets.filter((e) => Date.parse(e.startsAt ?? `${e.date}T23:59:00`) > now - 30 * 60_000);
  const past = meets.filter((e) => !upcoming.includes(e)).reverse().slice(0, 5);
  const when = (iso?: string | null, d?: string) => { const x = iso ? new Date(iso) : null; return `${dayText(d ?? iso?.slice(0, 10) ?? null)}${x ? ` · ${x.getHours()}:${String(x.getMinutes()).padStart(2, '0')}` : ''}`; };
  return (
    <CalmCard className="stg-plan stg-meet" aria-label="Meetings">
      <div className="stg-meet-head">
        <b>Meetings</b>
        {!archived && <button type="button" className="stg-go" onClick={() => openSchedule({ project: { id: projectId, name } })} data-testid="schedule-meeting"><Icon name="calendar" size={14} /> Schedule a meeting</button>}
      </div>
      {q.isLoading ? <p className="stg-empty">Loading…</p> : upcoming.length === 0 ? <p className="stg-empty">Nothing booked.</p> : (
        <ul>{upcoming.map((e) => (
          <li key={e.id} className="stg-task"><Icon name="video" size={15} /><span className="stg-task-t">{e.title}</span><span className="stg-task-m">{when(e.startsAt, e.date)}</span>
            {e.joinUrl && <a className="calm-join" href={e.joinUrl} target="_blank" rel="noreferrer">Join</a>}</li>
        ))}</ul>
      )}
      {past.length > 0 && <><h5 className="stg-cap">Earlier</h5><ul>{past.map((e) => <li key={e.id} className="stg-task done"><Icon name="video" size={15} /><span className="stg-task-t">{e.title}</span><span className="stg-task-m">{when(e.startsAt, e.date)}</span></li>)}</ul></>}
      <Link className="stg-link quiet" to={`/meetings?s=upcoming&project=${projectId}`}>All calls and meetings ›</Link>
    </CalmCard>
  );
}
