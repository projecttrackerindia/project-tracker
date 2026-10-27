import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { insightApi } from '../../api/endpoints';
import type { CalendarEvent } from '../../api/types';
import { Icon } from '../../components/Icon';
import { EmptyState } from '../../components/ui';
import { DOW, MONTHS_FULL, formatDate, formatTime, toISODate, todayISO } from '../../lib/format';
import { type SelectMode, activeDates as datesOf, dayClasses, monthCells, nextSelection, previewDates } from '../../lib/calendar';
import { useWsQuery } from '../../lib/hooks';
import { Sheet } from '../../components/Sheet';
import { haptic, useIsMobile } from '../../lib/mobile';
import './calendar.css';

const cls = (e: CalendarEvent) =>
  e.type === 'project' || e.type === 'milestone' ? 'purple' : e.type === 'stage' ? 'amber' : e.type === 'meeting' ? 'teal' : e.category === 'Done' ? 'green' : e.overdue ? 'red' : e.type === 'action' ? 'cyan' : e.type === 'work' ? 'orange' : 'blue';
const TYPE_LABEL: Record<CalendarEvent['type'], string> = { task: 'Task', action: 'Action item', work: 'Operational', project: 'Deadline', milestone: 'Milestone', stage: 'Stage', meeting: 'Meeting' };
const PREFIX: Partial<Record<CalendarEvent['type'], string>> = { project: '⚑ ', milestone: '⚑ ', stage: '◆ ', action: '✓ ', work: '⚡ ', meeting: '☉ ' };

/** Month calendar of task, action item and operational work deadlines, project deadlines and lifecycle stage ends. Days can be picked one at a time,
 *  as a range (click a start then an end), or as a scattered multi-select — whichever the "Dates" mode is set to. */
