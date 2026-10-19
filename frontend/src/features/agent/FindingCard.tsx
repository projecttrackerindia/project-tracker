import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { agentApi, delegateApi, workspaceApi } from '../../api/endpoints';
import type { AgentApproveEdits, AgentFinding, AgentFindingKind, AgentSourceKind, Priority } from '../../api/types';
import { Icon, type IconName } from '../../components/Icon';
import { Field } from '../../components/ui';
import { formatDate, formatDateTime } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { ImpactView } from '../command/Impact';
import '../command/command.css';

const KIND: Record<AgentFindingKind, { label: string; icon: IconName; tone: string; approve: string }> = {
  CreateTask: { label: 'New task', icon: 'plus', tone: 'primary', approve: 'Create task' },
  UpdateTask: { label: 'Task update', icon: 'edit', tone: 'info', approve: 'Apply update' },
  CreateActionItem: { label: 'Action item', icon: 'flag', tone: 'purple', approve: 'Add action item' },
  CreateIssue: { label: 'New ticket', icon: 'bug', tone: 'danger', approve: 'Create ticket' },
  UpdateIssue: { label: 'Ticket update', icon: 'bug', tone: 'warning', approve: 'Update ticket' },
  Delay: { label: 'Delay', icon: 'clock', tone: 'warning', approve: 'Note the delay' },
  Missed: { label: 'Missed', icon: 'alert', tone: 'danger', approve: 'Note it' },
  Suggestion: { label: 'Suggestion', icon: 'sparkle', tone: 'success', approve: 'Note it' },
  Decision: { label: 'Decision', icon: 'checks', tone: 'neutral', approve: 'Note it' },
};

const SOURCE_ICON: Record<AgentSourceKind, IconName> = {
  ProjectMailbox: 'mail', PersonalMail: 'mail', Chat: 'message', MeetingTranscript: 'video', LiveMeeting: 'video', Manual: 'note', Slack: 'message', WhatsApp: 'phone',
};

const STATUS_LABEL: Record<string, string> = { todo: 'To do', in_progress: 'In progress', done: 'Done', fixed: 'Fixed', resolved: 'Resolved' };
const PRIORITIES: Priority[] = ['Low', 'Medium', 'High', 'Critical'];
const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.errors[0]?.message ?? e.message : fallback);
const changes = (k: AgentFindingKind) => k === 'CreateTask' || k === 'UpdateTask' || k === 'CreateActionItem' || k === 'CreateIssue' || k === 'UpdateIssue' || k === 'Delay';

/**
 * One thing the agent found: what it is, the words it came from, and what approving it will do. People who may edit the project approve it
 * (optionally after changing the owner, date, priority or wording), or dismiss it.
 */
