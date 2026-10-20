import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { insightApi, timeApi } from '../../api/endpoints';
import type { GridCellChange, GridKind, GridRow, GridSuggestion, SearchHit, TimesheetGrid } from '../../api/types';
import { Icon } from '../../components/Icon';
import { EmptyState, ErrorState, PageLoader } from '../../components/ui';
import { formatDate, todayISO } from '../../lib/format';
import { invalidateWorkspace, useDebounced, useWsQuery } from '../../lib/hooks';
import { useIsMobile, haptic } from '../../lib/mobile';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { useAssistant } from '../ai/Assistant';
import { WeekApprovalBar, addDaysIso, mondayOf, weekLabel } from './Approvals';
import { PlannedLeavePanel } from './PlannedLeavePanel';
import { cellKey, dayName, dayNum, dayState, downloadText, gridCsv, hm, parseCell, parseQuickAdd, rowKey } from './grid';
import { clock, formatMinutes, useNow } from './time';

const REASON: Record<GridSuggestion['reason'], { label: string; icon: 'repeat' | 'user' | 'activity' | 'timer' }> = {
  lastWeek: { label: 'Last week', icon: 'repeat' },
  assigned: { label: 'Assigned to you', icon: 'user' },
  touched: { label: 'Worked on this week', icon: 'activity' },
  timer: { label: 'Timer', icon: 'timer' },
};

type Stub = Pick<GridRow, 'kind' | 'targetId' | 'key' | 'title' | 'projectId' | 'projectName'>;
const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.errors[0]?.message ?? e.message : fallback);

/**
 * The timesheet as a week: a row per task or piece of work, a column per day, each cell the total for that day. Type "1.5", "1:30" or
 * "45m"; Enter, Tab and the arrow keys move between cells and every change saves itself. Each day shows the person's normal day, planned
 * leave and meetings; suggestions add what they probably worked on; last week can be copied; a quick-add line takes "2h ATL-12 yesterday".
 */
