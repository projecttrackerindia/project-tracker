import { useEffect, useState } from 'react';
import { ApiError } from '../../api/client';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { refreshWork } from '../work/workUi';
import { recurrenceApi, type RepeatRule } from './api';
import './recurring.css';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const ORD = ['', 'first', 'second', 'third', 'fourth', 'last'];
const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.errors[0]?.message ?? e.message : fallback);
const short = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
const isoDay = (iso: string | null | undefined) => { const d = iso ? new Date(`${iso}T00:00:00`) : new Date(); return ((d.getDay() + 6) % 7) + 1; };

type Mode = 'never' | 'daily' | 'weekdays' | 'weekly' | 'monthly-date' | 'monthly-day' | 'custom';
type Draft = { mode: Mode; interval: number; unit: 'day' | 'week' | 'month'; days: number[]; monthDay: number; monthWeek: number; monthWeekday: number; end: 'never' | 'after' | 'by'; endAfter: number; endBy: string };

const fromRule = (r: RepeatRule | null, due: string | null | undefined): Draft => {
  const d = due ? new Date(`${due}T00:00:00`) : new Date();
  const base: Draft = { mode: 'never', interval: 1, unit: 'week', days: [isoDay(due)], monthDay: d.getDate(), monthWeek: Math.min(5, Math.ceil(d.getDate() / 7)), monthWeekday: isoDay(due), end: 'never', endAfter: 10, endBy: '' };
  if (!r) return base;
  const end = r.endAfter ? 'after' : r.endBy ? 'by' : 'never';
  const common = { ...base, interval: r.interval ?? 1, end, endAfter: r.endAfter ?? 10, endBy: r.endBy ?? '' } as Draft;
  if (r.frequency === 'weekdays') return { ...common, mode: 'weekdays' };
  if ((r.interval ?? 1) > 1 && r.frequency !== 'weekly') return { ...common, mode: 'custom', unit: r.frequency === 'monthly' ? 'month' : 'day' };
  if (r.frequency === 'daily') return { ...common, mode: 'daily' };
  if (r.frequency === 'weekly') return { ...common, mode: 'weekly', days: r.daysOfWeek?.length ? r.daysOfWeek : base.days };
  if (r.monthWeek) return { ...common, mode: 'monthly-day', monthWeek: r.monthWeek, monthWeekday: r.monthWeekday ?? base.monthWeekday };
  return { ...common, mode: 'monthly-date', monthDay: r.monthDay ?? base.monthDay };
};

const toRule = (d: Draft): RepeatRule | null => {
  const end = { endAfter: d.end === 'after' ? d.endAfter : null, endBy: d.end === 'by' && d.endBy ? d.endBy : null };
  switch (d.mode) {
    case 'never': return null;
    case 'daily': return { frequency: 'daily', interval: 1, ...end };
    case 'weekdays': return { frequency: 'weekdays', ...end };
    case 'weekly': return { frequency: 'weekly', interval: d.interval, daysOfWeek: d.days, ...end };
    case 'monthly-date': return { frequency: 'monthly', interval: 1, monthDay: d.monthDay, ...end };
    case 'monthly-day': return { frequency: 'monthly', interval: 1, monthWeek: d.monthWeek, monthWeekday: d.monthWeekday, ...end };
    case 'custom': return { frequency: 'custom', interval: d.interval, unit: d.unit, ...end };
  }
};

/**
 * The task sheet's "Repeat" field: shows how the task repeats ("Every week on Mon, Thu · next Thu 12 Nov") and opens a small editor: how often,
 * which days, when it ends; for a task that already repeats, whether the change is for this one only or this and all following; skip this one;
 * stop repeating. Self-contained: give it the task id (and its due date for sensible defaults).
 */
