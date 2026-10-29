import { useEffect, useMemo, useState } from 'react';
import { MeetTimeCards } from '../meet/MeetTime';
import { Link, useNavigate } from 'react-router-dom';
import { useQueries } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { integrationsApi, timeApi } from '../../api/endpoints';
import { toCalendarEvent, useTimeline } from '../calendar/timeline';
import { YourDayList } from '../calendar/YourDay';
import type { ApprovalRow, DevLink, TimesheetGrid } from '../../api/types';
import { Face } from '../../components/Face';
import { invalidateWorkspace, useCachedWsQuery, useWsQuery } from '../../lib/hooks';
import { refreshWork } from '../work/workUi';
import { todayISO } from '../../lib/format';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { KIND_LABEL, inboxApi, type InboxRow } from './inboxApi';
import { breachText, useMinuteNow } from '../work/dueTime';
import { SignalsSection, signalsLine, useTodaySignals } from './Signals';
import './phoneToday.css';

/*
 * Today on a phone held upright (apple/s-mobile "iPhone · Today" and apple/s-phone "Today, in your pocket"): the date, "Today", a live
 * outage pill with its running clock while an incident is open, "N things need you." with the reason, the rows that need you each with one
 * tap, UP NEXT with Join, and — for an approver — a timesheet to approve in one tap with its hours already reconciled.
 */

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.errors[0]?.message ?? e.message : fallback);
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const headDay = (s: string) => { const d = new Date(`${s}T00:00:00`); return `${d.toLocaleDateString('en-GB', { weekday: 'long' })}, ${d.getDate()} ${d.toLocaleDateString('en-GB', { month: 'long' })}`; };
const clock = (d: Date) => `${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')}`;
const hours = (min: number) => { const h = Math.floor(min / 60), m = Math.round(min % 60); return h && m ? `${h}h ${m}m` : h ? `${h}h` : `${m}m`; };
/** "1h 34m" from a start, ticking every second while under a minute ("42s"). */
const since = (fromMs: number, now: number) => { const s = Math.max(0, Math.floor((now - fromMs) / 1000)); return s < 60 ? `${s}s` : hours(Math.floor(s / 60)); };
const DOT: Record<string, string> = { ticket: '#ff3b30', decision: '#af52de', task: '#ff9500', mention: '#34c759', approval: '#0071e3', reminder: '#0071e3', access: '#0071e3', review: '#0071e3' };
const DONE_TEXT: Record<string, string> = { accept: 'Accepted.', approve: 'Approved.', done: 'Marked done.' };

function useNow(ms: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), ms); return () => window.clearInterval(t); }, [ms]);
  return now;
}