export function WeekGrid({ week, onWeek, userId }: { week: string; onWeek: (w: string) => void; userId: string }) {
  const wid = useWorkspaceId();
  const qc = useQueryClient();
  const key = useMemo(() => ['timesheet', 'grid', week, userId], [week, userId]);
  const q = useWsQuery(key, () => timeApi.grid(week, userId || undefined));
  const mobile = useIsMobile();
  const [extra, setExtra] = useState<Stub[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const pending = useRef<Map<string, GridCellChange>>(new Map());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [focus, setFocus] = useState<{ row: string; date: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const today = todayISO();

  useEffect(() => { setExtra([]); setDrafts({}); setErrors({}); setFocus(null); pending.current.clear(); }, [week, userId]);

  const grid = q.data;
  const rows: GridRow[] = useMemo(() => {
    if (!grid) return [];
    const have = new Set(grid.rows.map(rowKey));
    const stubs = extra.filter((s) => !have.has(rowKey(s))).map((s): GridRow => ({
      ...s, billable: false, totalMinutes: 0, cells: grid.days.map((d) => ({ date: d.date, minutes: 0, entries: 0, running: false, note: null })),
    }));
    return [...grid.rows, ...stubs];
  }, [grid, extra]);

  const put = useCallback((g: TimesheetGrid) => qc.setQueryData([wid, ...key], g), [qc, wid, key]);

  // One save at a time: a second flush waits for the one in flight, so a cell is never written twice at once.
  const inflight = useRef<Promise<void>>(Promise.resolve());
  const sending = useRef<Set<string>>(new Set());
  const flush = useCallback((): Promise<void> => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    const run = inflight.current.then(() => saveNow());
    inflight.current = run.catch(() => undefined);
    return run;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [week, put, wid]);
  const saveNow = async () => {
    const cells = [...pending.current.values()];
    if (!cells.length) return;
    pending.current.clear();
    for (const c of cells) sending.current.add(cellKey(c.kind, c.targetId, c.date));
    setSaving('saving');
    try {
      const res = await timeApi.saveGrid(week, cells);
      put(res.grid);
      const failed: Record<string, string> = {};
      for (const e of res.errors) failed[cellKey(e.kind, e.targetId, e.date)] = e.message;
      setErrors((old) => { const next = { ...old }; for (const c of cells) delete next[cellKey(c.kind, c.targetId, c.date)]; return { ...next, ...failed }; });
      // Only clear a draft that still shows what was sent: something typed since stays.
      setDrafts((old) => { const next = { ...old }; for (const c of cells) { const k = cellKey(c.kind, c.targetId, c.date); if (!failed[k] && !pending.current.has(k) && parseCell(next[k] ?? '') === c.minutes) delete next[k]; } return next; });
      setSaving(res.errors.length ? 'error' : 'saved');
      if (res.errors.length) toast(res.errors[0].message, 'error');
      void invalidateWorkspace(wid, 'timesheet', 'week');
      void invalidateWorkspace(wid, 'timer');
    } catch (e) {
      for (const c of cells) { const k = cellKey(c.kind, c.targetId, c.date); if (!pending.current.has(k)) pending.current.set(k, c); }   // keep them for the next try; newer edits win
      setSaving('error');
      toast(errText(e, 'Could not save your timesheet. Your changes are kept; try again.'), 'error');
    } finally {
      for (const c of cells) sending.current.delete(cellKey(c.kind, c.targetId, c.date));
    }
  };

  useEffect(() => () => { void flush(); }, [flush]);   // leaving the week saves what is waiting
  // Closing or hiding the tab: save now, and warn before closing while something is still unsaved.
  useEffect(() => {
    const hide = () => { if (document.visibilityState === 'hidden') void flush(); };
    const leave = (e: BeforeUnloadEvent) => { if (pending.current.size || sending.current.size) { void flush(); e.preventDefault(); e.returnValue = ''; } };
    document.addEventListener('visibilitychange', hide); window.addEventListener('beforeunload', leave);
    return () => { document.removeEventListener('visibilitychange', hide); window.removeEventListener('beforeunload', leave); };
  }, [flush]);
  const schedule = () => { if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => void flush(), 700); setSaving('saving'); };

  /** Commits what was typed into one cell. */
  const commit = (r: GridRow, date: string, text: string, note?: string | null, addAsNew = false) => {
    const k = cellKey(r.kind, r.targetId, date);
    const minutes = parseCell(text);
    if (minutes === null || minutes > 24 * 60) { setErrors((e) => ({ ...e, [k]: 'Type hours like 1.5, 1:30 or 45m (up to 24 h).' })); return; }
    const current = r.cells.find((c) => c.date === date)?.minutes ?? 0;
    if (minutes === current && note === undefined && !sending.current.has(k)) { pending.current.delete(k); setDrafts((d) => { const n = { ...d }; delete n[k]; return n; }); setErrors((e) => { const n = { ...e }; delete n[k]; return n; }); return; }
    setDrafts((d) => ({ ...d, [k]: minutes ? hm(minutes) : '' }));
    pending.current.set(k, { kind: r.kind, targetId: r.targetId, date, minutes, note, addAsNew: addAsNew || pending.current.get(k)?.addAsNew });
    haptic();
    schedule();
  };

  if (q.isLoading) return <PageLoader />;
  if (q.isError || !grid) return <ErrorState error={q.error} retry={() => void q.refetch()} />;

  const editable = grid.editable;
  const days = grid.days;
  const canLogOn = (date: string) => editable && date <= today;
  const addStub = (s: Stub) => { setExtra((x) => (x.some((y) => rowKey(y) === rowKey(s)) || rows.some((y) => rowKey(y) === rowKey(s)) ? x : [...x, s])); };

  const copyRows = () => {
    const last = grid.suggestions.filter((s) => s.reason === 'lastWeek');
    if (!last.length) return toast('Nothing from last week to bring over.');
    last.forEach(addStub); toast(`Added ${last.length} row${last.length === 1 ? '' : 's'} from last week.`);
  };
  const copyHours = async () => {
    setBusy(true);
    try { await flush(); const res = await timeApi.copyPrevious(week); put(res.grid); toast(res.saved ? `Copied ${res.saved} day${res.saved === 1 ? '' : 's'} of time from last week.` : 'Nothing to copy: the empty days already match, or last week had no time.'); }
    catch (e) { toast(errText(e, 'Could not copy last week.'), 'error'); } finally { setBusy(false); }
  };
  const exportCsv = () => downloadText(`timesheet-${grid.user.name.replace(/\s+/g, '-').toLowerCase()}-${week}.csv`, gridCsv(grid, rows));

  const focusedRow = focus ? rows.find((r) => rowKey(r) === focus.row) : undefined;
  const focusedCell = focusedRow?.cells.find((c) => c.date === focus?.date);

  return (
    <div className="tsg">
      <WeekHeader grid={grid} week={week} onWeek={onWeek} saving={saving} />
      <WeekApprovalBar weekStart={week} userId={userId || undefined} />

      <div className="tsg-tools">
        {editable && <QuickAdd grid={grid} rows={rows} onAdd={(r, date, minutes, note) => {
          const current = r.cells.find((c) => c.date === date)?.minutes ?? 0;
          const k = cellKey(r.kind, r.targetId, date);
          const typed = drafts[k] !== undefined ? parseCell(drafts[k]) ?? current : current;
          addStub(r); commit(r, date, hm(typed + minutes), note || undefined, !!note);
        }} />}
        <div className="tsg-tool-btns">
          {editable && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAdding((a) => !a)} aria-expanded={adding}><Icon name="plus" size={14} />Add row</button>}
          {editable && <button type="button" className="btn btn-ghost btn-sm" onClick={copyRows} title="Add last week's rows, empty"><Icon name="repeat" size={14} />Last week's rows</button>}
          {editable && <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void copyHours()} title="Fill this week's empty days with what you logged on the same day last week"><Icon name="copy" size={14} />Copy last week</button>}
          <button type="button" className="btn btn-ghost btn-sm" onClick={exportCsv}><Icon name="download" size={14} />Export</button>
        </div>
      </div>

      {editable && (adding || (!rows.length && grid.suggestions.length > 0)) && (
        <AddRows suggestions={grid.suggestions.filter((s) => !rows.some((r) => rowKey(r) === rowKey(s)))} onAdd={(s) => { addStub(s); }} onClose={() => setAdding(false)} />
      )}

      {rows.length === 0 ? (
        <div className="card"><div className="card-body">
          <EmptyState icon="clock" title={grid.mine ? 'Nothing logged this week yet' : `${grid.user.name} logged nothing this week`}
            text={grid.mine ? (editable ? 'Add a row from the suggestions, or type “2h ATL-12 yesterday” in the quick add.' : 'This week is locked.') : undefined} />
        </div></div>
      ) : mobile ? (
        <DayView grid={grid} rows={rows} drafts={drafts} errors={errors} canLogOn={canLogOn} today={today} onCommit={commit} />
      ) : (
        <div className="card tsg-card">
          <div className="tsg-scroll">
            <table className="tsg-table" aria-label={`Timesheet for the week of ${weekLabel(week)}`}>
              <thead>
                <tr>
                  <th className="tsg-what" scope="col">Work</th>
                  {days.map((d) => <DayHead key={d.date} d={d} today={today} />)}
                  <th className="tsg-total" scope="col">Total</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, ri) => (
                  <tr key={rowKey(r)} className={focus?.row === rowKey(r) ? 'focused' : ''}>
                    <th scope="row" className="tsg-what">
                      <RowLabel r={r} grid={grid} today={today} onRemove={r.totalMinutes === 0 && !grid.rows.some((x) => rowKey(x) === rowKey(r)) ? () => setExtra((x) => x.filter((y) => rowKey(y) !== rowKey(r))) : undefined} />
                    </th>
                    {r.cells.map((c, ci) => {
                      const k = cellKey(r.kind, r.targetId, c.date);
                      const day = days[ci];
                      return (
                        <td key={c.date} className={`tsg-cell ${day.weekend ? 'weekend' : ''} ${day.leave ? 'leave' : ''} ${c.date === today ? 'today' : ''} ${errors[k] ? 'bad' : ''} ${drafts[k] !== undefined ? 'dirty' : ''}`}>
                          <Cell r={r} ri={ri} ci={ci} value={drafts[k] ?? hm(c.minutes)} note={c.allNotes ?? c.note} running={c.running} error={errors[k]} disabled={!canLogOn(c.date) || c.running}
                            label={`${r.key} on ${dayName(c.date)} ${dayNum(c.date)}`} rowsCount={rows.length}
                            onFocus={() => setFocus({ row: rowKey(r), date: c.date })} onDraft={(v) => setDrafts((d) => ({ ...d, [k]: v }))} onCommit={(v) => commit(r, c.date, v)}
                            onRevert={() => setDrafts((d) => { const n = { ...d }; delete n[k]; return n; })} />
                        </td>
                      );
                    })}
                    <td className="tsg-total"><b>{formatMinutes(r.cells.reduce((n, c) => { const d = drafts[cellKey(r.kind, r.targetId, c.date)]; return n + (d === undefined ? c.minutes : parseCell(d) ?? c.minutes); }, 0))}</b></td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row" className="tsg-what">Day total</th>
                  {days.map((d) => {
                    const s = dayState(d.minutes, d.targetMinutes);
                    return (
                      <td key={d.date} className={`tsg-foot ${s}`}>
                        <b>{d.minutes ? formatMinutes(d.minutes) : '–'}</b>
                        {d.targetMinutes > 0 && <span className="tsg-meter" aria-hidden><i style={{ width: `${Math.min(100, (d.minutes / d.targetMinutes) * 100)}%` }} /></span>}
                        {d.targetMinutes > 0 && <small>of {formatMinutes(d.targetMinutes)}</small>}
                      </td>
                    );
                  })}
                  <td className="tsg-total tsg-foot"><b>{formatMinutes(grid.totalMinutes)}</b><small>of {formatMinutes(grid.targetMinutes)}</small></td>
                </tr>
              </tfoot>
            </table>
          </div>
          {focusedRow && focusedCell && editable && canLogOn(focusedCell.date) && !focusedCell.running && (
            <NoteBar key={`${focus!.row}:${focus!.date}`} row={focusedRow} date={focusedCell.date} note={focusedCell.note}
              onSave={(note) => commit(focusedRow, focusedCell.date, drafts[cellKey(focusedRow.kind, focusedRow.targetId, focusedCell.date)] ?? hm(focusedCell.minutes), note)} />
          )}
          <div className="tsg-legend">
            <span><kbd>1.5</kbd> <kbd>1:30</kbd> <kbd>45m</kbd> hours</span>
            <span><kbd>Enter</kbd> <kbd>Tab</kbd> <kbd>↑</kbd><kbd>↓</kbd> move</span>
            <span><kbd>Esc</kbd> undo the cell</span>
            <span><kbd>0</kbd> clears it</span>
          </div>
        </div>
      )}
      <PlannedLeavePanel key={`${grid.user.id}:${week}`} userId={grid.user.id} name={grid.user.name} from={week} to={grid.weekEnd} dates={null}
        onSaved={(date) => { void invalidateWorkspace(wid, 'timesheet'); if (mondayOf(date) !== week) onWeek(mondayOf(date)); }} />
    </div>
  );
}

