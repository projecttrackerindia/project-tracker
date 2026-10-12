import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import { inboxSummaryApi } from '../../api/endpoints.platform';
import type { InboxSummary as Summary, InboxSummaryOptions, InboxSummaryReceipt, InboxSummaryRequest, InboxThread } from '../../api/types';
import { Icon } from '../../components/Icon';
import { confirmDialog } from '../../stores/ui';

// Mail and generated text stay in component memory. Unmounting retires every response.
export function InboxSummary({ thread, messageId }: { thread: InboxThread; messageId: string }) {
  const [options, setOptions] = useState<InboxSummaryOptions | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [history, setHistory] = useState<InboxSummaryReceipt[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const operation = useRef<InboxSummaryRequest | null>(null);
  const request = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  const retire = useCallback(() => { sequence.current++; request.current?.abort(); }, []);
  const failure = (e: unknown) => e instanceof ApiError ? e.errors[0]?.message ?? e.message : 'The result could not be retrieved. Check the saved receipt before starting another summary.';
  useEffect(() => {
    const controller = new AbortController(); let active = true;
    void inboxSummaryApi.options(controller.signal).then(result => { if (active) setOptions(result); }).catch(e => { if (active && !controller.signal.aborted) setError(failure(e)); });
    return () => { active = false; controller.abort(); retire(); };
  }, [retire]);
  const run = async (kind: 'generate' | 'check' | 'history', receipt?: string) => {
    if (busy) return;
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    const current = ++sequence.current; setBusy(true); setError('');
    try {
      if (kind === 'history') {
        const result = await inboxSummaryApi.list(controller.signal);
        if (current === sequence.current) setHistory(result.filter(r => r.provider === thread.provider && r.messageId === messageId));
      } else {
        const result = kind === 'generate' ? await inboxSummaryApi.create(operation.current!, controller.signal) : await inboxSummaryApi.get(receipt || operation.current!.operationId, controller.signal);
        if (current === sequence.current) setSummary(result);
      }
    } catch (e) { if (current === sequence.current && !controller.signal.aborted) setError(failure(e)); }
    finally { if (current === sequence.current) setBusy(false); }
  };
  const generate = async () => {
    if (!options?.available || busy || thread.truncated) return;
    if (!operation.current) {
      const current = sequence.current;
      if (!await confirmDialog({ title: 'Share this conversation with AI?', message: `Only the displayed conversation will be shared with the configured AI provider. A validated result costs ${options.credits} AI ${options.credits === 1 ? 'credit' : 'credits'} and is saved privately for ${options.retentionHours} hours. Review every point against its source before using it.`, confirmText: `Summarize for ${options.credits} ${options.credits === 1 ? 'credit' : 'credits'}`, danger: false }) || current !== sequence.current) return;
      operation.current = { operationId: crypto.randomUUID(), provider: thread.provider, messageId, sourceHash: thread.sourceHash, credits: options.credits, confirmed: true };
    }
    await run('generate');
  };
  const remove = async () => {
    if (!summary || busy) return;
    const current = sequence.current;
    if (!await confirmDialog({ title: 'Delete this saved summary?', message: 'The private result will be deleted. The financial receipt remains for billing accuracy; this does not refund a completed generation.', confirmText: 'Delete summary', danger: true }) || current !== sequence.current) return;
    const id = summary.operationId; setBusy(true); setError('');
    try { await inboxSummaryApi.remove(id); if (current === sequence.current) { setSummary(null); setHistory(rows => rows?.filter(r => r.operationId !== id) ?? null); operation.current = null; } }
    catch (e) { if (current === sequence.current) setError(failure(e)); }
    finally { if (current === sequence.current) setBusy(false); }
  };
  const pending = summary?.status === 'pending';
  return <section className="inbox-summary" aria-labelledby="inbox-summary-title" aria-busy={busy}>
    <header><div className="inbox-summary-symbol" aria-hidden="true"><Icon name="sparkle" size={18} /></div><div><span className="studio-eyebrow">PRIVATE INTELLIGENCE</span><h4 id="inbox-summary-title">Understand, with evidence</h4></div><span className="inbox-summary-review">Human review</span></header>
    <p className="inbox-summary-note">AI highlights cite the original message. Your conversation stays under your control.</p>
    {thread.truncated && <p className="inbox-summary-note">A complete conversation is required for a summary.</p>}
    <div className="inbox-summary-actions">
      {options?.available && !summary && <button className="btn btn-primary btn-sm" disabled={busy || thread.truncated || !thread.sourceHash} onClick={() => void generate()}>{busy ? 'Working...' : operation.current ? 'Retry same operation' : 'Summarize conversation'}</button>}
      {options && !options.available && <span className="inbox-summary-note">AI summaries await administrator setup. Manual reading is available.</span>}
      {operation.current && (!summary || pending) && <button className="btn btn-sm" disabled={busy} onClick={() => void run('check')}>Check saved result</button>}
      <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void run('history')}>Saved summaries</button>
    </div>
    {error && <p className="inbox-summary-error" role="alert">{error}</p>}
    {busy && <p className="inbox-summary-note" role="status">Retrieving your private result. You can return to its saved receipt after leaving this view.</p>}
    {summary && <div className="inbox-summary-result">
      <div className="inbox-summary-receipt"><span>{summary.status === 'completed' ? 'Saved, source-linked result' : `Result: ${summary.status}`}</span><span>{summary.credits} {summary.credits === 1 ? 'credit' : 'credits'} charged</span></div>
      {summary.sourceChanged && <p className="inbox-truncated" role="status">The source has changed since this summary was generated. Reopen and review the current conversation before using these points.</p>}
      {pending && <p className="inbox-summary-note">Generation is still pending. Check this receipt again; it will not start another AI call. Interrupted holds expire automatically.</p>}
      {['failed', 'expired'].includes(summary.status) && <p className="inbox-summary-note">This operation did not publish a result. It cannot be generated again with the same receipt.</p>}
      <ol className="inbox-summary-points">{summary.points.map((point, i) => <li key={i}><p>{point.text}</p><blockquote>{point.quote}</blockquote><button className="btn btn-ghost btn-sm" onClick={() => { const source = document.getElementById(`inbox-source-${point.messageId}`); source?.scrollIntoView({ behavior: 'auto', block: 'center' }); source?.focus(); }}>View cited message</button></li>)}</ol>
      <div className="inbox-summary-actions"><small>Private result expires after 24 hours.</small><button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void remove()}>Delete saved summary</button></div>
    </div>}
    {history && <div className="inbox-summary-history"><h5>Saved for this conversation</h5>{!history.length ? <p className="inbox-summary-note">No unexpired summaries for this message.</p> : history.map(row => <button key={row.operationId} className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void run('check', row.operationId)}><span>{row.status}</span><time dateTime={row.createdAt}>{new Date(row.createdAt).toLocaleDateString()}</time></button>)}</div>}
  </section>;
}
