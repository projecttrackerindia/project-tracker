import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { checklistApi, planningApi, projectApi, taskApi, timeApi } from '../../api/endpoints';
import type { Checklist, Comment, Task } from '../../api/types';
import { CalmAv, CalmDot, CalmPicker, CalmSheet, CalmOrb } from '../../components/calm';
import { Icon } from '../../components/Icon';
import { projectColor } from '../../lib/calm';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { queryClient, useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { refreshWork } from '../work/workUi';
import { shortDay } from '../calm/createSheets';
import { RepeatField } from '../recurring/RepeatField';
import { templateApi } from '../recurring/api';
import { WorkItemPanel } from '../work/WorkItemPanel';
import { ActivityHistory, PanelTabs } from '../dates/ActivityHistory';
import { askExtensionReason, isExtension } from '../dates/ExtensionReason';
import { loadHint, SIZES, sizeOf } from '../projects/stagesKit';
import '../calm/calm-pages.css';
import '../projects/stagesProject.css';

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.errors[0]?.message ?? e.message : fallback);
const hm = (min: number) => { const h = Math.floor(min / 60), m = Math.round(min % 60); return h && m ? `${h}h ${m}m` : h ? `${h}h` : `${m}m`; };
const ago = (iso: string) => { const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000)); return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`; };
type TaskTab = 'details' | 'activity' | 'comments';

/**
 * The task panel (design: task-edit-web / task-edit): a right side panel on the web, a bottom sheet on a phone, the same pattern as the
 * project's Edit. "● Project · Stage", the title (tap to rename) and ✓ Saved; Details · Activity · Comments. Details edits everything in
 * place and saves as you go: Owner (with how busy they are), Stage, Status, Due (later asks why), Size, Repeat, Notes and the Checklist;
 * then time with Start timer, linked work and Save as template. "Full ›" opens the complete task (subtasks, labels, files, delete).
 */
export function CalmTaskSheet({ taskId, onClose, onFull }: { taskId: string | null; onClose: () => void; onFull?: (id: string) => void }) {
  const wid = useWorkspaceId();
  const on = !!taskId;
  const q = useWsQuery(['task', taskId], () => taskApi.get(taskId!), { enabled: on });
  const t = q.data?.task;
  const proj = useWsQuery(['project', t?.projectId], () => projectApi.get(t!.projectId), { enabled: !!t, staleTime: 60_000, retry: false });
  const ptasks = useWsQuery(['project', t?.projectId, 'tasks', 'calm'], () => taskApi.listForProject(t!.projectId), { enabled: !!t, staleTime: 30_000, retry: false });
  const cl = useWsQuery(['task', taskId, 'checklist'], () => checklistApi.get(taskId!), { enabled: on, retry: false });
  const deps = useWsQuery(['task', taskId, 'deps'], () => planningApi.dependencies(taskId!), { enabled: on, retry: false });
  const time = useWsQuery(['task', taskId, 'time'], () => timeApi.forTask(taskId!), { enabled: on, retry: false });
  const running = useWsQuery(['timer'], () => timeApi.running(), { enabled: on, staleTime: 30_000, retry: false });
  const [tab, setTab] = useState<TaskTab>('details');
  const comments = useWsQuery(['task', taskId, 'comments'], () => taskApi.comments(taskId!), { enabled: on, retry: false });
  const [saved, setSaved] = useState(false);
  const [item, setItem] = useState('');
  const [renaming, setRenaming] = useState(false);
  const flash = () => { setSaved(true); window.setTimeout(() => setSaved(false), 1600); };
  const key = [wid, 'task', taskId, 'checklist'];
  const close = () => { setTab('details'); setRenaming(false); onClose(); };

  const refresh = (next?: Task) => {
    if (next) queryClient.setQueryData([wid, 'task', taskId], (d: { task: Task } | undefined) => (d ? { ...d, task: next } : d));
    void invalidateWorkspace(wid, 'task', taskId); refreshWork(wid);
    if (t) void invalidateWorkspace(wid, 'project', t.projectId);
    flash();
  };
  /** Saves the whole task with one change on top (the update takes every field). */
  const save = async (patch: Partial<Parameters<typeof taskApi.update>[1]>, what: string) => {
    if (!t) return;
    try {
      const next = await taskApi.update(t.id, {
        title: t.title, description: t.description, statusId: t.statusId, priority: t.priority, assigneeId: t.assignee?.id ?? null, startDate: t.startDate,
        dueDate: t.dueDate, estimatedHours: t.estimatedHours, actualHours: t.actualHours, labelIds: t.labels.map((l) => l.id), milestoneId: t.milestoneId,
        stageId: t.stageId, version: t.version, ...patch,
      });
      refresh(next);
    } catch (e) { toast(errText(e, `Could not save ${what}.`), 'error'); void invalidateWorkspace(wid, 'task', taskId); }
  };
  const setDue = async (to: string) => {
    if (!t) return;
    let reason: string | null = null;
    if (isExtension(t.dueDate, to || null, true)) { reason = await askExtensionReason({ what: 'due date', from: t.dueDate, to: to || null }); if (!reason) return; }
    await save({ dueDate: to || null, dueDateReason: reason, extensionReason: reason }, 'the due date');
  };
  const setStatus = async (statusId: string) => {
    if (!t || statusId === t.statusId) return;
    try { refresh(await taskApi.move(t.id, { statusId })); } catch (e) { toast(errText(e, 'Could not change the status.'), 'error'); }
  };
  const toggle = async (id: string, isDone: boolean) => {
    const prev = queryClient.getQueryData<Checklist>(key);
    if (prev) queryClient.setQueryData<Checklist>(key, { ...prev, items: prev.items.map((i) => (i.id === id ? { ...i, isDone } : i)), done: prev.done + (isDone ? 1 : -1) });
    try { const next = await checklistApi.update(taskId!, id, { isDone }); queryClient.setQueryData(key, next); flash(); }
    catch (e) { if (prev) queryClient.setQueryData(key, prev); toast(errText(e, 'Could not save the checklist.'), 'error'); }
  };
  const addItem = async () => {
    const title = item.trim(); if (!title) return;
    setItem('');
    try { const next = await checklistApi.add(taskId!, title); queryClient.setQueryData(key, next); flash(); }
    catch (e) { setItem(title); toast(errText(e, 'Could not add it.'), 'error'); }
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
  const detail = proj.data;
  const stage = detail?.stages.find((s) => s.id === t?.stageId);
  const status = detail?.statuses.find((s) => s.id === t?.statusId);
  const hint = t?.assignee ? loadHint(t.assignee.id, ptasks.data?.items) : null;
  const size = sizeOf(t?.estimatedHours);
  const crumb = t ? <span className="cp-tag"><CalmDot color={projectColor(t.projectId)} />{[t.projectName, t.stageName].filter(Boolean).join(' · ')}</span> : null;
  const ro = !t?.canEdit;
  const title = t && renaming && !ro ? (
    <input className="stg-title-in" autoFocus defaultValue={t.title} maxLength={300} aria-label="Task title"
      onBlur={(e) => { setRenaming(false); const v = e.target.value.trim(); if (v && v !== t.title) void save({ title: v }, 'the title'); }}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setRenaming(false); }} />
  ) : <span className="stg-title-t" onClick={() => setRenaming(true)}>{t?.title ?? 'Task'}</span>;

  return (
    <CalmSheet open={on} onClose={close} width={620} clear className="stg-panel" label={t?.title ?? 'Task'} title={<>{crumb && <span className="ts-crumb">{crumb}</span>}{title}</>}
      actions={<><span className={`cp-saved${saved ? ' on' : ''}`} aria-live="polite" data-testid="saved"><Icon name="tick" size={13} /> Saved</span>{t && onFull && <button type="button" className="cp-lk" onClick={() => onFull(t.id)} aria-label="Open full task">Full ›</button>}</>}>
      {!t ? <p className="calm-week-note">{q.isError ? 'This task could not be opened.' : 'Loading…'}</p> : (
        <div className="stg-task-panel" data-testid="task-panel">
          <div className="stg-tabs line" role="tablist" aria-label="Task">
            {(['details', 'activity', 'comments'] as TaskTab[]).map((x) => (
              <button key={x} type="button" role="tab" aria-selected={tab === x} className={tab === x ? 'on' : ''} onClick={() => setTab(x)}>
                {x === 'details' ? 'Details' : x === 'activity' ? 'Activity' : `Comments${(comments.data?.length ?? t.commentCount) ? ` ${comments.data?.length ?? t.commentCount}` : ''}`}
              </button>
            ))}
          </div>
          {tab === 'activity' && <ActivityHistory type="task" id={t.id} />}
          {tab === 'comments' && <Comments taskId={t.id} list={comments.data} loading={comments.isLoading} onSaved={flash} />}
          {tab === 'details' && <>
            <div className="stg-rows" data-testid="task-sheet-fields">
              <div className="stg-row"><span>Owner</span>
                <span className="stg-val">
                  {/* LOAD-PICKER HOOK: swap for the load engine's picker (load-v2) when it lands; loadHint() is the fallback signal. */}
                  <CalmPicker label="Owner" value={t.assignee?.id ?? null} disabled={ro} recentKey="person" className="stg-pick" allowClear
                    selected={t.assignee ? { id: t.assignee.id, label: t.assignee.name } : null}
                    items={(detail?.members ?? []).map((m) => { const h = loadHint(m.userId, ptasks.data?.items); return { id: m.userId, label: m.name, sub: h?.label ?? m.role }; })}
                    onChange={(id) => id !== (t.assignee?.id ?? null) && void save({ assigneeId: id }, 'the owner')} />
                  {hint && <em className={`stg-hint ${hint.tone}`}>· {hint.label}</em>}
                </span>
              </div>
              {(detail?.stages.length ?? 0) > 0 && !t.parentTaskId && (
                <div className="stg-row"><span>Stage</span>
                  <CalmPicker label="Stage" value={t.stageId} disabled={ro} className="stg-pick" selected={stage ? { id: stage.id, label: stage.name } : null}
                    items={[...(detail?.stages ?? [])].sort((a, b) => a.order - b.order).map((s) => ({ id: s.id, label: s.name, sub: s.effectiveStatus === 'Completed' ? 'Done' : s.plannedEnd ? shortDay(s.plannedEnd) : null }))}
                    onChange={(id) => id && id !== t.stageId && void save({ stageId: id }, 'the stage')} />
                </div>
              )}
              <div className="stg-row"><span>Status</span>
                <CalmPicker label="Status" value={t.statusId} disabled={ro} className="stg-pick" selected={{ id: t.statusId, label: t.statusName, dot: status?.color ?? t.statusColor }}
                  items={[...(detail?.statuses ?? [])].sort((a, b) => a.order - b.order).map((s) => ({ id: s.id, label: s.name, dot: s.color }))}
                  onChange={(id) => id && void setStatus(id)} />
              </div>
              <label className="stg-row"><span>Due</span>
                <span className="stg-val date"><b>{t.dueDate ? shortDay(t.dueDate) : 'No date'}</b>
                  <input type="date" value={t.dueDate ?? ''} disabled={ro} aria-label="Due date" onClick={(e) => { try { (e.target as HTMLInputElement).showPicker?.(); } catch { /* unsupported */ } }} onChange={(e) => void setDue(e.target.value)} />
                </span>
              </label>
              <div className="stg-row"><span>Size</span>
                <CalmPicker label="Size" value={size} disabled={ro} className="stg-pick" allowClear selected={size ? { id: size, label: `${size} · ${hm(estMin)}` } : null}
                  items={SIZES.map((x) => ({ id: x.id, label: `${x.id} · ${x.hours}h` }))}
                  onChange={(id) => void save({ estimatedHours: id ? SIZES.find((x) => x.id === id)!.hours : null }, 'the size')} />
              </div>
              {!t.parentTaskId && <div className="stg-row"><span>Repeat</span><span className="stg-val"><RepeatField taskId={t.id} dueDate={t.dueDate} canEdit={t.canEdit} /></span></div>}
            </div>
            <h5 className="stg-cap">Notes</h5>
            <textarea key={`n${t.version}`} className="stg-notes" rows={3} defaultValue={t.description ?? ''} disabled={ro} placeholder="Add notes…" aria-label="Notes"
              onBlur={(e) => { if (e.target.value !== (t.description ?? '')) void save({ description: e.target.value }, 'the notes'); }} />
            <h5 className="stg-cap">Checklist · {cl.data?.done ?? 0} of {cl.data?.total ?? items.length}</h5>
            {items.map((i) => (
              <label key={i.id} className={`ts-check${i.isDone ? ' done' : ''}`}>
                <button type="button" className={`cp-ring${i.isDone ? ' done' : ''}`} aria-pressed={i.isDone} aria-label={i.title} onClick={() => void toggle(i.id, !i.isDone)} disabled={ro} />
                <span>{i.title}</span>
              </label>
            ))}
            {!ro && (
              <form className="stg-additem" onSubmit={(e) => { e.preventDefault(); void addItem(); }}>
                <Icon name="plus" size={14} />
                <input value={item} onChange={(e) => setItem(e.target.value)} placeholder="Add item" aria-label="Add a checklist item" maxLength={300} />
              </form>
            )}
            <h5 className="stg-cap">Time</h5>
            <p className="calm-week-note">{hm(loggedMin)} logged{estMin ? ` of ${hm(estMin)}` : ''} · <button type="button" className="cp-lk bl" onClick={() => void timer()}>{isRunning ? 'Stop timer' : 'Start timer'}</button></p>
            {(blockedBy.length > 0 || blocks.length > 0) && <h5 className="stg-cap">Linked</h5>}
            {[...blockedBy.map((b) => ({ ...b, rel: 'Blocked by' })), ...blocks.map((b) => ({ ...b, rel: 'Blocks' }))].map((b) => (
              <Link key={b.id} className="ts-link" to={`/work?item=${b.task.id}`}>
                <CalmDot color={projectColor(t.projectId)} />
                <span><b>{b.task.key} · {b.task.title}</b><small>{b.rel} · {b.task.statusName}{b.task.dueDate ? ` · ${shortDay(b.task.dueDate)}` : ''}</small></span>
                <Icon name="chevronR" size={13} />
              </Link>
            ))}
            {left != null && t.statusCategory !== 'Done' && <div className="ts-aura"><CalmOrb /><span>{left > 0 ? `About ${hm(left)} left${t.dueDate ? `, due ${shortDay(t.dueDate)}` : ''}.` : `${hm(loggedMin - estMin)} over the ${hm(estMin)} estimate.`}</span></div>}
            {!t.parentTaskId && <p className="stg-foot"><button type="button" className="cp-lk bl" data-testid="save-task-template" onClick={() => void templateApi.saveTask(t.id).then(() => toast('Saved as a task template.'), () => toast('Could not save the template.', 'error'))}>Save as template</button>
              {onFull && <> · <button type="button" className="cp-lk bl" onClick={() => onFull(t.id)}>Subtasks, labels, files ›</button></>}</p>}
          </>}
        </div>
      )}
    </CalmSheet>
  );
}

function Comments({ taskId, list, loading, onSaved }: { taskId: string; list: Comment[] | undefined; loading: boolean; onSaved: () => void }) {
  const wid = useWorkspaceId();
  const [text, setText] = useState('');
  const send = async () => {
    const body = text.trim(); if (!body) return;
    setText('');
    try { await taskApi.addComment(taskId, { body }); await invalidateWorkspace(wid, 'task', taskId, 'comments'); onSaved(); }
    catch (e) { setText(body); toast(errText(e, 'Could not post it.'), 'error'); }
  };
  return (
    <div className="stg-comments" data-testid="task-comments">
      {loading ? <p className="calm-week-note">Loading…</p> : !list?.length ? <p className="calm-week-note">No comments yet.</p> : list.map((c) => (
        <div key={c.id} className="stg-comment"><CalmAv name={c.author.name} size={28} /><div><b>{c.author.name}</b> <small>{ago(c.createdAt)}</small><p>{c.body}</p></div></div>
      ))}
      <form className="ts-compose" onSubmit={(e) => { e.preventDefault(); void send(); }}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Write a comment…" aria-label="Write a comment" maxLength={4000} />
        <button type="submit" className="ts-send" disabled={!text.trim()} aria-label="Send"><Icon name="send" size={15} /></button>
      </form>
    </div>
  );
}

/**
 * Any piece of work (a Plan sheet task, an action item, an issue) opened beside the page you are on, so you stay in Portfolio: the full
 * Work panel (status, owner, dates, priority, comments, history), every field edited in place and saved optimistically. A save refreshes
 * the shared work, plan sheet and action item queries, so the change shows everywhere at once.
 */
export function CalmWorkSheet({ id, title, onClose, kind = 'task' }: { id: string | null; title?: string; onClose: () => void; kind?: 'task' | 'actionitem' }) {
  const [tab, setTab] = useState<'details' | 'activity'>('details');
  return (
    <CalmSheet open={!!id} onClose={() => { setTab('details'); onClose(); }} width={720} label="Work item" title={title ?? 'Details'}>
      {id && <div className="cws-body" data-testid="calm-work-sheet">
        <PanelTabs tab={tab} setTab={setTab} />
        {tab === 'activity' ? <ActivityHistory type={kind} id={id} /> : <WorkItemPanel id={id} onClose={onClose} embedded />}
      </div>}
    </CalmSheet>
  );
}
