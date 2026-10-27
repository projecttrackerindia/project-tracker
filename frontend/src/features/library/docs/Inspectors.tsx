import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ApiError } from '../../../api/client';
import { documentApi } from '../../../api/endpoints';
import type { DocVersion, DocumentDetail, DocumentReview } from '../../../api/types';
import { Avatar, ErrorState, PageLoader, Spinner } from '../../../components/ui';
import { formatDateTime, timeAgo } from '../../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../../lib/hooks';
import { queryClient, useWorkspaceId } from '../../../stores/auth';
import { confirmDialog, toast } from '../../../stores/ui';
import { ChangesModal } from '../../documents/ApiTools';
import { CompareView } from '../../documents/DocumentHistory';
import { SectionEditor } from '../../documents/SectionEditor';

const STATE_LABEL: Record<string, string> = { Pending: 'In review', Approved: 'Approved', ChangesRequested: 'Changes asked', Cancelled: 'Withdrawn', Published: 'Published' };

/**
 * Review, calm: where the document is in its review, each step and who decided what, and the next thing this person can do: submit,
 * approve or ask for changes with a comment, withdraw, or publish what was approved.
 */
export function ReviewInspector({ detail, review, canEdit, onSubmit, onPublish }: { detail: DocumentDetail; review: DocumentReview; canEdit: boolean; onSubmit: () => void; onPublish: () => void }) {
  const wid = useWorkspaceId();
  const id = detail.item.id;
  const a = review.current;
  const [comment, setComment] = useState('');
  const decide = useMutation({
    mutationFn: (kind: 'approve' | 'changes' | 'withdraw') => kind === 'approve' ? documentApi.approve(id, comment.trim() || undefined) : kind === 'changes' ? documentApi.requestChanges(id, comment.trim()) : documentApi.withdraw(id),
    onSuccess: (_r, kind) => { setComment(''); invalidateWorkspace(wid, 'documents'); toast(kind === 'approve' ? 'Approved.' : kind === 'changes' ? 'Sent back with your comment.' : 'Withdrawn from review.'); },
    onError: (e) => toast(e instanceof ApiError ? e.message : 'Could not do that.', 'error'),
  });
  const live = a && (a.state === 'Pending' || a.state === 'Approved' || a.state === 'ChangesRequested');
  return (
    <div className="dx-rvw" data-testid="review-inspector">
      {!live ? (
        <>
          <p className="dx-note">{review.workflowApplies ? `${review.workflowName ?? 'A review'} (${review.stepCount} step${review.stepCount === 1 ? '' : 's'}) checks this document before it is published.` : 'No review is needed before publishing.'}</p>
          {review.canSubmit && canEdit && <button type="button" className="dx-btn pri sm" disabled={!detail.hasUnpublishedChanges && !!detail.publishedLabel} onClick={onSubmit}>Submit for review</button>}
        </>
      ) : (
        <>
          <div className={`dx-rvw-state s-${a.state.toLowerCase()}`}><b>{a.state === 'Pending' ? `Step ${a.currentStep + 1} of ${a.steps.length}` : STATE_LABEL[a.state]}</b>{a.canDecide && <span className="dx-tag">Your turn</span>}</div>
          <p className="dx-rvw-sum">“{a.summary}”</p>
          <p className="dx-note">{a.submittedBy.name} · <span title={formatDateTime(a.submittedAt)}>{timeAgo(a.submittedAt)}</span>{a.dueAt && a.state === 'Pending' ? ` · due ${formatDateTime(a.dueAt)}` : ''}</p>
          <ol className="dx-steps">
            {a.steps.map((s, i) => (
              <li key={i} className={`st-${s.state.toLowerCase()}`}>
                <i aria-hidden="true" />
                <div><b>{s.name}</b><small>{s.who}</small>
                  {s.people.filter((p) => p.decision).map((p) => <p key={p.userId} className="dx-note"><b>{p.name}</b> {p.decision === 'Approved' ? 'approved' : 'asked for changes'}{p.comment ? `: “${p.comment}”` : ''}</p>)}
                </div>
              </li>
            ))}
          </ol>
          {a.canDecide && (
            <div className="dx-rvw-decide">
              <textarea className="dx-notes-in" rows={2} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Comment (needed to ask for changes)" aria-label="Review comment" />
              <div className="dx-row">
                <button type="button" className="dx-btn pri sm" disabled={decide.isPending} onClick={() => decide.mutate('approve')}>{decide.isPending && <Spinner />}Approve</button>
                <button type="button" className="dx-btn sm" disabled={decide.isPending || comment.trim().length < 2} onClick={() => decide.mutate('changes')}>Request changes</button>
              </div>
            </div>
          )}
          <div className="dx-row">
            {a.state === 'Approved' && canEdit && detail.can.publish && <button type="button" className="dx-btn pri sm" onClick={onPublish}>Publish</button>}
            {a.canWithdraw && <button type="button" className="dx-btn sm" disabled={decide.isPending} onClick={() => decide.mutate('withdraw')}>Withdraw</button>}
          </div>
          {a.state === 'Pending' && canEdit && <p className="dx-note">Changing the text now cancels this review.</p>}
        </>
      )}
      {review.history.length > 0 && (
        <details className="dx-rvw-past"><summary>Earlier reviews · {review.history.length}</summary>
          <ul>{review.history.map((h) => <li key={h.id}><b>{STATE_LABEL[h.state] ?? h.state}</b> · {h.summary} <small>{timeAgo(h.closedAt ?? h.submittedAt)}</small>{h.closedNote && <small> · {h.closedNote}</small>}</li>)}</ul>
        </details>
      )}
    </div>
  );
}

