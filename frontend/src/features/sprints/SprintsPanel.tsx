import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { sprintApi, taskApi } from '../../api/endpoints';
import type { Sprint, Task } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Badge, EmptyState, Field, Modal, PriorityBadge, Progress, SubmitButton, TaskStatusBadge } from '../../components/ui';
import { dateOffset, formatDate, todayISO } from '../../lib/format';
import { useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
import { Burndown } from './Burndown';
import { Select } from '../../components/Select';

const tone = (s: Sprint['status']) => (s === 'Active' ? 'success' : s === 'Completed' ? 'neutral' : 'info');

/** Sprint planning for a project: plan backlog tasks into sprints, run one sprint at a time, and see how it burns down. */
export function SprintsPanel({ projectId, canEdit, canPlan, onOpenTask }: { projectId: string; canEdit: boolean; canPlan: boolean; onOpenTask: (id: string) => void }) {
  const wid = useWorkspaceId();
  const qc = useQueryClient();
  const sprints = useWsQuery(['sprints', projectId], () => sprintApi.list(projectId));
  const [modal, setModal] = useState<{ sprint?: Sprint } | null>(null);
  const [completing, setCompleting] = useState<Sprint | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const list = sprints.data ?? [];
  const active = list.find((s) => s.status === 'Active');
  const opened = open ?? active?.id ?? null;

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: [wid, 'sprints', projectId] });
    void qc.invalidateQueries({ queryKey: [wid, 'sprint-tasks', projectId] });
    void qc.invalidateQueries({ queryKey: [wid, 'project', projectId] });
    void qc.invalidateQueries({ queryKey: [wid, 'tasks'] });
  };
  const fail = (e: unknown, fallback: string) => toast(e instanceof ApiError ? e.message : fallback, 'error');

  const start = async (s: Sprint) => {
    try { await sprintApi.start(projectId, s.id); toast(`“${s.name}” started.`); refresh(); } catch (e) { fail(e, 'Could not start the sprint.'); }
  };
  const remove = async (s: Sprint) => {
    if (!(await confirmDialog({ title: 'Delete sprint?', message: `“${s.name}” will be deleted. Its ${s.taskTotal} task${s.taskTotal === 1 ? '' : 's'} go back to the backlog.`, confirmText: 'Delete' }))) return;
    try { await sprintApi.remove(projectId, s.id); toast('Sprint deleted.', 'warning'); refresh(); } catch (e) { fail(e, 'Could not delete the sprint.'); }
  };

  return (
    <>
      <div className="card mb-22">
        <div className="card-head">
          <h3><Icon name="flag" size={16} /> Sprints</h3>
          {canEdit && <button className="btn btn-primary btn-sm" onClick={() => setModal({})}><Icon name="plus" size={14} /> New sprint</button>}
        </div>
        <div className="card-body">
          {list.length === 0 ? (
            <EmptyState icon="flag" title="No sprints yet" text={canEdit ? 'Create a sprint, then plan tasks from the backlog into it.' : 'Nobody has planned a sprint for this project yet.'} />
          ) : (
            <div className="sprint-list">
              {list.map((s) => (
                <div className={`sprint ${s.status.toLowerCase()}`} key={s.id}>
                  <div className="sprint-head">
                    <button type="button" className="sprint-title" onClick={() => setOpen(opened === s.id ? '' : s.id)} aria-expanded={opened === s.id}>
                      <Icon name={opened === s.id ? 'chevronD' : 'chevronR'} size={16} />
                      <b>{s.name}</b> <Badge tone={tone(s.status)}>{s.status}</Badge>
                      {s.isOverdue && <Badge tone="danger">Past its end date</Badge>}
                    </button>
                    <div className="muted sprint-dates">{formatDate(s.startDate)} – {formatDate(s.endDate)}{s.daysLeft !== null ? ` · ${s.daysLeft} day${s.daysLeft === 1 ? '' : 's'} left` : ''}</div>
                    {canEdit && (
                      <div className="td-actions">
                        {s.status === 'Planned' && <button className="btn btn-primary btn-sm" onClick={() => void start(s)} disabled={!!active}>Start</button>}
                        {s.status === 'Active' && <button className="btn btn-primary btn-sm" onClick={() => setCompleting(s)}>Complete</button>}
                        {s.status !== 'Completed' && <button type="button" className="btn-icon" title="Edit" aria-label={`Edit ${s.name}`} onClick={() => setModal({ sprint: s })}><Icon name="edit" /></button>}
                        {s.status === 'Planned' && <button type="button" className="btn-icon danger" title="Delete" aria-label={`Delete ${s.name}`} onClick={() => void remove(s)}><Icon name="trash" /></button>}
                      </div>
                    )}
                  </div>
                  {s.goal && <div className="muted" style={{ fontSize: 13, margin: '2px 0 8px 24px' }}>Goal: {s.goal}</div>}
                  <div className="row" style={{ gap: 12, margin: '0 0 0 24px' }}>
                    <div style={{ flex: 1 }}><Progress value={s.progress} /></div>
                    <span className="muted" style={{ fontSize: 12.5, whiteSpace: 'nowrap' }}>{s.taskDone}/{s.taskTotal} done{s.estimatedHours ? ` · ${s.estimatedHours}h est.` : ''}</span>
                  </div>
                  {opened === s.id && <SprintBody projectId={projectId} sprint={s} canPlan={canPlan} onChanged={refresh} onOpenTask={onOpenTask} />}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <Backlog projectId={projectId} sprints={list.filter((s) => s.status !== 'Completed')} canPlan={canPlan} onChanged={refresh} onOpenTask={onOpenTask} />
      {modal && <SprintModal projectId={projectId} sprint={modal.sprint} onClose={() => setModal(null)} onSaved={refresh} />}
      {completing && <CompleteModal projectId={projectId} sprint={completing} others={list.filter((s) => s.status === 'Planned')} onClose={() => setCompleting(null)} onDone={refresh} />}
    </>
  );
}

function TaskRow({ t, checked, onCheck, onOpen }: { t: Task; checked?: boolean; onCheck?: (v: boolean) => void; onOpen: (id: string) => void }) {
  return (
    <div className="sprint-task">
      {onCheck && <input type="checkbox" aria-label={`Select ${t.key}`} checked={!!checked} onChange={(e) => onCheck(e.target.checked)} />}
      <button type="button" className="link" onClick={() => onOpen(t.id)}><b>{t.key}</b> {t.title}</button>
      <span className="sprint-task-meta"><PriorityBadge priority={t.priority} /><TaskStatusBadge name={t.statusName} category={t.statusCategory} />{t.assignee && <span className="muted">{t.assignee.name}</span>}</span>
    </div>
  );
}

function SprintBody({ projectId, sprint, canPlan, onChanged, onOpenTask }: { projectId: string; sprint: Sprint; canPlan: boolean; onChanged: () => void; onOpenTask: (id: string) => void }) {
  const tasks = useWsQuery(['sprint-tasks', projectId, sprint.id], () => taskApi.listForProject(projectId, { sprintId: sprint.id, pageSize: 200 }));
  const detail = useWsQuery(['sprints', projectId, sprint.id], () => sprintApi.get(projectId, sprint.id), { enabled: sprint.status !== 'Planned' });
  const [picked, setPicked] = useState<string[]>([]);
  const items = tasks.data?.items ?? [];
  const toBacklog = async () => {
    try { await sprintApi.toBacklog(projectId, picked); setPicked([]); toast('Moved to the backlog.'); onChanged(); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Could not move the tasks.', 'error'); }
  };
  return (
    <div className="sprint-body">
      {sprint.status !== 'Planned' && (detail.data?.burndown.length ?? 0) > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div className="muted" style={{ fontSize: 12, marginBottom: 4 }}>Burndown: tasks still open at the end of each day ({sprint.committed} committed)</div>
          <Burndown points={detail.data!.burndown} />
        </div>
      )}
      {items.length === 0 ? <div className="muted" style={{ fontSize: 13 }}>No tasks in this sprint yet. Add some from the backlog below.</div> : (
        <>
          {items.map((t) => <TaskRow key={t.id} t={t} onOpen={onOpenTask} checked={picked.includes(t.id)} onCheck={canPlan && sprint.status !== 'Completed' ? (v) => setPicked((p) => (v ? [...p, t.id] : p.filter((x) => x !== t.id))) : undefined} />)}
          {picked.length > 0 && <button className="btn btn-ghost btn-sm" style={{ marginTop: 8 }} onClick={() => void toBacklog()}>Move {picked.length} to backlog</button>}
        </>
      )}
    </div>
  );
}

function Backlog({ projectId, sprints, canPlan, onChanged, onOpenTask }: { projectId: string; sprints: Sprint[]; canPlan: boolean; onChanged: () => void; onOpenTask: (id: string) => void }) {
  const tasks = useWsQuery(['sprint-tasks', projectId, 'backlog'], () => taskApi.listForProject(projectId, { backlog: true, openOnly: true, pageSize: 200 }));
  const [picked, setPicked] = useState<string[]>([]);
  const [target, setTarget] = useState('');
  const items = tasks.data?.items ?? [];
  const chosen = target || sprints[0]?.id || '';

  const add = async () => {
    if (!chosen || picked.length === 0) return;
    try { await sprintApi.addTasks(projectId, chosen, picked); setPicked([]); toast('Tasks added to the sprint.'); onChanged(); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Could not add the tasks.', 'error'); }
  };

  return (
    <div className="card">
      <div className="card-head">
        <h3>Backlog <span className="muted" style={{ fontWeight: 400 }}>· {items.length} open task{items.length === 1 ? '' : 's'} not in a sprint</span></h3>
        {canPlan && sprints.length > 0 && items.length > 0 && (
          <div className="row" style={{ gap: 8 }}>
            <Select className="select" style={{ width: 'auto' }} value={chosen} onChange={(e) => setTarget(e.target.value)} aria-label="Sprint">
              {sprints.map((s) => <option key={s.id} value={s.id}>{s.name}{s.status === 'Active' ? ' (running)' : ''}</option>)}
            </Select>
            <button className="btn btn-primary btn-sm" disabled={picked.length === 0} onClick={() => void add()}>Add {picked.length || ''} to sprint</button>
          </div>
        )}
      </div>
      <div className="card-body">
        {items.length === 0 ? <EmptyState icon="check" title="Backlog is empty" text="Every open task is planned into a sprint." /> : items.map((t) => (
          <TaskRow key={t.id} t={t} onOpen={onOpenTask} checked={picked.includes(t.id)} onCheck={canPlan && sprints.length > 0 ? (v) => setPicked((p) => (v ? [...p, t.id] : p.filter((x) => x !== t.id))) : undefined} />
        ))}
        {sprints.length === 0 && items.length > 0 && <div className="muted" style={{ fontSize: 12.5, marginTop: 10 }}>Create a sprint to start planning these tasks.</div>}
      </div>
    </div>
  );
}

function SprintModal({ projectId, sprint, onClose, onSaved }: { projectId: string; sprint?: Sprint; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(sprint?.name ?? '');
  const [goal, setGoal] = useState(sprint?.goal ?? '');
  const [start, setStart] = useState(sprint?.startDate ?? todayISO());
  const [end, setEnd] = useState(sprint?.endDate ?? dateOffset(13));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const running = sprint?.status === 'Active';

  const submit = async () => {
    if (!name.trim()) return setError('Give the sprint a name.');
    if (end < start) return setError('The sprint must not end before it starts.');
    setBusy(true); setError(null);
    try {
      const body = { name: name.trim(), goal: goal.trim() || null, startDate: start, endDate: end };
      if (sprint) await sprintApi.update(projectId, sprint.id, body); else await sprintApi.create(projectId, body);
      toast(sprint ? 'Sprint updated.' : 'Sprint created.'); onSaved(); onClose();
    } catch (e) { setError(e instanceof ApiError ? e.errors[0]?.message ?? e.message : 'Could not save the sprint.'); }
    finally { setBusy(false); }
  };

  return (
    <Modal size="sm" title={sprint ? 'Edit sprint' : 'New sprint'} onClose={onClose} onSubmit={(e) => { e.preventDefault(); void submit(); }}
      footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><SubmitButton busy={busy}>{sprint ? 'Save sprint' : 'Create sprint'}</SubmitButton></>}>
      {error && <div className="form-error" role="alert">{error}</div>}
      <Field label="Name" required><input className="input" maxLength={100} autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Sprint 12" /></Field>
      <Field label="Goal"><textarea className="textarea" rows={2} maxLength={500} value={goal} onChange={(e) => setGoal(e.target.value)} placeholder="What should be true when this sprint ends?" /></Field>
      <div className="grid-2">
        <Field label="Starts"><input className="input" type="date" value={start} disabled={running} onChange={(e) => setStart(e.target.value)} /></Field>
        <Field label="Ends"><input className="input" type="date" value={end} onChange={(e) => setEnd(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

function CompleteModal({ projectId, sprint, others, onClose, onDone }: { projectId: string; sprint: Sprint; others: Sprint[]; onClose: () => void; onDone: () => void }) {
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unfinished = sprint.taskTotal - sprint.taskDone;

  const submit = async () => {
    setBusy(true); setError(null);
    try { await sprintApi.complete(projectId, sprint.id, target || null); toast(`“${sprint.name}” completed.`); onDone(); onClose(); }
    catch (e) { setError(e instanceof ApiError ? e.message : 'Could not complete the sprint.'); }
    finally { setBusy(false); }
  };
  return (
    <Modal size="sm" title={`Complete “${sprint.name}”`} onClose={onClose} onSubmit={(e) => { e.preventDefault(); void submit(); }}
      footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><SubmitButton busy={busy}>Complete sprint</SubmitButton></>}>
      {error && <div className="form-error" role="alert">{error}</div>}
      <p style={{ marginTop: 0 }}>{sprint.taskDone} of {sprint.taskTotal} tasks are done. {unfinished > 0 ? `${unfinished} unfinished task${unfinished === 1 ? '' : 's'} will move:` : 'Nothing is left over.'}</p>
      {unfinished > 0 && (
        <Field label="Move unfinished tasks to">
          <Select className="select" value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">The backlog</option>
            {others.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </Field>
      )}
    </Modal>
  );
}
