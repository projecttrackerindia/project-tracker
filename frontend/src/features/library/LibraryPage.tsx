import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { DocTrackerPage } from '../doctracker/DocTrackerPage';
import { DotsMenu } from '../talk/DotsMenu';
import { DocumentPage } from '../documents/DocumentPage';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { apiDocApi, docTrackerApi, documentApi } from '../../api/endpoints';
import { aiApi } from '../ai/Assistant';
import type { ApiDefinition, DocumentStatus } from '../../api/types';
import { EmptyState, ErrorState, PageLoader, Segmented, Spinner } from '../../components/ui';
import { timeAgo } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { AiDraftDialog } from '../documents/AiDraft';
import { ImportModal as ApiImportModal } from '../documents/ApiTools';
import { docAiApi, type DocProposal } from '../documents/docAi';
import { useNewPage } from '../documents/pages';
import { RichEditor } from '../documents/RichEditor';
import { LibraryVault } from './LibraryVault';
import { AskDocs } from './LibraryAsk';
import { ContinueShelf } from './LibraryShelf';
import { chipOf, inFilter, KIND_FILTERS, type KindFilter } from './libraryKinds';
import './library.css';

export type LibraryTab = 'docs' | 'vault';
const STATUS: Record<DocumentStatus, { label: string; tone: string }> = {
  Draft: { label: 'Draft', tone: 'draft' }, InReview: { label: 'In review', tone: 'review' }, ChangesRequested: { label: 'Changes asked', tone: 'changes' },
  Approved: { label: 'Approved', tone: 'ok' }, Published: { label: 'Published', tone: 'ok' }, Archived: { label: 'Archived', tone: 'draft' },
};
/** Today, a weekday within the week, else "22 Oct". */
const updated = (iso: string) => {
  const d = new Date(iso), now = new Date();
  if (d.toDateString() === now.toDateString()) return 'Today';
  return now.getTime() - d.getTime() < 6 * 86_400_000 ? d.toLocaleDateString(undefined, { weekday: 'short' }) : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
};
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?';
const hue = (s: string) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };

/**
 * Library: every document, Books-style. The Continue shelf (the four last opened, as covers with a live preview and how far they were read),
 * then one clean list filtered by kind; on the right, Ask your docs (answers from inside the pages, with their sources), what needs your
 * review and Paste a cURL. Vault is its own place in the sidebar (/library/vault).
 * Addresses: /library (Docs), /library/docs/{id} (a document), /library/vault and /library/vault/{item id}.
 */
function LibraryHome({ tab: forced }: { tab?: LibraryTab } = {}) {
  const location = useLocation();
  const [params] = useSearchParams();
  const tab: LibraryTab = forced ?? (/\/library\/vault/.test(location.pathname) || params.get('tab') === 'vault' ? 'vault' : 'docs');
  return tab === 'vault' ? <LibraryVault /> : <LibraryDocs />;
}

