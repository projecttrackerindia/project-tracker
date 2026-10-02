import { useRef, useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { projectApi, workApi, workspaceApi } from '../../api/endpoints';
import type { Priority, WorkTask, WorkTaskStatus } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Select } from '../../components/Select';
import { Avatar, ErrorState, Field, Modal, PageLoader, PriorityOptions, SubmitButton, Tabs } from '../../components/ui';
import { formatDate, formatDateTime } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { WORK_STATUSES } from '../../lib/workLabels';
import { useWorkspaceId } from '../../stores/auth';
import { TimeTracker } from '../time/TimeTracker';
import { SlaPanel } from './Sla';
import { DevLinks } from '../settings/IntegrationSettings';
import { Viewers } from '../live/Viewers';
import { formatMinutes } from '../time/time';
import type { Member } from '../../api/types';
import { confirmDialog, toast } from '../../stores/ui';
import { TriageButton } from '../ai/Assistant';
import { RemindMeButton } from '../reminders/RemindMe';

type Tab = 'details' | 'time' | 'comments' | 'files' | 'history';
const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.errors[0]?.message ?? e.message : fallback);
const size = (b: number) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

/**
 * A work task: operational work (a bug fix, some analysis, data preparation ...) that is not a task on a project's timeline. It can point at a project for
 * reference; that project is never changed by it. Create, edit and (with the right access) delete it, talk about it, attach files, and see its history.
 */
export function WorkTaskModal({ taskId, defaults, onClose }: { taskId?: string; defaults?: { relatedProjectId?: string; assigneeId?: string }; onClose: () => void }) {
  const q = useWsQuery(['work', 'task', taskId], () => workApi.get(taskId!), { enabled: !!taskId });
  if (taskId && q.isLoading) return <Modal title="Work task" onClose={onClose}><PageLoader /></Modal>;
  if (taskId && (q.isError || !q.data)) return <Modal title="Work task" onClose={onClose}><ErrorState error={q.error} retry={() => void q.refetch()} /></Modal>;
  return <WorkTaskForm task={q.data} defaults={defaults} onClose={onClose} />;
}

