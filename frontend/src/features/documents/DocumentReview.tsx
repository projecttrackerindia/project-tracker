import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { documentApi } from '../../api/endpoints';
import type { Approval, ApprovalStep, DocumentDetail, DocumentReview } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Avatar, Field, Modal, SubmitButton } from '../../components/ui';
import { formatDateTime, timeAgo } from '../../lib/format';
import { invalidateWorkspace } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';

/** Submit the draft to the document's approval path: what changed (required) and why. */
export function SubmitModal({ detail, review, onClose }: { detail: DocumentDetail; review: DocumentReview; onClose: () => void }) {
  const wid = useWorkspaceId();
  const id = detail.item.id;
  const [summary, setSummary] = useState('');
  const [reason, setReason] = useState('');
  const [major, setMajor] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = useMutation({
    mutationFn: () => documentApi.submit(id, { changeSummary: summary.trim(), changeReason: reason.trim() || undefined, major, revision: detail.revision }),
    onSuccess: () => { invalidateWorkspace(wid, 'documents'); toast('Submitted for review.'); onClose(); },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not submit.'),
  });
  return (
    <Modal title="Submit for review" subtitle={`${review.workflowName ?? 'Approval'} · ${review.stepCount} ${review.stepCount === 1 ? 'step' : 'steps'}`} size="sm" onClose={onClose}
      onSubmit={(e) => { e.preventDefault(); if (!summary.trim()) { setError('Say in a sentence what changed.'); return; } setError(null); send.mutate(); }}
      footer={<><button className="btn btn-ghost" type="button" onClick={onClose}>Cancel</button><SubmitButton busy={send.isPending}>Submit</SubmitButton></>}>
      {error && <div className="doc-alert" role="alert"><Icon name="alert" size={16} /><div>{error}</div></div>}
      <p className="muted rv-note">The reviewers read this draft. If you change the text while it is in review, the review is cancelled and you submit again.</p>
      <Field label="What changed?" required hint="Becomes the version's summary when it is published."><textarea className="textarea" value={summary} maxLength={500} rows={2} autoFocus onChange={(e) => setSummary(e.target.value)} placeholder="e.g. Scope now includes tax forms" /></Field>
      <Field label="Why?" hint="Optional: the reason behind the change."><textarea className="textarea" value={reason} maxLength={500} rows={2} onChange={(e) => setReason(e.target.value)} /></Field>
      {!!detail.publishedLabel && <label className="check-row"><input type="checkbox" checked={major} onChange={(e) => setMajor(e.target.checked)} /> <span><b>A major change</b> <small>: the meaning changed, not just the details.</small></span></label>}
    </Modal>
  );
}

/** Approve (a comment is optional) or ask for changes (saying what is needed is required). */
function DecideModal({ id, kind, onClose }: { id: string; kind: 'approve' | 'changes'; onClose: () => void }) {
  const wid = useWorkspaceId();
  const [comment, setComment] = useState('');
  const [error, setError] = useState<string | null>(null);
  const go = useMutation({
    mutationFn: () => kind === 'approve' ? documentApi.approve(id, comment.trim() || undefined) : documentApi.requestChanges(id, comment.trim()),
    onSuccess: () => { invalidateWorkspace(wid, 'documents'); toast(kind === 'approve' ? 'Approved.' : 'Sent back with your comments.'); onClose(); },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'That did not work.'),
  });
  return (
    <Modal title={kind === 'approve' ? 'Approve this document' : 'Ask for changes'} size="sm" onClose={onClose}
      onSubmit={(e) => { e.preventDefault(); if (kind === 'changes' && !comment.trim()) { setError('Say what needs to change.'); return; } setError(null); go.mutate(); }}
      footer={<><button className="btn btn-ghost" type="button" onClick={onClose}>Cancel</button><SubmitButton busy={go.isPending}>{kind === 'approve' ? 'Approve' : 'Send back'}</SubmitButton></>}>
      {error && <div className="doc-alert" role="alert"><Icon name="alert" size={16} /><div>{error}</div></div>}
      <Field label={kind === 'approve' ? 'Comment' : 'What needs to change?'} required={kind === 'changes'} hint={kind === 'approve' ? 'Optional.' : 'The author and the owner are told.'}>
        <textarea className="textarea" value={comment} maxLength={1000} rows={3} autoFocus onChange={(e) => setComment(e.target.value)} />
      </Field>
    </Modal>
  );
}

