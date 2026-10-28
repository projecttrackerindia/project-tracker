import { Face } from '../../components/Face';
import { useEffect, useState, type ReactNode } from 'react';
import { AgentPage, type AgentSection } from '../agent/AgentPage';
import { AiPage } from '../ai/AiPage';
import { RemindersPage } from '../reminders/RemindersPage';
import { CommandCenterPage } from '../command/CommandCenterPage';
import { ReviewQueueCard } from '../github/GitHubApp';
import { CalendarPlanning } from '../calendar/CalendarPage';
import { WeekPlanner } from '../calendar/WeekPlanner';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { UseQueryResult } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { insightApi, integrationsApi, projectApi, workItemApi } from '../../api/endpoints';
import type { CalendarEvent } from '../../api/types';
import { EmptyState, ErrorState, Modal, PageLoader, Segmented } from '../../components/ui';
import { useAi, useAssistant } from '../ai/Assistant';
import { useIsMobile, useIsSmallPhone } from '../../lib/mobile';
import { PhoneToday } from './PhoneToday';
import { MONTHS, todayISO } from '../../lib/format';
import { invalidateWorkspace, useCachedWsQuery, useWsQuery } from '../../lib/hooks';
import { refreshWork } from '../work/workUi';
import { hourIn, isoDateIn, zonedParts } from '../../lib/zone';
import { YourDay } from '../calendar/YourDay';
import { toCalendarEvent, useTimeline } from '../calendar/timeline';
import { useAuth, useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { DotsMenu } from '../talk/DotsMenu';
import { formatMinutes } from '../time/time';
import { KIND_LABEL, inboxApi, type InboxBriefing, type InboxFilter, type InboxKind, type InboxRow } from './inboxApi';
import { AnimatePresence, motion } from 'framer-motion';
import { itemVariants, listVariants } from '../../lib/motion';
import { SignalsSection, signalsLine, useTodaySignals } from './Signals';
import { Term } from '../../components/Term';
import './home.css';

type Tab = 'for-you' | 'calendar';
type View = 'me' | 'team';
const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.errors[0]?.message ?? e.message : fallback);
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dateOf = (s: string) => new Date(`${s}T00:00:00`);
/** "Monday 26 Oct" */
const longDay = (s: string) => { const d = dateOf(s); return `${d.toLocaleDateString(undefined, { weekday: 'long' })} ${d.getDate()} ${MONTHS[d.getMonth()]}`; };
/** "Tuesday, 27 October" (shown in capitals above the greeting) */
const headDay = (s: string) => { const d = dateOf(s); return `${d.toLocaleDateString('en-GB', { weekday: 'long' })}, ${d.getDate()} ${d.toLocaleDateString('en-GB', { month: 'long' })}`; };
const addDays = (s: string, n: number) => { const d = dateOf(s); d.setDate(d.getDate() + n); return iso(d); };
/** "9:30", "12:00" — the day card's 12-hour clock without AM/PM. */
/** "9:30" of an instant, read in the app's zone (not the device's). */
const clock = (d: Date) => { const p = zonedParts(d); return `${p.hour % 12 || 12}:${String(p.minute).padStart(2, '0')}`; };
/** The app-zone day of an instant. */
const dayOfInstant = (d: Date) => isoDateIn(d);
/** "1h 40m", "45m", "2h" */
const dur = (min: number) => { const h = Math.floor(min / 60), m = Math.round(min % 60); return h && m ? `${h}h ${m}m` : h ? `${h}h` : `${m}m`; };

/**
 * Home: "For me" (the briefing, your day, what needs you, up next and four numbers), "My team" (the same with the team's meetings) and
 * "Calendar" (the week; from the sidebar's Calendar, or the phone's tab). Tabs never leave Home; links with › do.
 */
const AGENT: Record<string, AgentSection> = { proposals: 'review', given: 'assigned', 'mail-agent': 'my-inbox' };
const COMMAND_TABS = ['today', 'decisions', 'audit', 'dashboard', 'work'];
const AGENT_TAB: Record<AgentSection, string> = { review: 'proposals', assigned: 'given', 'my-inbox': 'mail-agent' };

