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
import { useIsMobile } from '../../lib/mobile';
import { MONTHS, todayISO } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useAuth, useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { DotsMenu } from '../talk/DotsMenu';
import { formatMinutes } from '../time/time';
import { KIND_LABEL, inboxApi, type InboxBriefing, type InboxFilter, type InboxKind, type InboxRow } from './inboxApi';
import { AnimatePresence, motion } from 'framer-motion';
import { itemVariants, listVariants } from '../../lib/motion';
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
const clock = (d: Date) => `${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')}`;
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
  return tab === 'calendar' ? <WeekCalendar onTab={setTab} /> : <ForYou view={view} onTab={setTab} />;
}


// ------------------------------------------------------------------------------------------------------------------------- For you

function greeting(name: string) {
  const h = new Date().getHours();
  const part = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  return `${part}, ${name.split(' ')[0] || name}.`;
}

type HomeSeg = 'me' | 'team' | 'calendar';

function ForYou({ view, onTab }: { view: View; onTab: (t: Tab, v?: View) => void }) {
  const nav = useNavigate();
  const me = useAuth((s) => s.ctx!.user);
  const today = todayISO();
  const phone = useIsMobile();
  const briefing = useWsQuery(['inbox', 'briefing'], inboxApi.briefing, { staleTime: 30_000 });
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
            { label: 'Assistant', hint: 'Your conversations with the assistant', icon: 'sparkle', onSelect: () => nav('/?tab=assistant') },
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
    </div>
  );
}

/** "6 things need you." reads as "6 things need you today." on Today. */
const todayHeadline = (h?: string | null) => (h ?? '').replace(/ need(s)? you\.$/, ' need$1 you today.');

