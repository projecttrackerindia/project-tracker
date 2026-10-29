import { GrootAvatar } from '../../components/groot/GrootAvatar';
import { flashAura } from '../../components/aura/mood';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { create } from 'zustand';
import { ApiError } from '../../api/client';
import { Icon } from '../../components/Icon';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useIsMobile } from '../../lib/mobile';
import { useAuth, useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { attendanceApi, hm, MODES, modeOf, sourceOfDevice, type AttendanceCheckOut, type AttendanceMode, type AttendanceToday } from './attendanceApi';
import './attendance.css';

/** Which attendance sheet is open: the check-in card (from the sign-in prompt, the pill or the calendar) or the check-out sheet. */
export const useAttendanceSheet = create<{ open: 'checkin' | 'checkout' | null; why: 'prompt' | 'manual'; show: (k: 'checkin' | 'checkout', why?: 'prompt' | 'manual') => void; close: () => void }>((set) => ({
  open: null, why: 'manual',
  show: (k, why = 'manual') => set({ open: k, why }),
  close: () => set({ open: null }),
}));

/** Attendance is for members of organization workspaces (not guests, not platform administrators, not personal workspaces). */
export function useAttendanceOn() {
  return useAuth((s) => !!s.ctx?.current && s.ctx.current.type !== 'Personal' && s.ctx.current.role !== 'Guest' && !s.ctx.user.isPlatformAdmin);
}

/** Today on the organization's clock (shared by the prompt, the pill and the calendar). */
export function useAttendanceToday() {
  const on = useAttendanceOn();
  return useWsQuery(['attendance', 'today'], async (): Promise<AttendanceToday | null> => {
    const d = await attendanceApi.today();
    return d && typeof d === 'object' && 'policy' in d && d.policy ? d : null;   // an older server (or a test double) without attendance
  }, { enabled: on, staleTime: 60_000, refetchInterval: 5 * 60_000, retry: false });
}

/** Minutes since a moment, ticking every minute. */
export function useSince(iso: string | null | undefined, until?: string | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { if (!iso || until) return; const t = window.setInterval(() => setNow(Date.now()), 30_000); return () => window.clearInterval(t); }, [iso, until]);
  if (!iso) return 0;
  return Math.max(0, Math.round(((until ? Date.parse(until) : now) - Date.parse(iso)) / 60_000));
}

// ------------------------------------------------------------------ once a day, on the organization's date
const promptKey = (wid: string | null, date: string) => `pt.attendance.prompt.${wid ?? 'none'}.${date}`;
type PromptState = { s: 'shown' | 'snoozed' | 'done'; until?: number };
function readPrompt(wid: string | null, date: string): PromptState | null { try { return JSON.parse(localStorage.getItem(promptKey(wid, date)) ?? 'null') as PromptState | null; } catch { return null; } }
function writePrompt(wid: string | null, date: string, v: PromptState) { try { localStorage.setItem(promptKey(wid, date), JSON.stringify(v)); } catch { /* private window: asks again next visit */ } }

/**
 * Check-in and check-out for the whole app: asks once a day at the first open (in the organization's working window, never on leave,
 * holidays or days off), "Not now" asks again in 30 minutes; opens the check-in card or the check-out sheet when the pill, the calendar, a
 * notification (?attendance=checkin|checkout) or Aura (window event 'groot:checkout' / 'groot:checkin') asks.
 */
export function AttendanceHost() {
  const on = useAttendanceOn();
  const wid = useWorkspaceId();
  const q = useAttendanceToday();
  const { open, why, show, close } = useAttendanceSheet();
  const [params, setParams] = useSearchParams();
  const [tick, setTick] = useState(0);
  useEffect(() => { const t = window.setInterval(() => setTick((n) => n + 1), 60_000); return () => window.clearInterval(t); }, []);

  // the sign-in prompt
  const d = q.data;
  useEffect(() => {
    if (!on || !d || open) return;
    if (!d.shouldPrompt) return;
    const st = readPrompt(wid, d.date);
    if (st && !(st.s === 'snoozed' && (st.until ?? 0) <= Date.now())) return;
    writePrompt(wid, d.date, { s: 'shown' });
    show('checkin', 'prompt');
  }, [on, d, wid, open, show, tick]);

  // a notification's link, and Aura
  useEffect(() => {
    const a = params.get('attendance');
    if (!on || (a !== 'checkin' && a !== 'checkout')) return;
    show(a);
    setParams((p) => { const n = new URLSearchParams(p); n.delete('attendance'); return n; }, { replace: true });
  }, [params, setParams, on, show]);
  useEffect(() => {
    const out = (e: Event) => { e.preventDefault(); show('checkout'); };   // we handle it, so Aura does not fall back to asking in chat
    const inn = (e: Event) => { e.preventDefault(); show('checkin'); };
    window.addEventListener('groot:checkout', out);
    window.addEventListener('groot:checkin', inn);
    return () => { window.removeEventListener('groot:checkout', out); window.removeEventListener('groot:checkin', inn); };
  }, [show]);

  if (!on || !open) return null;
  const done = () => { if (d) writePrompt(wid, d.date, { s: 'done' }); close(); };
  const snooze = () => { if (d) writePrompt(wid, d.date, { s: 'snoozed', until: Date.now() + 30 * 60_000 }); close(); };
  if (open === 'checkin') return <CheckInCard today={d ?? null} prompted={why === 'prompt'} onDone={done} onSnooze={snooze} />;
  return <CheckOutSheet today={d ?? null} onClose={close} />;
}

