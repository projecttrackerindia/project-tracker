import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { delegateApi, projectApi } from '../../api/endpoints';
import type { MyMeeting } from '../../api/types';
import { Icon, type IconName } from '../../components/Icon';
import { Badge, EmptyState, ErrorState, PageHead, PageLoader } from '../../components/ui';
import { formatDate, formatTime } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useAuth, useModule, useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { SettingsCard } from '../command/CommandParts';
import { NotetakerPanel } from '../notetaker/NotetakerPage';
import { meetApi, parseRef, type MeetItem } from './meetApi';
import { MeetingForm } from './ScheduleMeeting';
import { NotetakerWorkspaceSettings } from './NotetakerWorkspaceSettings';
import '../command/command.css';
import './meet.css';
import { JoinButton, MeetingDetail, NOTETAKER_LABEL, RSVP_LABEL, joinable } from './MeetingDetail';

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.errors[0]?.message ?? e.message : fallback);
type Section = 'upcoming' | 'series' | 'past' | 'notetaker';
const DAY = 24 * 60 * 60 * 1000;


/**
 * Meet: every meeting and call in one place. Upcoming sessions (with the ones going on now first), repeating series, past meetings with
 * the notetaker's notes, and the notetaker itself. Scheduling and starting happen only here; Calendar, Reminders, chat and notifications
 * open the meeting here.
 */
export function MeetPage({ section }: { section: Section }) {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const role = useAuth((s) => s.ctx?.current?.role);
  const projects = useModule('projects') > 0;
  const projectId = params.get('project');
  const opened = parseRef(params.get('open'));
  const [form, setForm] = useState<'now' | 'schedule' | null>(params.get('new') === 'schedule' ? 'schedule' : params.get('new') === 'now' ? 'now' : null);
  const projectQ = useWsQuery(['project', projectId], () => projectApi.get(projectId!), { enabled: !!projectId });
  const project = projectId && projectQ.data ? { id: projectId, name: projectQ.data.project.name } : null;
  const setParam = (k: string, v: string | null) => { const next = new URLSearchParams(params); if (v) next.set(k, v); else next.delete(k); setParams(next, { replace: true }); };
  const closeForm = () => { setForm(null); setParam('new', null); };

  return (
    <div className="mt-page">
      <PageHead title="Meet" eyebrow={project ? project.name : new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}
        sub={project ? 'This project\'s meetings and calls.' : 'Google Meet, Teams and Project Tracker calls, in one place.'}>
        {projectId && <button type="button" className="btn btn-ghost" onClick={() => setParam('project', null)}>All meetings</button>}
        <button type="button" className="btn btn-ghost" onClick={() => setForm('now')}>Start now</button>
        <button type="button" className="btn btn-primary" onClick={() => setForm('schedule')}>Schedule</button>
      </PageHead>
      {/* v2: Meet lives in Talk (?f=meetings&s=…); the tabs keep the section in the query, which a NavLink cannot tell apart. */}
      <nav className="tabs route-tabs" aria-label="Meet">
        {([['upcoming', 'Upcoming', 'calendar'], ['series', 'Series', 'repeat'], ['past', 'Past', 'clock'],
          ...(projects && role !== 'Guest' ? [['notetaker', 'Groot notetaker', 'sparkle']] : [])] as [Section, string, IconName][]).map(([id, label, icon]) => (
          <Link key={id} to={`/messages?f=meetings&s=${id}${projectId ? `&project=${encodeURIComponent(projectId)}` : ''}`} className={`tab ${section === id ? 'active' : ''}`}
            aria-current={section === id ? 'page' : undefined}><Icon name={icon} />{label}</Link>
        ))}
      </nav>
      {section === 'upcoming' && <Upcoming projectId={projectId} onOpen={(m) => setParam('open', m.ref)} />}
      {section === 'series' && <Series projectId={projectId} onOpen={(m) => setParam('open', m.ref)} />}
      {section === 'past' && <Past projectId={projectId} onOpen={(m) => setParam('open', m.ref)} />}
      {section === 'notetaker' && <NotetakerSection />}
      {opened && <MeetingDetail kind={opened.kind} id={opened.id} at={params.get('at')} onClose={() => { const next = new URLSearchParams(params); next.delete('open'); next.delete('at'); setParams(next, { replace: true }); }}
        onProject={(pid) => navigate(`/messages?f=meetings&s=upcoming&project=${pid}`)} />}
      {form && <MeetingForm mode={form} project={project} title={params.get('title')} details={params.get('details')} onClose={closeForm} />}
    </div>
  );
}

// ------------------------------------------------------------------ lists

