import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ApiError } from '../../api/client';
import { Face } from '../../components/Face';
import { Icon } from '../../components/Icon';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useIsMobile } from '../../lib/mobile';
import { useAuth, useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import '../calendar/eventDetail.css';
import { attendanceApi, hm, MODES, modeOf, type AttendanceDay, type AttendanceMode } from './attendanceApi';
import { useAttendanceSheet, useAttendanceToday } from './AttendanceHost';
import './attendance.css';

const TINT: Record<AttendanceMode, string> = { Office: '#0071e3', Home: '#28cd41', ClientSite: '#ff9500' };
const dayName = (iso: string) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' }); };

type Open = { kind: 'mine'; day: string; rec: AttendanceDay | null } | { kind: 'team'; day: string; recs: AttendanceDay[] };

/**
 * The attendance band of the calendar: a slim row above the day columns with each day's check-in ("🏢 Office 9:12–18:05"), or, in Team
 * view (managers), who was where that day as faces grouped by mode. A click opens a card in the calendar's own card style; today's own
 * day can be corrected there (mode, place, note, times).
 */
export function AttendanceRow({ days, today }: { days: string[]; today: string }) {
  const t = useAttendanceToday();
  const [team, setTeam] = useState(false);
  const [open, setOpen] = useState<{ o: Open; el: HTMLElement | null } | null>(null);
  const from = days[0], to = days[days.length - 1];
  const scope = team ? 'team' : 'me';
  const q = useWsQuery(['attendance', 'list', from, to, scope], () => attendanceApi.list(from, to, scope), { enabled: !!t.data?.policy.enabled, staleTime: 60_000, retry: false, placeholderData: (p) => p });
  const me = useAuth((s) => s.ctx?.user.id);
  const rows = useMemo(() => (Array.isArray(q.data) ? q.data : []), [q.data]);
  if (!t.data?.policy.enabled) return null;
  const canTeam = t.data.canViewTeam;
  // "Today" is the organization's date, which can differ from this browser's near midnight.
  const orgToday = t.data.date ?? today;

  return (
    <div className={`att-row${team ? ' team' : ''}`} data-testid="att-row" style={{ ['--cols' as string]: days.length }}>
      <span className="att-row-lead">
        {canTeam ? (
          <button type="button" className={`att-team-tg${team ? ' on' : ''}`} aria-pressed={team} data-testid="att-team-toggle" title={team ? 'Show my days' : 'Show where my team works'} onClick={() => { setTeam(!team); setOpen(null); }}>
            <Icon name="users" size={12} />{team ? 'Team' : 'Me'}
          </button>
        ) : <span className="att-row-lab">In</span>}
      </span>
      {days.map((d) => {
        if (team) {
          const recs = rows.filter((r) => r.date === d);
          if (!recs.length) return <span key={d} className="att-band att-none" />;
          return (
            <button key={d} type="button" className="att-band team" data-testid="att-band" data-day={d} onClick={(e) => setOpen({ o: { kind: 'team', day: d, recs }, el: e.currentTarget })}
              aria-label={`${recs.length} checked in on ${dayName(d)}`}>
              {MODES.map((m) => {
                const of = recs.filter((r) => r.mode === m.id);
                if (!of.length) return null;
                return (
                  <span key={m.id} className="att-grp" title={`${m.label}: ${of.map((r) => r.userName).join(', ')}`}>
                    <span aria-hidden="true">{m.emoji}</span>
                    <span className="att-faces">{of.slice(0, 3).map((r) => <Face key={r.userId} userId={r.userId} name={r.userName} className="att-face" />)}</span>
                    {of.length > 3 && <em>+{of.length - 3}</em>}
                  </span>
                );
              })}
            </button>
          );
        }
        const rec = rows.find((r) => r.date === d && r.userId === me) ?? (d === orgToday ? t.data!.record : null) ?? null;
        if (!rec) {
          if (d === orgToday && t.data!.workingDay) return <button key={d} type="button" className="att-band ask" data-testid="att-band" data-day={d} onClick={() => useAttendanceSheet.getState().show('checkin')}>+ Check in</button>;
          return <span key={d} className="att-band att-none" />;
        }
        const m = modeOf(rec.mode);
        return (
          <button key={d} type="button" className={`att-band m-${rec.mode}${open?.o.day === d ? ' open' : ''}`} data-testid="att-band" data-day={d} style={{ ['--att-tint' as string]: TINT[rec.mode] }}
            onClick={(e) => { const el = e.currentTarget; setOpen((o) => (o?.o.day === d ? null : { o: { kind: 'mine', day: d, rec }, el })); }}
            title={`${m.label}${rec.place ? ` · ${rec.place}` : ''}`}>
            <span aria-hidden="true">{m.emoji}</span><b>{m.short}</b><span className="att-t">{rec.checkInLocal}{rec.checkOutLocal ? `–${rec.checkOutLocal}` : ' →'}</span>
          </button>
        );
      })}
      {open && <AttendanceCard open={open.o} anchor={open.el} today={orgToday} onClose={() => setOpen(null)} />}
    </div>
  );
}

/** The card for one day: anchored beside the band on a desktop (the calendar's card), a bottom sheet on a phone. */
function AttendanceCard({ open, anchor, today, onClose }: { open: Open; anchor: HTMLElement | null; today: string; onClose: () => void }) {
  const phone = useIsMobile();
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    if (phone || !anchor || !ref.current) return;
    const a = anchor.getBoundingClientRect(), w = ref.current.offsetWidth, h = ref.current.offsetHeight;
    const left = Math.min(Math.max(12, a.left), window.innerWidth - w - 12);
    const below = a.bottom + 8;
    setPos({ left, top: below + h <= window.innerHeight - 12 ? below : Math.max(12, a.top - h - 8) });
  }, [anchor, phone, open]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); } };
    const down = (e: PointerEvent) => { const t = e.target as Node; if (ref.current?.contains(t) || anchor?.contains(t)) return; onClose(); };
    document.addEventListener('keydown', key, true);
    if (!phone) document.addEventListener('pointerdown', down, true);
    ref.current?.focus({ preventScroll: true });
    return () => { document.removeEventListener('keydown', key, true); document.removeEventListener('pointerdown', down, true); };
  }, [anchor, onClose, phone]);

  const tint = open.kind === 'mine' && open.rec ? TINT[open.rec.mode] : '#5856d6';
  const card = (
    <div ref={ref} role="dialog" aria-label="Attendance" tabIndex={-1} data-testid="att-card" className={`ed${phone ? ' ed-sheet' : ' ed-pop'}`}
      style={{ ['--ed-tint' as string]: tint, ...(phone ? {} : { left: pos?.left ?? -9999, top: pos?.top ?? 0, visibility: pos ? undefined : 'hidden' }) }}>
      {phone && <div className="ed-grab" aria-hidden="true" />}
      <button type="button" className="ed-x" aria-label="Close" onClick={onClose}><Icon name="close" size={14} /></button>
      {open.kind === 'mine' && open.rec ? <MineBody rec={open.rec} today={today} onClose={onClose} /> : open.kind === 'team' ? <TeamBody day={open.day} recs={open.recs} /> : null}
    </div>
  );
  return createPortal(phone ? <div className="ed-scrim" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>{card}</div> : card, document.body);
}