function WeekHeader({ grid, week, onWeek, saving }: { grid: TimesheetGrid; week: string; onWeek: (w: string) => void; saving: 'idle' | 'saving' | 'saved' | 'error' }) {
  const thisMonday = mondayOf();
  const pct = grid.targetMinutes ? Math.round((grid.totalMinutes / grid.targetMinutes) * 100) : null;
  const billablePct = grid.totalMinutes ? Math.round((grid.billableMinutes / grid.totalMinutes) * 100) : 0;
  const meetings = grid.days.reduce((n, d) => n + d.meetingMinutes, 0);
  const leave = grid.days.filter((d) => d.leave).length;
  return (
    <section className="tsg-hero" aria-label="This week">
      <div className="tsg-hero-nav">
        <button type="button" className="btn-icon" aria-label="Previous week" onClick={() => onWeek(addDaysIso(week, -7))}><Icon name="chevronL" /></button>
        <div className="tsg-hero-week">
          <b>{weekLabel(week)}</b>
          <span>{week === thisMonday ? 'This week' : week === addDaysIso(thisMonday, -7) ? 'Last week' : grid.user.name}</span>
        </div>
        <button type="button" className="btn-icon" aria-label="Next week" disabled={week >= thisMonday} onClick={() => onWeek(addDaysIso(week, 7))}><Icon name="chevronR" /></button>
        {week !== thisMonday && <button type="button" className="btn btn-ghost btn-sm" onClick={() => onWeek(thisMonday)}>This week</button>}
        <span className={`tsg-save ${saving}`} role="status" aria-live="polite">
          {saving === 'saving' ? <><span className="tsg-spin" />Saving…</> : saving === 'saved' ? <><Icon name="check" size={13} />Saved</> : saving === 'error' ? <><Icon name="alert" size={13} />Some changes need attention</> : grid.locked ? <><Icon name="lock" size={13} />Locked</> : null}
        </span>
      </div>
      <div className="tsg-hero-stats">
        <div className="tsg-ring" style={{ ['--p' as string]: `${Math.min(100, pct ?? 0)}` }} aria-label={pct === null ? 'No working days this week' : `${pct}% of a normal week`}>
          <span><b>{pct === null ? '–' : `${pct}%`}</b><small>of week</small></span>
        </div>
        <Stat label="Logged" value={formatMinutes(grid.totalMinutes)} foot={`of ${formatMinutes(grid.targetMinutes)}`} />
        <Stat label="Billable" value={`${billablePct}%`} foot={formatMinutes(grid.billableMinutes)} tone="green" />
        <Stat label="Overtime" value={formatMinutes(grid.overtimeMinutes)} foot="above the normal day" tone={grid.overtimeMinutes > 0 ? 'amber' : undefined} />
        <Stat label="Days missing" value={String(grid.missingDays)} foot={grid.missingDays ? 'working days with nothing' : 'all caught up'} tone={grid.missingDays ? 'red' : 'green'} />
        <Stat label="Meetings" value={formatMinutes(meetings)} foot={`${grid.days.reduce((n, d) => n + d.meetings, 0)} on the calendar`} tone="blue" />
        {leave > 0 && <Stat label="Planned leave" value={`${leave} day${leave === 1 ? '' : 's'}`} foot="not counted" tone="purple" />}
      </div>
    </section>
  );
}

