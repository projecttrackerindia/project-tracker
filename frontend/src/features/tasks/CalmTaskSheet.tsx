import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { checklistApi, planningApi, taskApi, timeApi } from '../../api/endpoints';
import type { Checklist } from '../../api/types';
import { CalmAv, CalmDot, CalmSheet, CalmOrb } from '../../components/calm';
import { Icon } from '../../components/Icon';
import { projectColor } from '../../lib/calm';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { queryClient, useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { refreshWork } from '../work/workUi';
import { shortDay } from '../calm/createSheets';
import '../calm/calm-pages.css';

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.errors[0]?.message ?? e.message : fallback);
const hm = (min: number) => { const h = Math.floor(min / 60), m = Math.round(min % 60); return h && m ? `${h}h ${m}m` : h ? `${h}h` : `${m}m`; };
const at = (iso: string) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

/**
 * The task sheet (shot 10): project · phase · key, the title and ✓ Saved; owner, dates, status, what it blocks, time with Start timer;
 * the checklist ticked in place (optimistic); linked work (dependencies); comments with a composer; an Aura line on the time left.
 * "Open full task ›" opens the complete task (subtasks, labels, files, history) where everything else stays.
 */
export function CalmTaskSheet({ taskId, onClose, onFull }: { taskId: string | null; onClose: () => void; onFull?: (id: string) => void }) {
  const wid = useWorkspaceId();
  const on = !!taskId;
  const q = useWsQuery(['task', taskId], () => taskApi.get(taskId!), { enabled: on });
  const cl = useWsQuery(['task', taskId, 'checklist'], () => checklistApi.get(taskId!), { enabled: on, retry: false });
  const deps = useWsQuery(['task', taskId, 'deps'], () => planningApi.dependencies(taskId!), { enabled: on, retry: false });
  const cm = useWsQuery(['task', taskId, 'comments'], () => taskApi.comments(taskId!), { enabled: on, retry: false });
  const time = useWsQuery(['task', taskId, 'time'], () => timeApi.forTask(taskId!), { enabled: on, retry: false });
  const running = useWsQuery(['timer'], () => timeApi.running(), { enabled: on, staleTime: 30_000, retry: false });
  const [saved, setSaved] = useState(false);
  const [text, setText] = useState('');
  const flash = () => { setSaved(true); window.setTimeout(() => setSaved(false), 1600); };
  const t = q.data?.task;
  const key = [wid, 'task', taskId, 'checklist'];

  const toggle = async (id: string, isDone: boolean) => {
    const prev = queryClient.getQueryData<Checklist>(key);
    if (prev) queryClient.setQueryData<Checklist>(key, { ...prev, items: prev.items.map((i) => (i.id === id ? { ...i, isDone } : i)), done: prev.done + (isDone ? 1 : -1) });
    try { const next = await checklistApi.update(taskId!, id, { isDone }); queryClient.setQueryData(key, next); flash(); }
    catch (e) { if (prev) queryClient.setQueryData(key, prev); toast(errText(e, 'Could not save the checklist.'), 'error'); }
  };
  const send = async () => {
    const body = text.trim(); if (!body) return;
    setText('');
    try { await taskApi.addComment(taskId!, { body }); flash(); void invalidateWorkspace(wid, 'task', taskId); }
    catch (e) { setText(body); toast(errText(e, 'Could not post the comment.'), 'error'); }
  };
  const timer = async () => {
    const mine = running.data?.isRunning && running.data.taskId === taskId;
    try {
      if (mine) { await timeApi.stop(); toast('Time logged.'); } else { await timeApi.start(taskId!); toast('Timer started.'); }
      void invalidateWorkspace(wid, 'timer'); void invalidateWorkspace(wid, 'task', taskId); refreshWork(wid);
    } catch (e) { toast(errText(e, 'Could not change the timer.'), 'error'); }
  };

  const loggedMin = time.data ? time.data.totalMinutes : Math.round((t?.actualHours ?? 0) * 60);
  const estMin = Math.round((t?.estimatedHours ?? 0) * 60);
  const left = estMin > 0 ? Math.max(0, estMin - loggedMin) : null;
  const items = cl.data?.items ?? [];
  const blocks = deps.data?.blocks ?? [], blockedBy = deps.data?.blockedBy ?? [];
  const isRunning = running.data?.isRunning && running.data.taskId === taskId;
  const status = t?.statusCategory === 'Done' ? 'done' : '';
  const crumb = t ? <span className="cp-tag"><CalmDot color={projectColor(t.projectId)} />{[t.projectName, t.stageName, t.key].filter(Boolean).join(' · ')}</span> : null;

  return (
    <CalmSheet open={on} onClose={onClose} width={835} label="Task" title={<>{crumb && <span className="ts-crumb">{crumb}</span>}{t?.title ?? 'Task'}</>}
      actions={<><span className={`cp-saved${saved ? ' on' : ''}`} aria-live="polite"><Icon name="check" size={13} /> Saved</span>{t && onFull && <button type="button" className="cp-lk" onClick={() => onFull(t.id)} aria-label="Open full task">Full ›</button>}</>}>
      {!t ? <p className="calm-week-note">{q.isError ? 'This task could not be opened.' : 'Loading…'}</p> : (
        <div className="ts-grid">
          <div className="ts-col">
            <div className="ts-meta">
              <span>Owner</span><span>{t.assignee ? <><CalmAv name={t.assignee.name} size={22} />{t.assignee.name}</> : 'Nobody yet'}</span>
              <span>Dates</span><span>{t.startDate ? shortDay(t.startDate) : '—'} → {t.dueDate ? shortDay(t.dueDate) : 'no due date'}{t.isOverdue && <b style={{ color: 'var(--calm-red-text)' }}>overdue</b>}</span>
              <span>Status</span><span><span className={`ts-chip ${status}`}>{t.statusName}</span></span>
              {blocks.length > 0 && <><span>Blocks</span><span>{blocks.map((b) => b.task.title).join(' · ')}</span></>}
              <span>Time</span><span>{hm(loggedMin)} logged{estMin ? ` of ${hm(estMin)}` : ''} · <button type="button" className="cp-lk bl" onClick={() => void timer()}>{isRunning ? 'Stop timer' : 'Start timer'}</button></span>
              {t.milestoneName && <><span>Milestone</span><span>{t.milestoneName}</span></>}
            </div>
            <div className="ts-lab">Checklist · {cl.data?.done ?? 0} of {cl.data?.total ?? items.length}</div>
            {items.length === 0 && <p className="calm-week-note">No checklist yet.</p>}
            {items.map((i) => (
              <label key={i.id} className={`ts-check${i.isDone ? ' done' : ''}`}>
                <button type="button" className={`cp-ring${i.isDone ? ' done' : ''}`} aria-pressed={i.isDone} aria-label={i.title} onClick={() => void toggle(i.id, !i.isDone)} disabled={!t.canEdit} />
                <span>{i.title}</span>
              </label>
            ))}
            {(blockedBy.length > 0 || blocks.length > 0) && <div className="ts-lab">Linked</div>}
            {[...blockedBy.map((b) => ({ ...b, rel: 'Blocked by' })), ...blocks.map((b) => ({ ...b, rel: 'Blocks' }))].map((b) => (
              <Link key={b.id} className="ts-link" to={`/work?item=${b.task.id}`}>
                <CalmDot color={projectColor(t.projectId)} />
                <span><b>{b.task.key} · {b.task.title}</b><small>{b.rel} · {b.task.statusName}{b.task.dueDate ? ` · ${shortDay(b.task.dueDate)}` : ''}</small></span>
                <Icon name="chevronR" size={13} />
              </Link>
            ))}
            {left != null && t.statusCategory !== 'Done' && <div className="ts-aura"><CalmOrb /><span>{left > 0 ? `About ${hm(left)} left${t.dueDate ? `, due ${shortDay(t.dueDate)}` : ''}.` : `${hm(loggedMin - estMin)} over the ${hm(estMin)} estimate.`}</span></div>}
          </div>
          <div className="ts-col">
            <div className="ts-lab" style={{ marginTop: 0 }}>Comments</div>
            {(cm.data ?? []).length === 0 && <p className="calm-week-note">No comments yet.</p>}
            {(cm.data ?? []).map((c) => (
              <div key={c.id} className="ts-cm"><CalmAv name={c.author.name} size={30} /><div><b>{c.author.name.split(' ')[0]}</b><small>{at(c.createdAt)}</small><p>{c.body}</p></div></div>
            ))}
            <form className="ts-compose" onSubmit={(e) => { e.preventDefault(); void send(); }}>
              <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Add a comment…" aria-label="Add a comment" />
              <button type="submit" className="ts-send" disabled={!text.trim()} aria-label="Send"><Icon name="arrowUp" size={15} /></button>
            </form>
          </div>
        </div>
      )}
    </CalmSheet>
  );
}