export function PhoneToday() {
  const wid = useWorkspaceId();
  const nav = useNavigate();
  const today = todayISO();
  const briefing = useCachedWsQuery(['inbox', 'briefing'], inboxApi.briefing, { staleTime: 30_000 });
  const inbox = useCachedWsQuery(['inbox', 'rows', 'all'], () => inboxApi.list('all'), { staleTime: 30_000 });
  const rows = inbox.data?.rows ?? [];
  const outage = rows.find((r) => r.kind === 'ticket' && r.urgent) ?? null;
  // The timesheet card shows the approval itself, so its row is not listed twice.
  const approvals = useWsQuery(['time', 'approvals', 'pending'], () => timeApi.approvals(), { staleTime: 60_000, retry: false });
  const pending = (approvals.data?.pending ?? []).filter((p) => p.id && p.status === 'Submitted');
  const list = rows.filter((r) => r.id !== outage?.id && !(pending.length > 0 && r.kind === 'approval' && /timesheet/i.test(`${r.title} ${r.sub}`))).slice(0, 5);
  const minute = useMinuteNow(list.some((r) => !!r.breachAt));
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<Set<string>>(new Set());

  const act = async (r: InboxRow) => {
    if (!r.action.endpoint) { if (r.href) nav(r.href); return; }
    setBusy(r.id);
    try {
      await inboxApi.act(r);
      setDone((s) => new Set(s).add(r.id));
      toast(DONE_TEXT[r.action.verb] ?? 'Done.');
      window.setTimeout(() => { void invalidateWorkspace(wid, 'inbox'); void invalidateWorkspace(wid, 'reminders'); refreshWork(wid); }, 700);
    } catch (e) { toast(errText(e, 'That could not be done here. Open it instead.'), 'error'); }
    finally { setBusy(null); }
  };

  const b = briefing.data;
  const n = b?.count ?? inbox.data?.counts?.all ?? rows.length;
  const watch = signalsLine(useTodaySignals().data);
  return (
    <div className="pt" data-testid="phone-today">
      <div className="pt-date">{headDay(today)}</div>
      <h1 className="pt-h1">Today</h1>
      {outage && <OutagePill row={outage} />}
      <p className="pt-brief">
        {briefing.isLoading && inbox.isLoading ? 'Reading your work…'
          : n > 0 ? <><b>{n} thing{n === 1 ? '' : 's'} need{n === 1 ? 's' : ''} you.</b>{b?.reasons?.[0] ? ` ${b.reasons[0]}` : ''}</>
          : watch ? <span data-testid="needs-you-empty"><b>Nothing needs you right now</b> · {watch} below.</span>
          : <b>Nothing needs you right now.</b>}
      </p>
      <MeetTimeCards phone />
      {list.length > 0 && (
        <section className="pt-card" aria-label="Needs you">
          {list.map((r) => {
            const off = busy === r.id || done.has(r.id);
            const sub = `${r.sub || KIND_LABEL[r.kind]}${r.breachAt ? ` · ${breachText(r.breachAt, minute)}` : ''}`;
            const label = r.kind === 'ticket' && r.urgent ? 'Open' : r.kind === 'decision' ? 'Decide' : r.action.label;
            const go = !r.action.endpoint || r.kind === 'decision';
            return (
              <div key={r.id} className={`pt-li${done.has(r.id) ? ' done' : ''}`}>
                <span className="pt-dot" style={{ background: DOT[r.kind] ?? '#8e8e93' }} aria-hidden="true" />
                {r.href ? <Link className="pt-li-main" to={r.href}><span className="pt-li-t">{r.title}</span><small>{sub}</small></Link>
                  : <span className="pt-li-main"><span className="pt-li-t">{r.title}</span><small>{sub}</small></span>}
                <button type="button" className="pt-act" disabled={off} onClick={() => (go && r.href ? nav(r.href) : void act(r))}>{done.has(r.id) ? '✓' : label}</button>
              </div>
            );
          })}
        </section>
      )}
      <PhoneUpNext />
      <SignalsSection compact />
      <YourDayList />
      {pending.slice(0, 1).map((p) => <TimesheetApprovalCard key={p.id} row={p} />)}
    </div>
  );
}

/** The outage pill (s-phone's Live Activity): red pulse, what is down, who is on it, and the clock running since it opened. */
function OutagePill({ row }: { row: InboxRow }) {
  const now = useNow(1000);
  const start = Date.parse(row.at);
  return (
    <Link to={row.href ?? '/desk'} className="pt-la" data-testid="outage-pill" aria-label={`Open incident: ${row.title}, running ${since(start, now)}`}>
      <span className="pt-pulse" aria-hidden="true"><i /></span>
      <span className="pt-la-main"><b>{row.title}</b><small>{row.sub}</small></span>
      <span className="pt-la-clock" aria-hidden="true">{since(start, now)}</span>
    </Link>
  );
}

