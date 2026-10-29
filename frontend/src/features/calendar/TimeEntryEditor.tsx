import { useState } from 'react';
import { timeApi } from '../../api/endpoints';
import type { TimeEntry } from '../../api/types';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { undoToast } from '../talk/flyTask';
import { editError, entryLock, isoAt, refreshAfterEdit, warnOverlap } from './calendarEdit';
import { SNAP, fmtMins } from './plannerModel';

/** Work time can be logged on: a project task or a work item (ticket, action item). */
export interface WorkChoice { kind: 'task' | 'work'; id: string; key: string | null; title: string; projectName: string | null }
const choiceId = (c: Pick<WorkChoice, 'kind' | 'id'>) => `${c.kind}:${c.id}`;
const choiceLabel = (c: WorkChoice) => `${c.key ? `${c.key} · ` : ''}${c.title}${c.projectName ? ` — ${c.projectName}` : ''}`;

const hhmm = (h: number) => { const m = Math.round(h * 60); return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };
const hourOfInput = (v: string) => { const [h, m] = v.split(':').map(Number); return Number.isFinite(h) && Number.isFinite(m) ? h + m / 60 : NaN; };
const snap = (h: number) => Math.round(h / SNAP) * SNAP;

/**
 * Edit (or log) one time entry from the calendar: its day, start and end (15-minute steps, the minutes follow), the work it was spent on,
 * billable and a note. Saves to the same entry the timesheet grid shows, with its stamp, so a change made elsewhere is refused, not lost.
 * A locked week is read-only and says why. Delete has Undo.
 */
