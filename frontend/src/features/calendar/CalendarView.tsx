import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { insightApi } from '../../api/endpoints';
import type { CalendarEvent } from '../../api/types';
import { Icon } from '../../components/Icon';
import { EmptyState } from '../../components/ui';
import { DOW, MONTHS_FULL, formatDate, toISODate, todayISO } from '../../lib/format';
import { type SelectMode, activeDates as datesOf, dayClasses, monthCells, nextSelection, previewDates } from '../../lib/calendar';
import { useWsQuery } from '../../lib/hooks';
import { Sheet } from '../../components/Sheet';
import { haptic, useIsMobile } from '../../lib/mobile';

const cls = (e: CalendarEvent) =>
  e.type === 'project' || e.type === 'milestone' ? 'purple' : e.type === 'stage' ? 'amber' : e.category === 'Done' ? 'green' : e.overdue ? 'red' : e.type === 'action' ? 'cyan' : e.type === 'work' ? 'orange' : 'blue';
const TYPE_LABEL: Record<CalendarEvent['type'], string> = { task: 'Task', action: 'Action item', work: 'Operational', project: 'Deadline', milestone: 'Milestone', stage: 'Stage' };
const PREFIX: Partial<Record<CalendarEvent['type'], string>> = { project: '⚑ ', milestone: '⚑ ', stage: '◆ ', action: '✓ ', work: '⚡ ' };

/** Month calendar of task, action item and operational work deadlines, project deadlines and lifecycle stage ends. Days can be picked one at a time,
 *  as a range (click a start then an end), or as a scattered multi-select — whichever the "Dates" mode is set to. */