/** UP NEXT · IN 17 MIN — the next meeting (today's, else the next one in two weeks) with Join. */
function PhoneUpNext() {
  const today = todayISO();
  const to = iso(new Date(Date.now() + 14 * 864e5));
  const q = useTimeline({ from: today, to });
  const now = useNow(30_000);
  const next = useMemo(() => (q.data?.events ?? []).filter((t) => t.type === 'meeting').map((t) => ({ e: toCalendarEvent(t), start: new Date(t.start), mins: t.end ? Math.round((Date.parse(t.end) - Date.parse(t.start)) / 60_000) : 30 }))
    .sort((a, b) => a.start.getTime() - b.start.getTime())
    .find((m) => m.start.getTime() + m.mins * 60_000 > now) ?? null, [q.data, now]);
  if (!next) return null;
  const inMin = Math.round((next.start.getTime() - now) / 60_000);
  const sameDay = iso(next.start) === today;
  const when = inMin <= 0 ? 'NOW' : sameDay && inMin < 60 ? `IN ${inMin} MIN` : sameDay ? clock(next.start) : next.start.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).toUpperCase();
  const where = [clock(next.start), next.e.joinUrl ? 'Meet' : null, `${next.mins} min`, next.e.notes ? 'agenda ready' : next.e.projectName].filter(Boolean).join(' · ');
  const href = next.e.projectId ? `/work/projects/${next.e.projectId}` : '/?tab=calendar';
  return (
    <section className="pt-card pt-next" aria-label="Up next" data-testid="phone-up-next">
      <div className="pt-next-main">
        <div className="pt-eyebrow">UP NEXT · {when}</div>
        <div className="pt-next-t">{next.e.title}</div>
        <small>{where}</small>
      </div>
      {next.e.joinUrl ? <a className="pt-join" href={next.e.joinUrl} target="_blank" rel="noreferrer">Join</a> : <Link className="pt-join" to={href}>Join</Link>}
    </section>
  );
}

const DAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

/** What differs between the week's hours and the calendar and commits, or that nothing does. Only what can be checked is claimed. */
export function reconcile(grid: TimesheetGrid, commits: { checked: boolean; missing: string[] }): { ok: boolean; text: string } {
  const issues: string[] = [];
  const dayName = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'short' });
  const gaps = grid.days.filter((d) => !d.weekend && !d.leave && !d.future && d.minutes === 0).map((d) => dayName(d.date));
  if (gaps.length) issues.push(`No time on ${gaps.join(', ')}`);
  const under = grid.days.filter((d) => d.meetingMinutes > 0 && d.minutes > 0 && d.minutes < d.meetingMinutes);
  for (const d of under.slice(0, 2)) issues.push(`${dayName(d.date)} has ${hours(d.meetingMinutes)} of meetings, ${hours(d.minutes)} logged`);
  if (commits.missing.length) issues.push(`no commits on ${commits.missing.slice(0, 2).join(', ')}`);
  if (!issues.length) return { ok: true, text: commits.checked ? 'Matches calendar and commits. No gaps.' : 'Matches calendar. No gaps.' };
  const t = issues.join('; ');
  return { ok: false, text: `${t[0].toUpperCase()}${t.slice(1)}.` };
}

/**
 * One-tap timesheet approval (s-phone "Approve in one tap"): who and which week, the week's days, hours per project, the total, one line
 * on how it reconciles with the calendar and the code, then Approve or Send back with note.
 */
