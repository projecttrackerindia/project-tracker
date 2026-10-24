import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import { documentApi } from '../../api/endpoints';
import type { DocComment } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Avatar } from '../../components/ui';
import { formatDateTime, timeAgo } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import type { CommentRequest } from './RichEditor';

const MAX_BODY = 4000;
interface Thread { root: DocComment; replies: DocComment[] }

export function threadsOf(comments: DocComment[]): Thread[] {
  const roots = comments.filter((c) => !c.parentId);
  const byParent = new Map<string, DocComment[]>();
  for (const c of comments) if (c.parentId) byParent.set(c.parentId, [...(byParent.get(c.parentId) ?? []), c]);
  return roots.map((root) => ({ root, replies: byParent.get(root.id) ?? [] }));
}

function Composer({ placeholder, onSend, onCancel, autoFocus, label }: { placeholder: string; onSend: (body: string) => Promise<void>; onCancel?: () => void; autoFocus?: boolean; label: string }) {
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async () => {
    if (!body.trim() || busy) return;
    setBusy(true);
    try { await onSend(body.trim()); setBody(''); } finally { setBusy(false); }
  };
  return (
    <form className="ct-compose" onSubmit={(e) => { e.preventDefault(); void send(); }}>
      <textarea className="input" rows={2} maxLength={MAX_BODY} value={body} autoFocus={autoFocus} aria-label={label} placeholder={placeholder} onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); } if (e.key === 'Escape' && onCancel) onCancel(); }} />
      <div className="ct-compose-foot">
        {onCancel && <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>Cancel</button>}
        <button type="submit" className="btn btn-primary btn-sm" disabled={!body.trim() || busy}>{busy && <span className="spinner" />}Comment</button>
      </div>
    </form>
  );
}

/**
 * The page's conversations: threads on highlighted passages (click the highlight to open its thread, click the quote to jump back to it) and
 * general ones, each with replies, resolved when settled. A resolved thread's highlight comes off the text; the thread stays under "Resolved".
 */
