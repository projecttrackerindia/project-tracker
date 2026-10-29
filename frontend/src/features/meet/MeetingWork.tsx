import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { meetingApi, projectApi } from '../../api/endpoints';
import type { WorkSource } from '../../api/workItemsApi';
import { Avatar } from '../../components/ui';
import { todayISO } from '../../lib/format';
import { useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { refreshWork } from '../work/workUi';
import { connectApi, type OccurrenceScope } from './meetApi';
import { parseQuickLine, resolveOwner } from './quickLine';
import { wallInZone, zonedTimeToUtc } from './timezone';
import './connect.css';

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.errors[0]?.message ?? e.message : fallback);
const dayMonth = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '');
const dayLong = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) : '');
const dateOnly = (d: string | null) => (d ? new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }) : '');
/** The meeting page a source links back to (Messages opens the meeting, at that session). */
export const meetingLink = (ref: string | null | undefined, at?: string | null) => (ref ? `/messages?meeting=${encodeURIComponent(ref)}${at ? `&at=${encodeURIComponent(at)}` : ''}` : '/messages?f=meetings');

/** "◆ From: AutoPay weekly · 27 Oct": the small violet tag on items agreed in a meeting. */
export function SourceTag({ source, faded }: { source: WorkSource | null | undefined; faded?: boolean }) {
  if (!source?.meetingRef) return null;
  return <span className={`mc-tag${faded ? ' faded' : ''}`} data-testid="from-meeting-tag"><i aria-hidden="true">◆</i>From: {source.title ?? 'a meeting'}{source.occurrenceStart ? ` · ${dayMonth(source.occurrenceStart)}` : ''}</span>;
}

/** The "From meeting" card at the top of an item (design: mywork-item): the session, a link back, and when it is next reviewed. */
export function FromMeetingCard({ source, createdBy }: { source: WorkSource; createdBy?: string | null }) {
  const items = useWsQuery(['meet', 'items', source.seriesRef ?? source.meetingRef], () => connectApi.items(source.meetingRef!), { enabled: !!source.meetingRef, staleTime: 60_000, retry: false });
  const next = items.data?.nextSession;
  return (
    <section className="mc-from" aria-label="From meeting" data-testid="from-meeting-card">
      <div className="mc-from-eyebrow"><i aria-hidden="true">◆</i>From meeting</div>
      <div className="mc-from-row">
        <b>{source.title ?? 'A meeting'}{source.occurrenceStart ? ` · ${dayLong(source.occurrenceStart)}` : ''}</b>
        <Link to={meetingLink(source.meetingRef, source.occurrenceStart)} className="mc-from-open">Open ›</Link>
      </div>
      <p>{createdBy ? `Created by ${createdBy.split(' ')[0]} during the meeting` : 'Agreed in the meeting'}{next ? ` · next review ${dayLong(next)}` : ''}
        {items.data?.cadence && items.data.cadence !== 'Ad hoc' && <span className="mc-cad">{items.data.cadence}</span>}</p>
    </section>
  );
}

type Person = { id: string; name: string };

/**
 * During a meeting (design: meet-capture): one line - text, @owner, a date word - read live into chips for the owner, the date, the
 * project and "Source: this meeting". Enter makes the task (an action item, a work item like any other) and the line stays focused for the
 * next. Below: what was made in this meeting; beside: the series' open items and the way into their review.
 */
