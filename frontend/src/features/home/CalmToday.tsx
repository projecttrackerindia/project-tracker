import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { insightApi, timeApi } from '../../api/endpoints';
import type { WorkRow } from '../../api/workItemsApi';
import {
  AuraLine, CalmAv, CalmBar, CalmCard, CalmDayRibbon, CalmDot, CalmFoot, CalmGo, CalmInsights, CalmLink, CalmPills, CalmRailCard, CalmRailRow, CalmSheet, CalmSplit,
  type CalmSeg,
} from '../../components/calm';
import { DotsMenu } from '../talk/DotsMenu';
import { Icon } from '../../components/Icon';
import { projectColor, ribbonColors } from '../../lib/calm';
import { todayISO } from '../../lib/format';
import { invalidateWorkspace, useCachedWsQuery, useWsQuery } from '../../lib/hooks';
import { useReducedMotion, motion } from 'framer-motion';
import { gentleSpring } from '../../lib/motion';
import { hourIn, shiftIsoDate, zonedParts } from '../../lib/zone';
import { useAuth, useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { useAttendanceSheet, useAttendanceToday } from '../attendance/AttendanceHost';
import { attendanceApi, MODES, sourceOfDevice, type AttendanceMode } from '../attendance/attendanceApi';
import { useAi, useAssistant } from '../ai/Assistant';
import { useToday, useNow } from '../calendar/useToday';
import { reminderApi, type Reminder } from '../reminders/api';
import { refreshWork, useWorkList } from '../work/workUi';
import { dayText, smart } from '../work/workActions';
import { openCalmNew } from '../calm/createSheets';
import { WeekCard } from '../calm/WeekCard';
import { inboxApi } from './inboxApi';
import '../calm/calm-pages.css';

type DayState = 'morning' | 'afternoon' | 'evening';
const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.errors[0]?.message ?? e.message : fallback);
const hm = (min: number) => { const h = Math.floor(min / 60), m = Math.round(min % 60); return h && m ? `${h}h ${m}m` : h ? `${h}h` : `${m}m`; };
const clock = (d: Date) => { const p = zonedParts(d); return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`; };
const hhmm = (h: number) => `${String(Math.floor(h)).padStart(2, '0')}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`;
const toH = (s: string | null | undefined, d: number) => { const m = /^(\d{1,2}):(\d{2})/.exec(s ?? ''); return m ? Number(m[1]) + Number(m[2]) / 60 : d; };
const isOpen = (w: WorkRow) => w.category === 'Todo' || w.category === 'Active';
const headDay = (s: string) => { const d = new Date(`${s}T00:00:00`); return `${d.toLocaleDateString('en-GB', { weekday: 'long' })}, ${d.getDate()} ${d.toLocaleDateString('en-GB', { month: 'long' })}`; };

/** Why the hero task is the one to do now, in one plain sentence. */
function whyLine(w: WorkRow, nextMeetingIn: number | null): string {
  const parts: string[] = [];
  const late = w.isOverdue && w.dueDate ? Math.max(1, -Math.round((Date.parse(`${w.dueDate}T00:00:00Z`) - Date.parse(`${todayISO()}T00:00:00Z`)) / 864e5)) : 0;
  if (late) parts.push(`It is ${late} day${late === 1 ? '' : 's'} overdue`);
  else if (w.dueDate === todayISO()) parts.push(w.dueTime ? `It is due today at ${w.dueTime.slice(0, 5)}` : 'It is due today');
  else if (w.priority === 'Critical') parts.push('It is critical');
  else parts.push('It is the most urgent thing on your list');
  if (w.kind === 'ticket' && w.slaDueAt) parts.push('its service-level clock is running');
  let s = `${parts.join(', and ')}.`;
  if (nextMeetingIn != null && nextMeetingIn > 20) s += ` You have ${hm(nextMeetingIn)} before your next meeting.`;
  return s;
}

/**
 * Today (calm): the greeting and one line, then one thing to do now (Start runs its timer in place), "Then" with the two after it, the
 * day ribbon with the next meeting's Join, the insight line (each fact opens the insight sheet) and one Aura sentence. The right panel
 * holds Reminders · N today, Up next, Waiting on you, This week and a free-time tip. Morning (not checked in) asks to check in;
 * evening (checked out, or after the working day) sums up the day.
 */
export function CalmToday() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [skipped, setSkipped] = useState<string[]>([]);
  const me = useAuth((s) => s.ctx!.user);
  const first = me.displayName.split(' ')[0] || me.displayName;
  const today = todayISO();
  const now = useNow(30_000);
  const nowH = hourIn(now);
  const att = useAttendanceToday();
  const { day } = useToday(false);
  const work = useWorkList({ mine: true });
  const dash = useCachedWsQuery(['dashboard', null], () => insightApi.dashboard(null), { staleTime: 60_000 });
  const briefing = useCachedWsQuery(['inbox', 'briefing'], inboxApi.briefing, { staleTime: 30_000 });
  const inbox = useCachedWsQuery(['inbox', 'rows', 'all'], () => inboxApi.list('all'), { staleTime: 30_000 });
  const ai = useAi();
  const ask = useAssistant((s) => s.ask);
  const [sheet, setSheet] = useState(false);

  const a = att.data;
  const workEnd = toH(a?.workEnd, 18), workStart = toH(a?.workStart, 9);
  const forced = params.get('state') as DayState | null;
  const state: DayState = forced && ['morning', 'afternoon', 'evening'].includes(forced) ? forced
    : a?.record?.checkOutAt || nowH >= workEnd ? 'evening'
    : a && !a.record && a.workingDay && !a.onLeave && a.policy?.enabled !== false && nowH < 12 ? 'morning' : 'afternoon';
  const part = nowH < 12 ? 'Good morning' : nowH < 17 ? 'Good afternoon' : 'Good evening';

  const open = useMemo(() => { const o = work.items.filter(isOpen).sort(smart); return [...o.filter((w) => !skipped.includes(w.id)), ...o.filter((w) => skipped.includes(w.id))]; }, [work.items, skipped]);
  const hero = open[0] ?? null;
  const then = open.slice(1, 3);
  const meets = (day?.meets ?? []).slice().sort((x, y) => x.start - y.start);
  const nextMeet = meets.find((m) => m.end > nowH) ?? null;
  const nextIn = nextMeet ? Math.round((nextMeet.start - nowH) * 60) : null;
  const logged = day?.loggedMin ?? 0;
  const planned = Math.round((workEnd - workStart - 1) * 60);
  const doneToday = day?.done.length ?? 0;
  const overdue = dash.data?.counts?.myOverdue ?? open.filter((w) => w.isOverdue).length;
  const dueToday = open.filter((w) => w.dueDate === today).length;
  const cut = hero?.dueTime ? hero.dueTime.slice(0, 5) : nextMeet ? hhmm(nextMeet.start) : null;

  // The hero line under the greeting.
  const second = state === 'morning' ? 'Ready when you are.'
    : state === 'evening' ? (logged < planned ? `Log ${hm(planned - logged)} and you’re done.` : 'Everything is logged.')
    : hero ? (cut ? `One thing before ${cut}.` : 'One thing first.') : 'Nothing is waiting on you.';
  const title = state === 'evening' ? `You finished ${doneToday} thing${doneToday === 1 ? '' : 's'}.` : `${part}, ${first}.`;

  // The ribbon: meetings and calls, focus blocks, logged time; past ones faded.
  const segs: CalmSeg[] = [
    ...meets.map((m) => ({ key: m.key, start: m.start, end: m.end, label: m.e.title, color: /\b1:1\b|one-on-one/i.test(m.e.title) ? ribbonColors.review : /\b(sync|call|client)\b/i.test(m.e.title) ? ribbonColors.admin : ribbonColors.meet, past: m.end <= nowH, onClick: () => nav(m.e.joinUrl ? `/meetings?open=${m.e.projectId ? 'p' : 'w'}:${m.e.id}` : '/meetings') })),
    ...(day?.focus ?? []).map((f) => ({ key: f.key, start: f.start, end: f.end, label: `${f.e.key ? `${f.e.key} ` : ''}${f.e.title}`, color: ribbonColors.focus, past: f.end <= nowH })),
    ...(day?.time ?? []).filter((t) => t.start && t.end).map((t) => {
      const s = hourIn(new Date(t.start)), e = hourIn(new Date(t.end!));
      return { key: t.id, start: s, end: Math.max(e, s + 0.25), label: t.title, color: ribbonColors.light, past: true };
    }),
  ];
  const ribbonHead = nextMeet
    ? <><b>{nextMeet.e.title}{nextMeet.e.projectName ? ` · ${nextMeet.e.projectName}` : ''}</b> {nextIn! <= 0 ? 'now' : nextIn! < 60 ? `in ${nextIn} min` : `in ${hm(nextIn!)}`}</>
    : state === 'evening' ? <>Day ends at <b>{hhmm(workEnd)}</b></> : <>No more meetings today</>;
  const join = nextMeet?.e.joinUrl;

  const insights = state === 'evening'
    ? [{ key: 'logged', label: `${hm(logged)} of ${hm(planned)} logged`, onClick: () => setSheet(true) }, { key: 'done', label: `${doneToday} done today`, onClick: () => setSheet(true) }, { key: 'overdue', label: `${overdue} overdue`, onClick: () => setSheet(true) }]
    : state === 'morning'
      ? [{ key: 'planned', label: `${hm(planned)} planned`, onClick: () => setSheet(true) }, { key: 'due', label: `${dueToday} due today`, onClick: () => setSheet(true) }, { key: 'overdue', label: `${overdue} overdue`, onClick: () => setSheet(true) }]
      : [{ key: 'logged', label: `${hm(logged)} of ${hm(planned)} logged`, onClick: () => setSheet(true) }, { key: 'overdue', label: `${overdue} overdue`, onClick: () => setSheet(true) }, { key: 'due', label: `${dueToday} due today`, onClick: () => setSheet(true) }, { key: 'meet', label: `${meets.length} meeting${meets.length === 1 ? '' : 's'}`, onClick: () => setSheet(true) }];

  // The one Aura sentence: what is waiting longest (from the inbox), or the briefing's first reason.
  const waiting = (inbox.data?.rows ?? [])[0];
  const auraText = waiting ? `${waiting.title}.` : briefing.data?.reasons?.[0];

  const dots = (
        <DotsMenu label="More on Today" items={[
          { label: 'Briefing and Needs you', hint: 'The full inbox, My team and your numbers', icon: 'inbox', onSelect: () => nav('/?classic=1') },
          { label: 'My team', icon: 'users', onSelect: () => nav('/?classic=1&view=team') },
          { label: 'Check-ins and “what if”', icon: 'target', onSelect: () => nav('/?tab=today') },
          { label: 'Decisions', icon: 'checks', onSelect: () => nav('/?tab=decisions') },
          { label: 'Audit trail', icon: 'shield', onSelect: () => nav('/?tab=audit') },
          { label: 'Dashboard', icon: 'dashboard', onSelect: () => nav('/?tab=dashboard') },
          { label: 'Reminders', icon: 'bell', onSelect: () => nav('/?tab=reminders') },
          { label: 'Aura conversations', icon: 'sparkle', onSelect: () => nav('/?tab=assistant') },
        ]} />
  );
  return (
    <CalmSplit className="cp-page" crumb={<><span>{headDay(today)}</span><span style={{ flex: 1 }} />{dots}</>} label="Today" rail={<TodayRail meets={meets} nowH={nowH} freeMin={day?.freeMin ?? 0} hero={hero} />}>
      <header className="cp-hero" data-testid="today-hero"><h1>{title}<em>{second}</em></h1></header>
      {state === 'morning' ? <CheckInCard planned={planned} usual={a?.workStart} />
        : state === 'evening' ? <EveningCard logged={logged} planned={planned} />
        : hero ? <HeroTask w={hero} why={whyLine(hero, nextIn)} onOpen={() => nav(`/work?item=${hero.id}`)} onLater={() => setSkipped((x) => [...x, hero.id])} />
        : <CalmCard variant="hero" className="td-hero"><div className="cp-tag">All clear</div><h2>Nothing needs you right now</h2><p className="td-why">New work, decisions and mentions arrive here first.</p>
            <div className="td-acts"><CalmGo onClick={() => openCalmNew({ type: 'task' })}>New task</CalmGo><CalmLink onClick={() => nav('/work')}>My work ›</CalmLink></div></CalmCard>}
      {(then.length > 0 || state !== 'afternoon') && (
        <div className="td-then" aria-label={state === 'evening' ? 'Tomorrow' : 'Then'}>
          <span>{state === 'morning' ? 'First' : state === 'evening' ? 'Next' : 'Then'}</span>
          {(state === 'morning' ? open.slice(0, 2) : then).map((w) => (
            <Link key={w.id} to={`/work?item=${w.id}`} className={w.isOverdue ? 'hot' : ''}>{w.title}<small>{w.isOverdue ? 'overdue' : w.dueTime ? w.dueTime.slice(0, 5) : dayText(w.dueDate)}</small></Link>
          ))}
          <span className="cp-sp" />
          <Link className="cp-lk" to="/work">All {open.length} ›</Link>
        </div>
      )}
      <div className="td-gap" />
      <CalmDayRibbon segs={segs} from={Math.min(workStart, 9)} to={Math.max(workEnd, 18)} now={state === 'evening' && nowH > workEnd ? null : nowH} head={ribbonHead}
        aside={<>{join && <a className="calm-join" href={join} target="_blank" rel="noreferrer">Join</a>}<Link className="cp-lk" to="/?tab=calendar">Full day ›</Link></>} />
      <div className="td-gap" />
      <CalmFoot>
        <CalmInsights items={insights} />
        <AuraLine text={auraText} action={waiting?.href ? 'Open' : ai ? 'Ask Aura' : undefined}
          onAction={() => (waiting?.href ? nav(waiting.href) : ask('What should I do next today?'))} />
      </CalmFoot>
      <InsightSheet open={sheet} onClose={() => setSheet(false)} logged={logged} planned={planned} open_={open} doneToday={day?.done ?? []} meets={meets.length} free={day?.freeMin ?? 0} />
      <span hidden data-testid="today-state">{state}</span>
    </CalmSplit>
  );
}

/** The hero task: its project, title and why; Start turns into the running timer in place (spring, transform only). */
function HeroTask({ w, why, onOpen, onLater }: { w: WorkRow; why: string; onOpen: () => void; onLater: () => void }) {
  const wid = useWorkspaceId();
  const still = useReducedMotion();
  const running = useWsQuery(['timer'], () => timeApi.running(), { staleTime: 30_000, retry: false });
  const r = running.data;
  const mine = !!r && r.isRunning && (r.taskId === w.id || r.workTaskId === w.id);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  useEffect(() => { setStartedAt(mine && r?.startedAt ? Date.parse(r.startedAt) : null); }, [mine, r?.startedAt]);
  const [tick, setTick] = useState(Date.now());
  useEffect(() => { if (startedAt == null) return; const t = window.setInterval(() => setTick(Date.now()), 1000); return () => window.clearInterval(t); }, [startedAt]);
  const start = async () => {
    setStartedAt(Date.now());   // optimistic: the timer runs at once
    try {
      if (w.kind === 'task') await timeApi.start(w.id); else await timeApi.startOnWorkTask(w.id);
      void invalidateWorkspace(wid, 'timer');
    } catch (e) { setStartedAt(null); toast(errText(e, 'Could not start the timer.'), 'error'); }
  };
  const stop = async () => {
    const was = startedAt; setStartedAt(null);
    try { await timeApi.stop(); toast('Time logged.'); void invalidateWorkspace(wid, 'timer'); void invalidateWorkspace(wid, 'time'); refreshWork(wid); }
    catch (e) { setStartedAt(was); toast(errText(e, 'Could not stop the timer.'), 'error'); }
  };
  const secs = startedAt == null ? 0 : Math.max(0, Math.floor((tick - startedAt) / 1000));
  const t = `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;
  return (
    <CalmCard variant="hero" className="td-hero" aria-label="Do this now">
      <div className="cp-tag"><CalmDot color={projectColor(w.projectId)} />{[w.projectName, w.key].filter(Boolean).join(' · ')}</div>
      <h2>{w.title}</h2>
      <p className="td-why">{why}</p>
      <div className="td-acts">
        {startedAt == null ? (
          <motion.span key="go" initial={still ? false : { opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} transition={gentleSpring}>
            <CalmGo onClick={() => void start()}><Icon name="play" size={14} /> Start</CalmGo>
          </motion.span>
        ) : (
          <motion.button key="tm" type="button" className="td-timer" onClick={() => void stop()} aria-label={`Timer ${t}. Stop and log`} data-testid="hero-timer"
            initial={still ? false : { opacity: 0, scaleX: 0.7 }} animate={{ opacity: 1, scaleX: 1 }} style={{ transformOrigin: '0 50%' }} transition={gentleSpring}>
            <i aria-hidden="true" />{t}<small>Stop</small>
          </motion.button>
        )}
        <CalmLink onClick={onOpen}>Open</CalmLink>
        <CalmLink onClick={onLater}>Later</CalmLink>
      </div>
    </CalmCard>
  );
}

/** Morning: check in from here (Office, Home or Client site), or say not today. */
function CheckInCard({ planned, usual }: { planned: number; usual?: string }) {
  const wid = useWorkspaceId();
  const sheet = useAttendanceSheet((s) => s.show);
  const nav = useNavigate();
  const [mode, setMode] = useState<AttendanceMode>('Office');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try { await attendanceApi.checkIn({ mode, source: sourceOfDevice() }); toast(`Checked in · ${MODES.find((m) => m.id === mode)?.short ?? mode}.`); await invalidateWorkspace(wid, 'attendance'); }
    catch (e) { toast(errText(e, 'Could not check in.'), 'error'); }
    finally { setBusy(false); }
  };
  return (
    <CalmCard variant="hero" className="td-hero" aria-label="Check in">
      <div className="cp-tag">{usual ? `Work starts at ${usual.slice(0, 5)} · ` : ''}{hm(planned)} planned</div>
      <h2>Check in and start your day</h2>
      <div className="td-modes"><CalmPills label="Where" value={mode} onChange={setMode} options={MODES.map((m) => ({ value: m.id, label: m.id === 'ClientSite' ? 'Client site' : m.short }))} /></div>
      <div className="td-acts">
        <CalmGo tone="green" onClick={() => void go()} disabled={busy}>Check in · {mode === 'ClientSite' ? 'Client site' : MODES.find((m) => m.id === mode)?.short}</CalmGo>
        <CalmLink onClick={() => sheet('checkin')}>More options</CalmLink>
        <CalmLink onClick={() => nav('/?tab=calendar')}>Plan ›</CalmLink>
      </div>
    </CalmCard>
  );
}