function StepTrack({ steps, current }: { steps: ApprovalStep[]; current: number }) {
  return (
    <ol className="rv-steps" aria-label="Approval steps">
      {steps.map((s, i) => (
        <li key={i} className={`rv-step ${s.state.toLowerCase()}${i === current ? ' now' : ''}`}>
          <span className="rv-dot">{s.state === 'Done' ? <Icon name="tick" size={12} /> : i + 1}</span>
          <div className="rv-step-main">
            <b>{s.name}</b>
            <span className="muted">{s.who}{s.rule === 'All' && s.people.length > 1 ? ' · everyone' : ''}{s.dueDays ? ` · ${s.dueDays} d` : ''}</span>
            {(s.state === 'Current' || s.state === 'ChangesRequested' || s.people.some((p) => p.decision)) && (
              <div className="rv-people">
                {s.people.slice(0, 6).map((p) => (
                  <span key={p.userId} className={`rv-person ${p.decision ? p.decision.toLowerCase() : ''}`} title={p.comment ?? (p.decision ? p.decision : 'Waiting')}>
                    <Avatar name={p.name} />{p.name}{p.decision === 'Approved' ? ' ✓' : p.decision ? ' ↩' : ''}
                  </span>
                ))}
                {s.people.length > 6 && <span className="muted">+{s.people.length - 6}</span>}
              </div>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

function PastReviews({ items }: { items: Approval[] }) {
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;
  return (
    <div className="rv-past">
      <button className="link-btn" onClick={() => setOpen((v) => !v)}>{open ? 'Hide' : 'Show'} earlier reviews ({items.length})</button>
      {open && <ul>{items.map((a) => (
        <li key={a.id}>
          <span className={`badge ${a.state === 'Published' || a.state === 'Approved' ? 'badge-success' : a.state === 'ChangesRequested' ? 'badge-warning' : 'badge-neutral'}`}>{a.state === 'ChangesRequested' ? 'Sent back' : a.state === 'Cancelled' ? 'Cancelled' : a.state}</span>
          <span>{a.summary}</span><span className="muted">{a.submittedBy.name} · {timeAgo(a.submittedAt)}{a.closedNote ? ` · “${a.closedNote}”` : ''}</span>
        </li>
      ))}</ul>}
    </div>
  );
}

/** Where the document is in its review: who is asked, what they decided, and what the person looking at it can do next. */
export function ReviewPanel({ detail, review, canEdit, onPublish }: { detail: DocumentDetail; review: DocumentReview; canEdit: boolean; onPublish: () => void }) {
  const wid = useWorkspaceId();
  const id = detail.item.id;
  const [decide, setDecide] = useState<'approve' | 'changes' | null>(null);
  const a = review.current;
  const withdraw = useMutation({
    mutationFn: () => documentApi.withdraw(id),
    onSuccess: () => { invalidateWorkspace(wid, 'documents'); toast('Withdrawn from review.'); },
    onError: (e) => toast(e instanceof ApiError ? e.message : 'Could not withdraw.', 'error'),
  });
  if (!review.workflowApplies && !a) return null;
  const status = detail.item.status;
  const live = a && (a.state === 'Pending' || a.state === 'Approved' || (a.state === 'ChangesRequested' && status === 'ChangesRequested'));
  if (!live) return review.history.length + (a ? 1 : 0) > 0 ? <section className="rv rv-quiet"><PastReviews items={a ? [a, ...review.history] : review.history} /></section> : null;
  const tone = a.state === 'Approved' ? 'ok' : a.state === 'ChangesRequested' ? 'warn' : 'info';
  const asked = a.steps.flatMap((s) => s.people).find((p) => p.decision === 'ChangesRequested');
  return (
    <section className={`rv ${tone}`} aria-label="Review">
      <div className="rv-head">
        <div className="rv-title">
          <Icon name={a.state === 'Approved' ? 'checkCircle' : a.state === 'ChangesRequested' ? 'alert' : 'clock'} size={18} />
          <div>
            <b>{a.state === 'Pending' ? `In review · step ${a.currentStep + 1} of ${a.steps.length}` : a.state === 'Approved' ? 'Approved, ready to publish' : 'Sent back for changes'}</b>
            <span className="muted">{a.workflowName} · submitted by {a.submittedBy.name} <span title={formatDateTime(a.submittedAt)}>{timeAgo(a.submittedAt)}</span>{a.dueAt && a.state === 'Pending' ? ` · due ${formatDateTime(a.dueAt)}` : ''}</span>
          </div>
        </div>
        <div className="rv-actions">
          {a.canDecide && <><button className="btn btn-primary" onClick={() => setDecide('approve')}>Approve</button><button className="btn btn-ghost" onClick={() => setDecide('changes')}>Ask for changes</button></>}
          {a.state === 'Approved' && canEdit && detail.can.publish && <button className="btn btn-primary" onClick={onPublish}><Icon name="upload" size={15} /> Publish</button>}
          {a.canWithdraw && <button className="btn btn-ghost" disabled={withdraw.isPending} onClick={() => withdraw.mutate()}>Withdraw</button>}
        </div>
      </div>
      <p className="rv-sum">“{a.summary}”{a.reason ? <span className="muted"> · {a.reason}</span> : null}</p>
      {a.state === 'ChangesRequested' && asked?.comment && <div className="doc-alert rv-ask"><Icon name="info" size={16} /><div><b>{asked.name}:</b> {asked.comment}</div></div>}
      {a.state !== 'ChangesRequested' && <StepTrack steps={a.steps} current={a.currentStep} />}
      {a.state === 'Pending' && canEdit && <p className="muted rv-note"><Icon name="info" size={13} /> Changing the text now cancels this review.</p>}
      <PastReviews items={review.history} />
      {decide && <DecideModal id={id} kind={decide} onClose={() => setDecide(null)} />}
    </section>
  );
}

/** Publish an approved document: no form, it goes out with the summary it was approved with. */
export function PublishApprovedModal({ detail, review, onClose }: { detail: DocumentDetail; review: DocumentReview; onClose: () => void }) {
  const wid = useWorkspaceId();
  const a = review.current;
  const [error, setError] = useState<string | null>(null);
  const go = useMutation({
    mutationFn: () => documentApi.publish(detail.item.id, { changeSummary: a?.summary ?? '', changeReason: a?.reason ?? undefined, major: !!a?.major, revision: detail.revision }),
    onSuccess: () => { invalidateWorkspace(wid, 'documents'); toast('Published.'); onClose(); },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not publish.'),
  });
  return (
    <Modal title="Publish the approved version" subtitle="It goes out exactly as it was approved." size="sm" onClose={onClose}
      onSubmit={(e) => { e.preventDefault(); go.mutate(); }}
      footer={<><button className="btn btn-ghost" type="button" onClick={onClose}>Cancel</button><SubmitButton busy={go.isPending}>Publish</SubmitButton></>}>
      {error && <div className="doc-alert" role="alert"><Icon name="alert" size={16} /><div>{error}</div></div>}
      <p className="rv-sum">“{a?.summary}”</p>
      <p className="muted">People who build or verify work linked to this document, and everyone who took part in the review, are told about the new version.</p>
    </Modal>
  );
}