// ------------------------------------------------------------------ the frame: a card on a desktop, a bottom sheet on a phone
export function AttFrame({ label, onClose, children, testId, wide }: { label: string; onClose: () => void; children: ReactNode; testId: string; wide?: boolean }) {
  const phone = useIsMobile();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus({ preventScroll: true });
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); } };
    document.addEventListener('keydown', key, true);
    const html = document.documentElement, before = html.style.overflow;
    if (phone) html.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', key, true); html.style.overflow = before; prev?.focus?.({ preventScroll: true }); };
  }, [onClose, phone]);
  return createPortal(
    <div className={`att-scrim${phone ? ' phone' : ''}`} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} data-testid={testId} className={`att-card${phone ? ' att-sheet' : ''}${wide ? ' wide' : ''}`}>
        {phone && <div className="att-grab" aria-hidden="true" />}
        <button type="button" className="att-x" aria-label="Close" onClick={onClose}><Icon name="close" size={14} /></button>
        {children}
      </div>
    </div>,
    document.body,
  );
}

const greeting = (localTime: string | undefined) => { const h = Number((localTime ?? '09').slice(0, 2)); return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; };
const longDate = (iso: string) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }); };
const zoneName = (tz: string) => (tz === 'Asia/Kolkata' ? 'India time' : `${tz.split('/').pop()?.replace(/_/g, ' ')} time`);

// ------------------------------------------------------------------ check in
function CheckInCard({ today, prompted, onDone, onSnooze }: { today: AttendanceToday | null; prompted: boolean; onDone: () => void; onSnooze: () => void }) {
  const wid = useWorkspaceId();
  const nav = useNavigate();
  const first = useAuth((s) => s.ctx?.user.displayName.split(/\s+/)[0] ?? '');
  const allowed = today?.policy.allowedModes ?? MODES.map((m) => m.id);
  const [mode, setMode] = useState<AttendanceMode | null>(null);
  const [place, setPlace] = useState('');
  const [note, setNote] = useState('');
  const [noteOpen, setNoteOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const placeRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (mode === 'ClientSite') placeRef.current?.focus(); }, [mode]);
  const needPlace = mode === 'ClientSite' && (today?.policy.requireClientPlace ?? true) && !place.trim();
  const already = today?.record;

  const submit = async () => {
    if (!mode || needPlace) return;
    setBusy(true);
    try {
      const r = await attendanceApi.checkIn({ mode, place: mode === 'ClientSite' ? place.trim() : null, note: note.trim() || null, source: sourceOfDevice() });
      toast(`Checked in · ${modeOf(r.mode).short} · ${r.checkInLocal}`);
      flashAura('morning', 4000);
      void invalidateWorkspace(wid, 'attendance');
      onDone();
    } catch (e) { toast(e instanceof ApiError ? e.errors[0]?.message ?? e.message : 'Could not check in.', 'error'); }
    finally { setBusy(false); }
  };

  return (
    <AttFrame label="Check in" onClose={prompted ? onSnooze : onDone} testId="att-checkin">
      <header className="att-hd">
        <GrootAvatar state="greeting" mood="morning" size={56} className="groot-avatar" />
        <div>
          <h2>{greeting(today?.localTime)}{first ? `, ${first}` : ''}</h2>
          <p>{already ? `You checked in at ${already.checkInLocal}.` : 'Where are you working today?'}</p>
          {today && <small className="att-when">{longDate(today.date)} · {today.localTime} {zoneName(today.timeZone)} · day {today.workStart}–{today.workEnd}</small>}
        </div>
      </header>
      {already ? (
        <div className="att-acts"><button type="button" className="att-btn primary" onClick={onDone}>OK</button></div>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <div className="att-modes" role="radiogroup" aria-label="Where are you working today?">
            {MODES.filter((m) => allowed.includes(m.id)).map((m) => (
              <button key={m.id} type="button" role="radio" aria-checked={mode === m.id} className={`att-mode${mode === m.id ? ' on' : ''}`} data-mode={m.id} onClick={() => setMode(m.id)}>
                <span className="att-emoji" aria-hidden="true">{m.emoji}</span><b>{m.label}</b>
              </button>
            ))}
          </div>
          {mode === 'ClientSite' && (
            <div className="att-place">
              <label htmlFor="att-place">Client or place</label>
              <input ref={placeRef} id="att-place" className="att-input" value={place} maxLength={120} placeholder="e.g. Northwind Traders, Hitech City" onChange={(e) => setPlace(e.target.value)} />
              {(today?.recentPlaces.length ?? 0) > 0 && (
                <div className="att-chips" aria-label="Recent places">
                  {today!.recentPlaces.map((p) => <button key={p} type="button" className={`att-chip${place === p ? ' on' : ''}`} onClick={() => setPlace(p)}>{p}</button>)}
                </div>
              )}
            </div>
          )}
          {noteOpen ? (
            <textarea className="att-input att-note" aria-label="Note" maxLength={300} rows={2} placeholder="Anything to add? (optional)" value={note} onChange={(e) => setNote(e.target.value)} autoFocus />
          ) : <button type="button" className="att-link" onClick={() => setNoteOpen(true)}>Add a note</button>}
          <div className="att-acts">
            <button type="submit" className="att-btn primary" disabled={!mode || needPlace || busy}>{busy ? 'Checking in…' : 'Check in'}</button>
            <button type="button" className="att-btn" onClick={onSnooze}>Not now</button>
          </div>
          <button type="button" className="att-link faint" onClick={() => { onDone(); nav('/insights?tab=time'); }}>I’m on leave today</button>
        </form>
      )}
    </AttFrame>
  );
}

