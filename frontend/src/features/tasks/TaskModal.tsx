import { useEffect, useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { labelApi, planningApi, projectApi, taskApi, workspaceApi } from '../../api/endpoints';
import type { Priority, WorkflowStatus } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Attachments } from '../files/Attachments';
import { Dependencies } from '../planning/Dependencies';
import { TimeTracker } from '../time/TimeTracker';
import { DevLinks } from '../settings/IntegrationSettings';
import { Viewers } from '../live/Viewers';
import { Checklist } from './Checklist';
import { TargetDocuments } from '../documents/LinkedWork';
import { CustomFieldsSection } from '../customfields/CustomFieldsSection';
import { customFieldApi, sprintApi } from '../../api/endpoints';
import { Avatar, Field, Modal, PageLoader, SubmitButton, PriorityOptions } from '../../components/ui';
import { formatDateTime, timeAgo } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useCan, useModule, useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
import { reportTaskError } from './actions';
import { Select } from '../../components/Select';
import { DueChangeFields, dueChange } from '../projects/DueChangeFields';
import { RemindMeButton } from '../reminders/RemindMe';

interface Form {
  title: string; description: string; statusId: string; priority: Priority; assigneeId: string;
  startDate: string; dueDate: string; estimatedHours: string; actualHours: string; labelIds: string[]; milestoneId: string; stageId: string;
}
const EMPTY: Form = { title: '', description: '', statusId: '', priority: 'Medium', assigneeId: '', startDate: '', dueDate: '', estimatedHours: '', actualHours: '', labelIds: [], milestoneId: '', stageId: '' };
const NO_STATUSES: WorkflowStatus[] = [];