export function HomePage() {
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab') ?? '';
  // Pages that have no place of their own any more but are still reached from old links and the inbox: the project agent's proposals,
  // the reminders list, and the assistant's full page (also where an assistant conversation, ?c=<id>, opens).
  if (AGENT[raw]) return <AgentPage section={AGENT[raw]} onSection={(sec) => setParams({ tab: AGENT_TAB[sec] }, { replace: true })} />;
  if (raw === 'reminders') return <RemindersPage />;
  if (raw === 'assistant' || params.has('c')) return <AiPage />;
  // The former Command Center's views (Today with check-ins, the brief and "what if", Decisions, the agent's audit trail, the dashboard, My
  // work), and the deep links notifications still carry (/command-center?checkin=… arrives here with its query).
  if (COMMAND_TABS.includes(raw) || ['checkin', 'delegate', 'brief', 'delegation'].some((k) => params.has(k))) return <CommandCenterPage />;
  const tab: Tab = raw === 'calendar' ? 'calendar' : 'for-you';
  const view: View = params.get('view') === 'team' ? 'team' : 'me';
  const setTab = (t: Tab, v: View = 'me') => setParams((p) => {
    const n = new URLSearchParams(p);
    if (t === 'for-you') n.delete('tab'); else n.set('tab', t);
    if (t === 'for-you' && v === 'team') n.set('view', 'team'); else n.delete('view');
    return n;
  }, { replace: true });
  if (tab === 'calendar') return <WeekCalendar onTab={setTab} />;
  return <ForYouOrPhone view={view} onTab={setTab} />;
}

/** A phone held upright gets the phone's own Today (apple/s-mobile, s-phone); My team stays the full view. */
function ForYouOrPhone({ view, onTab }: { view: View; onTab: (t: Tab, v?: View) => void }) {
  const small = useIsSmallPhone();
  return small && view === 'me' ? <PhoneToday /> : <ForYou view={view} onTab={onTab} />;
}


// ------------------------------------------------------------------------------------------------------------------------- For you

function greeting(name: string) {
  const h = zonedParts(new Date()).hour;
  const part = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  return `${part}, ${name.split(' ')[0] || name}.`;
}

type HomeSeg = 'me' | 'team' | 'calendar';

function ForYou({ view, onTab }: { view: View; onTab: (t: Tab, v?: View) => void }) {
  const nav = useNavigate();
  const me = useAuth((s) => s.ctx!.user);
  const today = todayISO();
  const phone = useIsMobile();
  const briefing = useCachedWsQuery(['inbox', 'briefing'], inboxApi.briefing, { staleTime: 30_000 });
  const team = view === 'team';
  // The phone has no sidebar, so its Calendar stays a tab here; on a desk Calendar is in the sidebar.
  const segs: { id: HomeSeg; label: string }[] = [{ id: 'me', label: 'For me' }, { id: 'team', label: 'My team' }, ...(phone ? [{ id: 'calendar' as const, label: 'Calendar' }] : [])];
  return (
    <div className="hm">
      <header className="hm-hello">
        <div>
          <div className="hm-date">{headDay(today)}</div>
          <h1 className="hm-h1">{greeting(me.displayName)}</h1>
        </div>
        <div className="hm-heads">
          <Segmented label="Home" className="hm-seg" value={view as HomeSeg} options={segs}
            onChange={(v) => (v === 'calendar' ? onTab('calendar') : onTab('for-you', v))} />
          {/* The Command Center's own views stay one click away (quiet ··· beside the switch). */}
          <DotsMenu label="More on Home" items={[
            { label: 'Groot', hint: 'Your conversations with Groot', icon: 'sparkle', onSelect: () => nav('/?tab=assistant') },
            { label: 'Today', hint: 'Check-ins, meetings and "what if"', icon: 'target', onSelect: () => nav('/?tab=today') },
            { label: 'Decisions', icon: 'checks', onSelect: () => nav('/?tab=decisions') },
            { label: 'Audit trail', hint: 'Everything the agent did', icon: 'shield', onSelect: () => nav('/?tab=audit') },
            { label: 'Dashboard', icon: 'dashboard', onSelect: () => nav('/?tab=dashboard') },
            { label: 'Reminders', icon: 'bell', onSelect: () => nav('/?tab=reminders') },
          ]} />
        </div>
      </header>
      <Briefing q={briefing} />
      <YourDay team={team} />
      <div className="hm-grid">
        <InboxCard />
        <aside className="hm-side" aria-label="Up next and your numbers">
          <UpNext team={team} />
          <HomeNumbers />
          <ReviewQueueCard compact />
        </aside>
      </div>
      <SignalsSection />
    </div>
  );
}