export function MeetingCapture({ kind, id, at, projectId, projectName, title }: { kind: 'project' | 'workspace'; id: string; at: string | null; projectId: string | null; projectName: string | null; title: string }) {
  const wid = useWorkspaceId();
  const nav = useNavigate();
  const ref = `${kind === 'workspace' ? 'w' : 'p'}:${id}`;
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [pick, setPick] = useState<string | null>(projectId);
  const input = useRef<HTMLInputElement>(null);
  const items = useWsQuery(['meet', 'items', ref, at ?? 'all'], () => connectApi.items(ref, at), { staleTime: 15_000, retry: false });
  const projects = useWsQuery(['projects', 'capture-picker'], () => projectApi.list({ pageSize: 50 }), { enabled: !projectId, staleTime: 60_000 });
  const pid = projectId ?? pick;
  const people = useWsQuery(['meetings', 'participants', pid ?? 'none'], () => meetingApi.participants(pid!), { enabled: !!pid, staleTime: 60_000 });
  const candidates: Person[] = useMemo(() => (people.data ?? []).filter((p) => p.userId).map((p) => ({ id: p.userId!, name: p.name })), [people.data]);
  const line = parseQuickLine(text, todayISO());
  const owner = line.ownerToken ? resolveOwner(line.ownerToken, candidates) : null;
  const pname = projectName ?? (projects.data?.items ?? []).find((p) => p.id === pid)?.name ?? null;
  useEffect(() => { if (projectId) setPick(projectId); }, [projectId]);

  const create = async () => {
    if (!line.title || busy) return;
    if (owner?.ambiguous) { toast(`More than one person matches @${line.ownerToken}. Type more of the name.`, 'warning'); return; }
    if (!pid) { toast('Choose the project it belongs to.', 'warning'); return; }
    setBusy(true);
    try {
      const made = await connectApi.capture(ref, { text, projectId: projectId ? undefined : pid, occurrenceStart: at ?? undefined, assigneeId: owner?.person?.id });
      toast(`Created ${made.item.key}${owner?.person ? ` for ${owner.person.name.split(' ')[0]}` : ''}.`);
      setText('');
      void items.refetch(); refreshWork(wid);
      input.current?.focus();
    } catch (e) { toast(errText(e, 'Could not create it.'), 'error'); }
    finally { setBusy(false); }
  };

  const data = items.data && Array.isArray(items.data.createdHere) ? items.data : null;
  const open = data?.openInSeries ?? 0;
  const review = () => nav(`/messages?f=meetings&review=${encodeURIComponent(data?.seriesRef ?? ref)}${at ? `&at=${encodeURIComponent(at)}` : ''}`);
  return (
    <div className="mc-grid" data-testid="meeting-capture">
      <div className="mc-main">
        <section className="mc-line" aria-label="New task">
          <label className="mc-eyebrow" htmlFor={`mc-${id}`}>New task · type one line</label>
          <div className="mc-typed">
            <input id={`mc-${id}`} ref={input} value={text} onChange={(e) => setText(e.target.value)} placeholder="Confirm bank sandbox date @Ravi fri" aria-describedby={`mc-chips-${id}`}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void create(); } }} />
            <div className="mc-echo" aria-hidden="true">{text.split(/(\s+)/).map((w, i) => {
              const t = w.replace(/^[,.;]+|[,.;]+$/g, '');
              const cls = /^@/.test(t) && t.slice(1) === line.ownerToken ? 'mc-own' : line.dateToken && line.dateToken.split(' ').includes(t) && t ? 'mc-date' : '';
              return cls ? <mark key={i} className={cls}>{w}</mark> : <span key={i}>{w}</span>;
            })}</div>
          </div>
          <div className="mc-chips" id={`mc-chips-${id}`} aria-live="polite">
            {owner?.person && <span className="mc-chip"><Avatar name={owner.person.name} userId={owner.person.id} size="sm" />{owner.person.name}</span>}
            {owner?.ambiguous && <span className="mc-chip warn">@{line.ownerToken}: more than one</span>}
            {line.ownerToken && owner && !owner.person && !owner.ambiguous && <span className="mc-chip warn">Nobody matches @{line.ownerToken}</span>}
            {line.due && <span className="mc-chip">{dateOnly(line.due)}</span>}
            {projectId ? (pname && <span className="mc-chip">{pname}</span>) : (
              <label className="mc-chip mc-pick"><span>{pname ?? 'Choose project'}</span>
                <select aria-label="Project for the task" value={pick ?? ''} onChange={(e) => setPick(e.target.value || null)}>
                  <option value="">Choose project…</option>{(projects.data?.items ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select></label>
            )}
            <span className="mc-chip src"><i aria-hidden="true">◆</i>Source: this meeting</span>
            <button type="button" className="mc-enter" aria-label="Create the task" disabled={!line.title || busy} onClick={() => void create()}>↵</button>
          </div>
        </section>
        <h3 className="mc-h">Created in this meeting · {data?.createdHere.length ?? 0} task{data?.createdHere.length === 1 ? '' : 's'}</h3>
        {(data?.createdHere.length ?? 0) > 0 && (
          <ul className="mc-list" aria-label="Created in this meeting">
            {data!.createdHere.map((r) => (
              <li key={r.id}>
                <span className={`mc-ring${/completed|done/i.test(r.status) ? ' done' : ''}`} aria-hidden="true" />
                <Link to={`/work?item=${r.id}`} className="mc-li-t">{r.title}</Link>
                {r.owner && <span className="mc-li-who"><Avatar name={r.owner.name} userId={r.owner.id} size="sm" />{r.owner.name}</span>}
                <span className={`mc-li-due${r.isOverdue ? ' late' : ''}`}>{r.dueDate ? dateOnly(r.dueDate).replace(/^\w+ /, '') : ''}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <aside className="mc-side" aria-label="Review last time's items">
        <div className="mc-eyebrow gray">Review last time’s items</div>
        <div className="mc-open">{open} open</div>
        <p>Work items whose source is “{title}”, filtered from My Work. The same review flow as before (D · C · R · T · X).</p>
        <button type="button" className="btn btn-primary mc-review" onClick={review} disabled={open === 0 && !(data?.createdHere.length)}>Review {open} item{open === 1 ? '' : 's'}</button>
      </aside>
    </div>
  );
}

/**
 * Move one session, it and the ones after it, or the whole series (a Project Tracker series; Google and Outlook keep their own).
 * The time is typed in the meeting's zone.
 */
export function OccurrenceEditor({ kind, id, occurrence, start, end, zone, title, onDone, onCancel }: {
  kind: 'project' | 'workspace'; id: string; occurrence: string; start: string; end: string; zone: string; title: string; onDone: () => void; onCancel: () => void;
}) {
  const at = wallInZone(new Date(start), zone);
  const [scope, setScope] = useState<OccurrenceScope>('this');
  const [date, setDate] = useState(`${at.year}-${String(at.monthIndex + 1).padStart(2, '0')}-${String(at.day).padStart(2, '0')}`);
  const [time, setTime] = useState(`${String(at.hour).padStart(2, '0')}:${String(at.minute).padStart(2, '0')}`);
  const [duration, setDuration] = useState(Math.max(5, Math.round((new Date(end).getTime() - new Date(start).getTime()) / 60_000)));
  const [name, setName] = useState(title);
  const [busy, setBusy] = useState(false);
  const ref = `${kind === 'workspace' ? 'w' : 'p'}:${id}`;
  const run = async (cancel: boolean) => {
    const [y, mo, d] = date.split('-').map(Number); const [h, mi] = time.split(':').map(Number);
    const s = zonedTimeToUtc(y, mo - 1, d, h, mi, zone);
    if (!cancel && Number.isNaN(s.getTime())) { toast('Choose a date and a start time.', 'warning'); return; }
    const moved = !cancel && (s.getTime() !== new Date(start).getTime() || duration !== Math.round((new Date(end).getTime() - new Date(start).getTime()) / 60_000));
    setBusy(true);
    try {
      const r = await connectApi.changeOccurrence(ref, { occurrenceStart: occurrence, scope, cancel: cancel || undefined,
        startTime: moved ? s.toISOString() : undefined, endTime: moved ? new Date(s.getTime() + duration * 60_000).toISOString() : undefined,
        title: !cancel && name.trim() && name.trim() !== title ? name.trim() : undefined });
      toast(cancel ? (scope === 'this' ? 'That session is cancelled.' : 'Cancelled from here on.') : r.newSeriesRef ? 'Changed from this session on.' : scope === 'this' ? 'This session is changed.' : 'The whole series is changed.');
      onDone();
    } catch (e) { toast(errText(e, 'Could not change the meeting.'), 'error'); }
    finally { setBusy(false); }
  };
  return (
    <div className="mc-occ" data-testid="occurrence-editor">
      <div className="ms-seg" role="radiogroup" aria-label="Change">
        {([['this', 'This session'], ['following', 'This and following'], ['all', 'All sessions']] as const).map(([k, l]) => (
          <button key={k} type="button" role="radio" aria-checked={scope === k} className={scope === k ? 'on' : ''} onClick={() => setScope(k)}>{l}</button>
        ))}
      </div>
      <div className="mc-occ-grid">
        <label>Title<input className="input" aria-label="Session title" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} /></label>
        <label>Date<input className="input" type="date" aria-label="New date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
        <label>Start<input className="input" type="time" aria-label="New start" value={time} onChange={(e) => setTime(e.target.value)} /></label>
        <label>Length<select className="select" aria-label="New duration" value={duration} onChange={(e) => setDuration(Number(e.target.value))}>{[15, 30, 45, 60, 90, 120].map((m) => <option key={m} value={m}>{m} minutes</option>)}</select></label>
      </div>
      <p className="mt-hint">In {zone}. Everyone invited is told; reminders follow the change.</p>
      <div className="mt-row">
        <button type="button" className="btn btn-ghost btn-sm mt-danger" disabled={busy} onClick={() => void run(true)}>{scope === 'this' ? 'Cancel this session' : scope === 'following' ? 'Cancel from here on' : 'Cancel series'}</button>
        <span className="mt-grow" />
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>Keep it</button>
        <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void run(false)}>{busy && <span className="spinner" />}Save</button>
      </div>
    </div>
  );
}