/** Create or edit a task. Also hosts subtasks and the comment thread when editing. */
export function TaskModal({ taskId, projectId, statusId, onClose }: { taskId?: string; projectId?: string; statusId?: string; onClose: () => void }) {
  const wid = useWorkspaceId();
  const canCreate = useCan('tasks.create');
  const canDelete = useCan('tasks.delete');
  const canComment = useCan('tasks.comment');

  const [currentId, setCurrentId] = useState<string | undefined>(taskId);
  const [pickedProject, setPickedProject] = useState(projectId ?? '');
  const [f, setF] = useState<Form>({ ...EMPTY, statusId: statusId ?? '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  // Why an existing due date is being moved (kept in the task's date history and shown on the Portfolio page).
  const [dueReason, setDueReason] = useState('');
  const [dueDependency, setDueDependency] = useState('');
  const isEdit = !!currentId;
  const [more, setMore] = useState(false);   // a new task asks for the few things that matter; the rest is one click away
  const show = isEdit || more;

  const detail = useWsQuery(['task', currentId], () => taskApi.get(currentId!), { enabled: isEdit });
  const task = detail.data?.task;
  const readOnly = isEdit ? !task?.canEdit : !canCreate;
  const pid = task?.projectId ?? pickedProject;
  const project = useWsQuery(['project', pid], () => projectApi.get(pid), { enabled: !!pid });
  const members = useWsQuery(['members'], workspaceApi.members);
  const canPlan = useModule('projects') > 0;
  const milestones = useWsQuery(['milestones', pid], () => planningApi.milestones(pid), { enabled: !!pid && canPlan });
  const labels = useWsQuery(['labels'], labelApi.list);
  const sprints = useWsQuery(['sprints', pid], () => sprintApi.list(pid), { enabled: !!pid && isEdit && canPlan });
  const projects = useWsQuery(['projects', 'options'], () => projectApi.list({ pageSize: 100 }), { enabled: !isEdit && !projectId });

  const statuses = project.data?.statuses ?? NO_STATUSES;
  const stages = project.data?.stages ?? [];
  // A top-level task must sit in a timeline phase. (An older task that never had one is not forced to pick one just to be edited.)
  const showStage = stages.length > 0 && !task?.parentTaskId;
  const stageRequired = showStage && (!isEdit || !!task?.stageId);
  // Prime the form when a task loads (or reloads after a save), and default a new task's status.
  useEffect(() => {
    if (!task) return;
    setF({
      title: task.title, description: task.description ?? '', statusId: task.statusId, priority: task.priority, assigneeId: task.assignee?.id ?? '',
      startDate: task.startDate ?? '', dueDate: task.dueDate ?? '', estimatedHours: task.estimatedHours?.toString() ?? '',
      actualHours: task.actualHours?.toString() ?? '', labelIds: task.labels.map((l) => l.id), milestoneId: task.milestoneId ?? '', stageId: task.stageId ?? '',
    });
    setDueReason(''); setDueDependency('');
  }, [task?.id, task?.version]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!isEdit && statuses.length && !statuses.some((s) => s.id === f.statusId))
      setF((p) => ({ ...p, statusId: (statuses.find((s) => s.category === 'Todo') ?? statuses[0]).id }));
  }, [statuses, isEdit]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = <K extends keyof Form>(k: K, v: Form[K]) => { setF((p) => ({ ...p, [k]: v })); setErrors((e) => ({ ...e, [k]: '' })); };

  const validate = () => {
    const e: Record<string, string> = {};
    if (!f.title.trim()) e.title = 'Task title is required.';
    if (!isEdit && !pid) e.project = 'Choose a project.';
    if (stageRequired && !f.stageId) e.stageId = 'Choose the timeline phase this task belongs to.';
    if (f.startDate && f.dueDate && f.dueDate < f.startDate) e.dueDate = 'Due date must not be before the start date.';
    if (isEdit && dueChange(task?.dueDate, f.dueDate)?.delay && !dueReason.trim()) e.dueDateReason = 'Say why the due date is moving.';
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const payload = () => ({
    title: f.title.trim(), description: f.description.trim() || null, priority: f.priority, assigneeId: f.assigneeId || null,
    startDate: f.startDate || null, dueDate: f.dueDate || null, estimatedHours: f.estimatedHours ? Number(f.estimatedHours) : null,
    labelIds: f.labelIds, milestoneId: f.milestoneId || null, stageId: f.stageId || null,
  });

  const [pendingFields, setPendingFields] = useState<Record<string, string>>({});

  const save = useMutation({
    mutationFn: () => isEdit
      ? taskApi.update(currentId!, {
          ...payload(), statusId: f.statusId, actualHours: f.actualHours ? Number(f.actualHours) : null, version: task!.version,
          ...(dueChange(task!.dueDate, f.dueDate) ? { dueDateReason: dueReason.trim() || null, dueDateDependency: dueDependency.trim() || null } : {}),
        })
      : taskApi.create(pid, { ...payload(), statusId: f.statusId || null }).then(async (created) => {
          const filled = Object.fromEntries(Object.entries(pendingFields).filter(([, v]) => v !== ''));
          if (Object.keys(filled).length > 0) await customFieldApi.setValues(created.id, filled).catch(() => toast('The task was created, but some custom fields could not be saved.', 'warning'));
          return created;
        }),
    onSuccess: async () => { toast(isEdit ? 'Task updated.' : 'Task created.'); await invalidateWorkspace(wid); onClose(); },
    onError: async (err) => {
      if (err instanceof ApiError) {
        if (err.code === 'TASK_INCOMPLETE_CHILDREN' || err.code === 'STAGE_PREVIOUS_INCOMPLETE') {
          reportTaskError(err, '');
          if (task) set('statusId', task.statusId); // the task stays where it was, so the form should say so
          return;
        }
        if (err.code === 'VERSION_CONFLICT') { toast('Someone else changed this task. Reloaded the latest version.', 'warning'); await invalidateWorkspace(wid, 'task'); return; }
        const fe: Record<string, string> = {};
        err.errors.forEach((x) => { if (x.field) fe[x.field] = x.message; });
        setErrors((p) => ({ ...p, ...fe }));
        if (!Object.keys(fe).length || err.errors.some((x) => !x.field)) setFormError(err.message);
      } else setFormError('Could not save the task.');
    },
  });

  const remove = async () => {
    if (!task || !(await confirmDialog({ title: 'Delete task?', message: `Delete ${task.key} “${task.title}” and its subtasks?` }))) return;
    try { await taskApi.remove(task.id); toast('Task deleted.', 'warning'); await invalidateWorkspace(wid); onClose(); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Could not delete the task.', 'error'); }
  };

  const sortedStatuses = useMemo(() => [...statuses].sort((a, b) => a.order - b.order), [statuses]);

  if (isEdit && detail.isLoading) return <Modal title="Task" onClose={onClose}><PageLoader /></Modal>;
  if (isEdit && detail.isError) return <Modal title="Task" onClose={onClose}><div className="form-error">This task could not be loaded. It may have been deleted.</div></Modal>;

  return (
    <Modal size="lg" onClose={onClose}
      title={isEdit ? `${task?.key} · Edit task` : 'Add new task'}
      subtitle={isEdit ? (readOnly ? 'You have read-only access to this task.' : 'Update the details of this task.') : 'Create a task and assign it to a project.'}
      onSubmit={(e) => { e.preventDefault(); setFormError(null); if (!readOnly && validate()) save.mutate(); }}
      footer={<>
        {isEdit && canDelete && <button type="button" className="btn btn-danger" onClick={remove} style={{ marginRight: 'auto' }}><Icon name="trash" /> Delete</button>}
        <button type="button" className="btn btn-ghost" onClick={onClose}>{readOnly ? 'Close' : 'Cancel'}</button>
        {!readOnly && <SubmitButton busy={save.isPending}>{isEdit ? 'Save changes' : 'Save task'}</SubmitButton>}
      </>}>
      {task?.parentTaskId && <button type="button" className="link" style={{ marginBottom: 12, fontSize: 12.5 }} onClick={() => setCurrentId(task.parentTaskId!)}>← Back to parent task</button>}
      {isEdit && task && (
        <div className="rm-bar"><Viewers kind="task" id={task.id} />
          <RemindMeButton subject={{ type: 'Task', id: task.id, title: task.title, key: task.key, due: task.dueDate, assigneeId: task.assignee?.id, assigneeName: task.assignee?.name }} /></div>
      )}
      {formError && <div className="form-error" role="alert">{formError}</div>}

      <fieldset disabled={readOnly} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        <div className="form-grid">
          <Field label="Task title" required full error={errors.title}>
            <input className="input" value={f.title} onChange={(e) => set('title', e.target.value)} placeholder="e.g. Complete API development" maxLength={200} />
          </Field>
          {show && <Field label="Description" full error={errors.description}>
            <textarea className="textarea" value={f.description} onChange={(e) => set('description', e.target.value)} placeholder="What needs to be done?" />
          </Field>}

          {!isEdit && !projectId && (
            <Field label="Project" required error={errors.project}>
              <Select className="select" value={pickedProject} onChange={(e) => { setPickedProject(e.target.value); setF((p) => ({ ...p, statusId: '', stageId: '' })); setErrors((x) => ({ ...x, project: '' })); }}>
                <option value="">Select a project…</option>
                {projects.data?.items.filter((p) => p.status !== 'Archived').map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </Select>
            </Field>
          )}
          {showStage && (
            <Field label="Timeline phase" required={stageRequired} error={errors.stageId}
              hint={(() => {
                const picked = stages.find((s) => s.id === f.stageId);
                if (picked?.locked) return `Locked until “${picked.lockedBy}” is completed. The task can be worked on, but not completed before then.`;
                return picked?.status === 'Completed' ? 'This phase is already completed. Adding an unfinished task reopens it.' : 'The phase completes once all of its tasks are completed.';
              })()}>
              <Select className="select" value={f.stageId} onChange={(e) => set('stageId', e.target.value)} disabled={!pid}>
                <option value="">{pid ? 'Select a phase…' : 'Choose a project first'}</option>
                {stages.map((s) => <option key={s.id} value={s.id}>{s.name}{s.status === 'Completed' ? ' (completed)' : s.locked ? ' (locked)' : ''}</option>)}
              </Select>
            </Field>
          )}
          {show && <Field label="Status" error={errors.statusId}>
            <Select className="select" value={f.statusId} onChange={(e) => set('statusId', e.target.value)} disabled={!pid}>
              {sortedStatuses.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </Field>}
          {show && <Field label="Priority">
            <Select className="select" value={f.priority} onChange={(e) => set('priority', e.target.value as Priority)}><PriorityOptions /></Select>
          </Field>}
          <Field label="Assignee" error={errors.assigneeId}>
            <Select className="select" value={f.assigneeId} onChange={(e) => set('assigneeId', e.target.value)}>
              <option value="">Unassigned</option>
              {members.data?.filter((m) => m.role !== 'Guest' || m.userId === f.assigneeId).map((m) => <option key={m.userId} value={m.userId}>{m.displayName}</option>)}
            </Select>
          </Field>
          {show && <Field label="Start date"><input className="input" type="date" value={f.startDate} onChange={(e) => set('startDate', e.target.value)} /></Field>}
          <Field label="Due date" error={errors.dueDate}><input className="input" type="date" value={f.dueDate} onChange={(e) => set('dueDate', e.target.value)} /></Field>
          {isEdit && dueChange(task?.dueDate, f.dueDate) && (
            <div className="field full">
              <DueChangeFields previous={task?.dueDate} revised={f.dueDate} reason={dueReason} dependency={dueDependency} error={errors.dueDateReason}
                onReason={(v) => { setDueReason(v); setErrors((x) => ({ ...x, dueDateReason: '' })); }} onDependency={setDueDependency} />
            </div>
          )}
          {show && (milestones.data?.length ?? 0) > 0 && (
            <Field label="Milestone"><Select className="select" value={f.milestoneId} onChange={(e) => set('milestoneId', e.target.value)}>
              <option value="">— None —</option>{milestones.data!.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </Select></Field>
          )}
          {isEdit && task && !task.parentTaskId && (sprints.data?.some((x) => x.status !== 'Completed') || task.sprintId) && (
            <Field label="Sprint" hint="Changes immediately."><Select className="select" value={task.sprintId ?? ''} disabled={!task.canEdit} onChange={async (e) => {
              try { await sprintApi.setForTask(task.id, e.target.value || null); toast('Sprint updated.'); void invalidateWorkspace(wid); }
              catch (err) { toast(err instanceof ApiError ? err.message : 'Could not change the sprint.', 'error'); }
            }}>
              <option value="">— Backlog —</option>
              {sprints.data?.filter((x) => x.status !== 'Completed' || x.id === task.sprintId).map((x) => <option key={x.id} value={x.id}>{x.name}{x.status === 'Active' ? ' (running)' : x.status === 'Completed' ? ' (completed)' : ''}</option>)}
            </Select></Field>
          )}
          {show && <Field label="Estimated hours" error={errors.estimatedHours}><input className="input" type="number" min="0" max="100000" step="0.5" value={f.estimatedHours} onChange={(e) => set('estimatedHours', e.target.value)} /></Field>}
          {isEdit && <Field label="Actual hours" hint="Follows the time you log below once there is any." error={errors.actualHours}><input className="input" type="number" min="0" max="100000" step="0.5" value={f.actualHours} onChange={(e) => set('actualHours', e.target.value)} /></Field>}

          {show && labels.data && labels.data.length > 0 && (
            <Field label="Labels" full>
              <div className="task-meta">
                {labels.data.map((l) => {
                  const on = f.labelIds.includes(l.id);
                  return (
                    <button type="button" key={l.id} aria-pressed={on} onClick={() => set('labelIds', on ? f.labelIds.filter((x) => x !== l.id) : [...f.labelIds, l.id])}
                      className="label-chip" style={{ background: on ? `${l.color}33` : 'transparent', color: on ? l.color : 'var(--text-3)', borderColor: on ? l.color : 'var(--modal-field-border)', cursor: 'pointer' }}>
                      {on && <Icon name="tick" size={11} />}{l.name}
                    </button>
                  );
                })}
              </div>
            </Field>
          )}
        </div>
        {!isEdit && !more && (
          <button type="button" className="more-toggle" onClick={() => setMore(true)}>
            <Icon name="plus" size={13} /> More options <span>description, priority, start date, estimate, labels</span>
          </button>
        )}
        {!isEdit && more && <CustomFieldsSection canEdit pending={pendingFields} onPending={setPendingFields} />}
      </fieldset>

      {isEdit && task && detail.data && (
        <>
          <CustomFieldsSection taskId={task.id} canEdit={task.canEdit} />
          <Checklist taskId={task.id} canEdit={task.canEdit} />
          <TimeTracker taskId={task.id} canEdit={task.canEdit} />
          <DevLinks taskId={task.id} />
          <Dependencies taskId={task.id} projectId={task.projectId} canEdit={task.canEdit} />
          <Attachments projectId={task.projectId} taskId={task.id} canEdit={task.canEdit} compact />
          <TargetDocuments targetType="Task" targetId={task.id} />
          {!task.parentTaskId && <Subtasks parent={task} subtasks={detail.data.subtasks} statuses={sortedStatuses} canCreate={canCreate && task.canEdit} onOpen={setCurrentId} />}
          <Comments taskId={task.id} canComment={canComment} members={members.data ?? []} />
        </>
      )}
    </Modal>
  );
}

// ------------------------------------------------------------------ subtasks
function Subtasks({ parent, subtasks, statuses, canCreate, onOpen }: {
  parent: { id: string; projectId: string }; subtasks: import('../../api/types').Task[]; statuses: import('../../api/types').WorkflowStatus[];
  canCreate: boolean; onOpen: (id: string) => void;
}) {
  const wid = useWorkspaceId();
  const [title, setTitle] = useState('');
  const done = subtasks.filter((s) => s.statusCategory === 'Done').length;
  const pct = subtasks.length ? Math.round((done / subtasks.length) * 100) : 0;

  const add = useMutation({
    mutationFn: () => taskApi.create(parent.projectId, { title: title.trim(), priority: 'Medium', parentTaskId: parent.id }),
    onSuccess: () => { setTitle(''); invalidateWorkspace(wid); },
    onError: (e) => toast(e instanceof ApiError ? e.message : 'Could not add the subtask.', 'error'),
  });
  const toggle = async (s: import('../../api/types').Task) => {
    const target = s.statusCategory === 'Done' ? statuses.find((x) => x.category === 'Todo') : statuses.find((x) => x.category === 'Done');
    if (!target) return;
    try { await taskApi.move(s.id, { statusId: target.id }); invalidateWorkspace(wid); }
    catch (e) { reportTaskError(e, 'Could not update the subtask.'); }
  };

  return (
    <section style={{ marginTop: 24 }}>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
        <h4 style={{ fontSize: 13.5 }}>Subtasks {subtasks.length > 0 && <span className="muted" style={{ fontWeight: 500 }}>· {done} / {subtasks.length} · {pct}%</span>}</h4>
      </div>
      <div className="member-list" style={{ gap: 6 }}>
        {subtasks.map((s) => (
          <div className="member-item" key={s.id} style={{ padding: '7px 10px' }}>
            <button type="button" className={`check ${s.statusCategory === 'Done' ? 'checked' : ''}`} disabled={!s.canEdit} onClick={() => toggle(s)} aria-label="Toggle subtask"><Icon name="tick" /></button>
            <button type="button" className="member-main" style={{ textAlign: 'left', textDecoration: s.statusCategory === 'Done' ? 'line-through' : undefined }} onClick={() => onOpen(s.id)}>
              <span className="member-name">{s.title}</span>
            </button>
            {s.assignee && <Avatar name={s.assignee.name} size="sm" userId={s.assignee.id} />}
          </div>
        ))}
      </div>
      {canCreate && (
        <div className="row" style={{ marginTop: 8 }}>
          <input className="input" placeholder="Add a subtask…" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (title.trim()) add.mutate(); } }} />
          <button type="button" className="btn btn-ghost" disabled={!title.trim() || add.isPending} onClick={() => add.mutate()}><Icon name="plus" /> Add</button>
        </div>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ comments
function Comments({ taskId, canComment, members }: { taskId: string; canComment: boolean; members: import('../../api/types').Member[] }) {
  const wid = useWorkspaceId();
  const q = useWsQuery(['task', taskId, 'comments'], () => taskApi.comments(taskId));
  const [body, setBody] = useState('');
  const [mentions, setMentions] = useState<string[]>([]);
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  const refresh = () => invalidateWorkspace(wid, 'task', taskId);

  const add = useMutation({
    mutationFn: () => taskApi.addComment(taskId, { body: body.trim(), mentionUserIds: mentions.filter((id) => body.includes(`@${members.find((m) => m.userId === id)?.displayName}`)) }),
    onSuccess: () => { setBody(''); setMentions([]); refresh(); invalidateWorkspace(wid, 'notifications'); },
    onError: (e) => toast(e instanceof ApiError ? e.message : 'Could not post the comment.', 'error'),
  });
  const mention = (userId: string) => {
    const m = members.find((x) => x.userId === userId);
    if (!m) return;
    setBody((b) => `${b}${b && !b.endsWith(' ') ? ' ' : ''}@${m.displayName} `);
    setMentions((x) => [...new Set([...x, userId])]);
  };

  return (
    <section style={{ marginTop: 24 }}>
      <h4 style={{ fontSize: 13.5, marginBottom: 10 }}>Comments {q.data && q.data.length > 0 && <span className="muted" style={{ fontWeight: 500 }}>· {q.data.length}</span>}</h4>
      <div className="comments">
        {q.data?.length === 0 && <p className="muted" style={{ fontSize: 12.5 }}>No comments yet.</p>}
        {q.data?.map((c) => (
          <div className="comment" key={c.id}>
            <Avatar name={c.author.name} size="lg" userId={c.author.id} />
            <div className="comment-bubble">
              <div className="comment-head">
                <b>{c.author.name}</b><span className="muted" title={formatDateTime(c.createdAt)}>{timeAgo(c.createdAt)}{c.editedAt && ' · edited'}</span>
                <span className="spacer" />
                {c.canEdit && <button type="button" className="link" onClick={() => setEditing({ id: c.id, body: c.body })}>Edit</button>}
                {c.canDelete && <button type="button" className="link" style={{ color: 'var(--danger)' }} onClick={async () => {
                  if (await confirmDialog({ title: 'Delete comment?', message: 'This comment will be removed.' })) { await taskApi.deleteComment(c.id); refresh(); }
                }}>Delete</button>}
              </div>
              {editing?.id === c.id ? (
                <div>
                  <textarea className="textarea" value={editing.body} onChange={(e) => setEditing({ id: c.id, body: e.target.value })} />
                  <div className="row" style={{ marginTop: 6 }}>
                    <button type="button" className="btn btn-primary btn-sm" disabled={!editing.body.trim()} onClick={async () => {
                      try { await taskApi.updateComment(c.id, editing.body.trim()); setEditing(null); refresh(); } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not save.', 'error'); }
                    }}>Save</button>
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(null)}>Cancel</button>
                  </div>
                </div>
              ) : <div className="comment-body">{c.body}</div>}
            </div>
          </div>
        ))}
      </div>
      {canComment && (
        <div style={{ marginTop: 12 }}>
          <textarea className="textarea" placeholder="Write a comment…" value={body} onChange={(e) => setBody(e.target.value)} maxLength={5000} />
          <div className="row" style={{ marginTop: 8 }}>
            <Select className="select" style={{ width: 'auto', height: 32 }} value="" onChange={(e) => e.target.value && mention(e.target.value)} aria-label="Mention a teammate">
              <option value="">@ Mention…</option>
              {members.map((m) => <option key={m.userId} value={m.userId}>{m.displayName}</option>)}
            </Select>
            <span className="spacer" />
            <button type="button" className="btn btn-primary btn-sm" disabled={!body.trim() || add.isPending} onClick={() => add.mutate()}>Comment</button>
          </div>
        </div>
      )}
    </section>
  );
}

