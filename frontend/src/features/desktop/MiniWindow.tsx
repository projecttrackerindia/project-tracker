import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { workItemApi } from '../../api/endpoints.planning';
import { attendanceApi, sourceOfDevice } from '../attendance/attendanceApi';
import { meetApi, type MeetItem } from '../meet/meetApi';
import { reminderApi } from '../reminders/api';
import { useAuth } from '../../stores/auth';
import { orgHref } from '../../lib/orgPath';
import './mini.css';

type Bridge = { openMain?: (link: string) => void; hideMini?: () => void };
const bridge = () => (window as unknown as { ptDesktop?: Bridge }).ptDesktop;
/** Opens a page in the main window (the desktop app), or in this tab elsewhere. */
const openMain = (link: string) => { const b = bridge(); if (b?.openMain) b.openMain(link); else window.location.assign(orgHref(link)); };

const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const hm = (mins: number) => `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
const inMinutes = (iso: string) => Math.round((Date.parse(iso) - Date.now()) / 60000);

/**
 * The tray / menu-bar mini window of the desktop app (and the shape of the phone widgets): the check-in ring with In / Out, the next meeting
 * with Join, today's work, and one field to add a reminder or ask Aura. Opened from the tray icon or Ctrl/Cmd+Shift+Space.
 */
export default function MiniWindow() {
  const signedIn = useAuth((s) => !!s.ctx?.current?.id);
  const qc = useQueryClient();
  const [, tick] = useState(0);
  useEffect(() => { const t = window.setInterval(() => tick((x) => x + 1), 30_000); return () => window.clearInterval(t); }, []);
  const today = todayIso();
  const work = useQuery({ queryKey: ['mini', 'work', today], enabled: signedIn, queryFn: () => workItemApi.mine({ open: true, dueTo: today, limit: 6 }) });
  const att = useQuery({ queryKey: ['mini', 'attendance'], enabled: signedIn, queryFn: () => attendanceApi.today(), retry: false });
  const meet = useQuery({ queryKey: ['mini', 'meet', today], enabled: signedIn, queryFn: () => meetApi.feed({ from: new Date(Date.now() - 15 * 60000).toISOString(), to: new Date(Date.now() + 12 * 3600000).toISOString() }) });
  const next: MeetItem | undefined = useMemo(() => meet.data?.items.filter((m) => Date.parse(m.end) > Date.now() && m.myRsvp !== 'Declined').sort((a, b) => a.start.localeCompare(b.start))[0], [meet.data]);
  const [text, setText] = useState('');
  const [saved, setSaved] = useState(false);

  if (!signedIn) return <main className="mini mini-empty"><p>Sign in in the main window.</p><button type="button" className="mini-pill go" onClick={() => openMain('/login')}>Open ProjectTracker</button></main>;

  const rec = att.data?.record;
  const checkedIn = !!rec && !rec.checkOutAt;
  const minutes = rec ? (rec.checkOutAt ? rec.minutes : Math.max(0, Math.round((Date.now() - Date.parse(rec.checkInAt)) / 60000))) : 0;
  const goal = 8 * 60;
  const ring = Math.min(1, minutes / goal);
  const toggle = async () => {
    try {
      if (checkedIn) await attendanceApi.checkOut({});
      else await attendanceApi.checkIn({ mode: att.data?.policy.allowedModes[0] ?? 'Office', source: sourceOfDevice() === 'web' ? 'desktop' : sourceOfDevice() });
    } finally { void qc.invalidateQueries({ queryKey: ['mini', 'attendance'] }); }
  };
  const add = async (e: FormEvent) => {
    e.preventDefault();
    const t = text.trim(); if (!t) return;
    setText(''); setSaved(true); window.setTimeout(() => setSaved(false), 1600);
    try { await reminderApi.create({ title: t, when: { free: true } }); } catch { setText(t); setSaved(false); }
  };
  const starts = next ? inMinutes(next.start) : 0;

  return (
    <main className="mini" data-testid="mini">
      {att.data?.policy.enabled !== false && (
        <section className="mini-check" aria-label="Check-in">
          <span className="mini-ring" style={{ ['--p' as string]: `${ring * 100}%` }} aria-hidden="true" />
          <div className="mini-grow">
            <b>{checkedIn ? `Checked in · ${hm(minutes)}` : rec ? `Out · ${hm(minutes)} today` : 'Not checked in'}</b>
            <span>{rec ? `since ${rec.checkInLocal}` : att.data?.workStart ? `Day starts ${att.data.workStart}` : ' '}</span>
          </div>
          <button type="button" className={`mini-pill${checkedIn ? '' : ' go'}`} onClick={() => void toggle()} disabled={!att.data}>{checkedIn ? 'Out' : 'In'}</button>
        </section>
      )}

      {next && (
        <section className="mini-meet" aria-label="Next meeting">
          <div className="mini-grow">
            <b>{next.title}</b>
            <span>{starts <= 0 ? 'Now' : starts < 60 ? `in ${starts} min` : new Date(next.start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
          </div>
          <button type="button" className="mini-pill go" onClick={() => { if (/^https?:/.test(next.joinUrl)) window.open(next.joinUrl, '_blank', 'noopener'); else openMain(next.joinUrl); }}>Join</button>
        </section>
      )}

      <h2 className="mini-h">Today{work.data ? ` · ${work.data.length}` : ''}</h2>
      <ul className="mini-list">
        {(work.data ?? []).map((w) => (
          <li key={w.id}><button type="button" onClick={() => openMain(w.projectId ? `/projects/${w.projectId}?task=${w.id}` : '/my-work')}>
            <span className={`mini-ck${w.isOverdue ? ' late' : ''}`} aria-hidden="true" /><span className="mini-t">{w.title}</span>
          </button></li>
        ))}
        {work.data && work.data.length === 0 && <li className="mini-none">Nothing due today.</li>}
      </ul>

      <form className="mini-add" onSubmit={(e) => void add(e)}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Remind me… or ask Aura" aria-label="Quick add" maxLength={200} autoFocus />
        {saved ? <span className="mini-saved" role="status">✓ Saved</span>
          : <button type="button" className="mini-pill" disabled={!text.trim()} onClick={() => { const t = text.trim(); if (t) openMain(`/?tab=assistant&q=${encodeURIComponent(t)}`); }}>Ask Aura</button>}
      </form>
    </main>
  );
}