/** "6 things need you." reads as "6 things need you today." on Today. */
const todayHeadline = (h?: string | null) => (h ?? '').replace(/ need(s)? you\.$/, ' need$1 you today.');

function Briefing({ q }: { q: UseQueryResult<InboxBriefing, Error> }) {
  const ai = useAi();
  const ask = useAssistant((s) => s.ask);
  if (q.isLoading) return <div className="hm-brief loading" aria-busy="true"><span className="hm-orb" aria-hidden="true" /><p>Reading your work…</p></div>;
  if (q.isError) return <div className="hm-brief" role="status"><span className="hm-orb" aria-hidden="true" /><p>The briefing could not be read just now. <button type="button" className="link-btn" onClick={() => void q.refetch()}>Try again</button></p></div>;
  if (!q.data) return null;
  const b = q.data;
  return (
    <section className="hm-brief" aria-label="Briefing" title={b.sources ? `From ${b.sources}` : undefined}>
      <span className="hm-orb" aria-hidden="true" />
      <p><b>{todayHeadline(b.headline)}</b>{(b.reasons?.length ?? 0) > 0 && <> {b.reasons.join(' ')}</>}</p>
      {ai && <button type="button" className="hm-plan" onClick={() => ask('Plan my day: put what needs me today in order around my meetings, with focus blocks for the most important work.')}>Plan my day</button>}
    </section>
  );
}

const CHIPS: { id: InboxFilter; label: string; count: 'all' | 'assigned' | 'decisions' | 'mentions' }[] = [
  { id: 'all', label: 'All', count: 'all' }, { id: 'assigned', label: 'Assigned', count: 'assigned' },
  { id: 'decisions', label: 'Decisions', count: 'decisions' }, { id: 'mentions', label: 'Mentions', count: 'mentions' },
];

const DONE_TEXT: Record<string, string> = { accept: 'Accepted.', approve: 'Approved.', done: 'Marked done.' };

/** The rounded-square icon of each kind: red ● ticket, violet ✦ decision, orange ! task, green @ mention, blue ◷ the rest. */
const KIND_GLYPH: Record<InboxKind, string> = { ticket: '●', decision: '✦', task: '!', mention: '@', approval: '◷', reminder: '◷', access: '◷', review: '◷' };

/** The one button of a row: a critical ticket opens its war room (red), a decision is decided (blue), everything else is a grey pill. */
function rowButton(r: InboxRow): { label: string; tone: 'red' | 'blue' | 'grey'; open: boolean } {
  if (r.kind === 'ticket' && r.urgent) return { label: 'Open war room', tone: 'red', open: !r.action.endpoint };
  if (r.kind === 'decision') return { label: 'Decide', tone: 'blue', open: !!r.href };
  return { label: r.action.label, tone: 'grey', open: false };
}

/** The grey line under a row: a decision says so; a critical ticket reads "Critical ticket · …"; the rest as the server words it. */
function subLine(r: InboxRow): string {
  if (!r.sub) return KIND_LABEL[r.kind] ?? '';
  if (r.kind === 'decision') return `Decision · ${r.sub}`;
  if (r.kind === 'ticket') return /^Critical\b/.test(r.sub) ? r.sub.replace(/^Critical/, 'Critical ticket') : `Ticket · ${r.sub}`;
  return r.sub;
}

