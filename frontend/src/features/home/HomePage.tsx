import { useMemo, useState } from 'react';
import { AgentPage, type AgentSection } from '../agent/AgentPage';
import { AiPage } from '../ai/AiPage';
import { RemindersPage } from '../reminders/RemindersPage';
import { CommandCenterPage } from '../command/CommandCenterPage';
import { ReviewQueueCard } from '../github/GitHubApp';
import { DotsMenu } from '../talk/DotsMenu';
import { CalendarPlanning } from '../calendar/CalendarPage';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { UseQueryResult } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { insightApi, integrationsApi, projectApi, workItemApi } from '../../api/endpoints';
import type { CalendarEvent } from '../../api/types';
import { Icon } from '../../components/Icon';
import { EmptyState, ErrorState, Kpi, Modal, PageHead, PageLoader, Segmented } from '../../components/ui';
import { DOW, MONTHS, dateOffset, formatTime, todayISO } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useAuth, useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { formatMinutes } from '../time/time';
import { KIND_LABEL, inboxApi, type InboxBriefing, type InboxFilter, type InboxRow } from './inboxApi';
import { AnimatePresence, motion } from 'framer-motion';
import { itemVariants, listVariants } from '../../lib/motion';
import './home.css';

type Tab = 'for-you' | 'calendar';
const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.errors[0]?.message ?? e.message : fallback);
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const dateOf = (s: string) => new Date(`${s}T00:00:00`);
/** "Monday 26 Oct" */
const longDay = (s: string) => { const d = dateOf(s); return `${d.toLocaleDateString(undefined, { weekday: 'long' })} ${d.getDate()} ${MONTHS[d.getMonth()]}`; };
const mondayOf = (s: string) => { const d = dateOf(s); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return iso(d); };
const addDays = (s: string, n: number) => { const d = dateOf(s); d.setDate(d.getDate() + n); return iso(d); };

