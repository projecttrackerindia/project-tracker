import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { delegateApi, projectApi } from '../../api/endpoints';
import type { MyMeeting } from '../../api/types';
import { Face } from '../../components/Face';
import { Icon } from '../../components/Icon';
import { EmptyState, ErrorState, PageLoader } from '../../components/ui';
import { CalmCard, CalmHero, CalmPills } from '../../components/calm';
import { formatDate } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useAuth, useModule, useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { SettingsCard } from '../command/CommandParts';
import { NotetakerPanel } from '../notetaker/NotetakerPage';
import { callsApi, type CallLog } from '../calls/callsApi';
import { DotsMenu } from '../talk/DotsMenu';
import { meetApi, parseRef, type MeetItem } from './meetApi';
import { MeetingForm } from './ScheduleMeeting';
import { ActionReview } from './ActionReview';
import { NotetakerWorkspaceSettings } from './NotetakerWorkspaceSettings';
import { openSchedule } from './scheduleStore';
import { CallDetail } from './CallDetail';
import { dayWord, hm } from './meetFormat';
import '../command/command.css';
import './meet.css';
import './meetings-calm.css';
import { JoinButton, MeetingDetail, NOTETAKER_LABEL, RSVP_LABEL, joinable } from './MeetingDetail';

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.errors[0]?.message ?? e.message : fallback);
type Section = 'upcoming' | 'past' | 'recordings' | 'series' | 'notetaker';
const SECTIONS: readonly Section[] = ['upcoming', 'past', 'recordings', 'series', 'notetaker'];
const DAY = 24 * 60 * 60 * 1000;

const dayStart = (d = new Date()) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const minsBetween = (a: string, b: string | null) => Math.max(1, Math.round(((b ? Date.parse(b) : Date.now()) - Date.parse(a)) / 60_000));
const inWords = (iso: string) => {
  const m = Math.round((Date.parse(iso) - Date.now()) / 60_000);
  if (m <= 0) return 'now';
  if (m < 60) return `in ${m} minute${m === 1 ? '' : 's'}`;
  if (m < 24 * 60) { const h = Math.floor(m / 60), r = m % 60; return `in ${h}h${r ? ` ${r}m` : ''}`; }
  return `${dayWord(iso)} at ${hm(iso)}`;
};

/**
 * Meetings (/meetings): its own place, apart from Messages, and the home of every call. Tabs Upcoming · Past · Recordings (Series and the
 * notetaker in ⋯), + Schedule; ad-hoc and missed calls are in Past beside the meetings, and a call opens here with its
 * transcript, Aura's summary and action items (?call=). A meeting opens as a page (?open=p:{id}|w:{id}, &at= a session); ?new=schedule|now
 * schedules or starts one; ?review= reviews action items; ?join=p:{id}|w:{id} opens a meeting's own call.
 */
export function MeetingsPage() {
  const [params] = useSearchParams();
  if (params.has('review')) return <ActionReview key={`${params.get('review')}|${params.get('at')}`} seriesRef={params.get('review') || null} at={params.get('at')} />;
  const call = params.get('call');
  if (call) return <CallDetail key={call} id={call} />;
  const join = parseRef(params.get('join'));
  if (join) return <JoinMeetingCall kind={join.kind} id={join.id} />;
  const s = params.get('s') as Section | null;
  return <MeetPage section={s && SECTIONS.includes(s) ? s : 'upcoming'} />;
}

/** ?join=p:{id}: the meeting's own Project Tracker call (joins it, or starts it when nobody has yet), then the call. */
function JoinMeetingCall({ kind, id }: { kind: 'project' | 'workspace'; id: string }) {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    callsApi.openMeeting(id, kind === 'workspace').then((c) => navigate(`/meetings?call=${encodeURIComponent(c.id)}`, { replace: true }))
      .catch((e) => setError(errText(e, 'Could not open the meeting. Try again in a moment.')));
  }, [id, kind, navigate]);
  return <div className="mz-wait" role="status">{error ? <><p>{error}</p><Link to="/meetings">Back to Meetings</Link></> : <p>Opening the meeting…</p>}</div>;
}

