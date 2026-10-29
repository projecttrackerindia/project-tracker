import { Face } from '../../components/Face';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AgentWorkflowsPage } from '../ai/AgentWorkflowsPage';
import { TimesheetPage, type TimesheetSection } from '../time/TimesheetPage';
import { Link, useSearchParams } from 'react-router-dom';
import { ApiError, del, get, post } from '../../api/client';
import { opsApi, projectApi, timeApi, workItemApi } from '../../api/endpoints';
import type { GridKind, GridRow, ParsedTime, ReportKind, TimesheetGrid } from '../../api/types';
import { Icon, type IconName } from '../../components/Icon';
import { EmptyState, ErrorState, PageHead, PageLoader, Segmented } from '../../components/ui';
import { MONTHS, formatDate, timeAgo, todayISO } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useAuth, useCan, useModule, useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { Markdown } from '../ai/Markdown';
import { ExportList, KIND_INFO, ReportGenerator } from '../reports/Exports';
import { TimeWordsReview, useWordsRecorder } from '../time/TimeWords';
import { cellKey, hm, parseCell } from '../time/grid';
import { reminderApi } from '../reminders/api';
import { formatMinutes } from '../time/time';
import { ReviewDrawer, TargetExplain, useTimesheetReview } from '../time/ReviewDrawer';
import { Term } from '../../components/Term';
import { useOverlapsByDay } from '../calendar/timeline';
import './insights-v2.css';

type Tab = 'overview' | 'time' | 'reports';
const TS_SECTIONS = ['week', 'insights', 'entries', 'approvals'];
const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.errors[0]?.message ?? e.message : fallback);
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dateOf = (s: string) => new Date(`${s}T00:00:00`);
const mondayOf = (s: string) => { const d = dateOf(s); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return iso(d); };
const addDays = (s: string, n: number) => { const d = dateOf(s); d.setDate(d.getDate() + n); return iso(d); };
const dayMonth = (s: string) => { const d = dateOf(s); return `${d.getDate()} ${MONTHS[d.getMonth()]}`; };
const hours = (min: number) => (min > 0 ? formatMinutes(min) : '0h');

