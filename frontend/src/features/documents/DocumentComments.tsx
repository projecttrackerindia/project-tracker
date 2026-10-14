import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { documentApi } from '../../api/endpoints';
import { Icon } from '../../components/Icon';
import { Avatar, EmptyState, ErrorState, Modal, PageLoader } from '../../components/ui';
import { formatDateTime, timeAgo } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';

const MAX_BODY = 4000;

/** The running conversation on a document: anyone who can open it can read and add to it - a separate thing from an approval step's own decision comment. */
function CommentsThread({ id }: { id: string }) {
  const wid = useWorkspaceId();
  const q = useWsQuery(['documents', id, 'comments'], () => documentApi.comments(id));
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const add = useMutation({
    mutationFn: () => documentApi.addComment(id, body.trim()),
    onSuccess: () => { setBody(''); setError(null); invalidateWorkspace(wid, 'documents'); },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not add the comment.'),
  });
  if (q.isLoading) return <PageLoader />;
  if (q.isError || !q.data) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  return (
    <div className="cmt">
      {q.data.length === 0 ? <EmptyState icon="message" title="Nothing said yet" text="Be the first to leave a note on this document." /> : (
        <ul className="cmt-list">
          {q.data.map((c) => (
            <li key={c.id} className={c.mine ? 'mine' : ''}>
              <Avatar name={c.user.name} userId={c.user.id} />
              <div className="cmt-body">
                <div className="cmt-meta"><b>{c.user.name}</b><span className="muted" title={formatDateTime(c.createdAt)}>{timeAgo(c.createdAt)}</span></div>
                <p>{c.body}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
      <form className="cmt-add" onSubmit={(e) => { e.preventDefault(); if (body.trim() && !add.isPending) add.mutate(); }}>
        {error && <div className="doc-alert" role="alert"><Icon name="alert" size={16} /><div>{error}</div></div>}
        <textarea className="input" rows={3} maxLength={MAX_BODY} placeholder="Add a comment…" value={body} onChange={(e) => setBody(e.target.value)} aria-label="Add a comment" />
        <div className="cmt-add-foot">
          <span className="muted">{body.length}/{MAX_BODY}</span>
          <button className="btn btn-primary btn-sm" type="submit" disabled={!body.trim() || add.isPending}>{add.isPending && <span className="spinner" />}Comment</button>
        </div>
      </form>
    </div>
  );
}

export function CommentsModal({ id, title, onClose }: { id: string; title: string; onClose: () => void }) {
  return (
    <Modal title="Comments" subtitle={title} size="lg" onClose={onClose} className="doc-scope" footer={<button className="btn btn-ghost" onClick={onClose}>Close</button>}>
      <CommentsThread id={id} />
    </Modal>
  );
}

export function CommentsCard({ id, title }: { id: string; title: string }) {
  const [open, setOpen] = useState(false);
  const q = useWsQuery(['documents', id, 'comments'], () => documentApi.comments(id));
  const count = q.data?.length ?? 0;
  return (
    <div className="card doc-side-card">
      <div className="card-head"><div><h3>Comments{count > 0 && <span className="doc-count">{count}</span>}</h3></div><button className="btn btn-ghost btn-sm" onClick={() => setOpen(true)}>All</button></div>
      <div className="card-body">
        {count === 0 ? <p className="muted">Nothing said yet.</p> : (
          <ul className="act mini">
            {(q.data ?? []).slice(-3).reverse().map((c) => <li key={c.id}><div><span>{c.user.name}: {c.body.length > 80 ? `${c.body.slice(0, 80)}…` : c.body}</span><small title={formatDateTime(c.createdAt)}>{timeAgo(c.createdAt)}</small></div></li>)}
          </ul>
        )}
      </div>
      {open && <CommentsModal id={id} title={title} onClose={() => setOpen(false)} />}
    </div>
  );
}