function Stat({ label, value, foot, tone }: { label: string; value: string; foot?: string; tone?: string }) {
  return <div className={`tsg-stat ${tone ?? ''}`}><span>{label}</span><b>{value}</b>{foot && <small>{foot}</small>}</div>;
}

function DayHead({ d, today }: { d: TimesheetGrid['days'][number]; today: string }) {
  return (
    <th scope="col" className={`tsg-day ${d.weekend ? 'weekend' : ''} ${d.leave ? 'leave' : ''} ${d.date === today ? 'today' : ''}`} title={d.leave ? `Planned leave${d.leaveNote ? `: ${d.leaveNote}` : ''}` : formatDate(d.date)}>
      <span className="tsg-dow">{dayName(d.date)}</span>
      <span className="tsg-dnum">{dayNum(d.date)}</span>
      {d.leave ? <span className="tsg-tag leave"><Icon name="sun" size={11} />Leave</span>
        : d.meetings > 0 ? <span className="tsg-tag meet" title={`${d.meetings} meeting${d.meetings === 1 ? '' : 's'}, ${formatMinutes(d.meetingMinutes)}`}><Icon name="video" size={11} />{formatMinutes(d.meetingMinutes)}</span>
        : d.date === today ? <span className="tsg-tag now">Today</span> : null}
    </th>
  );
}

