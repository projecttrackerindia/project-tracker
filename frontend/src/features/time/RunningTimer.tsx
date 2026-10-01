import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { timeApi } from '../../api/endpoints';
import { Icon } from '../../components/Icon';
import { useWsQuery } from '../../lib/hooks';
import { useModule, useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { clock, useNow } from './time';

/** Topbar chip for the timer that is running right now, with a stop button. Hidden when nothing runs. */
export function RunningTimer() {
  const wid = useWorkspaceId();
  const qc = useQueryClient();
  const [mTasks, mWork] = [useModule('tasks'), useModule('work')];
  const allowed = mTasks > 0 || mWork > 0;
  const q = useWsQuery(['timer'], timeApi.running, { enabled: allowed, refetchInterval: 60_000 });
  const t = q.data ?? null;
  const now = useNow(!!t);
  if (!t) return null;

  const stop = async () => {
    try {
      await timeApi.stop();
      toast('Timer stopped and time saved.');
      void qc.invalidateQueries({ queryKey: [wid, 'timer'] });
      void qc.invalidateQueries({ queryKey: t.kind === 'work' ? [wid, 'work', 'task', t.workTaskId] : [wid, 'task', t.taskId] });
      void qc.invalidateQueries({ queryKey: [wid, 'timesheet'] });
    } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not stop the timer.', 'error'); }
  };

  return (
    <div className="timer-chip" role="status" aria-label="Timer running">
      <span className="live-dot" />
      <Link to={t.kind === 'work' ? `/operations?task=${t.workTaskId}` : `/projects/${t.projectId}?task=${t.taskId}`} title={t.taskTitle}>{t.taskKey}</Link>
      <b>{clock(now - new Date(t.startedAt!).getTime())}</b>
      <button type="button" className="icon-btn" onClick={() => void stop()} title="Stop timer" aria-label="Stop timer"><Icon name="pause" size={14} /></button>
    </div>
  );
}
