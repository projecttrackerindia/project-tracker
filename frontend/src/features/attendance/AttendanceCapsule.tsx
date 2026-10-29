import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import { flashAura } from '../../components/aura/mood';
import { invalidateWorkspace } from '../../lib/hooks';
import { useIsMobile } from '../../lib/mobile';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { AttFrame, useAttendanceToday, useSince } from './AttendanceHost';
import { attendanceApi, hm, MODES, modeOf, sourceOfDevice, type AttendanceMode, type AttendanceToday } from './attendanceApi';

/** The capsule's state: not checked in, working (office / home / client), past the shift's end, or checked out. */
export type CapsuleState = 'none' | 'office' | 'home' | 'client' | 'overtime' | 'done';
const COLOR: Record<CapsuleState, string> = { none: '#0071e3', office: '#28cd41', home: '#0a84ff', client: '#af52de', overtime: '#ff9f0a', done: '#8e8e93' };
const toMin = (hhmm: string | null | undefined) => { const [h, m] = (hhmm ?? '').split(':').map(Number); return Number.isFinite(h) ? h * 60 + (m || 0) : 0; };
const clock = (min: number) => { const m = ((Math.round(min) % 1440) + 1440) % 1440; return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };

/** The day as numbers: shift start/end, now, check-in/out (minutes after midnight on the organization's clock), the state and the share done. */
export function useWorkday(d: AttendanceToday | null | undefined) {
  const r = d?.record ?? null;
  const worked = useSince(r?.checkInAt, r?.checkOutAt);
  const start = toMin(d?.workStart), end = Math.max(toMin(d?.workEnd), start + 60);
  const inAt = r ? toMin(r.checkInLocal) : null;
  const outAt = r?.checkOutLocal ? toMin(r.checkOutLocal) : null;
  const now = r && !r.checkOutAt && inAt !== null ? inAt + worked : toMin(d?.localTime);
  const minutes = r ? (r.checkOutAt ? r.minutes : worked) : 0;
  const shift = end - start;
  const state: CapsuleState = !r ? 'none' : r.checkOutAt ? 'done' : now > end || minutes > shift ? 'overtime' : r.mode === 'Home' ? 'home' : r.mode === 'ClientSite' ? 'client' : 'office';
  return { r, start, end, inAt, outAt, now, minutes, shift, state, share: Math.max(0, Math.min(1, minutes / shift)) };
}

function Ring({ p, color }: { p: number; color: string }) {
  const r = 10, C = 2 * Math.PI * r;
  return (
    <svg className="att-ring" viewBox="0 0 26 26" width="26" height="26" aria-hidden="true">
      <circle cx="13" cy="13" r={r} fill="none" stroke="var(--att-track)" strokeWidth="3" />
      <circle cx="13" cy="13" r={r} fill="none" stroke={color} strokeWidth="3" strokeLinecap="round" strokeDasharray={`${C * p} ${C}`} transform="rotate(-90 13 13)" />
    </svg>
  );
}

/**
 * Check-in / check-out in the header: a capsule with a ring that fills over the shift, where you are (a dot and a label) and the hours.
 * Tapping it opens the day: the shift bar with a now-marker, Home / Office / Client, and one Check in / Check out button. On a phone it
 * shrinks to the ring and the hours and the day opens as a bottom sheet. Aura greets a check-in (morning) and a check-out (evening).
 */
export function AttendanceCapsule({ compact = false }: { compact?: boolean }) {
  const q = useAttendanceToday();
  const d = q.data;
  const day = useWorkday(d);
  const [open, setOpen] = useState(false);
  const phone = useIsMobile();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open || phone) return;
    const off = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', off); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', off); document.removeEventListener('keydown', esc); };
  }, [open, phone]);
  if (!d || !d.policy.enabled) return null;
  if (!day.r && !d.workingDay) return null;
  const { state, r } = day;
  const label = state === 'none' ? 'Check in' : state === 'done' ? 'Done' : state === 'overtime' ? 'Overtime' : modeOf(r!.mode).short;
  const hours = hm(day.minutes);
  const aria = state === 'none' ? 'Check in for today' : state === 'done' ? `Checked out, ${hours} today` : `Checked in, ${label}, ${hours}. Open your day`;
  return (
    <div className="att-cap-wrap" ref={box}>
      <button type="button" className={`att-cap${compact ? ' compact' : ''}`} data-state={state} data-testid="att-capsule" aria-label={aria} aria-expanded={open} aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)} style={{ '--att-c': COLOR[state] } as React.CSSProperties}>
        {state === 'none' ? <span className="att-cap-in">Check in</span> : (
          <>
            <Ring p={state === 'done' || state === 'overtime' ? 1 : day.share} color={COLOR[state]} />
            {compact ? <b className="att-cap-h">{hours}</b> : (
              <span className="att-cap-t">{state !== 'done' && <i className="att-cap-dot" aria-hidden="true" />}<b>{label}</b> <span className="att-cap-dim">· {hours}</span></span>
            )}
          </>
        )}
      </button>
      {open && (phone
        ? <AttFrame label="Your day" onClose={() => setOpen(false)} testId="att-day"><DayPanel today={d} onDone={() => setOpen(false)} /></AttFrame>
        : <div className="att-pop" role="dialog" aria-label="Your day" data-testid="att-day"><DayPanel today={d} onDone={() => setOpen(false)} /></div>)}
    </div>
  );
}