// ------------------------------------------------------------------ check out
function CheckOutSheet({ today, onClose }: { today: AttendanceToday | null; onClose: () => void }) {
  const wid = useWorkspaceId();
  const r = today?.record ?? null;
  const open = r && !r.checkOutAt ? r : null;
  const mins = useSince(open?.checkInAt);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<AttendanceCheckOut | null>(null);
  const m = useMemo(() => (r ? modeOf(r.mode) : null), [r]);

  const submit = async () => {
    setBusy(true);
    try {
      const res = await attendanceApi.checkOut({ note: note.trim() || null });
      setDone(res);
      flashAura('evening', 4000);
      void invalidateWorkspace(wid, 'attendance');
    } catch (e) { toast(e instanceof ApiError ? e.errors[0]?.message ?? e.message : 'Could not check out.', 'error'); }
    finally { setBusy(false); }
  };

  return (
    <AttFrame label="Check out" onClose={onClose} testId="att-checkout">
      <header className="att-hd">
        <GrootAvatar state={done ? 'success' : 'greeting'} mood="evening" size={56} className="groot-avatar" />
        <div>
          <h2>{done ? 'Have a good evening' : open ? 'Wrapping up?' : 'You’re not checked in'}</h2>
          <p>{done ? `Checked out at ${done.day.checkOutLocal}.` : open ? `${m?.emoji} ${m?.label}${open.place ? ` · ${open.place}` : ''} · since ${open.checkInLocal}` : r?.checkOutLocal ? `You checked out at ${r.checkOutLocal}.` : 'Check in first to start your day.'}</p>
        </div>
      </header>
      {done ? (
        <>
          <div className="att-sum" data-testid="att-summary">
            <div><b>{hm(done.minutes)}</b><span>checked in</span></div>
            <div><b>{done.tasksDone}</b><span>{done.tasksDone === 1 ? 'task done' : 'tasks done'}</span></div>
            <div><b>{hm(done.loggedMinutes)}</b><span>time logged</span></div>
          </div>
          {done.loggedMinutes < done.minutes * 0.5 && done.minutes > 60 && <p className="att-tip">Less than half of today is logged — add it to your timesheet while you remember.</p>}
          <div className="att-acts"><button type="button" className="att-btn primary" onClick={onClose}>Done</button></div>
        </>
      ) : open ? (
        <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <div className="att-sum one"><div><b>{hm(mins)}</b><span>so far today</span></div></div>
          <textarea className="att-input att-note" aria-label="Note for the day" maxLength={300} rows={2} placeholder="How did today go? (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
          <div className="att-acts">
            <button type="submit" className="att-btn primary" disabled={busy}>{busy ? 'Checking out…' : 'Check out'}</button>
            <button type="button" className="att-btn" onClick={onClose}>Not yet</button>
          </div>
        </form>
      ) : (
        <div className="att-acts">
          {!r && <button type="button" className="att-btn primary" onClick={() => useAttendanceSheet.getState().show('checkin')}>Check in</button>}
          <button type="button" className="att-btn" onClick={onClose}>Close</button>
        </div>
      )}
    </AttFrame>
  );
}
