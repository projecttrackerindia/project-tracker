import type { CSSProperties, ReactNode } from 'react';
import './calm-split.css';

export type CalmSeg = { key: string; start: number; end: number; label?: string; color: string; past?: boolean; onClick?: () => void; title?: string };

/**
 * The day ribbon (today2.html): the working hours as one rounded track, each meeting, focus block or logged span a pastel segment
 * (past ones faded), the red now line, and the hours beneath. `head` is the line above ("Design review in 8 min" · Join · Full day ›).
 * Positions are percentages, so the ribbon is fluid at every width; on a phone only every other hour is labelled.
 */
export function CalmDayRibbon({ segs, from = 9, to = 18, now, head, aside, label = 'Your day' }: {
  segs: CalmSeg[]; from?: number; to?: number; now?: number | null; head?: ReactNode; aside?: ReactNode; label?: string;
}) {
  const span = Math.max(1, to - from);
  const pos = (h: number) => `${((Math.max(from, Math.min(to, h)) - from) / span) * 100}%`;
  const hours = Array.from({ length: Math.floor(span) + 1 }, (_, i) => from + i);
  return (
    <section className="calm-day" aria-label={label}>
      {(head || aside) && <div className="calm-day-h"><span>{head}</span>{aside && <span className="calm-day-a">{aside}</span>}</div>}
      <div className="calm-day-track">
        {segs.filter((s) => s.end > from && s.start < to).map((s) => {
          const style = { left: pos(s.start), width: `calc(${pos(s.end)} - ${pos(s.start)} - 3px)`, '--seg': s.color } as CSSProperties;
          const body = <span className="calm-day-seg-l">{s.label}</span>;
          return s.onClick
            ? <button key={s.key} type="button" className={`calm-day-seg${s.past ? ' past' : ''}`} style={style} onClick={s.onClick} title={s.title ?? s.label}>{body}</button>
            : <span key={s.key} className={`calm-day-seg${s.past ? ' past' : ''}`} style={style} title={s.title ?? s.label}>{body}</span>;
        })}
        {now != null && now >= from && now <= to && <i className="calm-day-now" style={{ left: pos(now) }} aria-label="Now" />}
      </div>
      <div className="calm-day-hrs" aria-hidden="true">
        {hours.map((h, i) => <span key={h} className={i % 2 ? 'odd' : ''} style={{ left: pos(h) }}>{`${Math.floor(h)}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`}</span>)}
      </div>
    </section>
  );
}

export type CalmWeekDay = { day: string; label: string; num: number; today?: boolean; dots: string[]; onClick?: () => void };

/** The This week strip: five day tiles, today filled in the accent, a dot per thing due or meeting (in its colour). */
export function CalmWeek({ days, note }: { days: CalmWeekDay[]; note?: ReactNode }) {
  return (
    <div className="calm-week">
      <div className="calm-week-days">
        {days.map((d) => (
          <button key={d.day} type="button" className={`calm-week-d${d.today ? ' on' : ''}`} onClick={d.onClick} aria-label={`${d.label} ${d.num}: ${d.dots.length} item${d.dots.length === 1 ? '' : 's'}`}>
            <small>{d.label}</small><b>{d.num}</b>
            <span className="calm-week-dots">{d.dots.slice(0, 3).map((c, i) => <i key={i} style={{ background: c }} />)}</span>
          </button>
        ))}
      </div>
      {note && <p className="calm-week-note">{note}</p>}
    </div>
  );
}