function Head({ emoji, kind, title, when, why }: { emoji: string; kind: string; title: string; when: ReactNode; why?: ReactNode }) {
  return (
    <header className="ed-hd">
      <div className="ed-kind"><span className="ed-ico" aria-hidden="true">{emoji}</span>{kind}</div>
      <h2 className="ed-title">{title}</h2>
      <p className="ed-when">{when}</p>
      {why && <p className="ed-why"><span className="wp-orb sm" aria-hidden="true" /><span>{why}</span></p>}
    </header>
  );
}

function MineBody({ rec, today, onClose }: { rec: AttendanceDay; today: string; onClose: () => void }) {
  const wid = useWorkspaceId();
  const policy = useAttendanceToday().data?.policy;
  const m = modeOf(rec.mode);
  const editable = rec.date === today;
  const [edit, setEdit] = useState(false);
  const [mode, setMode] = useState<AttendanceMode>(rec.mode);
  const [place, setPlace] = useState(rec.place ?? '');
  const [note, setNote] = useState(rec.note ?? '');
  const [inn, setIn] = useState(rec.checkInLocal);
  const [out, setOut] = useState(rec.checkOutLocal ?? '');
  const [busy, setBusy] = useState(false);
  const why = rec.autoClosed ? <>Closed automatically at <b>{rec.checkOutLocal}</b> — you didn’t check out.</>
    : !rec.checkOutAt ? <>Checked in from {rec.source === 'phone' ? 'your phone' : rec.source === 'desktop' ? 'the desktop app' : 'the web'} at <b>{rec.checkInLocal}</b>; still in.</>
      : <>Checked in from {rec.source === 'phone' ? 'your phone' : rec.source === 'desktop' ? 'the desktop app' : 'the web'}.</>;
  const save = async () => {
    setBusy(true);
    try {
      await attendanceApi.correct(rec.date, { mode, place: mode === 'ClientSite' ? place : null, note, checkIn: inn, checkOut: rec.checkOutAt || out ? out : undefined });
      toast('Attendance updated.');
      void invalidateWorkspace(wid, 'attendance');
      onClose();
    } catch (e) { toast(e instanceof ApiError ? e.errors[0]?.message ?? e.message : 'Could not save.', 'error'); }
    finally { setBusy(false); }
  };
  return (
    <>
      <Head emoji={m.emoji} kind="Attendance" title={`${m.label}${rec.place ? ` · ${rec.place}` : ''}`}
        when={<>{dayName(rec.date)} · {rec.checkInLocal}{rec.checkOutLocal ? ` – ${rec.checkOutLocal}` : ' – now'} · {hm(rec.minutes)}</>} why={why} />
      {!edit ? (
        <>
          <div className="ed-rows">
            {rec.place && <div className="ed-row"><span>Place</span><div>{rec.place}</div></div>}
            <div className="ed-row"><span>Note</span><div>{rec.note ?? <span className="ed-faint">No note</span>}</div></div>
          </div>
          <div className="ed-acts">
            {editable ? (
              <div className="ed-main-acts">
                <button type="button" className="ed-btn primary" onClick={() => setEdit(true)}><Icon name="edit" size={13} />Correct</button>
                {!rec.checkOutAt && <button type="button" className="ed-btn" onClick={() => { onClose(); useAttendanceSheet.getState().show('checkout'); }}>Check out</button>}
              </div>
            ) : <p className="ed-foot">Only today’s day can be changed here — ask your manager to correct an earlier day.</p>}
          </div>
        </>
      ) : (
        <form className="ed-pick" onSubmit={(e) => { e.preventDefault(); void save(); }} data-testid="att-edit">
          <div className="att-where">Where
            <span className="att-seg" role="radiogroup" aria-label="Where">
              {MODES.filter((x) => (policy?.allowedModes ?? MODES.map((y) => y.id)).includes(x.id)).map((x) => (
                <button key={x.id} type="button" role="radio" aria-checked={mode === x.id} className={mode === x.id ? 'on' : ''} onClick={() => setMode(x.id)}>{x.emoji} {x.short}</button>
              ))}
            </span>
          </div>
          {mode === 'ClientSite' && <label className="wide">Client or place<input className="ed-sel" value={place} maxLength={120} onChange={(e) => setPlace(e.target.value)} /></label>}
          <label>Checked in<input className="ed-sel" type="time" value={inn} onChange={(e) => setIn(e.target.value)} /></label>
          <label>Checked out<input className="ed-sel" type="time" value={out} onChange={(e) => setOut(e.target.value)} /></label>
          <label className="wide">Note<input className="ed-sel" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} /></label>
          <div className="ed-pick-act">
            <button type="button" className="ed-btn ghost" onClick={() => setEdit(false)}>Cancel</button>
            <button type="submit" className="ed-btn primary" disabled={busy}>Save</button>
          </div>
        </form>
      )}
    </>
  );
}

function TeamBody({ day, recs }: { day: string; recs: AttendanceDay[] }) {
  return (
    <>
      <Head emoji="👥" kind="Team attendance" title={dayName(day)} when={MODES.map((m) => `${m.emoji} ${recs.filter((r) => r.mode === m.id).length}`).join('  ·  ')} />
      <ul className="ed-entries" data-testid="att-team-list">
        {recs.map((r) => {
          const m = modeOf(r.mode);
          return (
            <li key={r.id}><div className="att-person">
              <Face userId={r.userId} name={r.userName} className="ed-av" />
              <span className="ed-ent-t">{r.userName}<small>{m.emoji} {m.label}{r.place ? ` · ${r.place}` : ''}</small></span>
              <span className="ed-ent-m">{r.checkInLocal}<small>{r.checkOutLocal ? `out ${r.checkOutLocal}` : 'in'}</small></span>
            </div></li>
          );
        })}
      </ul>
    </>
  );
}