function LibraryDocs() {
  const navigate = useNavigate();
  const wid = useWorkspaceId();
  const [kind, setKind] = useState<KindFilter>('all');
  const [asking, setAsking] = useState(false);
  const catalog = useWsQuery(['documents', 'doctracker', 'catalog'], docTrackerApi.catalog, { staleTime: 20_000 });
  const docs = useWsQuery(['documents', 'library', 'all'], () => documentApi.list({ limit: 100 }), { staleTime: 20_000, placeholderData: (p) => p });
  const recent = useWsQuery(['documents', 'recent'], () => documentApi.list({ scope: 'recent', limit: 4 }), { staleTime: 20_000, retry: false });
  const projects = useMemo(() => (catalog.data?.projects ?? []).filter((p): p is typeof p & { id: string } => !!p.id).map((p) => ({ id: p.id, name: p.name })), [catalog.data]);
  const all = useMemo(() => [...(docs.data?.items ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), [docs.data]);
  const types = useMemo(() => new Map([...all, ...(recent.data?.items ?? [])].map((d) => [d.id, d.typeCode])), [all, recent.data]);
  const shown = all.filter((d) => inFilter(d.typeCode, kind));
  const shelf = (recent.data?.items?.length ? recent.data.items : all).filter((d) => d.typeCode !== 'ARTIFACT').slice(0, 4);
  const onAsking = useCallback((on: boolean) => setAsking(on), []);

  return (
    <div className="page lib lb">
      <div className="lb-main">
        <div className="lb-hd">
          <h1 className="lb-h1">Library</h1>
          <div className="lb-hd-r">
            <Segmented label="Kind" value={kind} onChange={setKind} options={KIND_FILTERS} />
            {/* DocTracker's API workspace (scores, endpoints, the tree, templates) and its Security Center keep their full views. */}
            <DotsMenu label="More in Docs" items={[
              { label: 'API workspace', hint: 'Projects, endpoints, scores and templates', icon: 'layers', onSelect: () => navigate('/library/docs?view=home') },
              { label: 'Security Center', hint: 'Masking, reveals, access requests and the audit trail', icon: 'shield', onSelect: () => navigate('/library/docs?view=security') },
            ]} />
          </div>
        </div>
        <ContinueShelf docs={shelf} onOpen={(id) => navigate(`/library/docs/${id}`)} />
        <section className="lb-list" aria-label="Documents">
          {docs.isLoading ? <PageLoader /> : docs.isError ? <ErrorState error={docs.error} retry={() => void docs.refetch()} /> : shown.length === 0 ? (
            kind !== 'all' ? <EmptyState icon="search" title="Nothing of this kind yet" />
              : <EmptyState icon="note" title="No documents yet" text="Write one with AI from + New, paste a cURL, or start from a template." />
          ) : (
            <table className="lb-table">
              <thead><tr><th scope="col">Name</th><th scope="col">Kind</th><th scope="col">Project</th><th scope="col">Status</th><th scope="col">Updated</th></tr></thead>
              <tbody>
                {shown.map((d) => (
                  <tr key={d.id} className="lb-tr" data-doc={d.title} onClick={() => navigate(`/library/docs/${d.id}`)}>
                    <td className="lb-name"><button type="button" onClick={(e) => { e.stopPropagation(); navigate(`/library/docs/${d.id}`); }}>{d.title}</button></td>
                    <td><span className="lb-kc lib-kind">{chipOf(d.typeCode)}</span></td>
                    <td className="lb-proj">{d.projectName ?? d.teamName ?? 'General'}</td>
                    <td><span className={`lb-st t-${STATUS[d.status].tone}`}>{STATUS[d.status].label}</span></td>
                    <td className="lb-upd"><time dateTime={d.updatedAt}>{updated(d.updatedAt)}</time></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {docs.data?.nextCursor && <p className="lib-note">Showing the latest {docs.data.items?.length ?? 0}. Ask your docs, or open the API workspace, to find older ones.</p>}
        </section>
      </div>

      <aside className="lb-side" aria-label="Ask and review">
        <AskDocs typeOf={(id) => types.get(id)} onAsking={onAsking} />
        <div className={`lb-side2${asking ? ' dim' : ''}`}>
          <NeedsReview onChanged={() => void invalidateWorkspace(wid, 'documents')} />
          <PasteCurl projectId={null} canCreate={catalog.data?.canCreate ?? false} />
        </div>
      </aside>
      <NewDocFromLink projects={projects} canCreate={catalog.data?.canCreate ?? false} />
    </div>
  );
}

/** What waits for this person: AI drafts to approve (release notes, decision logs, API references) and documents sent to them for review. */
function NeedsReview({ onChanged }: { onChanged: () => void }) {
  const navigate = useNavigate();
  const drafts = useWsQuery(['documents', 'proposals', 'Proposed'], () => docAiApi.proposals(null, 'Proposed'), { staleTime: 30_000 });
  const inbox = useWsQuery(['documents', 'inbox'], documentApi.inbox, { staleTime: 30_000 });
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const items = Array.isArray(drafts.data) ? drafts.data : [];
  const reviews = inbox.data?.toReview ?? [];
  const count = items.length + reviews.length;
  const act = async (p: DocProposal, what: 'accept' | 'dismiss') => {
    setBusy(p.id);
    try {
      if (what === 'accept') { const r = await docAiApi.accept(p.id); toast(r.message, 'success', { label: 'Open', onClick: () => navigate(`/library/docs/${r.documentId}`) }); }
      else { await docAiApi.dismiss(p.id); toast('Dismissed. It will not be suggested again.', 'info'); }
      setOpen(null); onChanged();
    } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not do that.', 'error'); }
    finally { setBusy(null); }
  };
  const kindLabel = (k: DocProposal['kind']) => (k === 'api-reference' ? 'API reference' : k === 'release-notes' ? 'Release notes' : 'Decision log');
  return (
    <section className="lb-card lb-rev" aria-label="Needs your review" data-testid="needs-review">
      <div className="lb-rev-h"><h3>Needs your review</h3>{count > 0 && <span className="lb-count">{count}</span>}</div>
      {drafts.isLoading && inbox.isLoading ? <p className="lb-note"><Spinner /> Loading…</p> : count === 0 ? (
        <p className="lb-note">Nothing waiting. Finished sprints, meeting decisions and API changes are drafted here for you to approve.</p>
      ) : (
        <ul>
          {reviews.map((r, i) => (
            <li key={r.approvalId} className="lb-rv">
              <span className="lb-av" style={{ '--h': hue(r.submittedBy.name) } as CSSProperties} aria-hidden="true">{initials(r.submittedBy.name)}</span>
              <span className="lb-rv-main"><b>{r.document.title}</b><small>{r.submittedBy.name.split(' ')[0]} · {r.dueAt ? `before ${new Date(r.dueAt).toLocaleDateString(undefined, { weekday: 'long' })}` : `asked ${timeAgo(r.submittedAt)}`}{r.overdue ? ' · overdue' : ''}</small></span>
              <button type="button" className={`lb-btn${i === 0 ? ' pri' : ''}`} onClick={() => navigate(`/library/docs/${r.document.id}`)}>Review</button>
            </li>
          ))}
          {items.map((p, i) => (
            <li key={p.id} className="lb-rv lb-draft">
              <span className="lb-av ai" aria-hidden="true"><span className="lb-orb" /></span>
              <span className="lb-rv-main"><b>{p.title}</b><small>{kindLabel(p.kind)} · AI draft{p.projectKey ? ` · ${p.projectKey}` : ''}</small></span>
              {open === p.id
                ? <button type="button" className="lb-btn" onClick={() => setOpen(null)}>Close</button>
                : <button type="button" className={`lb-btn${reviews.length === 0 && i === 0 ? ' pri' : ''}`} onClick={() => setOpen(p.id)}>Review</button>}
              {open === p.id && (
                <div className="lb-draft-open">
                  <div className="lib-draft-body"><RichEditor key={p.body} value={p.body} readOnly minimal label={`${p.title} draft`} /></div>
                  <div className="lib-draft-acts">
                    <button type="button" className="btn btn-primary btn-sm" disabled={busy === p.id} onClick={() => void act(p, 'accept')}>{busy === p.id && <Spinner />}{p.action === 'create' ? 'Create page' : 'Add it'}</button>
                    <button type="button" className="btn btn-ghost btn-sm" disabled={busy === p.id} onClick={() => void act(p, 'dismiss')}>Dismiss</button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Paste a cURL: paste (⌘V while it has focus), drop a .sh/.txt file, or click — the existing cURL → API reference import opens with it. */
function PasteCurl({ projectId, canCreate }: { projectId: string | null; canCreate: boolean }) {
  const navigate = useNavigate();
  const [api, setApi] = useState<{ documentId: string; definitions: ApiDefinition[]; curl?: string } | null>(null);
  const [opening, setOpening] = useState(false);
  const [over, setOver] = useState(false);
  const open = async (curl?: string) => {
    if (opening) return;
    setOpening(true);
    try {
      const home = await docTrackerApi.apiHome(projectId);
      const o = await apiDocApi.overview(home.documentId);
      setApi({ documentId: home.documentId, definitions: o.definitions, curl });
    } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not open the API reference.', 'error'); }
    finally { setOpening(false); }
  };
  if (!canCreate) return null;
  return (
    <>
      <div className={`lb-curl${over ? ' over' : ''}`} role="button" tabIndex={0} aria-label="Paste a cURL" data-testid="paste-curl"
        onClick={() => void open()} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void open(); } }}
        onPaste={(e) => { const t = e.clipboardData.getData('text'); if (t.trim()) { e.preventDefault(); void open(t); } }}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files?.[0]; const t = e.dataTransfer.getData('text'); if (f) void f.text().then((x) => open(x)); else if (t) void open(t); }}>
        <span className="lb-curl-i" aria-hidden="true">{opening ? <Spinner /> : '$_'}</span>
        <span className="lb-curl-t"><b>Paste a cURL</b><small>It becomes an API doc — endpoint, headers, sample.</small></span>
        <kbd aria-hidden="true">⌘V</kbd>
      </div>
      {api && <ApiImportModal documentId={api.documentId} definitions={api.definitions} initialCurl={api.curl} onClose={() => setApi(null)}
        onDone={() => { const id = api.documentId; setApi(null); navigate(`/library/docs/${id}`); }} />}
    </>
  );
}

/** + New › Doc (?new=1&title=…): the AI draft opens with those words; without the AI, a page with that title is made and opened. Once. */
function NewDocFromLink({ projects, canCreate }: { projects: { id: string; name: string }[]; canCreate: boolean }) {
  const newPage = useNewPage();
  const [ai, setAi] = useState(false);
  const [params, setParams] = useSearchParams();
  const aiStatus = useWsQuery(['ai', 'status'], aiApi.status, { staleTime: 5 * 60_000, retry: false });
  const [prompt, setPrompt] = useState('');
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current || params.get('new') !== '1' || !canCreate || aiStatus.isLoading) return;
    asked.current = true;
    const title = params.get('title') ?? '';
    setParams((p) => { const n = new URLSearchParams(p); n.delete('new'); n.delete('title'); return n; }, { replace: true });
    if (aiStatus.data?.enabled) { setPrompt(title); setAi(true); } else void newPage.create({ title: title || undefined, projectId: null });
  }, [params, setParams, canCreate, aiStatus.isLoading, aiStatus.data, newPage]);
  if (!ai) return null;
  return <AiDraftDialog projects={projects} projectId={null} initialPrompt={prompt} useLabel="Create the page" onClose={() => { setAi(false); setPrompt(''); }}
    onUse={async (d, from) => { await newPage.create({ title: d.title, body: d.body, projectId: from.projectId }); setAi(false); }} />;
}

/**
 * Library. A document opens on its own page (`/library/docs/<id>`); DocTracker's API workspace keeps its full view when a link asks for it
 * (`?p=` project, `?t=` tab, `?ep=` endpoint, `?view=`); everything else is the Docs list or the Vault.
 */
export function LibraryPage({ tab }: { tab?: LibraryTab } = {}) {
  const { section, id } = useParams();
  const [params] = useSearchParams();
  if (section === 'docs' && id) return <DocumentPage />;
  if ((section ?? 'docs') === 'docs' && ['p', 't', 'ep', 'view'].some((k) => params.has(k))) return <DocTrackerPage />;
  return <LibraryHome tab={tab} />;
}
