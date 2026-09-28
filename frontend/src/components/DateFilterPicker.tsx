import { useEffect, useMemo, useRef, useState } from 'react';
import { DOW, MONTHS_FULL, formatDate, formatDateShort, toISODate, todayISO } from '../lib/format';
import { type SelectMode, activeDates, dayClasses, monthCells, nextSelection, previewDates } from '../lib/calendar';
import { Icon } from './Icon';

interface Props {
  mode: SelectMode;
  single: string; onSingle: (iso: string) => void;
  range: { from: string; to: string }; onRange: (r: { from: string; to: string }) => void;
  multi: string[]; onMulti: (dates: string[]) => void;
}

/**
 * The date filter of a page as a button that opens a month calendar: one day, a start-to-end range, or several separate days.
 * Days light up when the pointer is on them (and, once a range has been started, the whole range up to the pointer is previewed),
 * as well as after a click.
 */
export function DateFilterPicker({ mode, single, onSingle, range, onRange, multi, onMulti }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState(() => { const d = new Date(); return { year: d.getFullYear(), month: d.getMonth() }; });
  const [anchor, setAnchor] = useState<string | null>(null);   // a range that has been started and is waiting for its end
  const [hover, setHover] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown); document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  const shown = mode === 'single' ? [single] : mode === 'range' ? [range.from, range.to] : multi;
  const active = useMemo(() => {
    if (mode === 'range' && anchor) return new Set([anchor]);
    return mode === 'range' ? activeDates('range', [range.from, range.to]) : new Set(mode === 'single' ? [single] : multi);
  }, [mode, anchor, range, single, multi]);
  const preview = useMemo(() => previewDates(mode, anchor, hover), [mode, anchor, hover]);
  const cells = useMemo(() => monthCells(view.year, view.month), [view]);
  const today = todayISO();

  const toggle = () => {
    if (!open) { const d = new Date((shown[0] ?? today) + 'T00:00:00'); setView({ year: d.getFullYear(), month: d.getMonth() }); setAnchor(null); setHover(null); }
    setOpen((o) => !o);
  };
  const shift = (delta: number) => { const d = new Date(view.year, view.month + delta, 1); setView({ year: d.getFullYear(), month: d.getMonth() }); };

  const pick = (iso: string) => {
    if (mode === 'single') { onSingle(iso); setOpen(false); return; }
    if (mode === 'multiple') { onMulti(nextSelection('multiple', multi, null, iso).selected.sort()); return; }
    const next = nextSelection('range', [], anchor, iso);
    if (next.anchor) { setAnchor(next.anchor); return; }
    const [from, to] = next.selected;
    setAnchor(null); onRange({ from, to }); setOpen(false);
  };

  const summary = mode === 'single' ? formatDate(single)
    : mode === 'range' ? (range.from === range.to ? formatDate(range.from) : `${formatDateShort(range.from)} – ${formatDateShort(range.to)}`)
    : multi.length === 0 ? 'Pick dates' : `${multi.length} date${multi.length === 1 ? '' : 's'}`;

  return (
    <div className="dp" ref={ref}>
      <button type="button" className="input dp-trigger" aria-haspopup="dialog" aria-expanded={open} onClick={toggle} aria-label={mode === 'single' ? 'Date' : mode === 'range' ? 'Date range' : 'Dates'}>
        <Icon name="calendar" size={15} /><span>{summary}</span>
      </button>
      {open && (
        <div className="dp-panel" role="dialog" aria-label="Choose dates">
          <div className="dp-head">
            <button type="button" className="btn-icon" aria-label="Previous month" onClick={() => shift(-1)}><Icon name="chevronL" size={16} /></button>
            <b>{MONTHS_FULL[view.month]} {view.year}</b>
            <button type="button" className="btn-icon" aria-label="Next month" onClick={() => shift(1)}><Icon name="chevronR" size={16} /></button>
          </div>
          <div className="dp-grid" onMouseLeave={() => setHover(null)}>
            {DOW.map((d) => <div className="dp-dow" key={d}>{d.slice(0, 2)}</div>)}
            {cells.map(({ date, other }) => {
              const iso = toISODate(date);
              const state = dayClasses(iso, { active, preview, hover, anchor });
              return (
                <button key={iso} type="button" className={`dp-day ${other ? 'other' : ''} ${iso === today ? 'today' : ''} ${state}`} aria-pressed={active.has(iso)}
                  aria-label={formatDate(iso)} onClick={() => pick(iso)} onMouseEnter={() => setHover(iso)} onFocus={() => setHover(iso)} onBlur={() => setHover(null)}>
                  {date.getDate()}
                </button>
              );
            })}
          </div>
          <div className="dp-foot">
            <span className="muted">{mode === 'single' ? 'Pick a day' : mode === 'range' ? (anchor ? 'Now pick the last day' : 'Pick the first day, then the last') : 'Pick as many days as you like'}</span>
            {mode === 'single' && <button type="button" className="btn btn-ghost btn-sm" onClick={() => { onSingle(today); setOpen(false); }}>Today</button>}
            {mode === 'multiple' && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(false)}>Done</button>}
          </div>
        </div>
      )}
    </div>
  );
}