export function TimesheetApprovalCard({ row }: { row: ApprovalRow }) {
  const wid = useWorkspaceId();
  const grid = useWsQuery(['time', 'grid', row.weekStart, row.user.id], () => timeApi.grid(row.weekStart, row.user.id), { staleTime: 60_000, retry: false });
  const [busy, setBusy] = useState(false);
  const [returning, setReturning] = useState(false);
  const [note, setNote] = useState('');
  const [doneAs, setDoneAs] = useState<'approved' | 'returned' | null>(null);
  const g = grid.data;

  // Code work this week: tasks with time whose dev links show commits or pull requests; a task with links but nothing that week is flagged.
  const taskRows = (g?.rows ?? []).filter((r) => r.kind === 'task' && r.totalMinutes > 0).slice(0, 5);
  const links = useQueries({ queries: taskRows.map((r) => ({ queryKey: [wid, 'dev-links', r.targetId], queryFn: () => integrationsApi.taskLinks(r.targetId), staleTime: 5 * 60_000, retry: false })) });
  const commits = useMemo(() => {
    if (!g) return { checked: false, missing: [] as string[] };
    const end = g.weekEnd;
    let checked = false; const missing: string[] = [];
    taskRows.forEach((r, i) => {
      const l = (links[i]?.data ?? []) as DevLink[];
      const code = l.filter((x) => x.kind === 'commit' || x.kind === 'pull_request');
      if (!code.length) return;
      checked = true;
      if (!code.some((x) => x.occurredAt.slice(0, 10) >= g.weekStart && x.occurredAt.slice(0, 10) <= end)) missing.push(r.key);
    });
    return { checked, missing };
  }, [g, links.map((l) => l.dataUpdatedAt).join()]); // eslint-disable-line react-hooks/exhaustive-deps

  const byProject = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of g?.rows ?? []) {
      if (!r.totalMinutes) continue;
      const k = r.projectName ?? (r.kind === 'work' ? `${r.title} (ticket)` : r.title);
      m.set(k, (m.get(k) ?? 0) + r.totalMinutes);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [g]);
  const shown = byProject.slice(0, 4);
  const rest = byProject.slice(4).reduce((s, [, v]) => s + v, 0);
  const rec = g ? reconcile(g, commits) : null;
  const wk = (s: string) => { const d = new Date(`${s}T00:00:00`); return `${d.getDate()} ${d.toLocaleDateString('en-GB', { month: 'short' })}`; };
  const end = iso(new Date(new Date(`${row.weekStart}T00:00:00`).getTime() + 6 * 864e5));

  const decide = async (approve: boolean) => {
    if (!row.id || busy) return;
    if (!approve && !note.trim()) { setReturning(true); return; }
    setBusy(true);
    try {
      if (approve) await timeApi.approve(row.id); else await timeApi.reject(row.id, note.trim());
      setDoneAs(approve ? 'approved' : 'returned');
      toast(approve ? `Approved ${row.user.name.split(' ')[0]}'s week.` : `Sent back to ${row.user.name.split(' ')[0]}.`);
      window.setTimeout(() => { void invalidateWorkspace(wid, 'time'); void invalidateWorkspace(wid, 'inbox'); }, 900);
    } catch (e) { toast(errText(e, 'Could not save the decision.'), 'error'); }
    finally { setBusy(false); }
  };

  return (
    <section className="pt-card pt-ts" aria-label={`Timesheet for ${row.user.name}`} data-testid="timesheet-approval">
      <div className="pt-ts-hd">
        <Face userId={row.user.id} name={row.user.name} className="pt-ts-av" />
        <div><b>{row.user.name}</b><small>Timesheet · {wk(row.weekStart)} – {wk(end)}</small></div>
      </div>
      {g && (
        <div className="pt-ts-days" aria-label="Hours per day">
          {g.days.map((d, i) => (
            <span key={d.date} className={`${d.minutes ? 'on' : ''}${d.weekend ? ' we' : ''}`} title={`${d.date}: ${hours(d.minutes)}`}>
              <i style={{ height: `${Math.min(100, (d.minutes / Math.max(60, d.targetMinutes || 480)) * 100)}%` }} />{DAYS[i]}
            </span>
          ))}
        </div>
      )}
      {grid.isLoading ? <p className="pt-faint">Reading the week…</p> : (
        <div className="pt-ts-lines">
          {shown.map(([k, v]) => <div key={k} className="pt-dl"><span>{k}</span><b>{hours(v)}</b></div>)}
          {rest > 0 && <div className="pt-dl"><span>Everything else</span><b>{hours(rest)}</b></div>}
          <div className="pt-dl total"><span>Total</span><b>{hours(g?.totalMinutes ?? row.totalMinutes)}</b></div>
        </div>
      )}
      {rec && <p className={`pt-rec ${rec.ok ? 'ok' : 'warn'}`} data-testid="timesheet-reconcile"><span aria-hidden="true">{rec.ok ? '✓' : '!'}</span>{rec.text}</p>}
      {doneAs ? <p className="pt-ts-done" role="status">{doneAs === 'approved' ? 'Approved.' : 'Sent back with your note.'}</p> : (
        <>
          {returning && <textarea className="pt-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What needs changing?" aria-label="Note for the person" autoFocus />}
          <button type="button" className="pt-approve" disabled={busy} onClick={() => void decide(true)}>{busy && !returning ? 'Approving…' : 'Approve'}</button>
          <button type="button" className="pt-return" disabled={busy || (returning && !note.trim())} onClick={() => void decide(false)}>{returning ? 'Send back' : 'Send back with note'}</button>
        </>
      )}
    </section>
  );
}