export function MeetPage({ section }: { section: Section }) {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const role = useAuth((s) => s.ctx?.current?.role);
  const projects = useModule('projects') > 0;
  const projectId = params.get('project');
  const opened = parseRef(params.get('open'));
  const [form, setForm] = useState<'now' | null>(params.get('new') === 'now' ? 'now' : null);
  const projectQ = useWsQuery(['project', projectId], () => projectApi.get(projectId!), { enabled: !!projectId });
  const project = projectId && projectQ.data ? { id: projectId, name: projectQ.data.project.name } : null;
  const setParam = (k: string, v: string | null) => { const next = new URLSearchParams(params); if (v) next.set(k, v); else next.delete(k); setParams(next, { replace: true }); };
  // ?new=schedule opens the one schedule sheet (and is taken off the address).
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current || params.get('new') !== 'schedule') return;
    asked.current = true;
    openSchedule({ project, title: params.get('title'), agenda: params.get('details') });
    setParam('new', null);
  }); // eslint-disable-line react-hooks/exhaustive-deps
  const go = (s: Section) => { const next = new URLSearchParams(); next.set('s', s); if (projectId) next.set('project', projectId); setParams(next); };

  // One read of each list: upcoming sessions, the last 30 days, and the call log.
  const [range] = useState(() => ({ now: Date.now() }));
  const upcoming = useWsQuery(['meet', 'feed', 'upcoming', projectId ?? 'all'], () => meetApi.feed({ from: new Date(range.now - 3 * 3600_000).toISOString(), to: new Date(range.now + 30 * DAY).toISOString(), projectId }), { refetchInterval: 60_000 });
  const past = useWsQuery(['meet', 'feed', 'past', projectId ?? 'all'], () => meetApi.feed({ from: new Date(range.now - 30 * DAY).toISOString(), to: new Date(range.now).toISOString(), projectId }), { staleTime: 60_000 });
  const calls = useWsQuery(['calls', 'history'], () => callsApi.history(30), { staleTime: 30_000, retry: false, enabled: !projectId });
  const now = Date.now();
  const next = (upcoming.data?.items ?? []).filter((m) => Date.parse(m.end) > now && m.status === 'Scheduled');
  const first = next.find((m) => m.myRsvp !== 'Declined') ?? null;
  const pastItems = useMemo(() => mergePast(past.data?.items ?? [], projectId ? [] : calls.data ?? []), [past.data, calls.data, projectId]);
  const recordings = pastItems.filter((x) => (x.kind === 'call' ? x.c.hasNotes : x.m.notes === 'done'));

  const hero = section === 'past' ? { t: 'Past meetings and calls.', s: 'Recordings, transcripts and summaries.' }
    : section === 'recordings' ? { t: 'Recordings.', s: recordings.length ? `${recordings.length} with notes and transcripts.` : 'Notes and transcripts from Aura land here.' }
      : section === 'series' ? { t: 'Repeating meetings.', s: 'Stand-ups and series, with their next session.' }
        : section === 'notetaker' ? { t: 'Aura notetaker.', s: 'It joins, listens and writes the minutes.' }
          : first ? { t: `Next: ${first.title}.`, s: `${cap(inWords(first.start))}${first.isOrganizer ? '' : `, with ${first.organizerName.split(' ')[0]}`}.` }
            : { t: 'No meetings coming up.', s: 'Schedule one, or call someone now.' };

  const pills = [
    { value: 'upcoming' as const, label: 'Upcoming', count: next.length },
    { value: 'past' as const, label: 'Past' },
    { value: 'recordings' as const, label: 'Recordings', count: recordings.length },
  ];
  const tab: 'upcoming' | 'past' | 'recordings' = section === 'past' || section === 'recordings' ? section : 'upcoming';
  const more = [
    { label: 'Series', icon: 'repeat' as const, onSelect: () => go('series'), hint: 'Repeating meetings' },
    { label: 'Aura notetaker', icon: 'sparkle' as const, onSelect: () => go('notetaker'), hidden: !projects || role === 'Guest' },
    { label: 'Start a meeting now', icon: 'video' as const, onSelect: () => setForm('now') },
    { label: 'Review action items', icon: 'check' as const, onSelect: () => navigate('/meetings?review=') },
    { label: 'All meetings', icon: 'close' as const, onSelect: () => setParam('project', null), hidden: !projectId },
  ];

  if (opened) {
    return <MeetingDetail page kind={opened.kind} id={opened.id} at={params.get('at')} onClose={() => { const n = new URLSearchParams(params); n.delete('open'); n.delete('at'); setParams(n, { replace: true }); }}
      onProject={(pid) => navigate(`/meetings?s=upcoming&project=${pid}`)} />;
  }

  return (
    <div className="mz" data-testid="meetings-page">
      <div className="mz-main">
        <CalmHero title={hero.t} second={hero.s} />
        <div className="mz-bar">
          {section === 'series' || section === 'notetaker'
            ? <button type="button" className="mz-back" onClick={() => go('upcoming')}><Icon name="chevronL" size={14} />Meetings</button>
            : <CalmPills label="Meetings" options={pills} value={tab} onChange={go} />}
          {project && <span className="mz-proj">{project.name}<button type="button" aria-label="All meetings" onClick={() => setParam('project', null)}><Icon name="close" size={11} /></button></span>}
          <span className="mz-sp" />
          <button type="button" className="mz-chip" onClick={() => openSchedule({ project })} data-testid="mz-schedule" aria-label="Schedule meeting"><Icon name="plus" size={13} />Schedule</button>
          <DotsMenu label="More" items={more} />
        </div>
        <CalmCard variant="list" className="mz-list">
          {section === 'upcoming' && <Upcoming q={upcoming} items={next} projectId={projectId} onOpen={(m) => openMeeting(setParams, params, m)} />}
          {section === 'past' && <Past loading={past.isLoading} error={past.error} retry={() => void past.refetch()} items={pastItems} onOpen={(x) => openPast(navigate, setParams, params, x)} />}
          {section === 'recordings' && <Past loading={past.isLoading} error={past.error} retry={() => void past.refetch()} items={recordings} recordings onOpen={(x) => openPast(navigate, setParams, params, x)} />}
          {section === 'series' && <Series projectId={projectId} onOpen={(m) => openMeeting(setParams, params, m)} />}
          {section === 'notetaker' && <NotetakerSection />}
        </CalmCard>
      </div>
      <aside className="mz-side" aria-label="Today">
        <TodayCard upcoming={upcoming.data?.items ?? []} past={past.data?.items ?? []} onOpen={(m) => openMeeting(setParams, params, m)} />
        {first && <PrepCard m={first} />}
        <WeekCard items={[...(past.data?.items ?? []), ...(upcoming.data?.items ?? [])]} />
      </aside>
      {form && <MeetingForm mode={form} project={project} title={params.get('title')} details={params.get('details')} onClose={() => { setForm(null); setParam('new', null); }} />}
    </div>
  );
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
function openMeeting(setParams: ReturnType<typeof useSearchParams>[1], params: URLSearchParams, m: MeetItem) {
  const n = new URLSearchParams(params); n.set('open', m.ref); n.set('at', m.start); setParams(n);
}
type PastItem = { kind: 'meeting'; key: string; at: string; m: MeetItem } | { kind: 'call'; key: string; at: string; c: CallLog };
function openPast(navigate: ReturnType<typeof useNavigate>, setParams: ReturnType<typeof useSearchParams>[1], params: URLSearchParams, x: PastItem) {
  if (x.kind === 'call') navigate(`/meetings?call=${encodeURIComponent(x.c.id)}&over=1`);
  else openMeeting(setParams, params, x.m);
}
/** Past meetings and the call log in one list, newest first. A call held for a meeting is the meeting's own row, so only other calls are added. */
function mergePast(meetings: MeetItem[], calls: CallLog[]): PastItem[] {
  const now = Date.now();
  const ms: PastItem[] = meetings.filter((m) => Date.parse(m.end) <= now).map((m) => ({ kind: 'meeting', key: `m:${m.ref}:${m.start}`, at: m.start, m }));
  const cs: PastItem[] = calls.filter((c) => c.status === 'ended').map((c) => ({ kind: 'call', key: `c:${c.id}`, at: c.startedAt, c }));
  return [...ms, ...cs].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

// ------------------------------------------------------------------ lists

function Upcoming({ q, items, projectId, onOpen }: { q: { isLoading: boolean; error: unknown; refetch: () => unknown; data?: { truncated: boolean } }; items: MeetItem[]; projectId: string | null; onOpen: (m: MeetItem) => void }) {
  const role = useAuth((s) => s.ctx?.current?.role);
  const projects = useModule('projects') > 0;
  // Other calls on the person's own Google or Outlook calendar (not made here), and who is sending the agent where.
  const calendar = useWsQuery(['agent', 'meetings'], () => delegateApi.meetings(), { enabled: projects && role !== 'Guest' && !projectId, staleTime: 60_000 });
  const outside = (calendar.data ?? []).filter((c) => !c.meetingId && c.meetUrl && new Date(c.endUtc).getTime() > Date.now());
  if (q.isLoading) return <PageLoader />;
  if (q.error) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  if (items.length === 0 && outside.length === 0) return <EmptyState icon="video" title="Nothing coming up" text="Meetings you organise or are invited to show here, with their join link, your reply and a reminder before each one. Schedule one, or call someone now." />;
  let lastDay = '';
  return (
    <ul className="mz-rows" aria-label="Upcoming">
      {items.map((m) => {
        const d = dayWord(m.start);
        const head = d !== lastDay && d !== 'Today' ? d : null; lastDay = d;
        return <UpcomingRow key={m.ref + m.start} m={m} head={head} onOpen={onOpen} />;
      })}
      {outside.length > 0 && <li className="mz-head">Also on your calendar</li>}
      {outside.map((c) => <CalendarRow key={c.id} c={c} />)}
      {q.data?.truncated && <li className="mz-hint">Showing the first 400 sessions. Choose a project to narrow the list.</li>}
    </ul>
  );
}

function People({ names, more = 0 }: { names: string[]; more?: number }) {
  return (
    <span className="mz-faces" aria-hidden="true">
      {names.slice(0, 3).map((n) => <Face key={n} byName name={n} className="mz-av" title={n} />)}
      {more > 0 && <span className="mz-av more">+{more}</span>}
    </span>
  );
}

function UpcomingRow({ m, head, onOpen }: { m: MeetItem; head: string | null; onOpen: (m: MeetItem) => void }) {
  const wid = useWorkspaceId();
  const [busy, setBusy] = useState(false);
  const reply = async (response: 'accepted' | 'declined') => {
    setBusy(true);
    try { await meetApi.rsvp(m, response); toast(response === 'accepted' ? 'You are going. A reminder is set.' : 'Declined. The organiser is told.'); void invalidateWorkspace(wid, 'meet'); void invalidateWorkspace(wid, 'reminders'); }
    catch (e) { toast(errText(e, 'Could not send your reply.'), 'error'); }
    finally { setBusy(false); }
  };
  const today = dayWord(m.start) === 'Today';
  const soon = Date.parse(m.start) - Date.now();
  const nt = NOTETAKER_LABEL[m.notetaker];
  return (
    <>
      {head && <li className="mz-head">{head} <em>{formatDate(m.start)}</em></li>}
      <li className={`mz-row${m.live ? ' live' : ''}${m.myRsvp === 'Declined' ? ' declined' : ''}`}>
        <button type="button" className="mz-row-main" onClick={() => onOpen(m)} aria-label={`${m.title}, ${dayWord(m.start)} ${hm(m.start)}`}>
          <b>{m.title}{m.projectName ? <span className="mz-proj-n"> · {m.projectName}</span> : null}</b>
          <small>{hm(m.start)} – {hm(m.end)} · {m.providerName}{today && soon > 0 && soon < 3 * 3600_000 ? ` · ${inWords(m.start)}` : ''}{m.live ? ' · live now' : ''}{m.recurring ? ' · repeats' : ''}{nt ? ` · ${nt}` : ''}</small>
        </button>
        <People names={[m.organizerName]} more={Math.max(0, m.invited - 1)} />
        <span className="mz-row-r">
          {!m.isOrganizer && <span className={`mz-rsvp rsvp-${m.myRsvp}`}>{RSVP_LABEL[m.myRsvp]}</span>}
          {m.status === 'Scheduled' && m.provider === 'ours' && !m.isOrganizer && m.myRsvp === 'NeedsAction' && <>
            <button type="button" className="mz-btn" disabled={busy} onClick={() => void reply('accepted')}>Accept</button>
            <button type="button" className="mz-btn ghost" disabled={busy} onClick={() => void reply('declined')}>Decline</button>
          </>}
          {m.status === 'Scheduled' && joinable(m) && <JoinButton m={m} />}
        </span>
      </li>
    </>
  );
}

function Past({ loading, error, retry, items, onOpen, recordings = false }: { loading: boolean; error: unknown; retry: () => void; items: PastItem[]; onOpen: (x: PastItem) => void; recordings?: boolean }) {
  if (loading) return <PageLoader />;
  if (error) return <ErrorState error={error} retry={retry} />;
  if (items.length === 0) return <EmptyState icon="clock" title={recordings ? 'No recordings yet' : 'Nothing in the last 30 days'} text={recordings ? 'Ask Aura along to a meeting or a call: its transcript, summary and action items show here.' : 'Past meetings and calls show here, with Aura\'s notes when it came.'} />;
  return (
    <ul className="mz-rows" aria-label={recordings ? 'Recordings' : 'Past'}>
      {items.map((x) => {
        if (x.kind === 'meeting') {
          const m = x.m;
          return (
            <li key={x.key} className="mz-row">
              <button type="button" className="mz-row-main" onClick={() => onOpen(x)}>
                <b>{m.title}{m.projectName ? <span className="mz-proj-n"> · {m.projectName}</span> : null}</b>
                <small>{dayWord(m.start)} {hm(m.start)} · {minsBetween(m.start, m.end)} min</small>
              </button>
              <span className="mz-who">{m.invited > 1 ? `${m.invited} people` : m.organizerName}</span>
              <span className="mz-row-r">{m.notes === 'done' && <button type="button" className="mz-tag" onClick={() => onOpen(x)}><Icon name="play" size={10} />Notes</button>}</span>
            </li>
          );
        }
        const c = x.c;
        return (
          <li key={x.key} className={`mz-row${c.missed ? ' missed' : ''}`} data-testid="mz-call-row">
            <button type="button" className="mz-row-main" onClick={() => onOpen(x)}>
              <b>{c.missed ? c.startedByName : c.title}</b>
              {c.missed ? <small className="mz-missed">Missed call · {dayWord(c.startedAt)} {hm(c.startedAt)}</small>
                : <small>{c.kind === 'adhoc' ? 'Ad-hoc call' : c.kind === 'chat' ? 'Chat call' : `${c.projectKey ?? 'Project'} call`} · {dayWord(c.startedAt)} {hm(c.startedAt)} · {c.minutes} min</small>}
            </button>
            <span className="mz-who">{c.missed ? '' : c.people.length > 3 ? `${c.people.length} people` : c.people.map((p) => p.split(' ')[0]).join(', ')}</span>
            <span className="mz-row-r">{c.hasNotes && <button type="button" className="mz-tag" onClick={() => onOpen(x)}><Icon name="play" size={10} />Recording</button>}</span>
          </li>
        );
      })}
    </ul>
  );
}

function Series({ projectId, onOpen }: { projectId: string | null; onOpen: (m: MeetItem) => void }) {
  const q = useWsQuery(['meet', 'series', projectId ?? 'all'], () => meetApi.series(projectId));
  if (q.isLoading) return <PageLoader />;
  if (q.isError) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  if (!q.data?.length) return <EmptyState icon="repeat" title="No repeating meetings" text="Stand-ups and other series show here with their next session. Schedule one and choose how often it repeats." />;
  return (
    <ul className="mz-rows" aria-label="Series">
      {q.data.map((m) => (
        <li key={m.ref} className="mz-row">
          <button type="button" className="mz-row-main" onClick={() => onOpen(m)}>
            <b>{m.title}{m.projectName ? <span className="mz-proj-n"> · {m.projectName}</span> : null}</b>
            <small>{m.recurrence ?? m.cadence ?? 'Repeats'} · next {dayWord(m.start)} {hm(m.start)}{m.sessionsLeft ? ` · ${m.sessionsLeft} sessions left` : ''}</small>
          </button>
          <span className="mz-who">{m.isOrganizer ? 'You organise' : m.organizerName}</span>
          <span className="mz-row-r">{m.isScrum && <span className="mz-rsvp">Stand-up</span>}</span>
        </li>
      ))}
    </ul>
  );
}

function CalendarRow({ c }: { c: MyMeeting }) {
  const send = `/meetings?s=notetaker&url=${encodeURIComponent(c.meetUrl ?? '')}&title=${encodeURIComponent(c.title)}`;
  return (
    <li className="mz-row">
      <span className="mz-row-main static"><b>{c.title}</b><small>{dayWord(c.startUtc)} {hm(c.startUtc)} · on your calendar{c.overlapsWith.length ? ` · overlaps ${c.overlapsWith.join(', ')}` : ''}</small></span>
      <span className="mz-who" />
      <span className="mz-row-r">
        <Link className="mz-btn ghost" to={send}><Icon name="sparkle" size={12} />Send notetaker</Link>
        {c.meetUrl && <a className="mz-btn" href={c.meetUrl} target="_blank" rel="noopener noreferrer">Join</a>}
      </span>
    </li>
  );
}

// ------------------------------------------------------------------ the side

function SideCard({ title, aside, children, className = '' }: { title: string; aside?: ReactNode; children: ReactNode; className?: string }) {
  return <CalmCard className={`mz-card ${className}`} title={title} aside={aside}>{children}</CalmCard>;
}

/** Today's meetings, done or to come, each with its colour bar and Join when it is time. */
function TodayCard({ upcoming, past, onOpen }: { upcoming: MeetItem[]; past: MeetItem[]; onOpen: (m: MeetItem) => void }) {
  const t0 = dayStart().getTime(), t1 = t0 + DAY;
  const all = new Map<string, MeetItem>();
  for (const m of [...past, ...upcoming]) if (Date.parse(m.start) >= t0 && Date.parse(m.start) < t1) all.set(m.ref + m.start, m);
  const list = [...all.values()].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  return (
    <SideCard title="Today" aside={<Link to="/?tab=calendar">Calendar ›</Link>} className="mz-today">
      {list.length === 0 ? <p className="mz-none">No meetings today.</p> : (
        <ul className="mz-day">
          {list.map((m, i) => {
            const done = Date.parse(m.end) <= Date.now();
            return (
              <li key={m.ref + m.start} style={{ ['--ck' as string]: `var(--calm-p${(i % 6) + 1})` }}>
                <button type="button" onClick={() => onOpen(m)}><b>{m.title}</b><small>{hm(m.start)} – {hm(m.end)}</small></button>
                {done ? <span className="mz-done">Done</span> : joinable(m) ? <JoinButton m={m} /> : null}
              </li>
            );
          })}
        </ul>
      )}
    </SideCard>
  );
}

/** Prep for the next meeting: its agenda as a checklist (ticked on this device). */
function PrepCard({ m }: { m: MeetItem }) {
  const lines = (m.agenda ?? m.description ?? '').split(/\n+/).map((s) => s.trim().replace(/^[-•*]\s*|^\d+[.)]\s*/, '')).filter(Boolean).slice(0, 5);
  const key = `pm_prep_${m.ref}_${m.start}`;
  const [done, setDone] = useState<string[]>(() => { try { return JSON.parse(localStorage.getItem(key) ?? '[]') as string[]; } catch { return []; } });
  if (lines.length === 0) return null;
  const toggle = (l: string) => {
    const n = done.includes(l) ? done.filter((x) => x !== l) : [...done, l];
    setDone(n);
    try { localStorage.setItem(key, JSON.stringify(n)); } catch { /* private window: kept for this visit only */ }
  };
  return (
    <SideCard title={`Prep for ${m.title}`}>
      <ul className="mz-prep">
        {lines.map((l) => (
          <li key={l}><label className={done.includes(l) ? 'on' : ''}><input type="checkbox" checked={done.includes(l)} onChange={() => toggle(l)} /><i aria-hidden="true" />{l}</label></li>
        ))}
      </ul>
    </SideCard>
  );
}