function InboxCard() {
  const wid = useWorkspaceId();
  const nav = useNavigate();
  const [filter, setFilter] = useState<InboxFilter>('all');
  const q = useCachedWsQuery(['inbox', 'rows', filter], () => inboxApi.list(filter), { staleTime: 30_000 });
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<Set<string>>(new Set());
  // Acting on a row (done, snooze, later) changes reminders and work too: refresh those views with the inbox.
  const refresh = () => { void invalidateWorkspace(wid, 'inbox'); void invalidateWorkspace(wid, 'reminders'); refreshWork(wid); };

  const act = async (row: InboxRow) => {
    if (!row.action.endpoint) { if (row.href) nav(row.href); return; }
    setBusy(row.id);
    try {
      await inboxApi.act(row);
      setDone((s) => new Set(s).add(row.id));
      toast(DONE_TEXT[row.action.verb] ?? 'Done.');
      window.setTimeout(refresh, 700);   // the row fades, then the list catches up
    } catch (e) { toast(errText(e, 'That could not be done here. Open it instead.'), 'error'); }
    finally { setBusy(null); }
  };
  const later = async (row: InboxRow) => {
    setBusy(row.id);
    try { await inboxApi.later(row.id); setDone((s) => new Set(s).add(row.id)); toast('Moved to tomorrow morning.'); window.setTimeout(refresh, 500); }
    catch (e) { toast(errText(e, 'Could not move it.'), 'error'); }
    finally { setBusy(null); }
  };

  const counts = q.data?.counts;
  const watch = signalsLine(useTodaySignals().data);
  // A reply without rows (an older server during a rolling release) reads as an empty inbox, not a crash of Home.
  const rows = q.data?.rows ?? [];
  const total = counts?.all ?? rows.length;
  return (
    <section className="hm-card hm-inbox" aria-label="Needs you">
      <div className="hm-lh"><h2 className="hm-h3"><Term k="needs you">Needs you</Term></h2>{total > 0 && <span className="hm-faint">{total} · newest problems first</span>}</div>
      {/* The chips only help with more than 10 rows (or when a chip other than All is on). */}
      {(filter !== 'all' || total > 10) && <div className="ds-chips hm-chips" role="group" aria-label="Show">
        {CHIPS.map((c) => (
          <button key={c.id} type="button" className={`ds-chip ${filter === c.id ? 'on' : ''}`} aria-pressed={filter === c.id} onClick={() => setFilter(c.id)}>
            {c.label}{counts && counts[c.count] > 0 && <em>{counts[c.count]}</em>}
          </button>
        ))}
      </div>}
      {q.isLoading ? <PageLoader /> : q.isError ? <ErrorState error={q.error} retry={() => void q.refetch()} /> : rows.length === 0 ? (
        // Never a bare "Nothing needs you" while there are signals to watch: say how many, and that they are below.
        filter === 'all' && watch ? (
          <p className="hm-empty-signals" data-testid="needs-you-empty"><b>Nothing needs you</b> · {watch} below</p>
        ) : (
          <EmptyState icon="checkCircle" title={filter === 'all' ? 'Nothing needs you' : 'Nothing here'}
            text={(q.data?.later ?? 0) > 0 ? `${q.data!.later} moved to tomorrow.` : 'New work, decisions and mentions arrive here.'} />
        )
      ) : (
        <motion.ul className="hm-rows" variants={listVariants} initial="hidden" animate="show">
          <AnimatePresence initial={false}>
          {rows.map((r) => {
            const b = rowButton(r);
            const off = busy === r.id || done.has(r.id);
            return (
              <motion.li key={r.id} layout="position" variants={itemVariants} exit="exit" style={{ overflow: 'hidden' }} className={`hm-row ${done.has(r.id) ? 'done' : ''}`}
                onContextMenu={(e) => { if (off) return; e.preventDefault(); void later(r); }}>
                <span className={`hm-kind k-${r.kind}`} role="img" aria-label={KIND_LABEL[r.kind]} title={KIND_LABEL[r.kind]}>{KIND_GLYPH[r.kind]}</span>
                <div className="hm-row-main">
                  {r.href ? <Link to={r.href} className="hm-row-title">{r.title}</Link> : <span className="hm-row-title">{r.title}</span>}
                  <span className="hm-row-sub">{subLine(r)}</span>
                </div>
                <div className="hm-row-acts">
                  <button type="button" className="hm-later" disabled={off} onClick={() => void later(r)} title="Hide until tomorrow morning (or right-click the row)">Later</button>
                  <button type="button" className={`hm-pill ${b.tone}`} disabled={off} onClick={() => (b.open && r.href ? nav(r.href) : void act(r))}>{b.label}</button>
                </div>
              </motion.li>
            );
          })}
          </AnimatePresence>
        </motion.ul>
      )}
    </section>
  );
}

// ------------------------------------------------------------------------------------------------------------------------ Your day

// "Your day" is the Calendar's own day (features/calendar/YourDay): one timeline, one layout, so the two always agree.

type Meeting = { e: CalendarEvent; start: Date; h: number; end: number };