export function CalendarView({ projectId, mine, userId, onOpenTask, onOpenWork }: { projectId?: string; mine?: boolean; userId?: string; onOpenTask: (taskId: string, projectId: string | null) => void; onOpenWork?: (workTaskId: string) => void }) {
  const nav = useNavigate();
  const phone = useIsMobile();
  const [daySheet, setDaySheet] = useState<string | null>(null);   // on a phone a tapped day opens its list in a sheet
  const now = new Date();
  const [month, setMonth] = useState(now.getMonth());
  const [year, setYear] = useState(now.getFullYear());
  const [mode, setMode] = useState<SelectMode>('single');
  const [selected, setSelected] = useState<string[]>([todayISO()]);
  const [rangeAnchor, setRangeAnchor] = useState<string | null>(null);
  // The day the pointer (or keyboard focus) is on: it lights up before it is clicked, and once a range is started the days up to it are previewed.
  const [hover, setHover] = useState<string | null>(null);
  const [show, setShow] = useState({ task: true, action: true, work: true, project: true, stage: true, milestone: true });

  const cells = useMemo(() => monthCells(year, month), [month, year]);

  const from = toISODate(cells[0].date);
  const to = toISODate(cells[cells.length - 1].date);
  const q = useWsQuery(['calendar', from, to, projectId, mine, userId], () => insightApi.calendar(from, to, projectId, mine, userId), { placeholderData: (p) => p });

  const byDate = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    (q.data ?? []).filter((e) => show[e.type]).forEach((e) => map.set(e.date, [...(map.get(e.date) ?? []), e]));
    return map;
  }, [q.data, show]);

  const shift = (delta: number) => {
    const d = new Date(year, month + delta, 1);
    setMonth(d.getMonth()); setYear(d.getFullYear());
  };
  const today = todayISO();

  // The active set of picked dates, whichever mode built it — range fills in every day between the two clicks.
  const activeDates = useMemo(() => datesOf(mode, [...selected].sort()), [mode, selected]);
  const preview = useMemo(() => previewDates(mode, rangeAnchor, hover), [mode, rangeAnchor, hover]);

  const selectedEvents = useMemo(() => [...activeDates].sort().flatMap((d) => byDate.get(d) ?? []), [activeDates, byDate]);

  const pickDate = (iso: string) => {
    const next = nextSelection(mode, selected, rangeAnchor, iso);
    setSelected(next.selected); setRangeAnchor(next.anchor);
  };
  const changeMode = (m: SelectMode) => { setMode(m); setRangeAnchor(null); setSelected(m === 'single' ? [today] : []); };

  const open = (e: CalendarEvent) => {
    if (e.type === 'task') onOpenTask(e.id, e.projectId);
    else if (e.type === 'action' && e.projectId) nav(`/projects/${e.projectId}?tab=actions&action=${e.id}`);
    else if (e.type === 'work') { if (onOpenWork) onOpenWork(e.id); else nav(`/operations?task=${e.id}`); }
    else if (e.projectId && e.projectId !== projectId) nav(`/projects/${e.projectId}`);
  };

  return (
    <>
      <div className="card mb-22">
        <div className="card-head">
          <div className="row" style={{ gap: 12 }}>
            <button className="btn-icon" onClick={() => shift(-1)} aria-label="Previous month"><Icon name="chevronL" /></button>
            <h3 style={{ minWidth: 170, textAlign: 'center' }}>{MONTHS_FULL[month]} {year}</h3>
            <button className="btn-icon" onClick={() => shift(1)} aria-label="Next month"><Icon name="chevronR" /></button>
            <button className="btn btn-ghost btn-sm" onClick={() => { setMonth(now.getMonth()); setYear(now.getFullYear()); changeMode('single'); }}>Today</button>
          </div>
          <div className="row" style={{ gap: 14, flexWrap: 'wrap' }}>
            <div className="seg" role="group" aria-label="Date selection mode">
              {([['single', 'calendar', 'Date'], ['range', 'arrowRight', 'Range'], ['multiple', 'grid', 'Dates']] as const).map(([m, icon, label]) => (
                <button key={m} type="button" className={mode === m ? 'active' : ''} aria-pressed={mode === m} title={label} onClick={() => changeMode(m)}><Icon name={icon} size={14} /><span>{label}</span></button>
              ))}
            </div>
            <div className="legend">
              {([['task', 'var(--primary)', 'Tasks'], ['action', '#0ea5e9', 'Action items'], ['work', '#f97316', 'Operational work'], ['project', 'var(--purple)', 'Project deadlines'], ['stage', 'var(--warning)', 'Stage ends'], ['milestone', 'var(--purple)', 'Milestones']] as const).map(([k, c, label]) => (
                <label key={k} style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
                  <input type="checkbox" checked={show[k]} onChange={(e) => setShow((s) => ({ ...s, [k]: e.target.checked }))} /><i style={{ background: c }} />{label}
                </label>
              ))}
              <span><i style={{ background: 'var(--danger)' }} />Overdue</span><span><i style={{ background: 'var(--success)' }} />Completed</span>
            </div>
          </div>
        </div>
        <div className="card-body tight">
          <div className="cal-grid" onMouseLeave={() => setHover(null)}>
            {DOW.map((d) => <div className="cal-dow" key={d}>{d}</div>)}
            {cells.map(({ date, other }) => {
              const iso = toISODate(date);
              const events = byDate.get(iso) ?? [];
              const isSelected = activeDates.has(iso);
              const state = dayClasses(iso, { active: activeDates, preview, hover, anchor: rangeAnchor });
              return (
                <button key={iso} type="button" className={`cal-day ${other ? 'other' : ''} ${iso === today ? 'today' : ''} ${state}`} onClick={() => { pickDate(iso); if (phone) { haptic(6); setDaySheet(iso); } }} onMouseEnter={() => setHover(iso)} onFocus={() => setHover(iso)} onBlur={() => setHover(null)} aria-pressed={isSelected} aria-label={`${formatDate(iso)}, ${events.length} events`}>
                  <div className="cal-num">{date.getDate()}</div>
                  <div className="cal-events">
                    {events.slice(0, 3).map((e) => <div key={e.type + e.id} className={`cal-ev ${cls(e)}`} title={`${TYPE_LABEL[e.type]}: ${e.title}`}>{PREFIX[e.type] ?? ''}{e.title}</div>)}
                    {events.length > 3 && <div className="cal-more">+{events.length - 3} more</div>}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {activeDates.size > 0 && (
        <div className="card">
          <div className="card-head">
            <div>
              <h3>{mode === 'single' ? formatDate([...activeDates][0]) : `${[...activeDates].sort()[0] ? formatDate([...activeDates].sort()[0]) : ''}${activeDates.size > 1 ? ` – ${formatDate([...activeDates].sort().at(-1))}` : ''}`}</h3>
              <p>{selectedEvents.length} item{selectedEvents.length === 1 ? '' : 's'} scheduled{mode !== 'single' && activeDates.size > 1 ? ` across ${activeDates.size} days` : ''}</p>
            </div>
            {mode !== 'single' && <button className="btn btn-ghost btn-sm" onClick={() => { setSelected([]); setRangeAnchor(null); }}><Icon name="close" /> Clear</button>}
          </div>
          <div className="card-body">
            {selectedEvents.length === 0 ? <p className="muted" style={{ fontSize: 13 }}>Nothing scheduled for {mode === 'single' ? 'this date' : 'these dates'}.</p> : (
              <div className="member-list">
                {selectedEvents.map((e) => (
                  <button key={`${e.date}:${e.type}:${e.id}`} className="member-item" style={{ textAlign: 'left' }} onClick={() => open(e)}>
                    <span className={`cal-ev ${cls(e)}`} style={{ flexShrink: 0 }}>{TYPE_LABEL[e.type]}</span>
                    <span className="member-main"><span className="member-name">{e.title}</span><span className="member-role">{mode !== 'single' ? `${formatDate(e.date)} · ` : ''}{e.projectName ?? ''}{e.status ? ` · ${e.status}` : ''}{e.overdue ? ' · overdue' : ''}</span></span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
      {q.data && q.data.length === 0 && activeDates.size === 0 && <EmptyState icon="calendar" title="Nothing scheduled" text="Tasks, action items and operational work with due dates appear here." />}
      {daySheet && (
        <Sheet title={formatDate(daySheet)} onClose={() => setDaySheet(null)}>
          {(byDate.get(daySheet) ?? []).length === 0 ? <div className="m-empty"><Icon name="calendar" size={26} /><b>Nothing scheduled</b><span>No deadlines on this day.</span></div> : (
            <ul className="m-list">
              {(byDate.get(daySheet) ?? []).map((e) => (
                <li key={`${e.type}:${e.id}`}><button type="button" className="m-row" onClick={() => { setDaySheet(null); open(e); }}>
                  <span className={`m-dot-lg ${cls(e)}`} />
                  <span className="m-row-main"><b>{e.title}</b><small>{TYPE_LABEL[e.type]}{e.projectName ? ` · ${e.projectName}` : ''}</small></span>
                  <Icon name="chevronR" size={16} />
                </button></li>
              ))}
            </ul>
          )}
        </Sheet>
      )}
    </>
  );
}