/**
 * Home: "For you" (the briefing, one inbox of everything that waits on you, tomorrow and four numbers) and "Calendar" (the week).
 * Tabs never leave Home; links with › do.
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
  const setTab = (t: Tab) => setParams((p) => { const n = new URLSearchParams(p); if (t === 'for-you') n.delete('tab'); else n.set('tab', t); return n; }, { replace: true });
  return tab === 'calendar' ? <WeekCalendar onTab={setTab} /> : <ForYou onTab={setTab} />;
}

function Tabs({ value, onTab }: { value: Tab; onTab: (t: Tab) => void }) {
  return <Segmented label="Home" value={value} onChange={onTab} options={[{ id: 'for-you', label: 'For you' }, { id: 'calendar', label: 'Calendar' }]} />;
}

// ------------------------------------------------------------------------------------------------------------------------- For you

function greeting(name: string) {
  const h = new Date().getHours();
  const part = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  return `${part}, ${name.split(' ')[0] || name}.`;
}

function ForYou({ onTab }: { onTab: (t: Tab) => void }) {
  const me = useAuth((s) => s.ctx!.user);
  const today = todayISO();
  const nav = useNavigate();
  const briefing = useWsQuery(['inbox', 'briefing'], inboxApi.briefing, { staleTime: 30_000 });
  return (
    <div className="hm">
      <PageHead eyebrow={<span className="hm-ai-brow">✦ {longDay(today)}{briefing.data ? ' · briefing ready' : ''}</span>} title={greeting(me.displayName)}>
        <div className="hm-heads">
          <Tabs value="for-you" onTab={onTab} />
          <DotsMenu label="More on Home" items={[
            { label: 'Assistant', hint: 'Your conversations with the assistant', icon: 'sparkle', onSelect: () => nav('/?tab=assistant') },
            { label: 'Today', hint: 'Check-ins, meetings and "what if"', icon: 'target', onSelect: () => nav('/?tab=today') },
            { label: 'Decisions', icon: 'checks', onSelect: () => nav('/?tab=decisions') },
            { label: 'Audit trail', hint: 'Everything the agent did', icon: 'shield', onSelect: () => nav('/?tab=audit') },
            { label: 'Dashboard', icon: 'dashboard', onSelect: () => nav('/?tab=dashboard') },
            { label: 'Reminders', icon: 'bell', onSelect: () => nav('/?tab=reminders') },
          ]} />
        </div>
      </PageHead>
      <Briefing q={briefing} />
      <div className="hm-grid">
        <InboxCard />
        <aside className="hm-side" aria-label="Tomorrow and your numbers">
          <Tomorrow onCalendar={() => onTab('calendar')} />
          <HomeNumbers />
          <ReviewQueueCard compact />
        </aside>
      </div>
    </div>
  );
}

function Briefing({ q }: { q: UseQueryResult<InboxBriefing, Error> }) {
  if (q.isLoading) return <div className="hm-brief loading" aria-busy="true"><span className="hm-orb" aria-hidden="true" /><p>Reading your work…</p></div>;
  if (q.isError || !q.data) return null;
  const b = q.data;
  return (
    <section className="hm-brief" aria-label="Briefing">
      <span className="hm-orb" aria-hidden="true" />
      <p><b>{b.headline}</b>{(b.reasons?.length ?? 0) > 0 && <> {b.reasons.join(' ')}</>}</p>
      <small>{b.sources}</small>
    </section>
  );
}

const CHIPS: { id: InboxFilter; label: string; count: 'all' | 'assigned' | 'decisions' | 'mentions' }[] = [
  { id: 'all', label: 'All', count: 'all' }, { id: 'assigned', label: 'Assigned', count: 'assigned' },
  { id: 'decisions', label: 'Decisions', count: 'decisions' }, { id: 'mentions', label: 'Mentions', count: 'mentions' },
];

const DONE_TEXT: Record<string, string> = { accept: 'Accepted.', approve: 'Approved.', done: 'Marked done.' };

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
  return (
    <section className="hm-card hm-inbox" aria-label="Inbox">
      {/* The chips only help with more than 10 rows (or when a chip other than All is on). */}
      {(filter !== 'all' || (counts?.all ?? rows.length) > 10) && <div className="ds-chips hm-chips" role="group" aria-label="Show">
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
          {rows.map((r) => (
            <motion.li key={r.id} layout="position" variants={itemVariants} exit="exit" style={{ overflow: 'hidden' }} className={`hm-row ${done.has(r.id) ? 'done' : ''}`}>
              <span className={`hm-tag k-${r.kind}`}>{KIND_LABEL[r.kind]}</span>
              <div className="hm-row-main">
                {r.href ? <Link to={r.href} className="hm-row-title">{r.title}</Link> : <span className="hm-row-title">{r.title}</span>}
                <span className={`hm-row-sub ${r.urgent ? 'urgent' : ''}`}>{r.sub}</span>
              </div>
              <div className="hm-row-acts">
                <button type="button" className="btn btn-primary btn-sm" disabled={busy === r.id || done.has(r.id)} onClick={() => void act(r)}>{r.action.label}</button>
                <button type="button" className="btn btn-soft btn-sm hm-later" disabled={busy === r.id || done.has(r.id)} onClick={() => void later(r)} title="Hide until tomorrow morning">Later</button>
              </div>
            </motion.li>
          ))}
          </AnimatePresence>
        </motion.ul>
      )}
    </section>
  );
}

