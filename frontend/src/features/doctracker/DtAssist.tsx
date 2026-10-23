import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError } from '../../api/client';
import type { DtProject } from '../../api/types';
import { Icon } from '../../components/Icon';
import { timeAgo } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { docAiApi, type AskAnswer, type DocProposal } from '../documents/docAi';
import { RichEditor } from '../documents/RichEditor';

/** The words of a hit with the searched words marked. */
function Marked({ text, q }: { text: string; q: string }) {
  const words = q.toLowerCase().split(/\s+/).filter((w) => w.length > 1).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!words.length) return <>{text}</>;
  const re = new RegExp(`(${words.join('|')})`, 'gi');
  return <>{text.split(re).map((part, i) => (i % 2 === 1 ? <mark key={i}>{part}</mark> : <span key={i}>{part}</span>))}</>;
}

/** Search inside the pages, best first, each with the line that matched (opens the page at that line). */
export function PageTextHits({ q }: { q: string }) {
  const [debounced, setDebounced] = useState(q);
  useEffect(() => { const t = window.setTimeout(() => setDebounced(q.trim()), 250); return () => window.clearTimeout(t); }, [q]);
  const r = useWsQuery(['documents', 'search', debounced], () => docAiApi.search(debounced, null, 12), { enabled: debounced.length >= 2, staleTime: 30_000 });
  if (debounced.length < 2) return null;
  if (r.isLoading) return <p className="dl-empty">Looking inside the pages…</p>;
  const hits = r.data?.hits ?? [];
  if (!hits.length) return null;
  return (
    <>
      <h3>Inside pages <small className="muted">{r.data!.total > hits.length ? `${hits.length} of ${r.data!.total}` : hits.length}</small></h3>
      <ul className="dl-rows dt-text-hits">
        {hits.map((h) => (
          <li key={h.id}>
            <Link to={`/documents/${h.id}${h.block >= 0 ? `#b-${h.block}` : ''}`} className="dl-row dt-text-hit">
              <span className="dt-hit-icon" aria-hidden="true">{h.icon ?? '📄'}</span>
              <span className="dt-hit-main"><b><Marked text={h.title} q={debounced} /></b>{h.line && <small><Marked text={h.line} q={debounced} /></small>}</span>
              <span className="dl-row-sub">{h.projectName ?? 'General'}</span>
              <time className="dl-row-time" dateTime={h.updatedAt}>{timeAgo(h.updatedAt)}</time>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}

/** The answer to a question about the pages, its citations linked to the lines they came from. */
export function AskAnswerCard({ question, onClose }: { question: string; onClose: () => void }) {
  const [state, setState] = useState<{ busy: boolean; answer: AskAnswer | null; error: string | null }>({ busy: true, answer: null, error: null });
  useEffect(() => {
    let off = false;
    setState({ busy: true, answer: null, error: null });
    docAiApi.ask(question).then((a) => { if (!off) setState({ busy: false, answer: a, error: null }); })
      .catch((e) => { if (!off) setState({ busy: false, answer: null, error: e instanceof ApiError ? e.message : 'The AI could not answer right now.' }); });
    return () => { off = true; };
  }, [question]);
  const a = state.answer;
  // "[2]" in the answer becomes a link to the second citation.
  const parts = a ? a.answer.split(/(\[\d+\])/g) : [];
  return (
    <section className="dt-ask-card" aria-live="polite" aria-label="Answer from your pages">
      <header><span>✨ {question}</span><button type="button" className="ct-x" aria-label="Close the answer" onClick={onClose}><Icon name="close" size={15} /></button></header>
      {state.busy ? <p className="muted"><span className="spinner" /> Reading the pages you can open…</p>
        : state.error ? <p className="aid-err" role="alert">{state.error}</p>
          : a && (
            <>
              <p className="dt-ask-text">{parts.map((p, i) => {
                const m = /^\[(\d+)\]$/.exec(p);
                const c = m ? a.citations.find((x) => x.n === Number(m[1])) : undefined;
                return c ? <Link key={i} className="dt-cite" to={`/documents/${c.documentId}#b-${c.block}`} title={`${c.key} · ${c.title}`}>{c.n}</Link> : <span key={i}>{p}</span>;
              })}</p>
              {a.citations.length > 0 && (
                <ol className="dt-ask-sources">
                  {a.citations.map((c) => (
                    <li key={c.n}><Link to={`/documents/${c.documentId}#b-${c.block}`}><span aria-hidden="true">{c.icon ?? '📄'}</span> <b>{c.title}</b> <small>{c.key}</small></Link><q>{c.snippet}</q></li>
                  ))}
                </ol>
              )}
              <p className="muted small">{a.found ? `From ${a.pagesRead} page${a.pagesRead === 1 ? '' : 's'} you can open.` : 'Nothing in the pages you can open answers this.'}</p>
            </>
          )}
    </section>
  );
}

const KIND_LABEL: Record<DocProposal['kind'], { label: string; icon: string }> = {
  'decision-log': { label: 'Decision log', icon: '🧭' },
  'release-notes': { label: 'Release notes', icon: '🚀' },
  'api-reference': { label: 'API reference', icon: '🔌' },
};

/**
 * Pages that write themselves: decisions from meetings, release notes from finished sprints and API references from changed APIs arrive as
 * drafts. Read one, then add it (a new page, or added to the page it belongs in) or dismiss it. Nothing reaches a page until accepted.
 */
export function DraftsToReview({ projects, canCreate }: { projects: DtProject[]; canCreate: boolean }) {
  const wid = useWorkspaceId();
  const navigate = useNavigate();
  const q = useWsQuery(['documents', 'proposals', 'Proposed'], () => docAiApi.proposals(null, 'Proposed'), { staleTime: 30_000 });
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [make, setMake] = useState<{ kind: DocProposal['kind']; projectId: string } | null>(null);
  const real = projects.filter((p): p is DtProject & { id: string } => !!p.id);
  const refresh = () => invalidateWorkspace(wid, 'documents');
  const act = async (p: DocProposal, what: 'accept' | 'dismiss') => {
    setBusy(p.id);
    try {
      if (what === 'accept') {
        const r = await docAiApi.accept(p.id);
        toast(r.message, 'success', { label: 'Open', onClick: () => navigate(`/documents/${r.documentId}`) });
      } else { await docAiApi.dismiss(p.id); toast('Dismissed. It will not be suggested again.', 'info'); }
      refresh();
    } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not do that.', 'error'); }
    setBusy(null);
  };
  const generate = async () => {
    if (!make) return;
    setBusy('make');
    try { const p = await docAiApi.generate(make.kind, make.projectId); setOpen(p.id); setMake(null); refresh(); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Could not make the draft.', 'error'); }
    setBusy(null);
  };
  const items = q.data ?? [];
  if (!canCreate && !items.length) return null;
  return (
    <section className="dl-section dt-drafts" aria-label="Drafts to review">
      <header>
        <h3>Drafts to review{items.length > 0 && <span className="doc-count">{items.length}</span>}</h3>
        {canCreate && real.length > 0 && !make && <button type="button" className="mb-link" onClick={() => setMake({ kind: 'release-notes', projectId: real[0].id })}>✨ Make a draft</button>}
      </header>
      {make && (
        <form className="dt-make" onSubmit={(e) => { e.preventDefault(); void generate(); }}>
          <select className="input" aria-label="What to write" value={make.kind} onChange={(e) => setMake({ ...make, kind: e.target.value as DocProposal['kind'] })}>
            <option value="release-notes">Release notes from the last finished sprint</option>
            <option value="decision-log">Decision log from the last meeting with decisions</option>
          </select>
          <select className="input" aria-label="Project" value={make.projectId} onChange={(e) => setMake({ ...make, projectId: e.target.value })}>
            {real.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy === 'make'}>{busy === 'make' && <span className="spinner" />}Write it</button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setMake(null)}>Cancel</button>
        </form>
      )}
      {items.length === 0 ? <p className="dl-empty">Nothing waiting. Finished sprints, meeting decisions and API changes are drafted here for you to approve.</p> : (
        <ul className="dt-draft-list">
          {items.map((p) => (
            <li key={p.id} className={open === p.id ? 'open' : ''}>
              <div className="dt-draft-head">
                <span className="dt-draft-kind" aria-hidden="true">{KIND_LABEL[p.kind]?.icon ?? '📝'}</span>
                <div className="dt-draft-main">
                  <b>{p.title}</b>
                  <small>{KIND_LABEL[p.kind]?.label ?? p.kind}{p.projectKey ? ` · ${p.projectKey}` : ''} · {p.action === 'create' ? 'a new page' : p.action === 'replace' ? `replaces ${p.targetTitle ?? 'its page'}` : `added to ${p.targetTitle ?? 'its page'}`} · {timeAgo(p.createdAt)}</small>
                  {p.summary && <p>{p.summary}</p>}
                </div>
                <div className="dt-draft-actions">
                  <button type="button" className="btn btn-ghost btn-sm" aria-expanded={open === p.id} onClick={() => setOpen((o) => (o === p.id ? null : p.id))}>{open === p.id ? 'Hide' : 'Read'}</button>
                  {canCreate && <button type="button" className="btn btn-primary btn-sm" disabled={busy === p.id} onClick={() => void act(p, 'accept')}>{busy === p.id && <span className="spinner" />}{p.action === 'create' ? 'Create page' : 'Add it'}</button>}
                  {canCreate && <button type="button" className="btn btn-ghost btn-sm" disabled={busy === p.id} onClick={() => void act(p, 'dismiss')}>Dismiss</button>}
                </div>
              </div>
              {open === p.id && <div className="dt-draft-body"><RichEditor key={p.body} value={p.body} readOnly minimal label={`${p.title} draft`} /></div>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
