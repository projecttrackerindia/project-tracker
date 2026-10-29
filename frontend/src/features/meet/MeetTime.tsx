import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { formatTime } from '../../lib/format';
import { invalidateWorkspace, refreshTime, useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { connectApi, type TimeProposal } from './meetApi';
import './connect.css';

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.errors[0]?.message ?? e.message : fallback);
export const dur = (m: number) => (m % 60 === 0 ? `${m / 60}h` : m > 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`);

/** The person's open "Log 45m to …?" prompts (made by the server when a session they were in has ended). */
export function useTimeProposals(enabled = true) {
  return useWsQuery(['time', 'meeting-proposals'], connectApi.proposals, { enabled, staleTime: 60_000, refetchInterval: 3 * 60_000, refetchOnWindowFocus: true, retry: false });
}

/** Log / Later / Didn't attend, shared by every place the prompt shows. Nothing is logged until Log is tapped. */
function useProposalActions() {
  const wid = useWorkspaceId();
  const [busy, setBusy] = useState<string | null>(null);
  const done = () => { void invalidateWorkspace(wid, 'time', 'meeting-proposals'); void refreshTime(wid); };
  const act = async (key: string, fn: () => Promise<unknown>, ok: string | ((r: unknown) => string)) => {
    setBusy(key);
    try { const r = await fn(); toast(typeof ok === 'string' ? ok : ok(r)); done(); }
    catch (e) { toast(errText(e, 'That did not work. Try again.'), 'error'); }
    finally { setBusy(null); }
  };
  return {
    busy,
    log: (p: TimeProposal, minutes: number, note: string, billable: boolean) => act(`log:${p.id}`, () => connectApi.log(p.id, { minutes, note: note.trim() || undefined, billable }),
      (r) => { const w = (r as { warning?: string | null }).warning; return w ? `Logged ${dur(minutes)} to ${p.projectName}. ${w}.` : `Logged ${dur(minutes)} to ${p.projectName}.`; }),
    later: (p: TimeProposal) => act(`later:${p.id}`, () => connectApi.later(p.id), 'Asked again in two hours.'),
    dismiss: (p: TimeProposal) => act(`dismiss:${p.id}`, () => connectApi.dismiss(p.id), 'Not logged.'),
  };
}

/**
 * "Log 45m to UPI AutoPay?" (design: meet-log): when the session ended and who it was for, the length as chips (Custom for any other),
 * billable, a note, and Didn't attend / Later / Log. It links to the action items the person was given in that meeting.
 */
export function ProposalCard({ p, variant = 'card', onClose }: { p: TimeProposal; variant?: 'toast' | 'card' | 'phone'; onClose?: () => void }) {
  const actions = useProposalActions();
  const [minutes, setMinutes] = useState(p.minutes);
  const [custom, setCustom] = useState(false);
  const [billable, setBillable] = useState(p.billable);
  const [note, setNote] = useState('');
  const chips = [...new Set([30, p.minutes, 60])].sort((a, b) => a - b);
  const span = `${formatTime(p.start)} – ${formatTime(p.end)}`;
  const busy = actions.busy?.endsWith(p.id);
  return (
    <section className={`mlog mlog-${variant}`} aria-label={`Log time for ${p.meetingTitle}`} data-testid="meeting-time-proposal">
      {variant === 'phone' ? <div className="mlog-eyebrow">Meeting ended · {formatTime(p.end)}</div> : (
        <header className="mlog-head">
          <span className="mlog-ico" aria-hidden="true" />
          <div><b>{p.meetingTitle} ended</b><small>{span} · you attended {dur(p.minutes)}</small></div>
          {onClose && <button type="button" className="mlog-close" aria-label="Hide" onClick={onClose}>×</button>}
        </header>
      )}
      <h3 className="mlog-q">Log {dur(minutes)} to {p.projectName}?</h3>
      <p className="mlog-sub">{variant === 'phone' ? `${p.meetingTitle} · you attended ${dur(p.minutes)}` : 'From the meeting’s length. Change it if you stepped out.'}</p>
      {p.overlap && <p className="mlog-warn">{p.overlap}: each meeting proposes its own time.</p>}
      <div className="mlog-chips" role="radiogroup" aria-label="How long">
        {chips.map((m) => <button key={m} type="button" role="radio" aria-checked={!custom && minutes === m} className={!custom && minutes === m ? 'on' : ''} onClick={() => { setCustom(false); setMinutes(m); }}>{dur(m)}</button>)}
        {custom
          ? <input className="mlog-custom" type="number" min={1} max={1440} aria-label="Minutes" autoFocus value={minutes} onChange={(e) => setMinutes(Math.max(1, Math.min(1440, Number(e.target.value) || 1)))} />
          : <button type="button" role="radio" aria-checked={false} onClick={() => setCustom(true)}>{variant === 'phone' ? 'Edit' : 'Custom'}</button>}
        {variant !== 'phone' && <button type="button" className={`mlog-bill${billable ? ' on' : ''}`} aria-pressed={billable} onClick={() => setBillable((b) => !b)}>Billable{billable ? ' ✓' : ''}</button>}
      </div>
      {variant !== 'phone' && <input className="mlog-note" aria-label="Note" placeholder={`Note: ${p.meetingTitle}`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />}
      <div className="mlog-acts">
        {variant === 'phone' ? <>
          <button type="button" className="btn btn-primary mlog-big" disabled={busy} onClick={() => void actions.log(p, minutes, note, billable)}>Log {dur(minutes)}</button>
          <button type="button" className="mlog-skip" disabled={busy} onClick={() => void actions.dismiss(p)}>Didn’t attend</button>
        </> : <>
          <button type="button" className="mlog-skip" disabled={busy} onClick={() => void actions.dismiss(p)}>Didn’t attend</button>
          <span className="mt-grow" />
          <button type="button" className="btn btn-ghost btn-sm mlog-later" disabled={busy} onClick={() => void actions.later(p)}>Later</button>
          <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void actions.log(p, minutes, note, billable)}>{actions.busy === `log:${p.id}` && <span className="spinner" />}Log {dur(minutes)}</button>
        </>}
      </div>
      {p.assignedToMe > 0 && variant !== 'phone' && (
        <Link className="mlog-foot" to="/work?from=meetings">{p.assignedToMe} action item{p.assignedToMe === 1 ? ' was' : 's were'} assigned to you in this meeting → in My Work</Link>
      )}
    </section>
  );
}

const SEEN = 'pm_meetlog_seen';
const seen = (): string[] => { try { return JSON.parse(sessionStorage.getItem(SEEN) ?? '[]') as string[]; } catch { return []; } };

/**
 * The toast: the newest prompt, once per session, in the corner of any page except Today and Time (which show it in their own lists).
 * Hiding it does not decide anything - it stays in Today and Time until Log, Later or Didn't attend.
 */
export function MeetTimePrompt() {
  const loc = useLocation();
  const parts = loc.pathname.split('/').filter(Boolean);
  const PLACES = ['work', 'messages', 'insights', 'library', 'people', 'settings', 'calls', 'desk', 'quality', 'mail', 'account', 'admin'];
  const onTodayOrTime = (parts.length <= 1 && !PLACES.includes(parts[0] ?? '')) || /tab=time/.test(loc.search);
  const q = useTimeProposals();
  const [hidden, setHidden] = useState<string[]>(seen);
  const p = (q.data ?? []).find((x) => !hidden.includes(x.id));
  if (!p || onTodayOrTime) return null;
  const hide = () => { const n = [...hidden, p.id]; setHidden(n); try { sessionStorage.setItem(SEEN, JSON.stringify(n.slice(-50))); } catch { /* private */ } };
  return <div className="mlog-toast-wrap" role="status"><ProposalCard p={p} variant="toast" onClose={hide} /></div>;
}

/** Today's card list (design: meet-log, meet-log-phone): every open prompt. */
export function MeetTimeCards({ phone = false }: { phone?: boolean }) {
  const q = useTimeProposals();
  const list = q.data ?? [];
  if (!list.length) return null;
  return <div className="mlog-list">{list.slice(0, 3).map((p) => <ProposalCard key={p.id} p={p} variant={phone ? 'phone' : 'card'} />)}</div>;
}

/** Time (design: meet-where, Time column): proposed entries as dashed rows with Confirm / Edit / Not attended. */
export function MeetTimeRows() {
  const q = useTimeProposals();
  const actions = useProposalActions();
  const [editing, setEditing] = useState<string | null>(null);
  const list = q.data ?? [];
  if (!list.length) return null;
  return (
    <section className="mlog-rows" aria-label="Time from meetings">
      <h3>From meetings <small>proposed · logged only when you confirm</small></h3>
      {list.map((p) => editing === p.id ? <ProposalCard key={p.id} p={p} onClose={() => setEditing(null)} /> : (
        <div key={p.id} className="mlog-row" data-testid="meeting-time-row">
          <div className="mlog-row-main"><b>{p.meetingTitle}</b><small>{p.projectName} · from meeting · {formatTime(p.start)}–{formatTime(p.end)}</small></div>
          <span className="mlog-row-min">{dur(p.minutes)}</span>
          <div className="mlog-row-acts">
            <button type="button" className="btn btn-primary btn-sm" disabled={!!actions.busy} onClick={() => void actions.log(p, p.minutes, '', p.billable)}>Confirm</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(p.id)}>Edit</button>
            <button type="button" className="mlog-skip" disabled={!!actions.busy} onClick={() => void actions.dismiss(p)}>Not attended</button>
          </div>
        </div>
      ))}
    </section>
  );
}
