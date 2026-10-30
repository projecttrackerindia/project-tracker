import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { SheetRow } from './portfolioApi';
import { ago, dm } from './planSheet';
import { Floating } from './planSheetParts';

const longDay = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

/**
 * A due date that is on the calendar (design plansheet7/04): the date with a small calendar glyph; hovering shows "On calendar · Thu 30 Oct · owner",
 * Open in Calendar, and whether the person's calendar feed has picked it up (Synced, when it last read the feed).
 */
export function CalendarDate({ r, calendar, late }: { r: SheetRow; calendar: { feed: boolean; syncedAt: string | null }; late?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const timer = useRef<number | null>(null);
  if (!r.due) return null;
  const show = () => { if (timer.current) clearTimeout(timer.current); timer.current = window.setTimeout(() => setOpen(true), 250); };
  const hide = () => { if (timer.current) clearTimeout(timer.current); timer.current = window.setTimeout(() => setOpen(false), 200); };
  return (
    <span ref={ref} className={`ps4-cal ${open ? 'hov' : ''}`} style={late ? { color: 'var(--p-red)' } : undefined} onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide} tabIndex={-1}>
      {dm(r.due)}<i className="cg" aria-label="On calendar" />
      {open && (
        <Floating anchor={ref.current} onClose={() => setOpen(false)} width={300} label="On calendar" style={{ padding: '14px 16px' }}>
          <div onMouseEnter={show} onMouseLeave={hide}>
            <div className="ps3-dim" style={{ fontSize: 11.5 }}>On calendar · {longDay(r.due)}{r.dueTime ? ` · ${r.dueTime}` : ''}{r.owner ? ` · ${r.owner}` : ''}</div>
            <div style={{ fontWeight: 600, margin: '4px 0 10px' }}><span className="ps3-key">{r.key}</span>{r.title}</div>
            <Link className="ps3-qc pri" to={`/?tab=calendar&date=${r.due}`} onClick={(e) => e.stopPropagation()}>Open in Calendar</Link>
            <div className="ps4-sync"><span className={`dot ${calendar.feed ? 'on' : ''}`} aria-hidden="true" />
              {calendar.feed ? <>Synced{calendar.syncedAt ? ` · ${ago(calendar.syncedAt).toLowerCase()}` : ''} · your calendar feed</> : <>In the app’s calendar · connect a calendar feed to sync it</>}</div>
          </div>
        </Floating>
      )}
    </span>
  );
}