export function TimeEntryEditor({ entry, day: day0, start: start0, end: end0, approximated, choices, today, onDone, onCancel }: {
  /** The entry to edit; without one this logs a new entry. */
  entry: TimeEntry | null; day: string; start: number; end: number; approximated?: boolean; choices: WorkChoice[]; today: string;
  onDone: () => void; onCancel?: () => void;
}) {
  const wid = useWorkspaceId();
  const lock = entry ? entryLock(entry) : null;
  const current: WorkChoice | null = entry ? { kind: entry.kind, id: (entry.kind === 'work' ? entry.workTaskId : entry.taskId) ?? '', key: entry.taskKey, title: entry.taskTitle, projectName: null } : null;
  const all = current && !choices.some((c) => choiceId(c) === choiceId(current)) ? [current, ...choices] : choices;
  const [day, setDay] = useState(day0);
  const [start, setStart] = useState(hhmm(snap(start0)));
  const [end, setEnd] = useState(hhmm(snap(Math.max(end0, start0 + SNAP))));
  const [work, setWork] = useState(current ? choiceId(current) : all[0] ? choiceId(all[0]) : '');
  const [note, setNote] = useState(entry?.note ?? '');
  const [billable, setBillable] = useState(entry?.billable ?? false);
  const [busy, setBusy] = useState(false);
  const s = hourOfInput(start), e = hourOfInput(end);
  const mins = Number.isFinite(s) && Number.isFinite(e) ? Math.round((e - s) * 60) : 0;
  const future = day > today;
  const problem = !work ? 'Choose the work this time was spent on.' : mins < 1 ? 'The end must be after the start.' : mins > 24 * 60 ? 'At most 24 hours.' : future ? 'Time is logged for days that have happened.' : null;

  const save = async () => {
    if (problem || lock) return;
    setBusy(true);
    const [kind, id] = work.split(':') as ['task' | 'work', string];
    const span = { startedAt: isoAt(day, s), endedAt: isoAt(day, e) };
    try {
      if (entry) {
        const moved = current && choiceId(current) !== work;
        const res = await timeApi.update(entry.id, { minutes: mins, workDate: day, note: note.trim() || null, billable, ...span, stamp: entry.stamp ?? null,
          ...(moved ? (kind === 'task' ? { taskId: id } : { workTaskId: id }) : {}) });
        if (!warnOverlap(res)) toast(`Saved · ${fmtMins(mins)} ${hhmm(s)}–${hhmm(e)}`, 'success');
      } else {
        const body = { minutes: mins, workDate: day, note: note.trim() || undefined, billable, ...span };
        const res = kind === 'task' ? await timeApi.log(id, body) : await timeApi.logOnWorkTask(id, body);
        if (!warnOverlap(res)) toast(`Logged ${fmtMins(mins)} · ${hhmm(s)}–${hhmm(e)}`, 'success');
      }
      refreshAfterEdit(wid);
      onDone();
    } catch (err) {
      toast(editError(err, 'That time could not be saved.'), 'error');
      refreshAfterEdit(wid);
    } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!entry || lock) return;
    setBusy(true);
    try {
      await timeApi.remove(entry.id);
      refreshAfterEdit(wid);
      onDone();
      const back = { minutes: entry.minutes, workDate: entry.workDate, note: entry.note ?? undefined, billable: entry.billable,
        ...(entry.startedAt && entry.endedAt ? { startedAt: entry.startedAt, endedAt: entry.endedAt } : {}) };
      undoToast(`${fmtMins(entry.minutes)} on ${entry.taskKey} deleted`, () => {
        void (entry.kind === 'work' && entry.workTaskId ? timeApi.logOnWorkTask(entry.workTaskId, back) : entry.taskId ? timeApi.log(entry.taskId, back) : Promise.resolve())
          .then(() => { toast('Time restored.', 'info'); refreshAfterEdit(wid); })
          .catch((err) => toast(editError(err, 'Could not restore it.'), 'error'));
      }, document.querySelector('.wp-cal'), 46);
    } catch (err) { toast(editError(err, 'That time could not be deleted.'), 'error'); }
    finally { setBusy(false); }
  };

  if (lock && entry) return <p className="ed-lock" data-testid="ed-lock"><span aria-hidden="true">🔒</span>{lock}</p>;
  return (
    <form className="ed-pick ed-time" data-testid="ed-time-form" onSubmit={(ev) => { ev.preventDefault(); void save(); }}>
      {approximated && entry && <p className="ed-note wide">Typed in as {fmtMins(entry.minutes)} without a time of day. Saving places it at the time below.</p>}
      <label className="wide"><span>Work</span>
        <select className="ed-sel" aria-label="Work item" value={work} onChange={(ev) => setWork(ev.target.value)}>
          {!work && <option value="">Choose work…</option>}
          {all.map((c) => <option key={choiceId(c)} value={choiceId(c)}>{choiceLabel(c)}</option>)}
        </select>
      </label>
      <label><span>Day</span><input className="ed-sel" type="date" aria-label="Day" value={day} max={today} onChange={(ev) => setDay(ev.target.value)} /></label>
      <label><span>Duration</span><output className="ed-sel ed-dur" aria-label="Duration">{mins > 0 ? fmtMins(mins) : '–'}</output></label>
      <label><span>Start</span><input className="ed-sel" type="time" step={900} aria-label="Start" value={start} onChange={(ev) => setStart(ev.target.value)} /></label>
      <label><span>End</span><input className="ed-sel" type="time" step={900} aria-label="End" value={end} onChange={(ev) => setEnd(ev.target.value)} /></label>
      <label className="wide"><span>Note</span><input className="ed-sel" aria-label="Note" maxLength={500} value={note} placeholder="What was it?" onChange={(ev) => setNote(ev.target.value)} /></label>
      <label className="wide ed-check"><input type="checkbox" checked={billable} onChange={(ev) => setBillable(ev.target.checked)} /> Billable</label>
      {problem && <p className="ed-note wide warn" role="status">{problem}</p>}
      <div className="ed-pick-act">
        {entry && <button type="button" className="ed-btn ghost danger" data-testid="ed-delete" disabled={busy} onClick={() => void remove()}>Delete</button>}
        <span style={{ flex: 1 }} />
        {onCancel && <button type="button" className="ed-btn ghost" onClick={onCancel}>Cancel</button>}
        <button type="submit" className="ed-btn primary" data-testid="ed-save" disabled={busy || !!problem}>{busy ? 'Saving…' : entry ? 'Save' : 'Log time'}</button>
      </div>
    </form>
  );
}