function RowLabel({ r, grid, today, onRemove }: { r: GridRow; grid: TimesheetGrid; today: string; onRemove?: () => void }) {
  const wid = useWorkspaceId();
  const running = grid.running && (grid.running.kind === 'work' ? grid.running.workTaskId : grid.running.taskId) === r.targetId ? grid.running : null;
  const now = useNow(!!running);
  const inWeek = grid.days.some((d) => d.date === today);
  const link = r.kind === 'work' ? `/operations?task=${r.targetId}` : `/projects/${r.projectId}?task=${r.targetId}`;
  const start = async () => {
    try { await (r.kind === 'work' ? timeApi.startOnWorkTask(r.targetId) : timeApi.start(r.targetId)); toast(`Timer started on ${r.key}.`); }
    catch (e) { toast(errText(e, 'Could not start the timer.'), 'error'); }
    void invalidateWorkspace(wid, 'timer'); void invalidateWorkspace(wid, 'timesheet');
  };
  const stop = async () => {
    try { await timeApi.stop(); toast('Timer stopped and time saved.'); } catch (e) { toast(errText(e, 'Could not stop the timer.'), 'error'); }
    void invalidateWorkspace(wid, 'timer'); void invalidateWorkspace(wid, 'timesheet');
  };
  return (
    <div className="tsg-row-label">
      <span className={`tsg-kind ${r.kind}`} aria-hidden />
      <div className="tsg-row-text">
        <Link to={link} className="tsg-key">{r.key}</Link>
        <span className="tsg-title" title={r.title}>{r.title}</span>
        <span className="tsg-proj">{r.projectName ?? (r.kind === 'work' ? 'Operational work' : '')}{r.billable && <em className="tsg-bill" title="Billable">₹</em>}</span>
      </div>
      {grid.mine && inWeek && grid.editable && (running
        ? <button type="button" className="tsg-timer on" onClick={() => void stop()} aria-label={`Stop the timer on ${r.key}`}><span className="live-dot" />{clock(now - new Date(running.startedAt!).getTime())}</button>
        : <button type="button" className="tsg-timer" onClick={() => void start()} aria-label={`Start a timer on ${r.key}`} title="Start a timer"><Icon name="play" size={12} /></button>)}
      {onRemove && <button type="button" className="tsg-remove" onClick={onRemove} aria-label={`Remove the ${r.key} row`} title="Remove this empty row"><Icon name="close" size={12} /></button>}
    </div>
  );
}

