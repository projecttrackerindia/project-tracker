import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { documentApi } from '../../api/endpoints';
import type { AccessRequest, DocAccessLevel, ReviewItem } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Select } from '../../components/Select';
import { Avatar, EmptyState, ErrorState, Field, Modal, PageLoader, SubmitButton } from '../../components/ui';
import { formatDate, timeAgo } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { DocStatusBadge, TypeChip } from './docUi';

const LEVEL_TEXT: Record<DocAccessLevel, string> = { Viewer: 'read', Editor: 'edit', Manager: 'manage' };
const DAYS = [{ v: '7', t: '7 days' }, { v: '30', t: '30 days' }, { v: '90', t: '90 days' }, { v: '180', t: '6 months' }, { v: '365', t: '1 year' }, { v: '', t: 'No end date' }];

export function DecideAccessModal({ request, onClose }: { request: AccessRequest; onClose: () => void }) {
  const wid = useWorkspaceId();
  const [approve, setApprove] = useState(true);
  const [level, setLevel] = useState<DocAccessLevel>(request.level);
  const [days, setDays] = useState(request.durationDays ? String(request.durationDays) : '');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const go = useMutation({
    mutationFn: () => documentApi.decideAccess(request.id, { approve, level, durationDays: days ? Number(days) : null, note: note.trim() || undefined }),
    onSuccess: () => { invalidateWorkspace(wid, 'documents'); toast(approve ? 'Access given.' : 'Request declined.'); onClose(); },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'That did not work.'),
  });
  return (
    <Modal title={`${request.requester.name} asks for access`} subtitle={`${request.documentKey}${request.documentTitle ? ` · ${request.documentTitle}` : ''}`} size="sm" onClose={onClose}
      onSubmit={(e) => { e.preventDefault(); setError(null); go.mutate(); }}
      footer={<><button className="btn btn-ghost" type="button" onClick={onClose}>Cancel</button><SubmitButton busy={go.isPending}>{approve ? 'Give access' : 'Decline'}</SubmitButton></>}>
      {error && <div className="doc-alert" role="alert"><Icon name="alert" size={16} /><div>{error}</div></div>}
      <blockquote className="ar-reason">“{request.reason}”</blockquote>
      <div className="seg" role="radiogroup" aria-label="Decision">
        <button type="button" role="radio" aria-checked={approve} className={approve ? 'on' : ''} onClick={() => setApprove(true)}>Give access</button>
        <button type="button" role="radio" aria-checked={!approve} className={!approve ? 'on' : ''} onClick={() => setApprove(false)}>Decline</button>
      </div>
      {approve && (
        <div className="ar-grid">
          <Field label="They can"><Select className="select" value={level} onChange={(e) => setLevel(e.target.value as DocAccessLevel)} aria-label="Access level"><option value="Viewer">Read</option><option value="Editor">Edit</option></Select></Field>
          <Field label="For"><Select className="select" value={days} onChange={(e) => setDays(e.target.value)} aria-label="Duration">{DAYS.map((d) => <option key={d.v} value={d.v}>{d.t}</option>)}</Select></Field>
        </div>
      )}
      <Field label="Note" hint="Optional. They see it with the answer."><textarea className="textarea" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
    </Modal>
  );
}