function DayPanel({ today, onDone }: { today: AttendanceToday; onDone: () => void }) {
  const wid = useWorkspaceId();
  const day = useWorkday(today);
  const { r, state, start, end, inAt, outAt, now } = day;
  const allowed = today.policy.allowedModes?.length ? today.policy.allowedModes : MODES.map((m) => m.id);
  const [mode, setMode] = useState<AttendanceMode>(r?.mode ?? (allowed.includes('Office') ? 'Office' : allowed[0]));
  const [place, setPlace] = useState(r?.place ?? '');
  const [busy, setBusy] = useState(false);
  const needPlace = !r && mode === 'ClientSite' && (today.policy.requireClientPlace ?? true) && !place.trim();
  // the bar: the shift from start to end (stretched when the day ran past it); the worked part filled; now marked
  const lo = Math.min(start, inAt ?? start), hi = Math.max(end, now, outAt ?? 0);
  const pos = (m: number) => `${((m - lo) / Math.max(1, hi - lo)) * 100}%`;
  const fillTo = outAt ?? now;
  const mid = [lo + (hi - lo) / 3, lo + (2 * (hi - lo)) / 3].map((m) => Math.round(m / 30) * 30);
  const title = state === 'none' ? 'Not checked in yet' : state === 'done' ? 'Done for today'
    : r!.mode === 'Home' ? 'Working from home' : r!.mode === 'ClientSite' ? `At ${r!.place || 'a client office'}` : 'Working from the office';
  const sub = state === 'none' ? `Shift ${today.workStart} – ${today.workEnd}` : state === 'done'
    ? `${r!.checkInLocal} – ${r!.checkOutLocal} · ${hm(r!.minutes)}${r!.autoClosed ? ' · closed automatically' : ''}`
    : `Checked in at ${r!.checkInLocal} · shift ${today.workStart} – ${today.workEnd}`;
  const late = inAt !== null ? inAt - (start + (today.policy.checkInGraceMinutes ?? 0)) : 0;

  const pickMode = async (m: AttendanceMode) => {
    setMode(m);
    if (!r || r.checkOutAt || m === r.mode || (m === 'ClientSite' && !place.trim() && (today.policy.requireClientPlace ?? true))) return;
    try { await attendanceApi.correct(today.date, { mode: m, place: m === 'ClientSite' ? place.trim() : null }); void invalidateWorkspace(wid, 'attendance'); }
    catch (e) { toast(e instanceof ApiError ? e.errors[0]?.message ?? e.message : 'Could not change where you are working.', 'error'); setMode(r.mode); }
  };
  const act = async () => {
    setBusy(true);
    try {
      if (!r) {
        const res = await attendanceApi.checkIn({ mode, place: mode === 'ClientSite' ? place.trim() : null, source: sourceOfDevice() });
        flashAura('morning', 4000);
        toast(`Checked in · ${modeOf(res.mode).short} · ${res.checkInLocal}`);
      } else {
        const res = await attendanceApi.checkOut({});
        flashAura('evening', 4000);
        toast(`Checked out · ${hm(res.minutes)} today · ${res.tasksDone} ${res.tasksDone === 1 ? 'task' : 'tasks'} done`);
      }
      void invalidateWorkspace(wid, 'attendance');
      onDone();
    } catch (e) { toast(e instanceof ApiError ? e.errors[0]?.message ?? e.message : r ? 'Could not check out.' : 'Could not check in.', 'error'); flashAura('sad'); }
    finally { setBusy(false); }
  };
  return (
    <div className="att-day" data-state={state}>
      <h3>{title}</h3>
      <p className="att-day-s">{sub}</p>
      <div className="att-bar" aria-hidden="true">
        <span className="att-bar-tr" />
        {inAt !== null && <span className="att-bar-fill" style={{ left: pos(inAt), width: `calc(${pos(fillTo)} - ${pos(inAt)})`, background: COLOR[state] }} />}
        {state !== 'done' && <span className="att-bar-now" style={{ left: pos(now) }} data-testid="att-now" />}
      </div>
      <div className="att-ticks"><span>{clock(lo)}</span><span>{clock(mid[0])}</span><span>{clock(mid[1])}</span><span>{clock(hi)}</span></div>
      {state !== 'done' && (
        <div className="att-seg" role="radiogroup" aria-label="Where are you working?">
          {MODES.filter((m) => allowed.includes(m.id)).map((m) => (
            <button key={m.id} type="button" role="radio" aria-checked={mode === m.id} className={mode === m.id ? 'on' : ''} data-mode={m.id} onClick={() => void pickMode(m.id)}>{m.short}</button>
          ))}
        </div>
      )}
      {state !== 'done' && mode === 'ClientSite' && (!r || r.mode !== 'ClientSite') && (
        <input className="att-input att-day-place" aria-label="Client or place" placeholder="Client or place" maxLength={120} value={place} onChange={(e) => setPlace(e.target.value)}
          list="att-recent-places" />
      )}
      <datalist id="att-recent-places">{today.recentPlaces.map((p) => <option key={p} value={p} />)}</datalist>
      {state !== 'done' && <button type="button" className="att-big" disabled={busy || needPlace} onClick={() => void act()}>{busy ? (r ? 'Checking out…' : 'Checking in…') : r ? 'Check out' : 'Check in'}</button>}
      <div className="att-day-mini">
        <span>{state === 'none' ? `Now ${today.localTime}` : `Today · ${hm(day.minutes)}`}</span>
        {late > 0 && <span>Late check-in · {hm(late)}</span>}
      </div>
    </div>
  );
}