export function CalendarView({ projectId, mine, userId, onOpenTask, onOpenWork }: { projectId?: string; mine?: boolean; userId?: string; onOpenTask: (taskId: string, projectId: string | null) => void; onOpenWork?: (workTaskId: string) => void }) {
  const nav = useNavigate();
  const phone = useIsMobile();
  // Meetings are shown here and open in Meet, the one place they are kept (an older link, /calendar?meeting=…, goes there too).
  const [params] = useSearchParams();
  const meetingParam = params.get('meeting');
  useEffect(() => { if (meetingParam) nav(`/meet?open=w:${meetingParam}`, { replace: true }); }, [meetingParam, nav]);
  const [daySheet, setDaySheet] = useState<string | null>(null);   // on a phone a tapped day opens its list in a sheet
  const now = new Date();
  const [month, setMonth] = useState(now.getMonth());
  const [year, setYear] = useState(now.getFullYear());
  const [mode, setMode] = useState<SelectMode>('single');
  const [selected, setSelected] = useState<string[]>([todayISO()]);
  const [rangeAnchor, setRangeAnchor] = useState<string | null>(null);
  // The day the pointer (or keyboard focus) is on: it lights up before it is clicked, and once a range is started the days up to it are previewed.
  const [hover, setHover] = useState<string | null>(null);
  const [show, setShow] = useState({ task: true, action: true, work: true, project: true, stage: true, milestone: true, meeting: true });

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
    else if (e.type === 'action') nav(`/work?item=${e.id}`);
    else if (e.type === 'work') { if (onOpenWork) onOpenWork(e.id); else nav(`/work?item=${e.id}`); }
    else if (e.type === 'meeting') nav(`/meet?open=${e.projectId ? 'p' : 'w'}:${e.id}${e.startsAt ? `&at=${encodeURIComponent(e.startsAt)}` : ''}`);
    else if (e.projectId && e.projectId !== projectId) nav(`/projects/${e.projectId}`);
  };

  return (
    <>
      <div className="card mb-22 cal-card">
        <div className="card-head cal-head">
          <div className="cal-month">
            <h2>{MONTHS_FULL[month]} <em>{year}</em></h2>
            <button className="btn-icon" onClick={() => shift(-1)} aria-label="Previous month"><Icon name="chevronL" /></button>
            <button className="btn-icon" onClick={() => shift(1)} aria-label="Next month"><Icon name="chevronR" /></button>
            <button className="btn btn-ghost btn-sm" onClick={() => { setMonth(now.getMonth()); setYear(now.getFullYear()); changeMode('single'); }}>Today</button>
          </div>
          <div className="cal-tools">
            <div className="seg" role="group" aria-label="Date selection mode">
              {([['single', 'Date'], ['range', 'Range'], ['multiple', 'Dates']] as const).map(([m, label]) => (
                <button key={m} type="button" className={mode === m ? 'active' : ''} aria-pressed={mode === m} title={label} onClick={() => changeMode(m)}><span>{label}</span></button>
              ))}
            </div>
            {/* Seven kinds of things: folded into one "Show" pill, so the calendar itself stays calm. */}
            <details className="cal-show">
              <summary className="btn btn-ghost btn-sm">Show · {Object.values(show).filter(Boolean).length}</summary>
              <div className="cal-show-pop">
                {([['task', 'var(--primary)', 'Tasks'], ['action', '#0ea5e9', 'Action items'], ['work', '#f97316', 'Operational work'], ['project', 'var(--purple)', 'Project deadlines'], ['stage', 'var(--warning)', 'Stage ends'], ['milestone', 'var(--purple)', 'Milestones'], ['meeting', '#0d9488', 'Meetings']] as const).map(([k, c, label]) => (
                  <label key={k}>
                    <input type="checkbox" checked={show[k]} onChange={(e) => setShow((s) => ({ ...s, [k]: e.target.checked }))} /><i style={{ background: c }} />{label}
                  </label>
                ))}
                <p><span><i style={{ background: 'var(--danger)' }} />Overdue</span><span><i style={{ background: 'var(--success)' }} />Completed</span></p>
              </div>
            </details>
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
              <div className="member-list cal-agenda">
                {selectedEvents.map((e) => (
                  <button key={`${e.date}:${e.type}:${e.id}`} className="member-item" style={{ textAlign: 'left' }} onClick={() => open(e)}>
                    <span className={`cal-ev ${cls(e)}`} style={{ flexShrink: 0 }}>{TYPE_LABEL[e.type]}</span>
                    <span className="member-main"><span className="member-name">{e.title}</span><span className="member-role">{mode !== 'single' ? `${formatDate(e.date)} · ` : ''}{e.startsAt ? `${formatTime(e.startsAt)} · ` : ''}{e.projectName ?? (e.type === 'meeting' ? 'Workspace' : '')}{e.status ? ` · ${e.status}` : ''}{e.overdue ? ' · overdue' : ''}</span></span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
      {q.data && q.data.length === 0 && activeDates.size === 0 && <EmptyState icon="calendar" title="Nothing scheduled" text="Tasks, action items, operational work and meetings with due dates appear here." />}
      {daySheet && (
        <Sheet title={formatDate(daySheet)} onClose={() => setDaySheet(null)}>
          {(byDate.get(daySheet) ?? []).length === 0 ? <div className="m-empty"><Icon name="calendar" size={26} /><b>Nothing scheduled</b><span>No deadlines on this day.</span></div> : (
            <ul className="m-list">
              {(byDate.get(daySheet) ?? []).map((e) => (
                <li key={`${e.type}:${e.id}`}><button type="button" className="m-row" onClick={() => { setDaySheet(null); open(e); }}>
                  <span className={`m-dot-lg ${cls(e)}`} />
                  <span className="m-row-main"><b>{e.title}</b><small>{TYPE_LABEL[e.type]}{e.startsAt ? ` · ${formatTime(e.startsAt)}` : ''}{e.projectName ? ` · ${e.projectName}` : ''}</small></span>
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