/** Meetings from the one timeline (scheduled meetings, including those synced from Google and Outlook), soonest first. */
function useMeetings(from: string, to: string, team: boolean) {
  const q = useTimeline({ from, to, scope: team ? 'team' : 'me' });
  const list: Meeting[] = (q.data?.events ?? []).filter((t) => t.type === 'meeting')
    .map((t) => { const e = toCalendarEvent(t); const start = new Date(t.start); const h = hourIn(start); return { e, start, h, end: h + (e.durationMinutes ?? 30) / 60 }; })
    .sort((a, b) => a.start.getTime() - b.start.getTime());
  return { q, list };
}

const AV_TINTS = ['#30b0c7', '#ff9500', '#5856d6', '#28cd41', '#ff2d55'];

/** The next meeting (today's, or the next one coming): when, who, Join, and a brief from the assistant. */
function UpNext({ team }: { team: boolean }) {
  const today = todayISO();
  const ai = useAi();
  const ask = useAssistant((s) => s.ask);
  const { q, list } = useMeetings(today, addDays(today, 14), team);
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = window.setInterval(() => setNow(new Date()), 60_000); return () => window.clearInterval(t); }, []);
  const next = list.find((m) => m.start.getTime() + (m.end - m.h) * 3600e3 > now.getTime());
  if (q.isLoading) return <section className="hm-card hm-next" aria-label="Up next"><p className="hm-quiet">Loading…</p></section>;
  if (!next) return <section className="hm-card hm-next" aria-label="Up next"><div className="hm-when">Up next</div><p className="hm-quiet">No meetings in the next two weeks.</p></section>;
  const mins = Math.round((next.start.getTime() - now.getTime()) / 60000);
  const nextDay = dayOfInstant(next.start);
  const sameDay = nextDay === today;
  const when = mins <= 0 ? 'Now' : sameDay ? `Up next · in ${mins < 60 ? `${mins} min` : dur(mins)}` : `Up next · ${addDays(today, 1) === nextDay ? 'Tomorrow' : longDay(nextDay)}`;
  const end = new Date(next.start.getTime() + (next.end - next.h) * 3600e3);
  const people = next.e.people ?? [];
  const join = next.e.joinUrl;
  return (
    <section className="hm-card hm-next" aria-label="Up next">
      <div className="hm-when">{when}</div>
      <h3 className="hm-h3 hm-next-t">{next.e.title}</h3>
      <div className="hm-faint hm-next-time">{clock(next.start)} – {clock(end)}{next.e.notes ? ' · Notes by Project Tracker' : next.e.projectName ? ` · ${next.e.projectName}` : ''}</div>
      <div className="hm-next-row">
        <div className="hm-ppl">{people.slice(0, 4).map((p, i) => <Face key={`${p}${i}`} byName name={p} className="hm-av" style={{ background: AV_TINTS[i % AV_TINTS.length] }} title={p} />)}</div>
        {join ? <a className="hm-pill join" href={join} target="_blank" rel="noreferrer">Join</a> : <Link className="hm-pill join" to={hrefOf(next.e)}>Join</Link>}
      </div>
      {ai && (
        <button type="button" className="hm-ai-line" onClick={() => ask(`Brief me for "${next.e.title}"${next.e.projectName ? ` (${next.e.projectName})` : ''}: open defects, pending items and what to ask for.`)}>
          <span className="hm-orb sm" aria-hidden="true" /><span>Brief ready: what is open, pending and worth asking{next.e.projectName ? ` on ${next.e.projectName}` : ''}.</span>
        </button>
      )}
    </section>
  );
}