/** Evening: what is left to log, and check out. */
function EveningCard({ logged, planned }: { logged: number; planned: number }) {
  const nav = useNavigate();
  const sheet = useAttendanceSheet((s) => s.show);
  const att = useAttendanceToday();
  const out = !!att.data?.record?.checkOutAt;
  const gap = Math.max(0, planned - logged);
  return (
    <CalmCard variant="hero" className="td-hero" aria-label="End of day">
      <div className="cp-tag">{hm(logged)} logged today{gap ? ` · ${hm(gap)} unlogged` : ''}</div>
      <h2>{gap ? 'Log the rest of your day' : 'Your day is logged'}</h2>
      <p className="td-why">{gap ? 'Add what you worked on, and the timesheet fills itself.' : 'Nothing is missing. See you tomorrow.'}</p>
      <div className="td-acts">
        {gap > 0 && <CalmGo onClick={() => nav('/time')}>Log {hm(gap)}</CalmGo>}
        {!out && <CalmLink onClick={() => sheet('checkout')}>Check out ›</CalmLink>}
        <CalmLink onClick={() => nav('/time')}>Timesheet ›</CalmLink>
      </div>
    </CalmCard>
  );
}

/** The insight sheet: the facts behind the insight line. */
function InsightSheet({ open, onClose, logged, planned, open_, doneToday, meets, free }: {
  open: boolean; onClose: () => void; logged: number; planned: number; open_: WorkRow[]; doneToday: { id: string; title: string; link: string | null }[]; meets: number; free: number;
}) {
  const late = open_.filter((w) => w.isOverdue);
  return (
    <CalmSheet open={open} onClose={onClose} kind="bottom" title="Your day in numbers" sub="Each one opens where it comes from.">
      <div className="td-ins-sheet">
        <CalmCard variant="tile"><b>{hm(logged)}</b><small>of {hm(planned)} logged</small><ul><li><Link to="/time" onClick={onClose}>Open the timesheet ›</Link></li></ul></CalmCard>
        <CalmCard variant="tile"><b>{late.length}</b><small>overdue</small><ul>{late.slice(0, 4).map((w) => <li key={w.id}><Link to={`/work?item=${w.id}`} onClick={onClose}>{w.key} {w.title}</Link></li>)}</ul></CalmCard>
        <CalmCard variant="tile"><b>{doneToday.length}</b><small>done today</small><ul>{doneToday.slice(0, 4).map((d) => <li key={d.id}>{d.link ? <Link to={d.link} onClick={onClose}>{d.title}</Link> : d.title}</li>)}</ul></CalmCard>
        <CalmCard variant="tile"><b>{meets}</b><small>meetings · {hm(free)} free</small><ul><li><Link to="/?tab=calendar" onClick={onClose}>Open the calendar ›</Link></li></ul></CalmCard>
      </div>
    </CalmSheet>
  );
}