function Cell({ r, ri, ci, value, note, running, error, disabled, label, rowsCount, onFocus, onDraft, onCommit, onRevert }: {
  r: GridRow; ri: number; ci: number; value: string; note: string | null; running: boolean; error?: string; disabled: boolean; label: string; rowsCount: number;
  onFocus: () => void; onDraft: (v: string) => void; onCommit: (v: string) => void; onRevert: () => void;
}) {
  const start = useRef(value);
  const move = (dr: number, dc: number) => {
    const nr = Math.max(0, Math.min(rowsCount - 1, ri + dr)), nc = Math.max(0, Math.min(6, ci + dc));
    const el = document.querySelector<HTMLInputElement>(`.tsg-table input[data-r="${nr}"][data-c="${nc}"]`);
    if (el && !el.disabled) { el.focus(); el.select(); }
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    const el = e.currentTarget;
    if (e.key === 'Enter') { e.preventDefault(); onCommit(el.value); move(e.shiftKey ? -1 : 1, 0); }
    else if (e.key === 'Escape') { e.preventDefault(); onRevert(); requestAnimationFrame(() => el.select()); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); onCommit(el.value); move(1, 0); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); onCommit(el.value); move(-1, 0); }
    else if (e.key === 'ArrowRight' && el.selectionStart === el.value.length) { e.preventDefault(); onCommit(el.value); move(0, 1); }
    else if (e.key === 'ArrowLeft' && el.selectionEnd === 0) { e.preventDefault(); onCommit(el.value); move(0, -1); }
  };
  return (
    <div className={`tsg-input ${note ? 'has-note' : ''} ${running ? 'running' : ''}`}>
      <input data-r={ri} data-c={ci} inputMode="decimal" autoComplete="off" spellCheck={false} aria-label={label} aria-invalid={!!error}
        title={error ?? (running ? 'A timer is running here' : note ?? undefined)} placeholder={disabled ? '' : '–'} disabled={disabled}
        value={value} onFocus={(e) => { start.current = e.currentTarget.value; onFocus(); e.currentTarget.select(); }}
        onChange={(e) => onDraft(e.target.value)} onBlur={(e) => { if (e.currentTarget.value !== start.current) onCommit(e.currentTarget.value); }} onKeyDown={onKey} />
      {running && <span className="live-dot" aria-hidden />}
      {note && !running && <span className="tsg-note-dot" aria-hidden />}
      <span className="sr-only">{r.title}</span>
    </div>
  );
}