/** The four numbers, each opening where it comes from: my overdue items, my time this week, projects at risk, the team's open work. */
function HomeNumbers() {
  const dash = useCachedWsQuery(['dashboard', null], () => insightApi.dashboard(null), { staleTime: 60_000 });
  const projects = useWsQuery(['projects', 'health'], () => projectApi.list({ pageSize: 100 }), { staleTime: 60_000, retry: false });
  const team = useWsQuery(['workload', 'default'], () => workItemApi.workload(), { staleTime: 60_000, retry: false });
  const risk = projects.data?.items?.filter((p) => p.health === 'Delayed' || p.health === 'AtRisk').length;
  const c = dash.data?.counts;
  const show = (v: number | undefined, loading: boolean) => (v === undefined ? (loading ? '…' : '—') : v);
  // Each number opens the filtered list it counts; its label carries the one definition (lib/glossary).
  const cell = (n: ReactNode, l: ReactNode, to: string, tone: 'red' | 'orange' | undefined, id: string) => (
    <Link to={to} className="hm-mini-c" data-testid={`number-${id}`}><span className={`hm-n ${tone ?? ''}`}>{n}</span><span className="hm-l">{l}</span></Link>
  );
  return (
    <section className="hm-card hm-mini" aria-label="Your numbers">
      {cell(show(c?.myOverdue, dash.isLoading), <Term k="overdue" focusable={false}>Overdue</Term>, '/work?overdue=1', c?.myOverdue ? 'red' : undefined, 'overdue')}
      {cell(c ? (c.myLoggedMinutesThisWeek > 0 ? formatMinutes(c.myLoggedMinutesThisWeek) : '0h') : dash.isLoading ? '…' : '—', <><Term k="logged" focusable={false}>Logged</Term> this week</>, '/insights?tab=time', undefined, 'logged')}
      {cell(show(risk, projects.isLoading), <>Projects <Term k="at risk" focusable={false}>at risk</Term></>, '/work/projects?status=AtRisk', risk ? 'orange' : undefined, 'risk')}
      {cell(show(team.data?.totals?.open, team.isLoading), <>Team <Term k="open" focusable={false}>open</Term> items</>, '/work?tab=team', undefined, 'team')}
    </section>
  );
}

// ------------------------------------------------------------------------------------------------------------------------ Calendar


function hrefOf(e: CalendarEvent): string {
  // Talk opens a meeting from ?meeting= (Meet's old ?open=), and a series' occurrence from ?at=.
  if (e.type === 'meeting') return `/messages?f=meetings&meeting=${e.projectId ? 'p' : 'w'}:${e.id}${e.startsAt ? `&at=${encodeURIComponent(e.startsAt)}` : ''}`;
  if (e.type === 'task' || e.type === 'action' || e.type === 'work') return `/work?item=${e.id}`;
  return e.projectId ? `/work/projects/${e.projectId}` : '/work/projects';
}

function WeekCalendar({ onTab }: { onTab: (t: Tab) => void }) {
  // The week planner (s-calendar); planning with your own calendars (Outlook free/busy, Google time blocks) follows when set up.
  return <><WeekPlanner onTab={onTab} extra={<SubscribeLink />} /><CalendarPlanning /></>;
}

/** "Subscribe in Google / Outlook ›": the private calendar address for work with a due date. */
function SubscribeLink() {
  const wid = useWorkspaceId();
  const [open, setOpen] = useState(false);
  const q = useWsQuery(['calendar-feed'], integrationsApi.calendarFeed, { enabled: open });
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try { await integrationsApi.resetCalendarFeed(); await invalidateWorkspace(wid, 'calendar-feed'); }
    catch (e) { toast(errText(e, 'Could not create the address.'), 'error'); }
    finally { setBusy(false); }
  };
  const copy = async (url: string) => { try { await navigator.clipboard.writeText(url); toast('Address copied.'); } catch { toast('Select the address and copy it.', 'info'); } };
  const f = q.data;
  return (
    <>
      <button type="button" className="btn btn-link hm-sub" onClick={() => setOpen(true)}>Subscribe in Google / Outlook ›</button>
      {open && (
        <Modal title="Subscribe in your calendar" subtitle="Your work with a due date, kept up to date in Outlook, Google Calendar or Apple Calendar." onClose={() => setOpen(false)}
          footer={<button type="button" className="btn btn-primary" onClick={() => setOpen(false)}>Done</button>}>
          {q.isLoading ? <PageLoader /> : !f?.enabled ? (
            <EmptyState icon="calendar" title="No subscription yet" text="Create a private address, then add it to your calendar app."
              action={<button type="button" className="btn btn-primary" disabled={busy} onClick={() => void create()}>Create my calendar address</button>} />
          ) : (
            <div className="hm-feed">
              <label className="field-label" htmlFor="hm-feed-url">Calendar address · keep it private</label>
              <div className="hm-feed-row"><input id="hm-feed-url" className="input" readOnly value={f.url ?? ''} onFocus={(e) => e.currentTarget.select()} />
                <button type="button" className="btn btn-soft" onClick={() => void copy(f.url ?? '')}>Copy</button></div>
              <p><b>Google Calendar</b> · Other calendars → + → From URL → paste the address.</p>
              <p><b>Outlook</b> · Calendar → Add calendar → Subscribe from web → paste the address.</p>
            </div>
          )}
        </Modal>
      )}
    </>
  );
}
