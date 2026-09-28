import { useMemo, useRef, useState } from 'react';
import { ApiError, uploadFile } from '../../api/client';
import { attachmentApi, issueApi } from '../../api/endpoints';
import type { IssueDetail, IssueEvent, IssueStatus, Priority, ProjectMember, Stage } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Avatar, ErrorState, Field, Modal, PageLoader, PriorityBadge, SubmitButton } from '../../components/ui';
import { formatBytes, formatDateTime, timeAgo } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
import { Attachments } from '../files/Attachments';
import { ISSUE_STATUS_LABEL, IssueStatusBadge, SEVERITIES, moveLabel, needsNote } from './issueMeta';
import { Select } from '../../components/Select';

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.errors[0]?.message ?? e.message : fallback);

// ------------------------------------------------------------------ reporting a new issue
/**
 * "Observed / Failed": what the tester found, in which stage, how bad it is, and the supporting files (screenshots, logs, documents).
 * The files are uploaded right after the issue is saved.
 */
export function ReportIssueModal({ projectId, stages, members, defaultStageId, onClose, onCreated }: {
  projectId: string; stages: Stage[]; members: ProjectMember[]; defaultStageId?: string; onClose: () => void; onCreated: (issueId: string) => void;
}) {
  const wid = useWorkspaceId();
  const usable = stages.filter((s) => !s.locked);
  const initialStage = usable.find((s) => s.id === defaultStageId)?.id
    ?? usable.find((s) => s.effectiveStatus === 'InProgress')?.id ?? usable.find((s) => s.status !== 'Completed')?.id ?? usable[0]?.id ?? '';
  const [f, setF] = useState({ stageId: initialStage, title: '', details: '', severity: 'Medium' as Priority, assigneeId: '' });
  const [files, setFiles] = useState<File[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const limits = useWsQuery(['attachments', 'limits'], attachmentApi.limits);
  const set = (k: keyof typeof f, v: string) => { setF((p) => ({ ...p, [k]: v })); setErrors((e) => ({ ...e, [k]: '' })); };

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    const next = [...files];
    for (const file of Array.from(list)) {
      if (limits.data && file.size > limits.data.maxFileBytes) { toast(`“${file.name}” is ${formatBytes(file.size)}. Your plan allows files up to ${formatBytes(limits.data.maxFileBytes)}.`, 'error'); continue; }
      if (next.length >= 20) { toast('An issue can have up to 20 files.', 'error'); break; }
      next.push(file);
    }
    setFiles(next);
    if (input.current) input.current.value = '';
  };

  const submit = async () => {
    if (!f.title.trim()) { setErrors({ title: 'Give the issue a short title.' }); return; }
    setBusy(true);
    try {
      const created = await issueApi.create(projectId, {
        stageId: f.stageId || null, title: f.title.trim(), details: f.details.trim() || null, severity: f.severity, assigneeId: f.assigneeId || null,
      });
      const id = created.issue.id;
      const failed: string[] = [];
      for (const file of files) {
        try { await uploadFile(attachmentApi.uploadPath(projectId, undefined, id), file); } catch { failed.push(file.name); }
      }
      await invalidateWorkspace(wid);
      toast(failed.length ? `Issue ${created.issue.key} reported, but ${failed.length === 1 ? `“${failed[0]}”` : `${failed.length} files`} could not be attached. Add ${failed.length === 1 ? 'it' : 'them'} from the issue.` : `Issue ${created.issue.key} reported.`, failed.length ? 'warning' : 'success');
      onCreated(id);
    } catch (e) {
      const fe: Record<string, string> = {};
      if (e instanceof ApiError) e.errors.forEach((x) => { if (x.field) fe[x.field] = x.message; });
      if (Object.keys(fe).length) setErrors(fe); else toast(errText(e, 'Could not report the issue.'), 'error');
    } finally { setBusy(false); }
  };

  return (
    <Modal size="lg" title="Report an issue" subtitle="Mark what failed or did not work as expected, so it can be fixed and retested." onClose={onClose}
      onSubmit={(e) => { e.preventDefault(); void submit(); }}
      footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><SubmitButton busy={busy}>Mark as Observed / Failed</SubmitButton></>}>
      <div className="form-grid">
        <Field label="Title" required error={errors.title} full><input className="input" value={f.title} onChange={(e) => set('title', e.target.value)} maxLength={200} placeholder="e.g. Login button does nothing on Safari" /></Field>
        <Field label="Stage" error={errors.stageId} hint="The stage it was found in. It cannot be completed until this is resolved.">
          <Select className="select" value={f.stageId} onChange={(e) => set('stageId', e.target.value)}>
            {stages.length === 0 && <option value="">—</option>}
            {stages.map((s) => <option key={s.id} value={s.id} disabled={s.locked}>{s.name}{s.locked ? ' (not started)' : ''}</option>)}
          </Select>
        </Field>
        <Field label="Severity">
          <Select className="select" value={f.severity} onChange={(e) => set('severity', e.target.value)}>{SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}</Select>
        </Field>
        <Field label="Assign to" hint="Who will fix it. You can assign it later.">
          <Select className="select" value={f.assigneeId} onChange={(e) => set('assigneeId', e.target.value)}>
            <option value="">Unassigned</option>{members.map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}
          </Select>
        </Field>
        <Field label="Details" error={errors.details} full hint="What did you do, what did you expect, and what happened instead?">
          <textarea className="textarea" rows={5} value={f.details} onChange={(e) => set('details', e.target.value)} maxLength={4000}
            placeholder={'Steps to reproduce:\n1. \n2. \n\nExpected:\n\nActual:'} />
        </Field>
        <div className="field full">
          <label>Supporting documents</label>
          <input ref={input} type="file" multiple hidden onChange={(e) => addFiles(e.target.files)} accept={limits.data?.allowedExtensions.map((x) => `.${x}`).join(',')} />
          <div className="issue-files">
            {files.map((file, i) => (
              <span className="issue-file-chip" key={`${file.name}-${i}`}><Icon name="paperclip" size={12} />{file.name} <small>{formatBytes(file.size)}</small>
                <button type="button" className="btn-icon" aria-label={`Remove ${file.name}`} onClick={() => setFiles(files.filter((_, j) => j !== i))}><Icon name="close" size={11} /></button></span>
            ))}
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => input.current?.click()}><Icon name="upload" /> Add screenshots or documents</button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ one issue
const eventText = (e: IssueEvent) => {
  const who = e.actor?.name ?? 'Someone';
  if (e.kind === 'reported') return <><b>{who}</b> marked it as Observed / Failed</>;
  if (e.kind === 'status') return <><b>{who}</b> moved it from {e.from ? ISSUE_STATUS_LABEL[e.from] : '—'} to <b>{e.to ? ISSUE_STATUS_LABEL[e.to] : '—'}</b></>;
  if (e.kind === 'assigned') return <><b>{who}</b>: {e.note}</>;
  return <><b>{who}</b> edited it{e.note ? ` (${e.note})` : ''}</>;
};