function NoteBar({ row, date, note, onSave }: { row: GridRow; date: string; note: string | null; onSave: (note: string) => void }) {
  const [text, setText] = useState(note ?? '');
  const changed = text.trim() !== (note ?? '').trim();
  return (
    <form className="tsg-notebar" onSubmit={(e) => { e.preventDefault(); if (changed) onSave(text.trim()); }}>
      <Icon name="note" size={14} />
      <label htmlFor="tsg-note"><b>{row.key}</b> · {dayName(date)} {dayNum(date)}</label>
      <input id="tsg-note" className="input" maxLength={500} placeholder="What was it? (a note for this day)" value={text} onChange={(e) => setText(e.target.value)} />
      <button type="submit" className="btn btn-sm btn-primary" disabled={!changed}>Save note</button>
    </form>
  );
}

/** Rows to add: the suggestions, and a search over the work the person can see. */
function AddRows({ suggestions, onAdd, onClose }: { suggestions: GridSuggestion[]; onAdd: (s: Stub) => void; onClose: () => void }) {
  const [text, setText] = useState('');
  const q = useDebounced(text.trim(), 250);
  const search = useWsQuery(['search', 'timesheet', q], () => insightApi.search(q), { enabled: q.length >= 2, staleTime: 30_000 });
  const hits = (search.data?.hits ?? []).filter((h: SearchHit) => h.type === 'task' || h.type === 'work' || h.type === 'action').slice(0, 8);
  const stubOf = (h: SearchHit): Stub => ({ kind: (h.type === 'task' ? 'task' : 'work') as GridKind, targetId: h.id, key: (h.subtitle ?? '').split(' · ')[0] || h.title, title: h.title, projectId: h.projectId, projectName: null });
  return (
    <div className="card tsg-add">
      <div className="tsg-add-head">
        <div><b>Add work to this week</b><span>Suggestions from what you did, or search any task or operational work.</span></div>
        <button type="button" className="btn-icon" aria-label="Close" onClick={onClose}><Icon name="close" size={14} /></button>
      </div>
      {suggestions.length > 0 && (
        <div className="tsg-sugs">
          {suggestions.map((s) => (
            <button type="button" key={rowKey(s)} className={`tsg-sug ${s.reason}`} onClick={() => onAdd(s)} title={`${s.key} ${s.title}`}>
              <Icon name={REASON[s.reason].icon} size={12} /><b>{s.key}</b><span>{s.title}</span><em>{REASON[s.reason].label}</em><Icon name="plus" size={12} />
            </button>
          ))}
        </div>
      )}
      <div className="tsg-search">
        <Icon name="search" size={14} />
        <input className="input" placeholder="Search by key or title…" value={text} onChange={(e) => setText(e.target.value)} aria-label="Search work to add" />
      </div>
      {q.length >= 2 && (
        <div className="tsg-hits">
          {search.isLoading ? <span className="muted">Searching…</span> : hits.length === 0 ? <span className="muted">Nothing matches “{q}”.</span> :
            hits.map((h) => (
              <button type="button" key={h.id} className="tsg-hit" onClick={() => { onAdd(stubOf(h)); setText(''); }}>
                <b>{stubOf(h).key}</b><span>{h.title}</span><em>{h.type === 'task' ? 'Task' : h.type === 'action' ? 'Action item' : 'Operational'}</em>
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

/** "2h ATL-12 yesterday": rows it knows are filled at once; anything else goes to the assistant, which can find the work and log it. */
function QuickAdd({ grid, rows, onAdd }: { grid: TimesheetGrid; rows: GridRow[]; onAdd: (r: GridRow, date: string, minutes: number, note: string) => void }) {
  const [text, setText] = useState('');
  const [hint, setHint] = useState<string | null>(null);
  const ask = useAssistant((s) => s.ask);
  const week = grid.days.map((d) => d.date);
  const known = [...rows, ...grid.suggestions.map((s): GridRow => ({ ...s, billable: false, totalMinutes: 0, cells: grid.days.map((d) => ({ date: d.date, minutes: 0, entries: 0, running: false, note: null })) }))];
  const submit = () => {
    if (!text.trim()) return;
    const p = parseQuickAdd(text, week, todayISO());
    if ('error' in p) { setHint(p.error); return; }
    const row = known.find((r) => r.key.toUpperCase() === p.key);
    if (!row) { ask(`Log my time: ${text.trim()}`); setText(''); setHint(null); return; }
    onAdd(rows.find((r) => rowKey(r) === rowKey(row)) ?? row, p.date, p.minutes, p.note);
    toast(`Added ${formatMinutes(p.minutes)} to ${p.key} on ${dayName(p.date)} ${dayNum(p.date)}.`);
    setText(''); setHint(null);
  };
  return (
    <form className="tsg-quick" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <Icon name="bolt" size={14} />
      <input className="input" value={text} onChange={(e) => { setText(e.target.value); setHint(null); }} placeholder="Quick add: 2h ATL-12 yesterday" aria-label="Quick add time" aria-describedby={hint ? 'tsg-quick-hint' : undefined} />
      <button type="submit" className="btn btn-sm btn-primary" disabled={!text.trim()}>Add</button>
      <button type="button" className="btn btn-sm btn-ghost" title="Describe your day and the assistant prepares the entries for you to confirm" onClick={() => ask(text.trim() ? `Log my time: ${text.trim()}` : 'Log my time for today: ')}>
        <Icon name="sparkle" size={14} />Ask the assistant
      </button>
      {hint && <span id="tsg-quick-hint" className="tsg-quick-hint" role="alert">{hint}</span>}
    </form>
  );
}

/** Phones: one day at a time, with steppers. */
function DayView({ grid, rows, drafts, errors, canLogOn, today, onCommit }: {
  grid: TimesheetGrid; rows: GridRow[]; drafts: Record<string, string>; errors: Record<string, string>; canLogOn: (d: string) => boolean; today: string;
  onCommit: (r: GridRow, date: string, text: string) => void;
}) {
  const initial = grid.days.find((d) => d.date === today)?.date ?? grid.days.filter((d) => !d.weekend).at(-1)?.date ?? grid.days[0].date;
  const [day, setDay] = useState(initial);
  const d = grid.days.find((x) => x.date === day) ?? grid.days[0];
  return (
    <div className="tsd">
      <div className="tsd-strip" role="tablist" aria-label="Day">
        {grid.days.map((x) => (
          <button key={x.date} type="button" role="tab" aria-selected={x.date === day} className={`tsd-day ${x.date === day ? 'on' : ''} ${dayState(x.minutes, x.targetMinutes)} ${x.leave ? 'leave' : ''}`} onClick={() => setDay(x.date)}>
            <span>{dayName(x.date)}</span><b>{dayNum(x.date)}</b><small>{x.leave ? 'Leave' : x.minutes ? hm(x.minutes) : '–'}</small>
          </button>
        ))}
      </div>
      <div className="tsd-sum">
        <b>{formatMinutes(d.minutes)}</b><span>{d.leave ? 'Planned leave' : d.targetMinutes ? `of ${formatMinutes(d.targetMinutes)}` : 'Weekend'}</span>
        {d.meetings > 0 && <em><Icon name="video" size={12} />{d.meetings} meeting{d.meetings === 1 ? '' : 's'} · {formatMinutes(d.meetingMinutes)}</em>}
      </div>
      <div className="tsd-list">
        {rows.map((r) => {
          const c = r.cells.find((x) => x.date === day)!;
          const k = cellKey(r.kind, r.targetId, day);
          const value = drafts[k] ?? hm(c.minutes);
          const mins = parseCell(value) ?? c.minutes;
          const can = canLogOn(day) && !c.running;
          return (
            <div key={rowKey(r)} className={`tsd-row ${errors[k] ? 'bad' : ''}`}>
              <div className="tsd-what"><b>{r.key}</b><span>{r.title}</span>{errors[k] && <small role="alert">{errors[k]}</small>}</div>
              <div className="tsd-step">
                <button type="button" aria-label={`15 minutes less on ${r.key}`} disabled={!can || mins <= 0} onClick={() => onCommit(r, day, hm(Math.max(0, mins - 15)))}>−</button>
                <input key={value} defaultValue={value} inputMode="decimal" aria-label={`${r.key} on ${dayName(day)}`} disabled={!can} placeholder="–"
                  onBlur={(e) => { if (e.currentTarget.value !== value) onCommit(r, day, e.currentTarget.value); }} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
                <button type="button" aria-label={`15 minutes more on ${r.key}`} disabled={!can} onClick={() => onCommit(r, day, hm(mins + 15))}>+</button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