function WorkTaskForm({ task, defaults, onClose }: { task?: WorkTask; defaults?: { relatedProjectId?: string; assigneeId?: string }; onClose: () => void }) {
  const wid = useWorkspaceId();
  const isEdit = !!task;
  const canEdit = !task || task.can.edit;
  const [tab, setTab] = useState<Tab>('details');

  const types = useWsQuery(['work', 'types', 'all'], () => workApi.types(true));
  const projects = useWsQuery(['projects', 'work-picker'], () => projectApi.list({ pageSize: 200, includeArchived: true, sort: 'name' }));
  const members = useWsQuery(['members'], () => workspaceApi.members());

  const [title, setTitle] = useState(task?.title ?? '');
  const [description, setDescription] = useState(task?.description ?? '');
  const [workTypeId, setWorkTypeId] = useState(task?.workTypeId ?? '');
  const [projectId, setProjectId] = useState(task?.relatedProject?.id ?? defaults?.relatedProjectId ?? '');
  const [assigneeId, setAssigneeId] = useState(task?.assignee?.id ?? defaults?.assigneeId ?? '');
  const [priority, setPriority] = useState<Priority>(task?.priority ?? 'Medium');
  const [status, setStatus] = useState<WorkTaskStatus>(task?.status ?? 'ToDo');
  const [startDate, setStartDate] = useState(task?.startDate ?? '');
  const [dueDate, setDueDate] = useState(task?.dueDate ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const pickableTypes = (types.data ?? []).filter((t) => t.isActive || t.id === task?.workTypeId);
  const refresh = () => invalidateWorkspace(wid, 'work');

  const save = useMutation({
    mutationFn: () => {
      const body = { title: title.trim(), description: description.trim() || null, workTypeId, relatedProjectId: projectId || null, assigneeId: assigneeId || null, startDate: startDate || null, dueDate: dueDate || null };
      return task ? workApi.update(task.id, { ...body, priority, status, version: task.version }) : workApi.create({ ...body, priority, status });
    },
    onSuccess: () => { toast(isEdit ? 'Work task updated.' : 'Work task created.'); refresh(); onClose(); },
    onError: (e) => {
      if (e instanceof ApiError && e.errors.length) {
        const map: Record<string, string> = {};
        for (const it of e.errors) if (it.field) map[it.field] = it.message;
        setErrors(map);
        if (!Object.keys(map).length) setFormError(e.message);
      } else setFormError(errText(e, 'Could not save the work task.'));
    },
  });

  const submit = (ev: FormEvent<HTMLFormElement>) => {
    ev.preventDefault();
    const e: Record<string, string> = {};
    if (!title.trim()) e.title = 'Give the work task a short title.';
    if (!workTypeId) e.workTypeId = 'Choose a work type.';
    if (startDate && dueDate && dueDate < startDate) e.dueDate = 'The due date must not be before the start date.';
    setErrors(e); setFormError(null);
    if (Object.keys(e).length === 0) save.mutate();
  };

  const remove = async () => {
    if (!task || !(await confirmDialog({ title: 'Delete this work task?', message: `${task.key} “${task.title}” will be removed. Its project is not affected.`, confirmText: 'Delete', danger: true }))) return;
    try { await workApi.remove(task.id); toast('Work task deleted.'); onClose(); refresh(); } catch (e) { toast(errText(e, 'Could not delete the work task.'), 'error'); }
  };

  const details = (
    <fieldset disabled={!canEdit} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      {formError && <div className="form-error" role="alert">{formError}</div>}
      {task?.sla && <SlaPanel sla={task.sla} />}
      <div className="form-grid">
        <Field label="Title" required full error={errors.title}>
          <input className="input" value={title} onChange={(e) => { setTitle(e.target.value); setErrors((x) => ({ ...x, title: '' })); }} maxLength={200} placeholder="e.g. Fix production issue in payment calculation" autoFocus={!isEdit} />
        </Field>
        {!isEdit && (
          <div className="field full" style={{ marginTop: -6 }}>
            <TriageButton title={title} description={description} onApply={(t) => {
              if (t.workTypeId) setWorkTypeId(t.workTypeId);
              if (t.priority) setPriority(t.priority);
              if (t.assigneeId) setAssigneeId(t.assigneeId);
            }} />
          </div>
        )}
        <Field label="Work type" required error={errors.workTypeId} hint="What kind of work this is. The list is managed in Workspace settings.">
          <Select className="select" value={workTypeId} onChange={(e) => { setWorkTypeId(e.target.value); setErrors((x) => ({ ...x, workTypeId: '' })); }} aria-label="Work type">
            <option value="">Select a work type…</option>
            {pickableTypes.map((t) => <option key={t.id} value={t.id}>{t.name}{t.isActive ? '' : ' (inactive)'}</option>)}
          </Select>
        </Field>
        <Field label="Related project" error={errors.relatedProjectId} hint="Optional, for reference and reporting. The project itself is never changed by this work.">
          <Select className="select" value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label="Related project">
            <option value="">None</option>
            {(projects.data?.items ?? []).map((p) => <option key={p.id} value={p.id}>{p.key} · {p.name}{p.status === 'Completed' ? ' (completed)' : p.status === 'Archived' ? ' (archived)' : ''}</option>)}
          </Select>
        </Field>
        <Field label="Assigned to" error={errors.assigneeId}>
          <Select className="select" value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)} aria-label="Assigned to">
            <option value="">Unassigned</option>
            {members.data?.filter((m) => m.role !== 'Guest').map((m) => <option key={m.userId} value={m.userId}>{m.displayName}</option>)}
          </Select>
        </Field>
        <Field label="Priority">
          <Select className="select" value={priority} onChange={(e) => setPriority(e.target.value as Priority)} aria-label="Priority"><PriorityOptions /></Select>
        </Field>
        <Field label="Status">
          <Select className="select" value={status} onChange={(e) => setStatus(e.target.value as WorkTaskStatus)} aria-label="Status">
            {WORK_STATUSES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </Select>
        </Field>
        <Field label="Start date"><input className="input" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></Field>
        <Field label="Due date" error={errors.dueDate}><input className="input" type="date" value={dueDate} onChange={(e) => { setDueDate(e.target.value); setErrors((x) => ({ ...x, dueDate: '' })); }} /></Field>
        <Field label="Description" full>
          <textarea className="textarea" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={8000} placeholder="What needs to be done, and any context that helps." />
        </Field>
      </div>
      {task && <DevLinks workTaskId={task.id} />}
      {task && <p className="field-hint" style={{ marginTop: 12 }}>Raised by {task.reporter?.name ?? 'someone'} on {formatDate(task.createdAt)}{task.completedAt ? ` · completed ${formatDate(task.completedAt)}` : ''}.</p>}
    </fieldset>
  );

  const footer = tab === 'details' ? (
    <>
      {task?.can.delete && <button type="button" className="btn btn-danger" style={{ marginRight: 'auto' }} onClick={() => void remove()}><Icon name="trash" /> Delete</button>}
      <button type="button" className="btn btn-ghost" onClick={onClose}>{canEdit ? 'Cancel' : 'Close'}</button>
      {canEdit && <SubmitButton busy={save.isPending}>{isEdit ? 'Save changes' : 'Create work task'}</SubmitButton>}
    </>
  ) : <button type="button" className="btn btn-ghost" onClick={onClose}>Close</button>;

  return (
    <Modal title={task ? `${task.key} · Work task` : 'New work task'} subtitle={task ? (canEdit ? 'Update the details of this work task.' : 'You can read this work task but not change it.') : 'Operational work that is not a task on a project’s timeline.'}
      onClose={onClose} size="lg" footer={footer} onSubmit={tab === 'details' && canEdit ? submit : undefined}>
      {task && (
        <div className="rm-bar"><Viewers kind="work" id={task.id} />
          <RemindMeButton subject={{ type: 'Operational', id: task.id, title: task.title, key: task.key, due: task.dueDate, assigneeId: task.assignee?.id, assigneeName: task.assignee?.name }} /></div>
      )}
      {task && (
        <div style={{ marginBottom: 16 }}>
          <Tabs<Tab> value={tab} onChange={setTab} tabs={[
            { id: 'details', label: 'Details', icon: 'note' }, { id: 'time', label: task.loggedMinutes ? `Time · ${formatMinutes(task.loggedMinutes)}` : 'Time', icon: 'clock' },
            { id: 'comments', label: 'Comments', icon: 'message', badge: task.commentCount || undefined },
            { id: 'files', label: 'Files', icon: 'paperclip', badge: task.attachmentCount || undefined }, { id: 'history', label: 'History', icon: 'activity' },
          ]} />
        </div>
      )}
      {tab === 'details' && details}
      {task && tab === 'time' && <TimeTracker workTaskId={task.id} canEdit={task.can.edit} />}
      {task && tab === 'comments' && <Comments task={task} members={members.data ?? []} onChanged={refresh} />}
      {task && tab === 'files' && <Files task={task} onChanged={refresh} />}
      {task && tab === 'history' && <History task={task} />}
    </Modal>
  );
}