/** An issue: its details, supporting files, who has it, where it stands and its history. Everyone who can see the project can read it; what they can change depends on their part in it. */
export function IssueDetailModal({ projectId, issueId, stages, members, onClose }: {
  projectId: string; issueId: string; stages: Stage[]; members: ProjectMember[]; onClose: () => void;
}) {
  const wid = useWorkspaceId();
  const key = ['issue', projectId, issueId];
  const q = useWsQuery(key, () => issueApi.get(projectId, issueId));
  const [note, setNote] = useState('');
  const [editing, setEditing] = useState<{ title: string; details: string; severity: Priority; stageId: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [noteError, setNoteError] = useState('');

  const detail = q.data;
  const assigneeChoices = useMemo(() => {
    const list = [...members];
    const a = detail?.issue.assignee;
    if (a && !list.some((m) => m.userId === a.id)) list.push({ userId: a.id, name: a.name, email: '', role: null });
    return list;
  }, [members, detail?.issue.assignee]);

  if (q.isLoading) return <Modal title="Issue" onClose={onClose}><PageLoader /></Modal>;
  if (q.isError || !detail) return <Modal title="Issue" onClose={onClose}><ErrorState error={q.error} retry={() => q.refetch()} /></Modal>;
  const i = detail.issue;

  const run = async (fn: () => Promise<IssueDetail>, done?: string) => {
    setBusy(true);
    try { await fn(); if (done) toast(done); await invalidateWorkspace(wid); }
    catch (e) { toast(errText(e, 'That change could not be saved.'), 'error'); }
    finally { setBusy(false); }
  };

  const move = async (to: IssueStatus) => {
    if (needsNote(i.status, to) && !note.trim()) { setNoteError('Say what still fails, so it can be fixed.'); return; }
    setNoteError('');
    await run(() => issueApi.setStatus(projectId, i.id, to, note.trim() || undefined), `Moved to ${ISSUE_STATUS_LABEL[to]}.`);
    setNote('');
  };

  const remove = async () => {
    if (!(await confirmDialog({ title: 'Delete issue?', message: `${i.key} “${i.title}” and its files will be deleted for everyone.`, confirmText: 'Delete' }))) return;
    setBusy(true);
    try { await issueApi.remove(projectId, i.id); toast('Issue deleted.', 'warning'); await invalidateWorkspace(wid); onClose(); }
    catch (e) { toast(errText(e, 'Could not delete the issue.'), 'error'); setBusy(false); }
  };

  const saveEdit = async () => {
    if (!editing) return;
    if (!editing.title.trim()) { toast('Give the issue a title.', 'error'); return; }
    await run(() => issueApi.update(projectId, i.id, { title: editing.title.trim(), details: editing.details, severity: editing.severity, stageId: editing.stageId || undefined }), 'Issue updated.');
    setEditing(null);
  };

  return (
    <Modal size="xl" title={`${i.key} · ${i.title}`} subtitle={i.stageName ? `Found in ${i.stageName}` : 'Not linked to a stage'} onClose={onClose}
      footer={<>
        {i.can.delete && <button type="button" className="btn btn-danger" style={{ marginRight: 'auto' }} disabled={busy} onClick={() => void remove()}><Icon name="trash" /> Delete</button>}
        <button type="button" className="btn btn-ghost" onClick={onClose}>Close</button>
      </>}>
      <div className="issue-layout">
        <div className="issue-main">
          <section className="form-section">
            <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
              <h4 className="section-title">Details</h4>
              {i.can.edit && !editing && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing({ title: i.title, details: i.details ?? '', severity: i.severity, stageId: i.stageId ?? '' })}><Icon name="edit" /> Edit</button>}
            </div>
            {editing ? (
              <div className="form-grid">
                <Field label="Title" full><input className="input" value={editing.title} maxLength={200} onChange={(e) => setEditing({ ...editing, title: e.target.value })} /></Field>
                <Field label="Stage"><Select className="select" value={editing.stageId} onChange={(e) => setEditing({ ...editing, stageId: e.target.value })}>
                  {!i.stageId && <option value="">—</option>}{stages.map((s) => <option key={s.id} value={s.id} disabled={s.locked && s.id !== i.stageId}>{s.name}</option>)}</Select></Field>
                <Field label="Severity"><Select className="select" value={editing.severity} onChange={(e) => setEditing({ ...editing, severity: e.target.value as Priority })}>{SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}</Select></Field>
                <Field label="Details" full><textarea className="textarea" rows={6} maxLength={4000} value={editing.details} onChange={(e) => setEditing({ ...editing, details: e.target.value })} /></Field>
                <div className="field full row" style={{ justifyContent: 'flex-end', gap: 8 }}>
                  <button type="button" className="btn btn-ghost" onClick={() => setEditing(null)}>Cancel</button>
                  <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void saveEdit()}>Save changes</button>
                </div>
              </div>
            ) : i.details ? <p className="issue-details">{i.details}</p> : <p className="muted">No details were given.</p>}
          </section>

          {i.can.moveTo.length > 0 && (
            <section className="form-section issue-actions">
              <h4 className="section-title">Progress</h4>
              <Field label="Note" error={noteError} hint={i.can.moveTo.some((t) => needsNote(i.status, t)) ? 'Required when sending it back: say what still fails.' : 'Optional: what was done, or what should be checked.'}>
                <textarea className="textarea" rows={2} maxLength={1000} value={note} onChange={(e) => { setNote(e.target.value); setNoteError(''); }} placeholder="Add a note for the history" />
              </Field>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                {i.can.moveTo.map((to) => (
                  <button key={to} type="button" disabled={busy} onClick={() => void move(to)}
                    className={`btn ${to === 'Resolved' ? 'btn-primary' : 'btn-ghost'} ${to === 'Observed' ? 'btn-danger-soft' : ''}`}>{moveLabel(i.status, to)}</button>
                ))}
              </div>
            </section>
          )}

          <Attachments projectId={projectId} issueId={i.id} canEdit={i.can.attach} compact />

          <section className="form-section">
            <h4 className="section-title">History</h4>
            <ol className="issue-history">
              {[...detail.history].reverse().map((e) => (
                <li key={e.id}>
                  <div>{eventText(e)}</div>
                  {e.note && e.kind === 'status' && <blockquote>{e.note}</blockquote>}
                  <time title={formatDateTime(e.at)}>{timeAgo(e.at)}</time>
                </li>
              ))}
            </ol>
          </section>
        </div>

        <aside className="issue-side">
          <dl>
            <dt>Status</dt><dd><IssueStatusBadge status={i.status} /></dd>
            <dt>Severity</dt><dd><PriorityBadge priority={i.severity} /></dd>
            <dt>Stage</dt><dd>{i.stageName ?? '—'}</dd>
            <dt>Reported by</dt><dd>{i.reporter ? <span className="row" style={{ gap: 6 }}><Avatar name={i.reporter.name} size="sm" />{i.reporter.name}</span> : '—'}</dd>
            <dt>Assigned to</dt>
            <dd>
              {i.can.assign
                ? <Select className="select" value={i.assignee?.id ?? ''} disabled={busy} aria-label="Assigned to"
                    onChange={(e) => void run(() => issueApi.assign(projectId, i.id, e.target.value || null), e.target.value ? 'Issue assigned.' : 'Issue unassigned.')}>
                    <option value="">Unassigned</option>{assigneeChoices.map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}
                  </Select>
                : i.assignee ? <span className="row" style={{ gap: 6 }}><Avatar name={i.assignee.name} size="sm" />{i.assignee.name}</span> : <em>Unassigned</em>}
            </dd>
            <dt>Reported</dt><dd title={formatDateTime(i.createdAt)}>{timeAgo(i.createdAt)}</dd>
            {i.resolvedAt && <><dt>Resolved</dt><dd title={formatDateTime(i.resolvedAt)}>{timeAgo(i.resolvedAt)}</dd></>}
          </dl>
        </aside>
      </div>
    </Modal>
  );
}
