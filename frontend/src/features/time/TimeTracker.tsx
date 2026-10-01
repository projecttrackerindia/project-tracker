import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { timeApi } from '../../api/endpoints';
import { Icon } from '../../components/Icon';
import { formatDate, todayISO } from '../../lib/format';
import { useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
import { clock, formatMinutes, parseDuration, useNow } from './time';

/**
 * Time on one project task (taskId) or one piece of operational work (workTaskId): a start/stop timer, a quick "log time" form and
 * the list of entries. On a project task, actual hours follow the total.
 */
export function TimeTracker({ taskId, workTaskId, canEdit }: { taskId?: string; workTaskId?: string; canEdit: boolean }) {
  const wid = useWorkspaceId();
  const qc = useQueryClient();
  const onWork = !!workTaskId;
  const id = (workTaskId ?? taskId)!;
  const cacheKey = onWork ? ['work', 'task', id] : ['task', id];
  const q = useWsQuery([...cacheKey, 'time'], () => (onWork ? timeApi.forWorkTask(id) : timeApi.forTask(id)));
  const [duration, setDuration] = useState('');
  const [date, setDate] = useState(todayISO());
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const data = q.data;
  const mine = data?.myTimer ?? null;
  const runningHere = !!mine && (onWork ? mine.workTaskId === id : mine.taskId === id);
  const now = useNow(!!mine);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: [wid, ...cacheKey] });
    void qc.invalidateQueries({ queryKey: [wid, 'timer'] });
    void qc.invalidateQueries({ queryKey: [wid, 'timesheet'] });
    void qc.invalidateQueries({ queryKey: [wid, 'tasks'] });
  };
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true); setError(null);
    try { await fn(); if (ok) toast(ok); refresh(); }
    catch (e) { setError(e instanceof ApiError ? e.message : 'Something went wrong. Please try again.'); }
    finally { setBusy(false); }
  };

  const log = () => {
    const minutes = parseDuration(duration);
    if (!minutes) return setError('Enter a duration such as 1h 30m, 45m or 1.5h.');
    const body = { minutes, workDate: date, note: note.trim() || undefined };
    void run(async () => { await (onWork ? timeApi.logOnWorkTask(id, body) : timeApi.log(id, body)); setDuration(''); setNote(''); }, 'Time logged.');
  };

  const total = data?.totalMinutes ?? 0;
  const estimate = data?.estimatedHours ? Math.round(data.estimatedHours * 60) : null;

  return (
    <div className="time-box">
      <div className="time-head">
        <h4><Icon name="clock" size={15} /> Time</h4>
        <div className="muted" style={{ fontSize: 12.5 }}>
          {formatMinutes(total)} logged{estimate ? <> of {formatMinutes(estimate)} estimated{total > estimate ? <b className="over"> · over</b> : null}</> : null}
        </div>
      </div>
      {estimate ? <div className="time-bar"><span style={{ width: `${Math.min(100, (total / estimate) * 100)}%` }} className={total > estimate ? 'over' : ''} /></div> : null}

      {canEdit && (
        <>
          <div className="time-actions">
            {runningHere ? (
              <button type="button" className="btn btn-danger btn-sm" disabled={busy} onClick={() => void run(() => timeApi.stop(), 'Timer stopped and time saved.')}>
                <Icon name="pause" size={14} /> Stop · {clock(now - new Date(mine!.startedAt!).getTime())}
              </button>
            ) : (
              <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void run(() => (onWork ? timeApi.startOnWorkTask(id) : timeApi.start(id)))}>
                <Icon name="play" size={14} /> Start timer
              </button>
            )}
            {mine && !runningHere && <span className="muted" style={{ fontSize: 12 }}>Timer is running on {mine.taskKey}; starting here stops it.</span>}
          </div>
          <div className="time-form">
            <input className="input" placeholder="1h 30m" aria-label="Duration" value={duration} onChange={(e) => setDuration(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); log(); } }} />
            <input className="input" type="date" aria-label="Date" max={todayISO()} value={date} onChange={(e) => setDate(e.target.value || todayISO())} />
            <input className="input" placeholder="What did you do? (optional)" aria-label="Note" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); log(); } }} />
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={log}>Log time</button>
          </div>
        </>
      )}
      {error && <div className="form-error" role="alert" style={{ marginTop: 8 }}>{error}</div>}

      {(data?.entries.length ?? 0) > 0 && (
        <div className="time-list">
          {data!.entries.map((e) => (
            <div className="time-row" key={e.id}>
              <span className="time-min">{e.isRunning ? <span className="live-dot" title="Running" /> : null}{e.isRunning ? clock(now - new Date(e.startedAt!).getTime()) : formatMinutes(e.minutes)}</span>
              <span className="time-what"><b>{e.user.name}</b> · {formatDate(e.workDate)}{e.note ? <span className="muted"> — {e.note}</span> : null}</span>
              {e.canEdit && (
                <button type="button" className="btn-icon danger" title="Delete entry" aria-label="Delete time entry" onClick={async () => {
                  if (await confirmDialog({ title: 'Delete time entry?', message: `${e.isRunning ? 'The running timer' : formatMinutes(e.minutes)} will be removed from this ${onWork ? 'work task' : 'task'}.`, confirmText: 'Delete' }))
                    void run(() => timeApi.remove(e.id));
                }}><Icon name="trash" size={14} /></button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