// ------------------------------------------------------------------------------------------------------------------ the right panel

type MeetLite = { key: string; start: number; end: number; e: { id: string; title: string; projectId: string | null; projectName: string | null; joinUrl?: string | null } };

function TodayRail({ meets, nowH, freeMin, hero }: { meets: MeetLite[]; nowH: number; freeMin: number; hero: WorkRow | null }) {
  const nav = useNavigate();
  const ai = useAi();
  const ask = useAssistant((s) => s.ask);
  const inbox = useCachedWsQuery(['inbox', 'rows', 'all'], () => inboxApi.list('all'), { staleTime: 30_000 });
  const upcoming = meets.filter((m) => m.end > nowH).slice(0, 3);
  const rows = (inbox.data?.rows ?? []).slice(0, 3);
  return (
    <>
      <RemindersCard />
      <CalmRailCard title="Up next" link="Calendar ›" to="/?tab=calendar">
        {upcoming.length === 0 ? <p className="calm-week-note">No more meetings today.</p> : upcoming.map((m, i) => {
          const mins = Math.round((m.start - nowH) * 60);
          return <CalmRailRow key={m.key} lead={<CalmBar color={projectColor(m.e.projectId ?? m.e.id)} />} title={`${m.e.title}${m.e.projectName ? ` · ${m.e.projectName}` : ''}`} sub={hhmm(m.start)}
            right={i === 0 && m.e.joinUrl && mins < 15 ? <a className="calm-join" href={m.e.joinUrl} target="_blank" rel="noreferrer">Join</a> : mins <= 0 ? 'Now' : `in ${hm(mins)}`}
            onClick={() => nav(`/meetings?open=${m.e.projectId ? 'p' : 'w'}:${m.e.id}`)} />;
        })}
      </CalmRailCard>
      {rows.length > 0 && (
        <CalmRailCard title="Waiting on you" link="All ›" to="/?classic=1">
          {rows.map((r) => <CalmRailRow key={r.id} lead={<CalmAv name={r.title} />} title={r.title} sub={r.sub} hot={r.urgent} right={agoText(r.at)} to={r.href ?? undefined} />)}
        </CalmRailCard>
      )}
      <WeekCard />
      {freeMin >= 30 && hero && (
        <CalmCard className="td-tip" aria-label="Aura">
          <span className="calm-orb" aria-hidden="true" />
          <p>You have {hm(freeMin)} free today. {hero.title} is the best use of it. {ai && <button type="button" onClick={() => ask(`Hold focus time for ${hero.key} ${hero.title} in my free time today.`)}>Hold it</button>}</p>
        </CalmCard>
      )}
    </>
  );
}