type View = null | { kind: 'read'; id: string } | { kind: 'diff'; from: string; to: string };

/** Versions as a timeline: each publish with who, when and why; read one, see what changed, restore it, or (for an API) see the API changes. */
export function VersionsInspector({ detail, hasApi, onExpand }: { detail: DocumentDetail; hasApi: boolean; onExpand: (v: View) => void }) {
  const wid = useWorkspaceId();
  const id = detail.item.id;
  const q = useWsQuery(['documents', id, 'versions'], () => documentApi.versions(id));
  const [apiChanges, setApiChanges] = useState(false);
  const [limit, setLimit] = useState(6);
  const restore = useMutation({
    mutationFn: (v: DocVersion) => documentApi.restoreVersion(id, v.id, { discardChanges: true, revision: detail.revision }),
    onSuccess: () => { invalidateWorkspace(wid, 'documents'); queryClient.removeQueries({ queryKey: [wid, 'documents', id] }); toast('Restored as a new version.'); },
    onError: (e) => toast(e instanceof ApiError ? e.message : 'Could not restore.', 'error'),
  });
  if (q.isLoading) return <PageLoader />;
  if (q.isError || !q.data) return <ErrorState error={q.error} retry={() => void q.refetch()} />;
  const items = q.data.items;
  const newest = items[0];
  const published = items.find((v) => v.isCurrent);
  if (!items.length) return <p className="dx-note">Nothing published yet. Each publish appears here, readable and restorable.</p>;
  return (
    <div className="dx-vers" data-testid="versions">
      <ol className="dx-timeline">
        {items.slice(0, limit).map((v) => (
          <li key={v.id} className={`${v.isCurrent ? 'cur' : ''}${v.isDraft ? ' draft' : ''}`}>
            <i aria-hidden="true" />
            <div>
              <div className="dx-tl-h"><b>{v.isDraft ? 'Working draft' : `v${v.label}`}</b>{v.isCurrent && <span className="dx-tag ok">Current</span>}{v.isDraft && v.hasChanges && <span className="dx-tag warn">Unpublished</span>}</div>
              {v.changeSummary && <p>{v.changeSummary}</p>}
              {v.changeReason && <p className="dx-note">Why: {v.changeReason}</p>}
              {v.publishedBy && <p className="dx-note dx-tl-by"><Avatar name={v.publishedBy.name} userId={v.publishedBy.id} size="sm" /> {v.publishedBy.name} · <span title={formatDateTime(v.publishedAt)}>{timeAgo(v.publishedAt)}</span></p>}
              <div className="dx-tl-acts">
                <button type="button" className="dx-link" onClick={() => onExpand({ kind: 'read', id: v.id })}>Read</button>
                {v.id !== newest?.id ? <button type="button" className="dx-link" onClick={() => onExpand({ kind: 'diff', from: v.id, to: newest.id })}>Changes since</button>
                  : published && published.id !== v.id && <button type="button" className="dx-link" onClick={() => onExpand({ kind: 'diff', from: published.id, to: v.id })}>Changes</button>}
                {detail.can.edit && !v.isDraft && !v.isCurrent && <button type="button" className="dx-link" disabled={restore.isPending} onClick={async () => {
                  if (await confirmDialog({ title: `Restore version ${v.label}?`, message: `This publishes a new version with the text of ${v.label}; every version stays in the history.${q.data.hasUnpublishedChanges ? ' The unpublished changes in the draft will be replaced.' : ''}`, confirmText: 'Restore', danger: false })) restore.mutate(v);
                }}>Restore</button>}
              </div>
            </div>
          </li>
        ))}
      </ol>
      {items.length > limit && <button type="button" className="dx-link" onClick={() => setLimit((n) => n + 6)}>Show older</button>}
      {hasApi && <button type="button" className="dx-btn sm" onClick={() => setApiChanges(true)}>API changes between versions</button>}
      {apiChanges && <ChangesModal documentId={id} canEdit={detail.can.edit} onClose={() => setApiChanges(false)} />}
    </div>
  );
}

/** A version read in place of the document, or the difference between two, inside the reading column. */
export function VersionStage({ documentId, view, onClose }: { documentId: string; view: NonNullable<View>; onClose: () => void }) {
  const read = useWsQuery(['documents', documentId, 'version', view.kind === 'read' ? view.id : ''], () => documentApi.version(documentId, (view as { id: string }).id), { enabled: view.kind === 'read' });
  return (
    <section className="dx-verstage" aria-label={view.kind === 'read' ? 'Version' : 'Changes'} data-testid="version-stage">
      <div className="dx-verstage-bar"><b>{view.kind === 'read' ? `Reading version ${read.data?.version.label ?? ''}` : 'What changed'}</b><span className="dx-note">read only</span><button type="button" className="dx-btn sm" onClick={onClose}>Back to the document</button></div>
      {view.kind === 'diff' ? <CompareView documentId={documentId} from={view.from} to={view.to} /> : read.isLoading ? <PageLoader /> : read.isError || !read.data ? <ErrorState error={read.error} /> : (
        <div className="doc-body">{read.data.sections.length === 0 ? <p className="dx-note">Nothing was written in this version.</p> : read.data.sections.map((s) => <SectionEditor key={s.key} section={s} value={s.content} readOnly />)}</div>
      )}
    </section>
  );
}
export type { View as VersionView };