export function RepeatField({ taskId, dueDate, canEdit = true }: { taskId: string; dueDate?: string | null; canEdit?: boolean }) {
  const wid = useWorkspaceId();
  const q = useWsQuery(['task', taskId, 'recurrence'], () => recurrenceApi.get(taskId), { retry: false });
  const r = q.data;
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => fromRule(null, dueDate));
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) setDraft(fromRule(r?.repeats ? r.rule : null, dueDate)); }, [open, r, dueDate]);

  const done = () => { void invalidateWorkspace(wid, 'task', taskId); refreshWork(wid); };
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try { await fn(); toast(ok); setOpen(false); done(); }
    catch (e) { toast(errText(e, 'Could not change how it repeats.'), 'error'); }
    finally { setBusy(false); }
  };
  const save = () => {
    const rule = toRule(draft);
    if (!rule) return run(() => recurrenceApi.stop(taskId), 'No longer repeats.');
    return run(() => recurrenceApi.set(taskId, rule), r?.repeats ? 'Saved for this and all following.' : 'Now repeats.');
  };
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const toggleDay = (n: number) => set({ days: draft.days.includes(n) ? draft.days.filter((x) => x !== n).length ? draft.days.filter((x) => x !== n) : draft.days : [...draft.days, n].sort() });

  const label = r?.repeats ? r.summary : 'Does not repeat';
  const next = r?.repeats && r.next[0] ? ` · next ${short(r.next[0])}` : '';

  return (
    <span className="rp-field">
      <button type="button" className={`rp-value${r?.repeats ? ' on' : ''}`} onClick={() => setOpen((o) => !o)} disabled={!canEdit || q.isLoading} aria-expanded={open} data-testid="repeat-field">
        <span aria-hidden="true" className="rp-glyph">↻</span>{q.isLoading ? 'Loading…' : `${label}${next}`}
      </button>
      {open && (
        <div className="rp-pop" role="dialog" aria-label="Repeat">
          <label className="rp-row"><span>Repeat</span>
            <select value={draft.mode} onChange={(e) => set({ mode: e.target.value as Mode })} aria-label="How often">
              <option value="never">Never</option><option value="daily">Every day</option><option value="weekdays">Every weekday</option>
              <option value="weekly">Weekly</option><option value="monthly-date">Monthly on day {draft.monthDay}</option>
              <option value="monthly-day">Monthly on the {ORD[draft.monthWeek]} {DAYS[draft.monthWeekday - 1]}</option><option value="custom">Custom…</option>
            </select>
          </label>
          {(draft.mode === 'weekly' || draft.mode === 'custom') && (
            <label className="rp-row"><span>Every</span>
              <span className="rp-inline">
                <input type="number" min={1} max={365} value={draft.interval} onChange={(e) => set({ interval: Math.max(1, Number(e.target.value) || 1) })} aria-label="Interval" />
                {draft.mode === 'custom'
                  ? <select value={draft.unit} onChange={(e) => set({ unit: e.target.value as Draft['unit'] })} aria-label="Unit"><option value="day">days</option><option value="week">weeks</option><option value="month">months</option></select>
                  : <em>week{draft.interval === 1 ? '' : 's'}</em>}
              </span>
            </label>
          )}
          {draft.mode === 'weekly' && (
            <div className="rp-days" role="group" aria-label="On these days">
              {DAYS.map((d, i) => <button key={d} type="button" aria-pressed={draft.days.includes(i + 1)} className={draft.days.includes(i + 1) ? 'on' : ''} onClick={() => toggleDay(i + 1)}>{d[0]}<span className="sr-only">{d}</span></button>)}
            </div>
          )}
          {draft.mode === 'monthly-day' && (
            <label className="rp-row"><span>On the</span>
              <span className="rp-inline">
                <select value={draft.monthWeek} onChange={(e) => set({ monthWeek: Number(e.target.value) })} aria-label="Which week">{[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{ORD[n]}</option>)}</select>
                <select value={draft.monthWeekday} onChange={(e) => set({ monthWeekday: Number(e.target.value) })} aria-label="Weekday">{DAYS.map((d, i) => <option key={d} value={i + 1}>{d}</option>)}</select>
              </span>
            </label>
          )}
          {draft.mode !== 'never' && (
            <label className="rp-row"><span>Ends</span>
              <span className="rp-inline">
                <select value={draft.end} onChange={(e) => set({ end: e.target.value as Draft['end'] })} aria-label="Ends"><option value="never">Never</option><option value="after">After</option><option value="by">On date</option></select>
                {draft.end === 'after' && <><input type="number" min={1} max={1000} value={draft.endAfter} onChange={(e) => set({ endAfter: Math.max(1, Number(e.target.value) || 1) })} aria-label="Times" /><em>times</em></>}
                {draft.end === 'by' && <input type="date" value={draft.endBy} onChange={(e) => set({ endBy: e.target.value })} aria-label="End date" />}
              </span>
            </label>
          )}
          {r?.repeats && draft.mode !== 'never' && <p className="rp-next">A new rule applies to this one and all following; earlier ones keep theirs.</p>}
          {r?.repeats && r.next.length > 0 && <p className="rp-next">Next: {r.next.slice(0, 3).map(short).join(' · ')}</p>}
          <div className="rp-acts">
            {r?.repeats && <button type="button" className="rp-lk" disabled={busy} onClick={() => void run(() => recurrenceApi.skip(taskId), 'Skipped this one.')}>Skip this one</button>}
            <span className="rp-sp" />
            <button type="button" className="rp-btn" onClick={() => setOpen(false)}>Cancel</button>
            <button type="button" className="rp-btn primary" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Done'}</button>
          </div>
        </div>
      )}
    </span>
  );
}