function Comments({ task, members, onChanged }: { task: WorkTask; members: Member[]; onChanged: () => void }) {
  const list = useWsQuery(['work', 'task', task.id, 'comments'], () => workApi.comments(task.id));
  const [body, setBody] = useState('');
  const [mentions, setMentions] = useState<string[]>([]);
  const people = members.filter((m) => m.role !== 'Guest');
  const mention = (userId: string) => {
    const m = people.find((x) => x.userId === userId);
    if (!m) return;
    setBody((b) => `${b}${b && !b.endsWith(' ') ? ' ' : ''}@${m.displayName} `);
    setMentions((x) => [...new Set([...x, userId])]);
  };
  // Only the people still named in the text are notified.
  const mentioned = () => mentions.filter((id) => body.includes(`@${people.find((m) => m.userId === id)?.displayName}`));
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, fallback: string) => {
    setBusy(true);
    try { await fn(); await list.refetch(); onChanged(); } catch (e) { toast(errText(e, fallback), 'error'); } finally { setBusy(false); }
  };
  return (
    <div>
      {list.isLoading ? <PageLoader /> : (list.data ?? []).length === 0 ? <p className="muted" style={{ marginBottom: 12 }}>No comments yet.</p> : (
        <div className="comments" style={{ marginBottom: 14 }}>
          {list.data!.map((c) => (
            <div className="comment" key={c.id}>
              <Avatar name={c.author?.name} size="sm" />
              <div className="comment-bubble">
                <div className="comment-head"><b>{c.author?.name ?? 'Someone'}</b><span className="muted">{formatDateTime(c.createdAt)}{c.editedAt ? ' · edited' : ''}</span>
                  <span className="spacer" />
                  {c.canEdit && <button type="button" className="btn-icon" aria-label="Edit comment" onClick={() => setEditing({ id: c.id, body: c.body })}><Icon name="edit" /></button>}
                  {c.canDelete && <button type="button" className="btn-icon danger" aria-label="Delete comment" onClick={() => void run(() => workApi.deleteComment(task.id, c.id), 'Could not delete the comment.')}><Icon name="trash" /></button>}
                </div>
                {editing?.id === c.id ? (
                  <div style={{ display: 'grid', gap: 8 }}>
                    <textarea className="textarea" value={editing.body} onChange={(e) => setEditing({ id: c.id, body: e.target.value })} maxLength={4000} />
                    <div className="row" style={{ justifyContent: 'flex-end' }}>
                      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(null)}>Cancel</button>
                      <button type="button" className="btn btn-primary btn-sm" disabled={busy || !editing.body.trim()} onClick={() => void run(async () => { await workApi.updateComment(task.id, c.id, editing.body); setEditing(null); }, 'Could not save the comment.')}>Save</button>
                    </div>
                  </div>
                ) : <div className="comment-body">{c.body}</div>}
              </div>
            </div>
          ))}
        </div>
      )}
      <div style={{ display: 'grid', gap: 8 }}>
        <textarea className="textarea" value={body} onChange={(e) => setBody(e.target.value)} maxLength={4000} placeholder="Write a comment…" aria-label="New comment" />
        <div className="row">
          <Select className="select" style={{ width: 'auto', height: 32 }} value="" onChange={(e) => e.target.value && mention(e.target.value)} aria-label="Mention a teammate">
            <option value="">@ Mention…</option>
            {people.map((m) => <option key={m.userId} value={m.userId}>{m.displayName}</option>)}
          </Select>
          <span className="spacer" />
          <button type="button" className="btn btn-primary btn-sm" disabled={busy || !body.trim()} onClick={() => void run(async () => { await workApi.addComment(task.id, body, mentioned()); setBody(''); setMentions([]); }, 'Could not add the comment.')}>Comment</button>
        </div>
      </div>
    </div>
  );
}