function useFeed(projectId: string | null, from: Date, to: Date, key: string) {
  return useWsQuery(['meet', 'feed', key, projectId ?? 'all'], () => meetApi.feed({ from: from.toISOString(), to: to.toISOString(), projectId }), { refetchInterval: 60_000 });
}

function Upcoming({ projectId, onOpen }: { projectId: string | null; onOpen: (m: MeetItem) => void }) {
  const role = useAuth((s) => s.ctx?.current?.role);
  const projects = useModule('projects') > 0;
  const [range] = useState(() => ({ from: new Date(Date.now() - 3 * 60 * 60_000), to: new Date(Date.now() + 30 * DAY) }));
  const q = useFeed(projectId, range.from, range.to, 'upcoming');
  // Other calls on the person's own Google or Outlook calendar (not made here), and who is sending the agent where.
  const calendar = useWsQuery(['agent', 'meetings'], () => delegateApi.meetings(), { enabled: projects && role !== 'Guest' && !projectId, staleTime: 60_000 });
  const now = Date.now();
  const items = (q.data?.items ?? []).filter((m) => new Date(m.end).getTime() > now - 60_000);
  const live = items.filter((m) => m.live || (new Date(m.start).getTime() <= now && new Date(m.end).getTime() > now));
  const later = items.filter((m) => !live.includes(m));
  const days = useMemo(() => group(later), [later]);
  const outside = (calendar.data ?? []).filter((c) => !c.meetingId && c.meetUrl && new Date(c.endUtc).getTime() > now);
  if (q.isLoading) return <PageLoader />;
  if (q.isError) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  return (
    <div className="mt-lists">
      {items.length === 0 && outside.length === 0 && <EmptyState icon="video" title="Nothing coming up" text="Meetings you organize or are invited to show here, with their join link, your reply and a reminder before each one. Schedule one, or start a call now." />}
      {live.length > 0 && <section aria-label="Happening now"><h2 className="mt-day now"><span className="mt-live-dot" aria-hidden="true" />Now</h2><ul className="mt-list">{live.map((m) => <Row key={m.ref + m.start} m={m} onOpen={onOpen} />)}</ul></section>}
      {days.map(([day, list]) => (
        <section key={day} aria-label={day}><DayTitle day={day} /><ul className="mt-list">{list.map((m) => <Row key={m.ref + m.start} m={m} onOpen={onOpen} />)}</ul></section>
      ))}
      {outside.length > 0 && (
        <section aria-label="Also on your calendar">
          <h2 className="mt-day">Also on your calendar</h2>
          <ul className="mt-list">{outside.map((c) => <CalendarRow key={c.id} c={c} />)}</ul>
        </section>
      )}
      {q.data?.truncated && <p className="mt-hint">Showing the first 400 sessions. Choose a project to narrow the list.</p>}
    </div>
  );
}

function Past({ projectId, onOpen }: { projectId: string | null; onOpen: (m: MeetItem) => void }) {
  const [range] = useState(() => ({ from: new Date(Date.now() - 30 * DAY), to: new Date() }));
  const q = useFeed(projectId, range.from, range.to, 'past');
  const items = (q.data?.items ?? []).filter((m) => new Date(m.end).getTime() <= Date.now()).reverse();
  const days = useMemo(() => group(items), [items]);
  if (q.isLoading) return <PageLoader />;
  if (q.isError) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  if (items.length === 0) return <EmptyState icon="clock" title="No meetings in the last 30 days" text="Past meetings show here with the notetaker's notes when it came." />;
  return <div className="mt-lists">{days.map(([day, list]) => <section key={day} aria-label={day}><DayTitle day={day} /><ul className="mt-list">{list.map((m) => <Row key={m.ref + m.start} m={m} onOpen={onOpen} past />)}</ul></section>)}</div>;
}

function Series({ projectId, onOpen }: { projectId: string | null; onOpen: (m: MeetItem) => void }) {
  const q = useWsQuery(['meet', 'series', projectId ?? 'all'], () => meetApi.series(projectId));
  if (q.isLoading) return <PageLoader />;
  if (q.isError) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  if (!q.data?.length) return <EmptyState icon="repeat" title="No repeating meetings" text="Stand-ups and other series show here with their next session. Schedule one and choose how often it repeats." />;
  return <ul className="mt-list mt-lists">{q.data.map((m) => <Row key={m.ref} m={m} onOpen={onOpen} series />)}</ul>;
}

/** A day's heading: "Today" in bold with the date in grey beside it. */
function DayTitle({ day }: { day: string }) {
  const [name, date] = day.includes(' · ') ? day.split(' · ') : [day, null];
  return <h2 className="mt-day">{name}{date && <em>{date}</em>}</h2>;
}