/** Insights: Overview (the numbers and who carries the work), Time (my week) and Reports. Tabs never leave Insights. */
export function InsightsPage() {
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab');
  // The agent workflows (where /ai/operations leads) keep their own full page here.
  if (raw === 'workflows') return <AgentWorkflowsPage />;
  // The full timesheet (the week grid with planned leave, Insights over the weeks, Entries, Approvals, someone else's time) opens from
  // Time's "Full timesheet ›" as ?tab=time&s=…, and old /timesheet links arrive here too.
  const ts = params.get('s');
  if (raw === 'time' && (TS_SECTIONS.includes(ts ?? '') || params.has('user'))) return <TimesheetPage section={(TS_SECTIONS.includes(ts ?? '') ? ts : 'week') as TimesheetSection} />;
  const tab: Tab = raw === 'time' || raw === 'reports' ? raw : 'overview';
  const setTab = (t: Tab) => setParams((p) => { const n = new URLSearchParams(p); if (t === 'overview') n.delete('tab'); else n.set('tab', t); n.delete('job'); return n; }, { replace: true });
  const tabs = <Segmented label="Insights" value={tab} onChange={setTab} options={[{ id: 'overview', label: 'Overview' }, { id: 'time', label: 'Time' }, { id: 'reports', label: 'Reports' }]} />;
  return (
    <div className="ins">
      {tab === 'overview' && <Overview tabs={tabs} onReports={(job) => setParams({ tab: 'reports', job }, { replace: true })} />}
      {tab === 'time' && <TimeTab tabs={tabs} />}
      {tab === 'reports' && <Reports tabs={tabs} />}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------------------------------ Overview

const SCOPE_TEXT: Record<string, string> = { Reports: 'Your team', Everyone: 'Everyone', Me: 'Just you' };
const reduceMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
/** Spring-like curve with a ~7% overshoot (the rings and the numbers share it). */
const springy = (t: number) => { const c = 1.25; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); };

/** Counts a number up from 0 with the rings' curve; reduced motion shows it at once. */
function useCountUp(target: number | null, delay = 0) {
  const [v, setV] = useState<number | null>(() => (target == null || reduceMotion() ? target : 0));
  useEffect(() => {
    if (target == null || reduceMotion()) { setV(target); return; }
    let raf = 0; const t0 = performance.now() + delay;
    const step = (now: number) => {
      const t = Math.min(1, Math.max(0, (now - t0) / 900));
      setV(Math.round(target * Math.min(1.07, springy(t))));
      if (t < 1) raf = requestAnimationFrame(step); else setV(target);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, delay]);
  return v;
}

function Ring({ label, value, tone, sub, foot, index, to }: { label: string; value: number | null; tone: 'pink' | 'orange' | 'green'; sub: React.ReactNode; foot?: React.ReactNode; index: number; to?: string }) {
  const shown = useCountUp(value, index * 80);
  const v = value == null ? 0 : Math.max(0, Math.min(100, value)) / 100;
  const body = (
    <>
      <svg className="ins-ring-svg" viewBox="0 0 120 120" aria-hidden="true">
        <circle className="trk" cx="60" cy="60" r="50" />
        <circle className="arc" cx="60" cy="60" r="50" style={{ '--v': v, animationDelay: `${index * 80}ms` } as React.CSSProperties} />
      </svg>
      <div className="ins-ring-text">
        <span className="ins-ring-l">{label}</span>
        <b className="ins-ring-n">{shown == null ? '—' : shown}{shown != null && <small>%</small>}</b>
        <span className="ins-ring-s">{sub}</span>
        {foot && <span className="ins-ring-d">{foot}</span>}
      </div>
    </>
  );
  return to
    ? <Link to={to} className={`ins-ring ${tone}`} aria-label={`${label}: ${value == null ? 'no data' : `${value}%`}`}>{body}</Link>
    : <div className={`ins-ring ${tone}`} role="group" aria-label={`${label}: ${value == null ? 'no data' : `${value}%`}`}>{body}</div>;
}

/** Done vs planned, 12 weeks: work finished (pink, filled) against work that came in (grey, dashed), from the operations weeks. */
function Trend({ weeks }: { weeks: { weekStart: string; created: number; completed: number }[] }) {
  const W = 560, H = 190, padX = 8, top = 16, bottom = 160;
  if (weeks.length < 2) return <p className="ins-p ins-trend-empty">Not enough weeks yet to draw a trend.</p>;
  const max = Math.max(1, ...weeks.flatMap((w) => [w.created, w.completed])) * 1.15;
  const x = (i: number) => padX + (i / (weeks.length - 1)) * (W - padX * 2);
  const y = (n: number) => bottom - (n / max) * (bottom - top);
  const line = (k: 'created' | 'completed') => weeks.map((w, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(w[k]).toFixed(1)}`).join(' ');
  const last = weeks[weeks.length - 1];
  const ticks = [0, Math.round((weeks.length - 1) / 3), Math.round(((weeks.length - 1) * 2) / 3), weeks.length - 1];
  return (
    <svg className="ins-trend" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Done vs planned over ${weeks.length} weeks: last week ${last.completed} done of ${last.created} planned`}>
      {[0.25, 0.5, 0.75].map((f) => <line key={f} className="grid" x1={padX} x2={W - padX} y1={top + (bottom - top) * f} y2={top + (bottom - top) * f} />)}
      <path className="area" d={`${line('completed')} L${x(weeks.length - 1)},${bottom} L${x(0)},${bottom} Z`} />
      <path className="plan" d={line('created')} />
      <path className="done" d={line('completed')} pathLength={1} />
      <circle className="end" cx={x(weeks.length - 1)} cy={y(last.completed)} r="5" />
      {ticks.map((i) => <text key={i} x={x(i)} y={H - 4} textAnchor={i === 0 ? 'start' : i === weeks.length - 1 ? 'end' : 'middle'}>{dayMonth(weeks[i].weekStart)}</text>)}
    </svg>
  );
}

type Note = { id: string; lead: string; rest: string; action: React.ReactNode };

function Overview({ tabs, onReports }: { tabs: React.ReactNode; onReports: (job: string) => void }) {
  const today = todayISO();
  const seeWork = useModule('work') > 0;
  const projects = useWsQuery(['projects', 'health'], () => projectApi.list({ pageSize: 100 }), { staleTime: 60_000, retry: false });
  const workload = useWsQuery(['workload', 'default'], () => workItemApi.workload(), { staleTime: 60_000, retry: false });
  const ops = useWsQuery(['ops', 'insights', 84], () => opsApi.insights(84), { enabled: seeWork, staleTime: 60_000, retry: false });
  const { busy, rebalance } = useRebalance(onReports);
  const [reminded, setReminded] = useState(false);
  const [reminding, setReminding] = useState(false);

  const live = (projects.data?.items ?? []).filter((p) => p.status === 'Planning' || p.status === 'Active' || p.status === 'OnHold');
  const onTrack = live.filter((p) => p.health === 'OnTrack').length;
  const delayed = live.filter((p) => p.health === 'Delayed');
  // "Your team" is the people who report to you; your own time counts too, so the ring and Today never disagree.
  const mine = useWsQuery(['workload', 'Me'], () => workItemApi.workload('Me'), { staleTime: 60_000, retry: false, enabled: workload.data?.scope === 'Reports' });
  const everyone = useMemo(() => {
    const base = workload.data?.members ?? [];
    const me = mine.data?.members?.[0];
    return me && !base.some((m) => m.userId === me.userId) ? [me, ...base] : base;
  }, [workload.data, mine.data]);
  const members = useMemo(() => [...(workload.data?.members ?? [])].filter((m) => m.open > 0 || m.overdue > 0).sort((a, b) => b.open - a.open || b.overdue - a.overdue), [workload.data]);
  const total = workload.data?.totals.open ?? 0;
  const top = members[0];
  const avg = members.length ? total / members.length : 0;

  // The three rings, from the data already on the page.
  const delivery = projects.data && live.length ? Math.round((onTrack / live.length) * 100) : null;
  const balance = top && top.open > 0 ? Math.round((avg / top.open) * 100) : null;
  const logged = everyone.reduce((a, m) => a + m.loggedMinutesLast7Days, 0);
  const expected = everyone.length * 40 * 60;
  const timePct = workload.data && expected ? Math.round((logged / expected) * 100) : null;
  const notLogged = everyone.filter((m) => m.loggedMinutesLast7Days === 0);
  const capPos = Math.max(1, ...members.map((m) => m.open), avg * 1.6);

  const remindTeam = async () => {
    const people = notLogged.length ? notLogged : everyone;
    if (!people.length) return;
    setReminding(true);
    const results = await Promise.allSettled(people.map((m) => reminderApi.create({
      title: 'Log your time for this week', note: 'Your timesheet has no time in the last 7 days. Please fill it in.',
      forUserId: m.userId, when: { at: new Date().toISOString() },
    })));
    setReminding(false);
    const sent = results.filter((r) => r.status === 'fulfilled').length;
    if (sent > 0) { setReminded(true); toast(`Reminded ${sent} ${sent === 1 ? 'person' : 'people'} to log their time.`); }
    else { const first = results.find((r): r is PromiseRejectedResult => r.status === 'rejected'); toast(errText(first?.reason, 'Could not send the reminders.'), 'error'); }
  };

  // ✦ What stands out: up to three sentences, each with one action.
  const notes: Note[] = [];
  if (top && total >= 4 && members.length > 1 && (top.open / total >= 0.35 || top.open >= avg * 1.5)) notes.push({
    id: 'load', lead: top.name, rest: ` holds ${Math.round((top.open / total) * 100)}% of the team's open work${top.overdue ? `, ${top.overdue} of it overdue` : ''}.`,
    action: members.length > 1 ? <button type="button" className="ins-act" disabled={busy} onClick={() => void rebalance()}>{busy && <span className="spinner" />}Suggest a rebalance</button> : null,
  });
  if (workload.data && everyone.length > 0 && notLogged.length > 0) notes.push({
    id: 'time', lead: notLogged.length === everyone.length ? 'Nobody' : `${notLogged.length} ${notLogged.length === 1 ? 'person hasn’t' : 'people haven’t'}`,
    rest: notLogged.length === everyone.length ? ' has logged time in the last 7 days.' : ' logged time in the last 7 days.',
    action: <button type="button" className="ins-act" disabled={reminded || reminding} onClick={() => void remindTeam()}>{reminding && <span className="spinner" />}{reminded ? 'Reminded' : 'Remind team'}</button>,
  });
  if (delayed.length) notes.push({
    id: 'late', lead: delayed.length === 1 ? '1 project is' : `${delayed.length} projects are`, rest: ` delayed: ${delayed.slice(0, 3).map((p) => p.name).join(', ')}${delayed.length > 3 ? '…' : ''}.`,
    action: <Link className="ins-act" to={`/work/projects/${delayed[0].id}`}>Review {delayed[0].key}</Link>,
  });
  const overdueTotal = workload.data?.totals.overdue ?? 0;
  if (notes.length < 3 && overdueTotal > 0 && !notes.some((n) => n.id === 'load' && n.rest.includes('overdue'))) notes.push({
    id: 'overdue', lead: `${overdueTotal} item${overdueTotal === 1 ? ' is' : 's are'} overdue`, rest: ' across the team.',
    action: <Link className="ins-act" to="/work?tab=team&s=workload">Review overdue work</Link>,
  });
  if (!notes.length && workload.data) notes.push({ id: 'calm', lead: 'Nothing stands out', rest: ' this week.', action: null });

  const weeks = (ops.data?.weeks ?? []).slice(-12);
  const lastW = weeks[weeks.length - 1];
  const half = Math.floor(weeks.length / 2);
  const gap = (ws: typeof weeks) => ws.reduce((a, w) => a + (w.created - w.completed), 0) / Math.max(1, ws.length);
  const trendLine = lastW ? `${weeks.length >= 4 ? (gap(weeks.slice(half)) <= gap(weeks.slice(0, half)) ? 'Gap narrowing' : 'Gap widening') + ' — ' : ''}${lastW.completed} of ${lastW.created} items last week` : '';
  const scope = workload.data ? SCOPE_TEXT[workload.data.scope] ?? 'Your team' : 'Your team';

  return (
    <>
      <PageHead eyebrow={`${scope} · as of ${dayMonth(today)}`} title="Insights">{tabs}</PageHead>
      <div className="ins-rings">
        <Ring index={0} tone="pink" label="Delivery on time" value={delivery} to="/work/projects"
          sub={projects.data ? `${onTrack} of ${live.length} projects on track` : projects.isLoading ? 'Reading…' : projects.isError ? 'Projects could not be loaded — open to retry' : 'No projects yet'}
          foot={projects.data && live.length ? (delayed.length ? <><span aria-hidden="true">↓ </span>{delayed.length} delayed</> : 'None delayed') : undefined} />
        <Ring index={1} tone="orange" label="Load balance" value={balance} to="/work?tab=team&s=workload"
          sub={top ? `Spread across ${members.length} ${members.length === 1 ? 'person' : 'people'} — ${top.name.split(' ')[0]} carries ${total ? Math.round((top.open / total) * 100) : 0}%` : workload.isLoading ? 'Reading…' : 'No open work'}
          foot={workload.data ? `${total} open · ${overdueTotal} overdue` : undefined} />
        <Ring index={2} tone="green" label="Time logged" value={timePct} to="/insights?tab=time"
          sub={workload.data ? `${Math.round(logged / 60)}h of ${Math.round(expected / 60)}h expected this week` : workload.isLoading ? 'Reading…' : '—'}
          foot={workload.data ? (notLogged.length ? `${notLogged.length} not logged yet` : 'Everyone logged') : undefined} />
      </div>
      <div className="ins-two">
        <section className="ins-card ins-trendcard" aria-label="Done vs planned">
          <div className="ins-card-head"><b>Done vs planned · {weeks.length || 12} weeks</b><span className="ins-lg"><span><i className="done" />Done</span><span><i className="plan" />Planned</span></span></div>
          {trendLine && <p className="ins-sub">{trendLine}</p>}
          {!seeWork ? <p className="ins-p ins-trend-empty">Weekly work isn’t open to you.</p> : ops.isLoading ? <PageLoader /> : <Trend weeks={weeks} />}
        </section>
        <section className="ins-card ins-load" aria-label="Workload">
          <div className="ins-card-head"><Link to="/work?tab=team&s=workload" className="ins-card-title">Workload</Link><span className="ins-lg"><span><i className="open" />Open items</span><span><i className="late" />Overdue</span><span className="cap">Team average</span></span></div>
          {workload.isLoading ? <PageLoader /> : workload.isError ? <ErrorState error={workload.error} retry={() => void workload.refetch()} /> : members.length === 0 ? (
            <EmptyState icon="users" title="No open work" text="Nobody you can see has open work right now." />
          ) : (
            <ul className="ins-bars">
              {members.slice(0, 7).map((m, i) => (
                <li key={m.userId}>
                  <Link to={`/work?tab=team&person=${m.userId}`} className="ins-name"><Face userId={m.userId} name={m.name} className="ins-av" />{m.name}</Link>
                  <span className="ins-bar" role="img" aria-label={`${m.open} open, ${m.overdue} overdue`}>
                    <i className="open" style={{ width: `${((m.open - m.overdue) / capPos) * 100}%`, animationDelay: `${i * 40}ms` }} />
                    <i className="late" style={{ width: `${(m.overdue / capPos) * 100}%`, animationDelay: `${i * 40}ms` }} />
                    <b className="cap" style={{ left: `${(avg / capPos) * 100}%` }} />
                  </span>
                  <span className="ins-num">{m.open} open{m.overdue > 0 && <> · <em className="late">{m.overdue} late</em></>}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
      <section className="ins-card ins-ai" aria-label="What stands out">
        <b className="ins-ai-h"><span className="ins-orb" aria-hidden="true" />What stands out</b>
        {workload.isLoading || projects.isLoading ? <p>Reading the numbers…</p> : (
          <div className="ins-so">
            {notes.slice(0, 3).map((n) => <div key={n.id}><p><b>{n.lead}</b>{n.rest}</p>{n.action}</div>)}
          </div>
        )}
      </section>
    </>
  );
}

/** "Suggest a rebalance": starts the AI workload and capacity review; `onStarted` gets the job id (Insights opens it under Reports). */
export function useRebalance(onStarted: (job: string) => void) {
  const [busy, setBusy] = useState(false);
  const rebalance = async () => {
    setBusy(true);
    try {
      const job = await post<{ id: string }>('/ai/operations/jobs', { kind: 'workload', title: 'Workload and capacity review', idempotencyKey: crypto.randomUUID() });
      toast('Started a workload review. It appears under Reports when ready.');
      onStarted(job.id);
    } catch (e) { toast(errText(e, 'Could not start the review.'), 'error'); }
    finally { setBusy(false); }
  };
  return { busy, rebalance };
}

// ------------------------------------------------------------------------------------------------------------------------ Time

const STATUS_TEXT = { NotSubmitted: 'not submitted', Submitted: 'waiting for approval', Approved: 'approved', Rejected: 'returned' } as const;

function TimeTab({ tabs }: { tabs: React.ReactNode }) {
  const wid = useWorkspaceId();
  const today = todayISO();
  const hasReports = (useAuth((s) => s.ctx?.current?.reportCount) ?? 0) > 0;
  const [params] = useSearchParams();
  // A week in the address (old /timesheet?week=… links, notifications) opens that week.
  const [week, setWeek] = useState(() => { const w = params.get('week'); return w && /^\d{4}-\d{2}-\d{2}$/.test(w) && w <= today ? mondayOf(w) : mondayOf(today); });
  const grid = useWsQuery(['time', 'grid', week], () => timeApi.grid(week), { placeholderData: (p) => p });
  const status = useWsQuery(['time', 'week', week], () => timeApi.week(week));
  const g = grid.data;
  const draft = useWsQuery(['time', 'draft', week], () => timeApi.draft(week), { enabled: !!g?.editable && !g.locked, staleTime: 60_000, retry: false });
  const [text, setText] = useState(() => params.get('log') ?? '');   // + New › Time arrives with the words (?log=)
  const [parsed, setParsed] = useState<ParsedTime | null>(null);
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState(false);
  const voice = useWordsRecorder((r) => setParsed(r));
  const refresh = () => void invalidateWorkspace(wid, 'time');

  const read = async () => {
    if (!text.trim()) return;
    setReading(true);
    try { setParsed(await timeApi.parseWords(text.trim())); }
    catch (e) { toast(errText(e, 'Could not read that. Try "2h on PAY-12 today".'), 'error'); }
    finally { setReading(false); }
  };
  const draftCells = (draft.data?.cells ?? []).filter((c) => c.date <= today);
  const draftMinutes = draftCells.reduce((a, c) => a + c.minutes, 0);
  const applyDraft = async () => {
    setBusy(true);
    try {
      const res = await timeApi.saveGrid(week, draftCells.map((c) => ({ kind: c.kind, targetId: c.targetId, date: c.date, minutes: c.minutes, note: null })));
      toast(res.errors.length ? `Added ${res.saved}; ${res.errors.length} could not be: ${res.errors[0].message}` : `Added ${hours(draftMinutes)} from the draft. Check it before you submit.`, res.errors.length ? 'error' : 'success');
      refresh();
    } catch (e) { toast(errText(e, 'Could not add the draft.'), 'error'); }
    finally { setBusy(false); }
  };
  // "Submit week" opens the review first: errors block, warnings are acknowledged (ReviewDrawer).
  const [reviewing, setReviewing] = useState(false);
  const review = useTimesheetReview(week, !!g);
  const focusDay = (date: string | null) => {
    setReviewing(false);
    window.setTimeout(() => {
      const cell = document.querySelector<HTMLInputElement>(date ? `.ins-grid td[data-day="${date}"] input:not(:disabled)` : '.ins-say input, .ins-grid input:not(:disabled)');
      cell?.scrollIntoView({ block: 'center', behavior: 'smooth' }); cell?.focus();
    }, 120);
  };

  const st = status.data;
  const example = g?.rows[0]?.key ?? g?.suggestions[0]?.key ?? 'PAY-12';
  return (
    <>
      <PageHead eyebrow={`Week of ${dayMonth(week)}${st ? ` · ${STATUS_TEXT[st.status]}` : ''}`} eyebrowTone={st?.status === 'Rejected' ? 'danger' : st?.status === 'Approved' ? 'success' : undefined} title="Time">{tabs}</PageHead>
      {g?.editable && !g.locked && (
        <form className="ds-command ins-say" onSubmit={(e) => { e.preventDefault(); void read(); }}>
          <span className="ins-spark" aria-hidden="true">✦</span>
          <input value={text} onChange={(e) => setText(e.target.value)} aria-label="Log time in words" placeholder={`"3h on ${example} today, 1h call" — or say it`} />
          {voice.supported && (voice.state === 'recording'
            ? <button type="button" className="btn btn-danger btn-sm" onClick={() => void voice.finish()}><Icon name="micOff" size={15} />Stop · {voice.secs}s</button>
            : <button type="button" className="icon-btn" aria-label="Say it" title="Say it" disabled={voice.state === 'reading'} onClick={() => void voice.start()}><Icon name="mic" /></button>)}
          <button type="submit" className="btn btn-dark" disabled={!text.trim() || reading}>{reading && <span className="spinner" />}Log</button>
        </form>
      )}
      {draftCells.length > 0 && (
        <section className="ins-draft" aria-label="Draft of your week">
          <p><b>✦ I drafted your week</b> from what you changed or commented on, less your meetings — {hours(draftMinutes)} across {draftCells.length} item{draftCells.length === 1 ? '' : 's'}. Check and adjust before submitting.</p>
          <button type="button" className="btn btn-ai" disabled={busy} onClick={() => void applyDraft()}>Use draft</button>
        </section>
      )}
      {grid.isLoading ? <PageLoader /> : grid.isError ? <ErrorState error={grid.error} retry={() => void grid.refetch()} /> : g && (
        <CleanGrid grid={g} week={week} onWeek={setWeek} onSaved={refresh} />
      )}
      {g && (
        <div className="ins-week-foot">
          <span><b><Term k="logged">{hours(g.totalMinutes)}</Term></b> of <TargetExplain target={review.data?.target} label={hours(review.data?.target?.targetMinutes ?? g.targetMinutes)} /> · billable {hours(g.billableMinutes)}</span>
          {st?.canSubmit && <button type="button" className="btn btn-primary ins-submit" disabled={busy || g.totalMinutes === 0} onClick={() => setReviewing(true)} data-testid="submit-week">
            Submit week{(review.data?.issues?.length ?? 0) > 0 ? ` · ${review.data!.issues.length} to check` : ''}</button>}
          {st && !st.canSubmit && st.status !== 'NotSubmitted' && <span className={`ds-pill ${st.status === 'Approved' ? 'success' : st.status === 'Rejected' ? 'danger' : 'warning'}`} data-testid="week-status">{st.status === 'Approved' ? <Term k="approved">{STATUS_TEXT[st.status]}</Term> : st.status === 'Submitted' ? <Term k="submitted">{STATUS_TEXT[st.status]}</Term> : STATUS_TEXT[st.status]}</span>}
        </div>
      )}
      {st?.status === 'Rejected' && st.reviewNote && <p className="ins-note">Returned: {st.reviewNote}</p>}
      <p className="ins-note"><Link to={`/insights?tab=time&s=week${week !== mondayOf(today) ? `&week=${week}` : ''}`}>Full timesheet ›</Link> Planned leave, entries over any dates{hasReports ? ', approvals' : ''} and insights over your weeks.</p>
      {hasReports && <p className="ins-note">Timesheets your team submits arrive in your <Link to="/">Home inbox ›</Link></p>}
      {reviewing && <ReviewDrawer week={week} onClose={() => setReviewing(false)} onLog={focusDay} onSubmitted={() => { setReviewing(false); refresh(); }} />}
      {parsed && <TimeWordsReview parsed={parsed} onClose={() => setParsed(null)} onLogged={() => { setParsed(null); setText(''); refresh(); }} />}
    </>
  );
}

/** A clean week: one row per piece of work, Monday to Friday (weekends only when they hold time), the total, typing saves as you go. */
function CleanGrid({ grid, week, onWeek, onSaved }: { grid: TimesheetGrid; week: string; onWeek: (w: string) => void; onSaved: () => void }) {
  const today = todayISO();
  const [saving, setSaving] = useState<Set<string>>(new Set());
  const days = grid.days.filter((d) => !d.weekend || d.minutes > 0);
  // The same entries on the clock as Today and the Calendar: a day whose entries overlap says so (its total stays the grid's own).
  const overlapsByDay = useOverlapsByDay(week, grid.mine);
  const rows: GridRow[] = grid.rows.length ? grid.rows : grid.suggestions.slice(0, 5).map((s) => ({
    kind: s.kind, targetId: s.targetId, key: s.key, title: s.title, projectId: s.projectId, projectName: s.projectName, billable: false, totalMinutes: 0,
    cells: grid.days.map((d) => ({ date: d.date, minutes: 0, entries: 0, running: false, note: null })),
  }));
  const save = async (kind: GridKind, targetId: string, date: string, value: string, current: number) => {
    const minutes = value.trim() ? parseCell(value) : 0;
    if (minutes === null || minutes > 24 * 60) { toast('Type a time like 2h, 45m or 1:30.', 'error'); return false; }
    if (minutes === current) return true;
    const k = cellKey(kind, targetId, date);
    setSaving((s) => new Set(s).add(k));
    try {
      const res = await timeApi.saveGrid(grid.weekStart, [{ kind, targetId, date, minutes, note: null }]);
      if (res.errors.length) { toast(res.errors[0].message, 'error'); return false; }
      onSaved();
      return true;
    } catch (e) { toast(errText(e, 'Could not save the time.'), 'error'); return false; }
    finally { setSaving((s) => { const n = new Set(s); n.delete(k); return n; }); }
  };
  return (
    <section className="ins-card ins-grid" aria-label="Week">
      <div className="ins-grid-nav">
        <button type="button" className="icon-btn" aria-label="Previous week" onClick={() => onWeek(addDays(week, -7))}><Icon name="chevronL" /></button>
        <span>{dayMonth(grid.weekStart)} – {dayMonth(grid.weekEnd)}</span>
        <button type="button" className="icon-btn" aria-label="Next week" disabled={addDays(week, 7) > today} onClick={() => onWeek(addDays(week, 7))}><Icon name="chevronR" /></button>
      </div>
      {rows.length === 0 ? <EmptyState icon="clock" title="No work this week" text="Log time above, in words or by voice." /> : (
        <div className="ins-table-wrap">
          <table className="ins-table">
            <thead><tr><th scope="col">Work</th>{days.map((d) => <th key={d.date} scope="col" className={d.date === today ? 'today' : ''}>{dateOf(d.date).toLocaleDateString(undefined, { weekday: 'short' })} {dateOf(d.date).getDate()}</th>)}<th scope="col">Total</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.kind}:${r.targetId}`}>
                  <th scope="row" title={`${r.key} · ${r.title}${r.projectName ? ` · ${r.projectName}` : ''}`}><span className="ins-key">{r.key}</span> <span className="ins-title">{r.title}</span></th>
                  {days.map((d) => {
                    const c = r.cells.find((x) => x.date === d.date) ?? { date: d.date, minutes: 0, entries: 0, running: false, note: null };
                    const k = cellKey(r.kind, r.targetId, d.date);
                    const off = !grid.editable || grid.locked || d.date > today || c.running;
                    return (
                      <td key={d.date} data-day={d.date}>
                        <CellInput label={`${r.key} on ${formatDate(d.date)}`} value={hm(c.minutes)} disabled={off} busy={saving.has(k)}
                          onCommit={(v) => save(r.kind, r.targetId, d.date, v, c.minutes)} />
                      </td>
                    );
                  })}
                  <td className="ins-total"><b>{hours(r.cells.reduce((a, c) => a + c.minutes, 0))}</b></td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="ins-day-total">
                <th scope="row">Day</th>
                {days.map((d) => (
                  <td key={d.date} data-testid="tsg-day-total" data-day={d.date} data-minutes={d.minutes}>
                    <b>{d.minutes ? hours(d.minutes) : '–'}</b>
                    {overlapsByDay.get(d.date) && <Link to="/?tab=calendar" className="tsg-ovl" data-testid="tsg-overlap" title="Some of this day's entries share the same time on the clock. Open the Calendar to move or trim one.">{overlapsByDay.get(d.date)} overlapping</Link>}
                  </td>
                ))}
                <td className="ins-total"><b>{hours(grid.totalMinutes)}</b></td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </section>
  );
}

function CellInput({ label, value, disabled, busy, onCommit }: { label: string; value: string; disabled: boolean; busy: boolean; onCommit: (v: string) => Promise<boolean> }) {
  const [text, setText] = useState<string | null>(null);
  const start = useRef(value);
  return (
    <input className={`ins-cell ${busy ? 'busy' : ''}`} aria-label={label} inputMode="decimal" placeholder="–" disabled={disabled}
      value={text ?? value} onFocus={() => { start.current = value; }} onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { setText(null); e.currentTarget.blur(); } }}
      onBlur={async (e) => { const v = e.currentTarget.value; if (text === null || v === start.current) { setText(null); return; } const ok = await onCommit(v); if (ok) setText(null); }} />
  );
}

// ------------------------------------------------------------------------------------------------------------------------ Reports

type ReviewKind = 'portfolio' | 'workload' | 'history';
interface ReviewJob { id: string; kind: ReviewKind; title: string; status: string; progress: number; createdAt: string; errorCode: string | null; result: { summary: string; evidenceAt: string } | null }
interface ReviewSchedule { id: string; title: string; kind: ReviewKind; intervalMinutes: number; nextRunAt: string; enabled: boolean }
const REVIEWS: { id: ReviewKind; label: string; hint: string }[] = [
  { id: 'portfolio', label: 'Portfolio risks & delivery forecast', hint: 'Which projects will slip, and why' },
  { id: 'workload', label: 'Workload & capacity', hint: 'Who is overloaded, who has room' },
  { id: 'history', label: 'Delivery history & blockers', hint: 'What keeps slowing delivery down' },
];
const JOB_STATUS: Record<string, string> = { queued: 'Queued', running: 'Running', succeeded: 'Done', completed: 'Done', failed: 'Failed', cancelled: 'Cancelled' };
const TYPES: [ReportKind, IconName, string][] = [['Project', 'folder', 'Tasks, status and progress'], ['Workload', 'users', 'Open and overdue work per person'], ['Timesheet', 'clock', 'Logged time by person and day'], ['WorkTasks', 'bolt', 'Tickets and their time']];

/** "Hours by person last month as Excel" → the Timesheet report. Plain rules on the words; nothing is generated until you press Generate. */
function reportKindFor(words: string): ReportKind {
  const w = words.toLowerCase();
  if (/\b(hour|hours|time|timesheet|logged|billable)\b/.test(w)) return 'Timesheet';
  if (/\b(ticket|tickets|sla|operational|support|incident)\b/.test(w)) return 'WorkTasks';
  if (/\b(workload|capacity|people|person|team|who)\b/.test(w)) return 'Workload';
  return 'Project';
}

/** The Monday 09:00 (local) after today, as an instant. */
function nextMonday9() {
  const d = new Date(); d.setHours(9, 0, 0, 0);
  const add = ((8 - d.getDay()) % 7) || 7;
  d.setDate(d.getDate() + add);
  return d.toISOString();
}

function Reports({ tabs }: { tabs: React.ReactNode }) {
  const [params, setParams] = useSearchParams();
  const permReports = useCan('reports.view');
  const modReports = useModule('reports');
  const seeWork = useModule('work') > 0;
  const canReports = permReports && modReports > 0;
  const kinds = TYPES.filter(([k]) => k !== 'WorkTasks' || seeWork);
  const [kind, setKind] = useState<ReportKind>('Project');
  const [words, setWords] = useState('');
  const [exportKey, setExportKey] = useState(0);
  const generator = useRef<HTMLDivElement>(null);
  const describe = () => {
    if (!words.trim()) return;
    const k = reportKindFor(words);
    setKind(kinds.some(([x]) => x === k) ? k : 'Project');
    toast(`Set up a ${KIND_INFO[k].label} report. Check the filters, then generate.`, 'info');
    requestAnimationFrame(() => generator.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };

  return (
    <>
      <PageHead eyebrow="Insights" title="Reports">{tabs}</PageHead>
      {canReports && (
        <>
          <form className="ds-command ins-say" onSubmit={(e) => { e.preventDefault(); describe(); }}>
            <Icon name="search" size={18} />
            <input value={words} onChange={(e) => setWords(e.target.value)} aria-label="Describe a report" placeholder="Describe a report — e.g. hours by person this month, as Excel" />
            <button type="submit" className="btn btn-dark" disabled={!words.trim()}>Set up</button>
          </form>
          <div className="ds-choices ins-types" role="group" aria-label="Report type">
            {kinds.map(([k, icon, hint]) => (
              <button key={k} type="button" className={`ds-choice ${kind === k ? 'on' : ''}`} aria-pressed={kind === k} onClick={() => setKind(k)}>
                <span className="ds-tile-ico"><Icon name={icon} /></span><b>{KIND_INFO[k].label}</b><span>{hint}</span>
              </button>
            ))}
          </div>
          <div ref={generator} className="ins-gen"><ReportGenerator kind={kind} onRequested={() => setExportKey((n) => n + 1)} /></div>
          <ExportList refreshKey={exportKey} />
        </>
      )}
      <Reviews selected={params.get('job')} onSelect={(job) => setParams((p) => { const n = new URLSearchParams(p); if (job) n.set('job', job); else n.delete('job'); return n; }, { replace: true })} />
    </>
  );
}

/** The Monday summary and the background reviews (what Agents › Workflows used to hold). */
function Reviews({ selected, onSelect }: { selected: string | null; onSelect: (id: string | null) => void }) {
  const jobs = useWsQuery(['agent-workflows', 'jobs'], () => get<ReviewJob[]>('/ai/operations/jobs'), { refetchInterval: 15_000, retry: false });
  const schedules = useWsQuery(['agent-workflows', 'schedules'], () => get<ReviewSchedule[]>('/ai/operations/schedules'), { retry: false });
  const picked = useWsQuery(['agent-workflows', 'job', selected], () => get<ReviewJob>(`/ai/operations/jobs/${selected}`), { enabled: !!selected, retry: false });
  const [busy, setBusy] = useState(false);
  if (jobs.isError && schedules.isError) return null;   // reviews are not open to this person
  const monday = schedules.data?.find((s) => s.title === 'Monday summary' && s.intervalMinutes === 10080);
  const perform = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try { await fn(); toast(done); await Promise.all([jobs.refetch(), schedules.refetch()]); }
    catch (e) { toast(errText(e, 'That could not be done.'), 'error'); }
    finally { setBusy(false); }
  };
  const job = (selected && (jobs.data?.find((j) => j.id === selected) ?? picked.data)) || null;
  return (
    <div className="ins-row ins-reviews">
      <section className="ins-card" aria-label="Monday summary">
        <div className="ins-card-head"><b>Monday summary</b>{monday && <span className="ds-pill success">On</span>}</div>
        {monday ? (
          <>
            <p className="ins-p">Every Monday: projects at risk and the delivery forecast, sent to you. Next on {formatDate(monday.nextRunAt.slice(0, 10))}.</p>
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void perform(() => del(`/ai/operations/schedules/${monday.id}`), 'Monday summary stopped.')}>Stop</button>
          </>
        ) : (
          <>
            <p className="ins-p">Projects at risk and the delivery forecast, ready for you every Monday at 09:00.</p>
            <button type="button" className="btn btn-primary btn-sm" disabled={busy || schedules.isError} onClick={() => void perform(() => post('/ai/operations/schedules', { kind: 'portfolio', title: 'Monday summary', intervalMinutes: 10080, firstRunAt: nextMonday9() }), 'Monday summary scheduled.')}>Schedule it</button>
          </>
        )}
      </section>
      <section className="ins-card" aria-label="Reviews">
        <div className="ins-card-head"><b>Reviews</b><span>delivery, capacity, blockers</span></div>
        <div className="ins-run">
          {REVIEWS.map((r) => (
            <button key={r.id} type="button" className="btn btn-soft btn-sm" title={r.hint} disabled={busy || jobs.isError}
              onClick={() => void perform(() => post('/ai/operations/jobs', { kind: r.id, title: r.label, idempotencyKey: crypto.randomUUID() }), 'Review started.')}>{r.label}</button>
          ))}
        </div>
        {(jobs.data ?? []).length === 0 ? <p className="ins-p">No reviews yet.</p> : (
          <ul className="ins-jobs">
            {jobs.data!.slice(0, 6).map((j) => (
              <li key={j.id}><button type="button" className={`ins-job ${selected === j.id ? 'on' : ''}`} onClick={() => onSelect(selected === j.id ? null : j.id)}>
                <b>{j.title}</b><span>{JOB_STATUS[j.status] ?? j.status} · {timeAgo(j.createdAt)}</span></button></li>
            ))}
          </ul>
        )}
        {job?.result && <div className="ins-result"><Markdown text={job.result.summary} /></div>}
        {job && !job.result && <p className="ins-p">{job.status === 'failed' ? 'This review could not finish.' : 'Still working on it…'}</p>}
      </section>
    </div>
  );
}