const agoText = (iso: string) => { const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000)); return m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`; };

/** Reminders · N today: tick one off in place (optimistic, with ✓ Saved), All › opens Reminders. */
function RemindersCard() {
  const wid = useWorkspaceId();
  const today = todayISO();
  const q = useWsQuery(['reminders', 'list'], reminderApi.list, { staleTime: 30_000, retry: false });
  const [done, setDone] = useState<Set<string>>(new Set());
  const [saved, setSaved] = useState(false);
  const due = (r: Reminder) => (r.nextFireAt ? new Date(r.nextFireAt) : null);
  const list = (q.data?.open ?? []).filter((r) => { const d = due(r); return !!d && d.toISOString() <= new Date(`${shiftIsoDate(today, 1)}T00:00:00`).toISOString(); })
    .sort((x, y) => (x.nextFireAt ?? '').localeCompare(y.nextFireAt ?? ''));
  const n = q.data?.counts?.today ?? list.length;
  const tick = async (r: Reminder) => {
    setDone((s) => new Set(s).add(r.id));
    try { await reminderApi.done(r.id, { nextFireAt: r.nextFireAt, lastFiredAt: r.lastFiredAt }); setSaved(true); window.setTimeout(() => setSaved(false), 1400); window.setTimeout(() => void invalidateWorkspace(wid, 'reminders'), 700); }
    catch (e) { setDone((s) => { const x = new Set(s); x.delete(r.id); return x; }); toast(errText(e, 'Could not finish the reminder.'), 'error'); }
  };
  return (
    <CalmRailCard title={<>Reminders · {n} today <span className={`cp-saved${saved ? ' on' : ''}`} aria-live="polite">{saved ? '✓ Saved' : ''}</span></>} link="All ›" to="/?tab=reminders" label="Reminders">
      {list.length === 0 ? <p className="calm-week-note">{q.isLoading ? 'Loading…' : 'Nothing to remember today.'}</p> : list.slice(0, 3).map((r) => {
        const d = due(r);
        const off = done.has(r.id);
        return (
          <div key={r.id} className={`td-rem-row${off ? ' done' : ''}`}>
            <button type="button" className={`cp-ring${off ? ' done' : ''}`} aria-label={`Done: ${r.title}`} aria-pressed={off} disabled={off} onClick={() => void tick(r)} />
            <span className="calm-rr-t"><b>{r.title}</b><small>{[d ? clock(d) : null, r.from ? `From ${r.from.name.split(' ')[0]}` : r.source === 'Meeting' ? 'Meeting' : r.targetKey].filter(Boolean).join(' · ')}</small></span>
          </div>
        );
      })}
    </CalmRailCard>
  );
}