/** Sessions grouped by day: "Today", "Tomorrow", then the date. */
function group(items: MeetItem[]): [string, MeetItem[]][] {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const label = (iso: string) => {
    const d = new Date(iso); d.setHours(0, 0, 0, 0);
    const diff = Math.round((d.getTime() - today.getTime()) / DAY);
    return diff === 0 ? `Today · ${formatDate(iso)}` : diff === 1 ? `Tomorrow · ${formatDate(iso)}` : diff === -1 ? `Yesterday · ${formatDate(iso)}` : formatDate(iso);
  };
  const map = new Map<string, MeetItem[]>();
  for (const m of items) { const k = label(m.start); map.set(k, [...(map.get(k) ?? []), m]); }
  return [...map.entries()];
}

function Row({ m, onOpen, past = false, series = false }: { m: MeetItem; onOpen: (m: MeetItem) => void; past?: boolean; series?: boolean }) {
  const wid = useWorkspaceId();
  const [busy, setBusy] = useState(false);
  const reply = async (response: 'accepted' | 'declined') => {
    setBusy(true);
    try { await meetApi.rsvp(m, response); toast(response === 'accepted' ? 'You are going. A reminder is set.' : 'Declined. The organizer is told.'); void invalidateWorkspace(wid, 'meet'); void invalidateWorkspace(wid, 'reminders'); }
    catch (e) { toast(errText(e, 'Could not send your reply.'), 'error'); }
    finally { setBusy(false); }
  };
  const nt = NOTETAKER_LABEL[m.notetaker];
  return (
    <li className={`mt-item${m.live ? ' live' : ''}${m.myRsvp === 'Declined' ? ' declined' : ''}`}>
      <button type="button" className="mt-item-main" onClick={() => onOpen(m)} aria-label={`${m.title}, ${formatDate(m.start)} ${formatTime(m.start)}`}>
        <span className="mt-time"><b>{formatTime(m.start)}</b><small>{series ? formatDate(m.start) : formatTime(m.end)}</small></span>
        <span className="mt-what">
          <b>{m.title}</b>
          <small>
            {[m.projectKey ?? (m.kind === 'workspace' ? 'Workspace' : null), m.providerName, series && m.sessionsLeft ? `${m.sessionsLeft} sessions left` : null,
              m.isOrganizer ? 'You organize' : `By ${m.organizerName}`, m.provider === 'ours' && m.invited > 1 ? `${m.accepted} of ${m.invited} going` : null].filter(Boolean).join(' · ')}
          </small>
        </span>
        <span className="mt-tags">
          {m.live && <Badge tone="success">Live</Badge>}
          {m.isScrum && <Badge tone="neutral">Stand-up</Badge>}
          {m.recurring && !series && <Badge tone="neutral">Repeats</Badge>}
          {nt && <Badge tone="purple">{nt}</Badge>}
          {past && m.notes === 'done' && <Badge tone="info">Notes</Badge>}
          {!m.isOrganizer && !past && <span className={`mt-rsvp ds-pill rsvp-${m.myRsvp}`}>{RSVP_LABEL[m.myRsvp]}</span>}
        </span>
      </button>
      {!past && m.status === 'Scheduled' && (
        <span className="mt-actions">
          {m.provider === 'ours' && !m.isOrganizer && m.myRsvp === 'NeedsAction' && <>
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void reply('accepted')}>Accept</button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void reply('declined')}>Decline</button>
          </>}
          {joinable(m) && <JoinButton m={m} />}
        </span>
      )}
    </li>
  );
}

function CalendarRow({ c }: { c: MyMeeting }) {
  const send = `/meet/notetaker?url=${encodeURIComponent(c.meetUrl ?? '')}&title=${encodeURIComponent(c.title)}`;
  return (
    <li className="mt-item">
      <span className="mt-item-main mt-static">
        <span className="mt-time"><b>{formatTime(c.startUtc)}</b><small>{formatDate(c.startUtc)}</small></span>
        <span className="mt-what"><b>{c.title}</b><small>On your calendar{c.overlapsWith.length ? ` · overlaps ${c.overlapsWith.join(', ')}` : ''}</small></span>
      </span>
      <span className="mt-actions">
        <Link className="btn btn-ghost btn-sm" to={send}><Icon name="sparkle" size={14} /> Send notetaker</Link>
        {c.meetUrl && <a className="btn btn-ghost btn-sm" href={c.meetUrl} target="_blank" rel="noopener noreferrer"><Icon name="video" size={14} /> Join</a>}
      </span>
    </li>
  );
}

// ------------------------------------------------------------------ notetaker

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