export function CommentThreads({ id, focus, pending, onPendingDone, onJump, onResolved, onClose }: {
  id: string; focus: string | null; pending: CommentRequest | null; onPendingDone: () => void;
  onJump: (anchorId: string) => void; onResolved: (anchorId: string) => void; onClose: () => void;
}) {
  const wid = useWorkspaceId();
  const q = useWsQuery(['documents', id, 'comments'], () => documentApi.comments(id));
  const [show, setShow] = useState<'open' | 'resolved'>('open');
  const threads = useMemo(() => threadsOf(q.data ?? []), [q.data]);
  const open = threads.filter((t) => !t.root.resolvedAt);
  const resolved = threads.filter((t) => t.root.resolvedAt);
  const list = show === 'open' ? open : resolved;
  const focused = useRef<HTMLLIElement | null>(null);
  useEffect(() => {
    if (!focus) return;
    const t = threads.find((x) => x.root.anchorId === focus);
    if (t?.root.resolvedAt) setShow('resolved');
    window.setTimeout(() => focused.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 50);
  }, [focus, threads]);

  const refresh = () => invalidateWorkspace(wid, 'documents');
  const fail = (e: unknown, what: string) => toast(e instanceof ApiError ? e.message : what, 'error');
  const start = async (body: string) => {
    if (!pending) return;
    try { await documentApi.addComment(id, body, { anchorId: pending.anchorId ?? undefined, quote: pending.quote || undefined }); onPendingDone(); setShow('open'); refresh(); }
    catch (e) { fail(e, 'Could not add the comment.'); throw e; }
  };
  const general = async (body: string) => {
    try { await documentApi.addComment(id, body); refresh(); } catch (e) { fail(e, 'Could not add the comment.'); throw e; }
  };
  const reply = async (root: DocComment, body: string) => {
    try { await documentApi.addComment(id, body, { parentId: root.id }); refresh(); } catch (e) { fail(e, 'Could not reply.'); throw e; }
  };
  const resolve = async (root: DocComment, done: boolean) => {
    try {
      await documentApi.resolveComment(id, root.id, done);
      if (done && root.anchorId) onResolved(root.anchorId);
      refresh();
      toast(done ? 'Resolved. The thread is under “Resolved”.' : 'Reopened.', 'success');
    } catch (e) { fail(e, 'Could not change the thread.'); }
  };

  return (
    <aside className="ct" aria-label="Comments">
      <header className="ct-head">
        <h3>Comments</h3>
        <div className="ct-tabs" role="tablist" aria-label="Which threads">
          <button type="button" role="tab" aria-selected={show === 'open'} className={show === 'open' ? 'on' : ''} onClick={() => setShow('open')}>Open{open.length ? ` ${open.length}` : ''}</button>
          <button type="button" role="tab" aria-selected={show === 'resolved'} className={show === 'resolved' ? 'on' : ''} onClick={() => setShow('resolved')}>Resolved{resolved.length ? ` ${resolved.length}` : ''}</button>
        </div>
        <button type="button" className="ct-x" aria-label="Close comments" onClick={onClose}><Icon name="close" size={16} /></button>
      </header>

      {pending && (
        <div className="ct-new">
          {pending.quote && <blockquote className="ct-quote">{pending.quote}</blockquote>}
          <Composer autoFocus label="Your comment" placeholder="Comment on this passage… (Ctrl+Enter to send)" onSend={start} onCancel={() => { pending.cancel(); onPendingDone(); }} />
        </div>
      )}

      {q.isLoading ? <p className="ct-none">Loading…</p> : list.length === 0 ? (
        <p className="ct-none">{show === 'open' ? 'No open threads. Select text in the page and choose Comment to start a thread.' : 'Nothing resolved yet.'}</p>
      ) : (
        <ul className="ct-list">
          {list.map((t) => {
            const isFocus = !!focus && t.root.anchorId === focus;
            return (
              <li key={t.root.id} ref={isFocus ? focused : undefined} className={`ct-thread${isFocus ? ' focus' : ''}${t.root.resolvedAt ? ' done' : ''}`}>
                {t.root.quote && (
                  t.root.anchorId && !t.root.resolvedAt
                    ? <button type="button" className="ct-quote as-link" onClick={() => onJump(t.root.anchorId!)} title="Show in the page">{t.root.quote}</button>
                    : <blockquote className="ct-quote">{t.root.quote}</blockquote>
                )}
                {[t.root, ...t.replies].map((c) => (
                  <div key={c.id} className={`ct-c${c.mine ? ' mine' : ''}`}>
                    <Avatar name={c.user.name} userId={c.user.id} size="sm" />
                    <div>
                      <div className="ct-meta"><b>{c.user.name}</b><span title={formatDateTime(c.createdAt)}>{timeAgo(c.createdAt)}</span></div>
                      <p>{c.body}</p>
                    </div>
                  </div>
                ))}
                {t.root.resolvedAt && <p className="ct-resolved">Resolved {t.root.resolvedBy ? `by ${t.root.resolvedBy} ` : ''}{timeAgo(t.root.resolvedAt)}</p>}
                <div className="ct-actions">
                  {t.root.canResolve !== false && (t.root.resolvedAt
                    ? <button type="button" className="link-btn" onClick={() => void resolve(t.root, false)}>Reopen</button>
                    : <button type="button" className="link-btn" onClick={() => void resolve(t.root, true)}><Icon name="tick" size={13} /> Resolve</button>)}
                </div>
                {!t.root.resolvedAt && <Composer label={`Reply to ${t.root.user.name}`} placeholder="Reply…" onSend={(b) => reply(t.root, b)} />}
              </li>
            );
          })}
        </ul>
      )}
      {!pending && show === 'open' && (
        <div className="ct-general"><Composer label="Comment on the whole page" placeholder="Comment on the whole page…" onSend={general} /></div>
      )}
    </aside>
  );
}