function Files({ task, onChanged }: { task: WorkTask; onChanged: () => void }) {
  const list = useWsQuery(['work', 'task', task.id, 'files'], () => workApi.files(task.id));
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const upload = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try { await workApi.upload(task.id, file); await list.refetch(); onChanged(); toast('File added.'); } catch (e) { toast(errText(e, 'Could not upload the file.'), 'error'); } finally { setBusy(false); if (input.current) input.current.value = ''; }
  };
  return (
    <div>
      {task.can.edit && (
        <div style={{ marginBottom: 14 }}>
          <input ref={input} type="file" hidden onChange={(e) => void upload(e.target.files?.[0])} />
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => input.current?.click()}>{busy ? <span className="spinner" /> : <Icon name="upload" />} Add a file</button>
        </div>
      )}
      {list.isLoading ? <PageLoader /> : (list.data ?? []).length === 0 ? <p className="muted">No files yet.</p> : (
        <div className="member-list">
          {list.data!.map((f) => (
            <div className="member-item" key={f.id}>
              <Icon name="paperclip" />
              <div className="member-main"><span className="member-name">{f.fileName}</span><span className="member-role">{size(f.sizeBytes)} · {f.uploadedBy?.name ?? 'someone'} · {formatDate(f.createdAt)}</span></div>
              <button type="button" className="btn-icon" aria-label={`Download ${f.fileName}`} onClick={() => void workApi.download(f.id, f.fileName).catch((e) => toast(errText(e, 'Could not download the file.'), 'error'))}><Icon name="download" /></button>
              {f.canDelete && <button type="button" className="btn-icon danger" aria-label={`Remove ${f.fileName}`} onClick={() => void (async () => { try { await workApi.removeFile(f.id); await list.refetch(); onChanged(); } catch (e) { toast(errText(e, 'Could not remove the file.'), 'error'); } })()}><Icon name="trash" /></button>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function History({ task }: { task: WorkTask }) {
  const list = useWsQuery(['work', 'task', task.id, 'history'], () => workApi.history(task.id));
  if (list.isLoading) return <PageLoader />;
  if (!list.data?.length) return <p className="muted">Nothing has happened to this work task yet.</p>;
  return (
    <div className="activity-list">
      {list.data.map((a) => (
        <div className="act-item" key={a.id}>
          <div className="act-ico"><Icon name="activity" /></div>
          <div className="act-body"><div className="act-text"><b>{a.actor?.name ?? 'Someone'}</b> {a.summary}</div><div className="act-time">{formatDateTime(a.createdAt)}</div></div>
        </div>
      ))}
    </div>
  );
}