function Tomorrow({ onCalendar }: { onCalendar: () => void }) {
  const day = dateOffset(1);
  const q = useWsQuery(['calendar', 'tomorrow', day], () => insightApi.calendar(day, day, undefined, true), { staleTime: 60_000 });
  const items = (q.data ?? []).filter((e) => e.category !== 'Done' && e.category !== 'Cancelled')
    .sort((a, b) => (a.startsAt ?? 'z').localeCompare(b.startsAt ?? 'z')).slice(0, 4);
  return (
    <section className="hm-card hm-tomorrow" aria-label="Tomorrow">
      <div className="hm-card-head"><b>Tomorrow</b><button type="button" className="btn btn-link" onClick={onCalendar}>Calendar ›</button></div>
      {q.isLoading ? <p className="hm-quiet">Loading…</p> : items.length === 0 ? <p className="hm-quiet">Nothing on your calendar.</p> : (
        <ul className="hm-agenda">
          {items.map((e) => (
            <li key={`${e.type}:${e.id}`} className={`c-${colourOf(e)}`}>
              <b>{e.title}</b>
              <span>{e.type === 'meeting' && e.startsAt ? `${formatTime(e.startsAt)} · meeting` : e.type === 'stage' || e.type === 'milestone' ? `Stage · ${e.projectName ?? ''}` : `Due${e.projectName ? ` · ${e.projectName}` : ''}`}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The four numbers, each opening where it comes from: delayed projects, my overdue items, my time this week, the team's open work. */
function HomeNumbers() {
  const dash = useWsQuery(['dashboard', null], () => insightApi.dashboard(null), { staleTime: 60_000 });
  const projects = useWsQuery(['projects', 'health'], () => projectApi.list({ pageSize: 100 }), { staleTime: 60_000, retry: false });
  const team = useWsQuery(['workload', 'default'], () => workItemApi.workload(), { staleTime: 60_000, retry: false });
  const delayed = projects.data?.items?.filter((p) => p.health === 'Delayed').length;
  const c = dash.data?.counts;
  const show = (v: number | undefined, loading: boolean) => (v === undefined ? (loading ? '…' : '—') : v);
  return (
    <div className="hm-kpis">
      <Kpi tile label="Delayed projects" value={show(delayed, projects.isLoading)} tone={delayed ? 'danger' : undefined} to="/work/projects" />
      <Kpi tile label="Overdue items" value={show(c?.myOverdue, dash.isLoading)} tone={c?.myOverdue ? 'warning' : undefined} to="/work" />
      <Kpi tile label="Logged this week" value={c ? (c.myLoggedMinutesThisWeek > 0 ? formatMinutes(c.myLoggedMinutesThisWeek) : '0h') : dash.isLoading ? '…' : '—'} to="/insights?tab=time" />
      <Kpi tile label="Team open items" value={show(team.data?.totals?.open, team.isLoading)} to="/insights" />
    </div>
  );
}

// ------------------------------------------------------------------------------------------------------------------------ Calendar

/** Three colours only: meetings blue, deadlines red, stages violet. */
function colourOf(e: CalendarEvent): 'meeting' | 'deadline' | 'stage' {
  return e.type === 'meeting' ? 'meeting' : e.type === 'stage' || e.type === 'milestone' ? 'stage' : 'deadline';
}

function hrefOf(e: CalendarEvent): string {
  // Talk opens a meeting from ?meeting= (Meet's old ?open=), and a series' occurrence from ?at=.
  if (e.type === 'meeting') return `/talk?f=meetings&meeting=${e.projectId ? 'p' : 'w'}:${e.id}${e.startsAt ? `&at=${encodeURIComponent(e.startsAt)}` : ''}`;
  if (e.type === 'task' || e.type === 'action' || e.type === 'work') return `/work?item=${e.id}`;
  return e.projectId ? `/work/projects/${e.projectId}` : '/work/projects';
}

function WeekCalendar({ onTab }: { onTab: (t: Tab) => void }) {
  const today = todayISO();
  const [monday, setMonday] = useState(() => mondayOf(today));
  const [who, setWho] = useState<'me' | 'team'>('me');
  const [focus, setFocus] = useState<string | null>(null);
  const sunday = addDays(monday, 6);
  const q = useWsQuery(['calendar', 'week', monday, who], () => insightApi.calendar(monday, sunday, undefined, who === 'me'), { placeholderData: (p) => p });
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(monday, i)), [monday]);
  const byDay = useMemo(() => {
    const m = new Map<string, CalendarEvent[]>();
    for (const e of q.data ?? []) if (e.category !== 'Cancelled') m.set(e.date, [...(m.get(e.date) ?? []), e]);
    for (const list of m.values()) list.sort((a, b) => (a.startsAt ?? 'z').localeCompare(b.startsAt ?? 'z'));
    return m;
  }, [q.data]);
  const a = dateOf(monday), b = dateOf(sunday);
  const range = a.getMonth() === b.getMonth() ? `${a.getDate()} – ${b.getDate()} ${MONTHS[b.getMonth()]} ${b.getFullYear()}` : `${a.getDate()} ${MONTHS[a.getMonth()]} – ${b.getDate()} ${MONTHS[b.getMonth()]} ${b.getFullYear()}`;

  // ✦ The week in one line, from the calendar itself: how many deadlines and meetings, and the first working day still clear.
  const events = q.data ?? [];
  const deadlines = events.filter((e) => colourOf(e) === 'deadline' && e.category !== 'Done').length;
  const meetings = events.filter((e) => e.type === 'meeting').length;
  const clear = days.slice(0, 5).find((d) => d >= today && !(byDay.get(d)?.length));
  const clearName = clear ? dateOf(clear).toLocaleDateString(undefined, { weekday: 'long' }) : null;

  return (
    <div className="hm">
      <PageHead eyebrow={range} title="Calendar">
        <div className="hm-heads">
          <Tabs value="calendar" onTab={onTab} />
          <Segmented label="Whose calendar" value={who} onChange={setWho} options={[{ id: 'me', label: 'Me' }, { id: 'team', label: 'Team' }]} />
        </div>
      </PageHead>
      <div className="hm-cal-grid">
        <section className="hm-card hm-week" aria-label={`Week of ${range}`}>
          <div className="hm-week-nav">
            <button type="button" className="icon-btn" aria-label="Previous week" onClick={() => setMonday(addDays(monday, -7))}><Icon name="chevronL" /></button>
            <button type="button" className="btn btn-soft btn-sm" onClick={() => setMonday(mondayOf(today))} disabled={monday === mondayOf(today)}>This week</button>
            <button type="button" className="icon-btn" aria-label="Next week" onClick={() => setMonday(addDays(monday, 7))}><Icon name="chevronR" /></button>
          </div>
          {q.isError ? <ErrorState error={q.error} retry={() => void q.refetch()} /> : (
            <div className="hm-days">
              {days.map((d) => {
                const date = dateOf(d);
                const list = byDay.get(d) ?? [];
                return (
                  <div key={d} className={`hm-day ${d === today ? 'today' : ''} ${focus === d ? 'focus' : ''} ${date.getDay() % 6 === 0 ? 'weekend' : ''}`} aria-label={longDay(d)}>
                    <span className="hm-dow">{DOW[date.getDay()]}</span>
                    <b className="hm-dnum">{date.getDate()}</b>
                    <div className="hm-evs">
                      {list.slice(0, 6).map((e) => (
                        <Link key={`${e.type}:${e.id}:${e.startsAt ?? ''}`} to={hrefOf(e)} className={`hm-ev c-${colourOf(e)} ${e.category === 'Done' ? 'done' : ''}`} title={e.projectName ? `${e.title} · ${e.projectName}` : e.title}>
                          {e.type === 'meeting' && e.startsAt ? `${formatTime(e.startsAt)} ` : ''}{e.title}{colourOf(e) === 'deadline' ? ' due' : ''}
                        </Link>
                      ))}
                      {list.length > 6 && <span className="hm-more">+{list.length - 6} more</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
        <aside className="hm-side" aria-label="About this week">
          <section className="hm-card hm-ai" aria-label="This week">
            <b>✦ This week</b>
            <p>{q.isLoading ? 'Reading the week…' : `${deadlines} deadline${deadlines === 1 ? '' : 's'} and ${meetings} meeting${meetings === 1 ? '' : 's'}.${clearName ? ` ${clearName} is clear — a good day for focused work.` : ' No clear working day left this week.'}`}</p>
            {clear && <button type="button" className="btn btn-ai btn-sm" onClick={() => setFocus(focus === clear ? null : clear)}>{focus === clear ? 'Done' : `Show ${clearName?.slice(0, 3)}`}</button>}
          </section>
          <section className="hm-card hm-legend" aria-label="Colours">
            <b>Colours</b>
            <ul>
              <li><i className="c-meeting" />Meeting</li>
              <li><i className="c-deadline" />Deadline</li>
              <li><i className="c-stage" />Stage</li>
            </ul>
            <SubscribeLink />
          </section>
        </aside>
      </div>
      {/* Planning with your own calendars (Outlook free/busy, Google time blocks): shown only when the administrator set it up. */}
      <CalendarPlanning />
    </div>
  );
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