export function FindingCard({ f, canDecide, showProject }: { f: AgentFinding; canDecide: boolean; showProject?: boolean }) {
  const wid = useWorkspaceId();
  const meta = KIND[f.kind];
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<'approve' | 'dismiss' | null>(null);
  const [edits, setEdits] = useState<AgentApproveEdits>({});
  const [showImpact, setShowImpact] = useState(false);
  const movesDate = (f.kind === 'Delay' || f.kind === 'UpdateTask') && !!f.taskId && !!f.dueDate;
  const impact = useWsQuery(['agent', 'impact', f.id], () => delegateApi.findingImpact(f.id), { enabled: showImpact && movesDate && canDecide, staleTime: 60_000 });
  const people = useWsQuery(['members'], () => workspaceApi.members(), { enabled: editing, staleTime: 300_000 });
  const refresh = () => { void invalidateWorkspace(wid, 'agent'); void invalidateWorkspace(wid, 'project', f.projectId); void invalidateWorkspace(wid, 'tasks'); };

  const decide = async (what: 'approve' | 'dismiss') => {
    setBusy(what);
    try {
      const r = what === 'approve' ? await agentApi.approve(f.id, editing ? edits : undefined) : await agentApi.dismiss(f.id);
      if (r.status === 'Failed') toast(r.error ?? 'That could not be done.', 'error');
      else toast(what === 'dismiss' ? 'Dismissed.' : r.appliedKey ? `Done - ${r.appliedKey}.` : 'Done.');
      setEditing(false);
      refresh();
    } catch (e) { toast(errText(e, 'Could not save that.'), 'error'); }
    finally { setBusy(null); }
  };

  const assignee = edits.clearAssignee ? null : edits.assigneeId ? people.data?.find((p) => p.userId === edits.assigneeId)?.displayName ?? '…' : f.assignee?.name;
  const due = edits.clearDueDate ? null : edits.dueDate ?? f.dueDate;
  const open = f.status === 'Proposed' || f.status === 'Failed';
  const taskLink = f.taskId ? `/projects/${f.projectId}?task=${f.taskId}` : null;

  return (
    <article className={`ag-card ag-${meta.tone} ${open ? '' : 'ag-closed'}`} data-finding={f.id}>
      <header className="ag-card-head">
        <span className="ag-kind"><Icon name={meta.icon} size={13} />{meta.label}</span>
        {showProject && <Link className="ag-project" to={`/projects/${f.projectId}?tab=agent`}>{f.projectKey} · {f.projectName}</Link>}
        {f.autoApplied && <span className="ag-auto" title="Carried out by the agent itself: a safe kind, grounded in the source and above the confidence the lead chose"><Icon name="sparkle" size={11} />Auto</span>}
        {f.commitmentId && <span className="ag-auto" title="Asked for in a check-in by the person who owns the work"><Icon name="flag" size={11} />Check-in</span>}
        {!f.grounded && <span className="ag-unchecked" title="The quoted words were not found in the source - check it before approving"><Icon name="alert" size={12} />Check the source</span>}
        <span className="ag-conf" title="How sure the agent is">{f.confidence}%</span>
      </header>
      <h4 className="ag-title">{edits.title ?? f.title}</h4>
      {f.detail && <p className="ag-detail">{f.detail}</p>}
      {f.evidence && (
        <blockquote className="ag-quote">
          <p>“{f.evidence}”</p>
          <footer>{f.source && <Icon name={SOURCE_ICON[f.source]} size={12} />}{f.sourceLabel ?? 'Source'}</footer>
        </blockquote>
      )}
      {changes(f.kind) && (
        <div className="ag-chips">
          {(f.taskKey || f.issueKey) && (taskLink
            ? <Link className="ag-chip ag-chip-link" to={taskLink}><Icon name="link" size={12} />{f.taskKey}{f.taskTitle ? ` · ${f.taskTitle}` : ''}</Link>
            : <span className="ag-chip"><Icon name="bug" size={12} />{f.issueKey}</span>)}
          {assignee && <span className="ag-chip"><Icon name="user" size={12} />{assignee}</span>}
          {due && <span className="ag-chip"><Icon name="calendar" size={12} />Due {formatDate(due)}</span>}
          {(edits.priority ?? f.priority) && <span className="ag-chip"><Icon name="flag" size={12} />{edits.priority ?? f.priority}</span>}
          {(edits.newStatus ?? f.newStatus) && <span className="ag-chip"><Icon name="arrowRight" size={12} />{STATUS_LABEL[(edits.newStatus ?? f.newStatus)!] ?? edits.newStatus ?? f.newStatus}</span>}
        </div>
      )}
      {(edits.comment ?? f.comment) && <p className="ag-comment"><Icon name="message" size={13} />{edits.comment ?? f.comment}</p>}
      {f.error && open && <div className="form-error" role="alert">{f.error}</div>}
      {movesDate && open && canDecide && (
        <div className="ag-impact-toggle">
          {!showImpact
            ? <button type="button" className="ag-link" onClick={() => setShowImpact(true)}><Icon name="git" size={12} /> What would this move?</button>
            : impact.isLoading ? <span className="ag-meta">Working out what moves…</span>
            : impact.data ? <ImpactView impact={impact.data} compact /> : null}
        </div>
      )}
      {!open && f.before && <p className="ag-meta">Before: {f.before}</p>}

      {editing && open && (
        <div className="ag-edit">
          <Field label="Title" full><input className="input" aria-label="Title" defaultValue={f.title} maxLength={300} onChange={(e) => setEdits((x) => ({ ...x, title: e.target.value }))} /></Field>
          {changes(f.kind) && f.kind !== 'Delay' && (
            <>
              <Field label="Owner">
                <select className="input" aria-label="Owner" value={edits.clearAssignee ? '' : edits.assigneeId ?? f.assignee?.id ?? ''}
                  onChange={(e) => setEdits((x) => e.target.value ? { ...x, assigneeId: e.target.value, clearAssignee: undefined } : { ...x, assigneeId: undefined, clearAssignee: true })}>
                  <option value="">Nobody yet</option>
                  {f.assignee && !people.data?.some((p) => p.userId === f.assignee!.id) && <option value={f.assignee.id}>{f.assignee.name}</option>}
                  {(people.data ?? []).filter((p) => p.role !== 'Guest').map((p) => <option key={p.userId} value={p.userId}>{p.displayName}</option>)}
                </select>
              </Field>
              <Field label="Priority">
                <select className="input" aria-label="Priority" value={edits.priority ?? f.priority ?? ''} onChange={(e) => setEdits((x) => ({ ...x, priority: (e.target.value || undefined) as Priority | undefined }))}>
                  <option value="">Keep</option>
                  {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </Field>
            </>
          )}
          {changes(f.kind) && (
            <Field label="Due date">
              <input className="input" aria-label="Due date" type="date" value={due ?? ''} onChange={(e) => setEdits((x) => e.target.value ? { ...x, dueDate: e.target.value, clearDueDate: undefined } : { ...x, dueDate: undefined, clearDueDate: true })} />
            </Field>
          )}
          {(f.kind === 'UpdateTask' || f.kind === 'UpdateIssue') && (
            <Field label="Status">
              <select className="input" aria-label="Status" value={edits.newStatus ?? f.newStatus ?? ''} onChange={(e) => setEdits((x) => ({ ...x, newStatus: e.target.value }))}>
                <option value="">Leave as it is</option>
                {(f.kind === 'UpdateTask' ? ['todo', 'in_progress', 'done'] : ['in_progress', 'fixed', 'resolved']).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
              </select>
            </Field>
          )}
          {(f.kind === 'UpdateTask' || f.kind === 'UpdateIssue' || f.kind === 'Delay') && (
            <Field label="Comment" full><textarea className="input" aria-label="Comment" rows={2} defaultValue={f.comment ?? ''} maxLength={4000} onChange={(e) => setEdits((x) => ({ ...x, comment: e.target.value }))} /></Field>
          )}
        </div>
      )}

      <footer className="ag-card-foot">
        {open && canDecide ? (
          <>
            <button type="button" className="btn btn-primary btn-sm" disabled={busy !== null} onClick={() => void decide('approve')}>
              {busy === 'approve' ? <span className="spinner" /> : <Icon name="tick" size={14} />}{meta.approve}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy !== null} onClick={() => setEditing((v) => !v)}><Icon name="edit" size={14} />{editing ? 'Close' : 'Edit'}</button>
            <button type="button" className="btn btn-ghost btn-sm ag-dismiss" disabled={busy !== null} onClick={() => void decide('dismiss')}>
              {busy === 'dismiss' ? <span className="spinner" /> : <Icon name="close" size={14} />}Dismiss
            </button>
            <span className="ag-when">{formatDateTime(f.createdAt)}</span>
          </>
        ) : open ? (
          <span className="ag-when">Waiting for someone who can edit this project · {formatDateTime(f.createdAt)}</span>
        ) : (
          <span className="ag-when">
            {f.status === 'Applied' ? <><Icon name="checkCircle" size={13} /> {f.appliedKey ? <>Done as <b>{f.appliedKey}</b></> : 'Noted'}</> : <><Icon name="xCircle" size={13} /> Dismissed</>}
            {f.decidedBy && ` by ${f.decidedBy.name}`}{f.decidedAt && ` · ${formatDateTime(f.decidedAt)}`}
            {f.edits && <> · changed {f.edits}</>}
            {f.ownerResponse === 'accepted' && <> · <Icon name="tick" size={12} /> {f.assignee?.name ?? 'The owner'} accepted</>}
            {f.ownerResponse === 'declined' && <> · <b className="ag-declined">{f.assignee?.name ?? 'The owner'} says it is not theirs{f.ownerNote ? `: ${f.ownerNote}` : ''}</b></>}
          </span>
        )}
      </footer>
    </article>
  );
}