export function AccessRequestRow({ r, showDoc = true, onDecide }: { r: AccessRequest; showDoc?: boolean; onDecide?: () => void }) {
  const wid = useWorkspaceId();
  const cancel = useMutation({
    mutationFn: () => documentApi.cancelAccess(r.id),
    onSuccess: () => { invalidateWorkspace(wid, 'documents'); toast('Request withdrawn.'); },
    onError: (e) => toast(e instanceof ApiError ? e.message : 'Could not withdraw it.', 'error'),
  });
  const tone = r.status === 'Approved' ? (r.expired ? 'badge-neutral' : 'badge-success') : r.status === 'Rejected' ? 'badge-danger' : r.status === 'Pending' ? 'badge-info' : 'badge-neutral';
  const label = r.status === 'Approved' && r.expired ? 'Ended' : r.status === 'Rejected' ? 'Declined' : r.status;
  return (
    <li className="ar-row">
      <Avatar name={r.requester.name} userId={r.requester.id} />
      <div className="ar-main">
        <div className="ar-title"><b>{r.requester.name}</b><span className="muted">wants to {LEVEL_TEXT[r.level]}</span>{showDoc && <><span className="doc-key">{r.documentKey}</span>{r.documentTitle && <Link to={`/documents/${r.documentId}`}>{r.documentTitle}</Link>}</>}</div>
        <p className="ar-why">“{r.reason}”</p>
        <div className="ar-sub muted">{timeAgo(r.createdAt)} · {r.durationDays ? `${r.durationDays} days` : 'no end date'}
          {r.status === 'Approved' && r.grantedUntil && <> · until {formatDate(r.grantedUntil)}</>}{r.decisionNote && <> · “{r.decisionNote}”</>}{r.decidedBy && <> · {r.decidedBy.name}</>}</div>
      </div>
      <span className={`badge ${tone}`}>{label}</span>
      {r.canDecide && onDecide && <button className="btn btn-primary btn-sm" onClick={onDecide}>Decide</button>}
      {r.status === 'Pending' && !r.canDecide && <button className="btn btn-ghost btn-sm" disabled={cancel.isPending} onClick={() => cancel.mutate()}>Withdraw</button>}
    </li>
  );
}

function ReviewRow({ r }: { r: ReviewItem }) {
  return (
    <li>
      <Link className="doc-row" to={`/documents/${r.document.id}`}>
        <TypeChip doc={r.document} />
        <div className="doc-row-main">
          <div className="doc-row-title"><span className="doc-key">{r.document.key}</span><b>{r.document.title}</b></div>
          <div className="doc-row-sub"><span>{r.step || 'Review'}</span><span>“{r.summary}”</span><span>{r.submittedBy.name} · {timeAgo(r.submittedAt)}</span>{r.overdue && <span className="badge badge-danger">Overdue</span>}</div>
        </div>
        <div className="doc-row-meta"><DocStatusBadge status={r.document.status} /><Icon name="chevronR" size={15} /></div>
      </Link>
    </li>
  );
}

/** Everything waiting on the signed-in person: reviews to decide, access requests to answer, and what they submitted or asked for. */
export function InboxView() {
  const q = useWsQuery(['documents', 'inbox'], documentApi.inbox);
  const [deciding, setDeciding] = useState<AccessRequest | null>(null);
  if (q.isLoading) return <PageLoader />;
  if (q.isError || !q.data) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const d = q.data;
  const nothing = d.toReview.length + d.submitted.length + d.accessToDecide.length + d.myAccessRequests.length === 0;
  return (
    <div className="inbox">
      {nothing && <EmptyState icon="inbox" title="Nothing is waiting for you" text="Documents sent to you for review and requests for access appear here." />}
      {d.toReview.length > 0 && <section><h3 className="inbox-h">Waiting for your review <span className="count">{d.toReview.length}</span></h3><ul className="doc-rows">{d.toReview.map((r) => <ReviewRow key={r.approvalId} r={r} />)}</ul></section>}
      {d.accessToDecide.length > 0 && <section><h3 className="inbox-h">Requests for access <span className="count">{d.accessToDecide.length}</span></h3><ul className="ar-list">{d.accessToDecide.map((r) => <AccessRequestRow key={r.id} r={r} onDecide={() => setDeciding(r)} />)}</ul></section>}
      {d.submitted.length > 0 && <section><h3 className="inbox-h">Your submissions</h3><ul className="doc-rows">{d.submitted.map((r) => <ReviewRow key={r.approvalId} r={r} />)}</ul></section>}
      {d.myAccessRequests.length > 0 && <section><h3 className="inbox-h">Your requests for access</h3><ul className="ar-list">{d.myAccessRequests.map((r) => <AccessRequestRow key={r.id} r={r} />)}</ul></section>}
      {deciding && <DecideAccessModal request={deciding} onClose={() => setDeciding(null)} />}
    </div>
  );
}