function Briefing({ q }: { q: UseQueryResult<InboxBriefing, Error> }) {
  const ai = useAi();
  const ask = useAssistant((s) => s.ask);
  if (q.isLoading) return <div className="hm-brief loading" aria-busy="true"><span className="hm-orb" aria-hidden="true" /><p>Reading your work…</p></div>;
  if (q.isError || !q.data) return null;
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
  const q = useWsQuery(['inbox', 'rows', filter], () => inboxApi.list(filter), { placeholderData: (p) => p });
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<Set<string>>(new Set());
  const refresh = () => void invalidateWorkspace(wid, 'inbox');

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
  // A reply without rows (an older server during a rolling release) reads as an empty inbox, not a crash of Home.
  const rows = q.data?.rows ?? [];
  const total = counts?.all ?? rows.length;
  return (
    <section className="hm-card hm-inbox" aria-label="Needs you">
      <div className="hm-lh"><h2 className="hm-h3">Needs you</h2>{total > 0 && <span className="hm-faint">{total} · newest problems first</span>}</div>
      {/* The chips only help with more than 10 rows (or when a chip other than All is on). */}
      {(filter !== 'all' || total > 10) && <div className="ds-chips hm-chips" role="group" aria-label="Show">
        {CHIPS.map((c) => (
          <button key={c.id} type="button" className={`ds-chip ${filter === c.id ? 'on' : ''}`} aria-pressed={filter === c.id} onClick={() => setFilter(c.id)}>
            {c.label}{counts && counts[c.count] > 0 && <em>{counts[c.count]}</em>}
          </button>
        ))}
      </div>}
      {q.isLoading ? <PageLoader /> : q.isError ? <ErrorState error={q.error} retry={() => void q.refetch()} /> : rows.length === 0 ? (
        <EmptyState icon="checkCircle" title={filter === 'all' ? 'Nothing needs you' : 'Nothing here'}
          text={(q.data?.later ?? 0) > 0 ? `${q.data!.later} moved to tomorrow.` : 'New work, decisions and mentions arrive here.'} />
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

/** The day runs 9 AM to 7 PM; the scale shows eleven hour columns (9 … 7), as the design's ruler. A meeting without an end reads as 30 min. */
const DAY_START = 9, DAY_END = 19, DAY_COLS = 11, MEETING_MIN = 30;
const MEET_TINTS = ['m-green', 'm-teal', 'm-indigo'];
const hourOf = (d: Date) => d.getHours() + d.getMinutes() / 60;
type Meeting = { e: CalendarEvent; start: Date; h: number; end: number };

function useMeetings(from: string, to: string, team: boolean) {
  const q = useWsQuery(['calendar', 'range', from, to, team ? 'team' : 'me'], () => insightApi.calendar(from, to, undefined, !team), { staleTime: 60_000 });
  const list: Meeting[] = (q.data ?? []).filter((e) => e.type === 'meeting' && e.startsAt && e.category !== 'Cancelled' && e.status !== 'Cancelled')
    .map((e) => { const start = new Date(e.startsAt!); const h = hourOf(start); return { e, start, h, end: h + (e.durationMinutes ?? MEETING_MIN) / 60 }; })
    .sort((a, b) => a.start.getTime() - b.start.getTime());
  return { q, list };
}

/**
 * Today from 9 to 7 on two lanes: meetings (tinted capsules, real lengths) above; open incidents (red) and focus blocks (orange, hatched)
 * below — suggested in the free gaps of an hour or more after now, for the work that needs you most. A red line marks now.
 */
function YourDay({ team }: { team: boolean }) {
  const today = todayISO();
  const { list } = useMeetings(today, today, team);
  const inbox = useWsQuery(['inbox', 'rows', 'all'], () => inboxApi.list('all'), { staleTime: 30_000 });
  const [now, setNow] = useState(() => new Date());
  useEffect(() => { const t = window.setInterval(() => setNow(new Date()), 60_000); return () => window.clearInterval(t); }, []);
  const nowH = hourOf(now);
  const meetings = list.filter((m) => m.end > DAY_START && m.h < DAY_END);
  const rows = inbox.data?.rows ?? [];
  const incidents = rows.filter((r) => r.kind === 'ticket' && r.urgent).slice(0, 2).map((r) => {
    const at = new Date(r.at);
    const sameDay = iso(at) === today;
    return { r, start: sameDay ? Math.max(DAY_START, hourOf(at)) : DAY_START, since: sameDay ? clock(at) : `${at.getDate()} ${MONTHS[at.getMonth()]}` };
  });
  // Focus blocks: free gaps of 60 min or more between meetings from now (rounded up to the quarter) to 7 PM; up to two, at most 90 min each.
  const topics = rows.filter((r) => !(r.kind === 'ticket' && r.urgent)).map((r) => r.title);
  const cursor0 = Math.max(DAY_START, Math.ceil(nowH * 4) / 4);
  const focus: { start: number; end: number; label: string }[] = [];
  let free = 0;
  if (cursor0 < DAY_END) {
    const busy = meetings.map((m) => [m.h, m.end] as const).sort((a, b) => a[0] - b[0]);
    let cur = cursor0;
    const gaps: [number, number][] = [];
    for (const [a, b] of busy) { if (a > cur) gaps.push([cur, Math.min(a, DAY_END)]); cur = Math.max(cur, b); if (cur >= DAY_END) break; }
    if (cur < DAY_END) gaps.push([cur, DAY_END]);
    for (const [a, b] of gaps) {
      if (b - a >= 1 && focus.length < 2) {
        const len = Math.min(1.5, b - a);
        focus.push({ start: a, end: a + len, label: topics[focus.length] ?? (focus.length ? 'Reviews' : 'Deep work') });
        free += (b - a - len) * 60;
      } else if (b > a) free += (b - a) * 60;
    }
  }
  const pct = (h: number) => `${(Math.min(DAY_COLS, Math.max(0, h - DAY_START)) / DAY_COLS) * 100}%`;
  const width = (a: number, b: number) => `${(Math.max(.25, Math.min(b, DAY_START + DAY_COLS) - Math.max(a, DAY_START)) / DAY_COLS) * 100}%`;
  const hours = Array.from({ length: DAY_COLS }, (_, i) => DAY_START + i);
  const label = (h: number) => (h === 9 ? '9 AM' : h === 12 ? '12 PM' : String(h > 12 ? h - 12 : h));
  const span = (h: number) => `${clock(new Date(2000, 0, 1, Math.floor(h), Math.round((h % 1) * 60)))}`;
  const n = meetings.length;
  return (
    <section className="hm-card hm-yday" aria-label="Your day">
      <div className="hm-day-hd"><h2 className="hm-h3">Your day</h2>
        <span className="hm-faint">{n} meeting{n === 1 ? '' : 's'} · {focus.length} focus block{focus.length === 1 ? '' : 's'} · {dur(free)} free</span></div>
      <div className="hm-day-track">
        <div className="hm-lane a" /><div className="hm-lane b" />
        {meetings.map((m, i) => (
          <Link key={`${m.e.id}:${m.e.startsAt}`} to={hrefOf(m.e)} className={`hm-cap ${MEET_TINTS[i % MEET_TINTS.length]}`} style={{ left: pct(m.h), width: width(m.h, m.end), top: 0 }}
            title={`${clock(m.start)} · ${m.e.title}`}>
            {m.e.title}<small>{clock(m.start)}{m.e.joinUrl ? ' · Meet' : ''}</small>
          </Link>
        ))}
        {incidents.map(({ r, start, since }) => (
          <Link key={r.id} to={r.href ?? '/work'} className="hm-cap inc" style={{ left: pct(start), width: width(start, Math.max(nowH, start + .75)), top: 46 }} title={r.sub}>
            {r.title}<small>since {since}</small>
          </Link>
        ))}
        {focus.map((f) => (
          <span key={f.start} className="hm-cap focus" style={{ left: pct(f.start), width: width(f.start, f.end), top: 46 }} title="A suggested focus block">
            Focus · {f.label}<small>{span(f.start)} – {span(f.end)}</small>
          </span>
        ))}
        {nowH >= DAY_START && nowH <= DAY_START + DAY_COLS && (
          <div className="hm-now" style={{ left: pct(nowH) }} aria-label={`Now, ${clock(now)}`}><span>{clock(now)}</span></div>
        )}
      </div>
      <div className="hm-hours" aria-hidden="true">{hours.map((h) => <span key={h}>{label(h)}</span>)}</div>
    </section>
  );
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
  const sameDay = iso(next.start) === today;
  const when = mins <= 0 ? 'Now' : sameDay ? `Up next · in ${mins < 60 ? `${mins} min` : dur(mins)}` : `Up next · ${addDays(today, 1) === iso(next.start) ? 'Tomorrow' : longDay(iso(next.start))}`;
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
  const dash = useWsQuery(['dashboard', null], () => insightApi.dashboard(null), { staleTime: 60_000 });
  const projects = useWsQuery(['projects', 'health'], () => projectApi.list({ pageSize: 100 }), { staleTime: 60_000, retry: false });
  const team = useWsQuery(['workload', 'default'], () => workItemApi.workload(), { staleTime: 60_000, retry: false });
  const risk = projects.data?.items?.filter((p) => p.health === 'Delayed' || p.health === 'AtRisk').length;
  const c = dash.data?.counts;
  const show = (v: number | undefined, loading: boolean) => (v === undefined ? (loading ? '…' : '—') : v);
  const cell = (n: ReactNode, l: string, to: string, tone?: 'red' | 'orange') => (
    <Link to={to} className="hm-mini-c"><span className={`hm-n ${tone ?? ''}`}>{n}</span><span className="hm-l">{l}</span></Link>
  );
  return (
    <section className="hm-card hm-mini" aria-label="Your numbers">
      {cell(show(c?.myOverdue, dash.isLoading), 'Overdue', '/work', c?.myOverdue ? 'red' : undefined)}
      {cell(c ? (c.myLoggedMinutesThisWeek > 0 ? formatMinutes(c.myLoggedMinutesThisWeek) : '0h') : dash.isLoading ? '…' : '—', 'Logged this week', '/insights?tab=time')}
      {cell(show(risk, projects.isLoading), 'Projects at risk', '/work/projects', risk ? 'orange' : undefined)}
      {cell(show(team.data?.totals?.open, team.isLoading), 'Team open items', '/insights')}
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