/** This week in meetings: the hours booked, against a 40-hour week. */
function WeekCard({ items }: { items: MeetItem[] }) {
  const mon = dayStart(); mon.setDate(mon.getDate() - ((mon.getDay() + 6) % 7));
  const a = mon.getTime(), b = a + 7 * DAY;
  const seen = new Set<string>();
  let mins = 0;
  for (const m of items) {
    const s = Date.parse(m.start);
    if (s < a || s >= b || m.myRsvp === 'Declined' || seen.has(m.ref + m.start)) continue;
    seen.add(m.ref + m.start); mins += minsBetween(m.start, m.end);
  }
  const h = Math.floor(mins / 60), r = mins % 60, pct = Math.round((mins / (40 * 60)) * 100);
  return (
    <SideCard title="This week">
      <div className="mz-bar-row"><span>Meetings</span><i aria-hidden="true"><b style={{ width: `${Math.min(100, pct)}%` }} /></i><em>{h ? `${h}h` : ''}{r ? ` ${r}m` : h ? '' : '0m'}</em></div>
      <p className="mz-none">{pct}% of a 40-hour week is meetings.</p>
    </SideCard>
  );
}

function NotetakerSection() {
  const role = useAuth((s) => s.ctx?.current?.role);
  const admin = role === 'Owner' || role === 'Admin';
  return (
    <div className="mt-notetaker-page">
      <NotetakerPanel />
      <div className="mt-notetaker-side">
        <SettingsCard />
        {admin && <NotetakerWorkspaceSettings />}
      </div>
    </div>
  );
}

