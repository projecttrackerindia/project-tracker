import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError } from '../../../api/client';
import { apiDocApi, docTrackerApi, documentApi } from '../../../api/endpoints';
import type { ApiDefinition, DocumentStatus, DtCatalog, DtProject } from '../../../api/types';
import { EmptyState, ErrorState, PageLoader, Segmented, Spinner } from '../../../components/ui';
import { timeAgo } from '../../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../../lib/hooks';
import { useWorkspaceId } from '../../../stores/auth';
import { toast } from '../../../stores/ui';
import { aiApi } from '../../ai/Assistant';
import { DotsMenu } from '../../talk/DotsMenu';
import { AiDraftDialog } from '../../documents/AiDraft';
import { ImportModal as ApiImportModal } from '../../documents/ApiTools';
import { docAiApi, type DocProposal } from '../../documents/docAi';
import { DocumentWizard } from '../../documents/DocumentWizard';
import { WorkflowsModal } from '../../documents/DocumentWorkflows';
import { NeedsAttention, RequiredDocumentsModal } from '../../documents/NeedsAttention';
import { PAGE_CODE, useNewPage } from '../../documents/pages';
import { RichEditor } from '../../documents/RichEditor';
import { AskDocs } from '../LibraryAsk';
import { ContinueShelf } from '../LibraryShelf';
import { chipOf, inFilter, KIND_FILTERS, type KindFilter } from '../libraryKinds';
import { docsPath } from './nav';
import { avgScore, HealthRing, MethodPill, pidOf, plural, PopMenu, ProjectMark } from './shared';
import { TextHits } from './TextHits';
import './docs.css';

const STATUS: Record<DocumentStatus, { label: string; tone: string }> = {
  Draft: { label: 'Draft', tone: 'draft' }, InReview: { label: 'In review', tone: 'review' }, ChangesRequested: { label: 'Changes asked', tone: 'changes' },
  Approved: { label: 'Approved', tone: 'ok' }, Published: { label: 'Published', tone: 'ok' }, Archived: { label: 'Archived', tone: 'draft' },
};
const updated = (iso: string) => {
  const d = new Date(iso), now = new Date();
  if (d.toDateString() === now.toDateString()) return 'Today';
  return now.getTime() - d.getTime() < 6 * 86_400_000 ? d.toLocaleDateString(undefined, { weekday: 'short' }) : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
};
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?';
const hue = (s: string) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };

/** When a collection last changed: its newest document or endpoint. */
const lastChange = (p: DtProject) => [...p.documents.map((d) => d.updatedAt), ...p.endpoints.map((e) => e.updatedAt ?? '')].filter(Boolean).sort().pop() ?? null;

/**
 * Library's documentation hub (developer.apple.com-style): one search that also asks, a collection per project with its health, what you
 * read last, what waits for your review, Paste a cURL and New. Everything else is one click deeper, in a project's documentation.
 */
export function DocsHub() {
  const navigate = useNavigate();
  const wid = useWorkspaceId();
  const [q, setQ] = useState('');
  const [asking, setAsking] = useState(false);
  const [asked, setAsked] = useState<string | null>(null);
  const [kind, setKind] = useState<KindFilter>('all');
  const [modal, setModal] = useState<null | 'flows' | 'required' | 'wizard' | 'ai'>(null);
  const catalog = useWsQuery(['documents', 'doctracker', 'catalog'], docTrackerApi.catalog, { staleTime: 20_000 });
  const docs = useWsQuery(['documents', 'library', 'all'], () => documentApi.list({ limit: 100 }), { staleTime: 20_000, placeholderData: (p) => p });
  const recent = useWsQuery(['documents', 'recent'], () => documentApi.list({ scope: 'recent', limit: 4 }), { staleTime: 20_000, retry: false });
  const c = catalog.data;
  const projects = useMemo(() => (c?.projects ?? []).filter((p): p is DtProject & { id: string } => !!p.id).map((p) => ({ id: p.id, name: p.name })), [c]);
  const all = useMemo(() => [...(docs.data?.items ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), [docs.data]);
  const types = useMemo(() => new Map([...all, ...(recent.data?.items ?? [])].map((d) => [d.id, d.typeCode])), [all, recent.data]);
  const shelf = (recent.data?.items?.length ? recent.data.items : all).filter((d) => d.typeCode !== 'ARTIFACT').slice(0, 4);
  const shown = all.filter((d) => inFilter(d.typeCode, kind));
  const onAsking = useCallback((on: boolean) => setAsking(on), []);
  const canCreate = c?.canCreate ?? false;
  const newPage = useNewPage();
  const tpl = useWsQuery(['document-types'], documentApi.types, { staleTime: 300_000 });
  const starters = (tpl.data ?? []).filter((t) => t.code !== PAGE_CODE && t.code !== 'ARTIFACT').sort((a, b) => a.sortOrder - b.sortOrder).slice(0, 4);
  const dash = useWsQuery(['documents', 'dashboard'], documentApi.dashboard, { staleTime: 60_000 });
  const attention = dash.data ? (dash.data.projectsMissingRequired ?? 0) + dash.data.notUpdatedIn90Days + dash.data.unpublished : 0;
  const searching = q.trim().length >= 2 && asked !== q.trim();

  return (
    <div className="page dx dx-hub">
      <header className="dx-hub-head">
        <div>
          <p className="dx-eyebrow">Documentation</p>
          <h1 className="dx-h1">Library</h1>
        </div>
        <div className="dx-hub-tools">
          {canCreate && <NewDocMenu onAi={() => setModal('ai')} onBlank={() => void newPage.create()} onTemplate={() => setModal('wizard')} />}
          <DotsMenu label="More in Library" items={[
            { label: 'Security Center', hint: 'Masking, reveals, access requests and the audit trail', icon: 'shield', onSelect: () => navigate(docsPath.security()) },
            { label: 'Approval workflows', hint: 'Who reviews before a document is published', icon: 'checks', onSelect: () => setModal('flows') },
            { label: 'Required documents', hint: 'Documents every project must have', icon: 'flag', onSelect: () => setModal('required'), hidden: !c?.isAdmin },
          ]} />
        </div>
      </header>

      <section className="dx-hero" aria-label="Search and ask">
        <AskDocs hero typeOf={(id) => types.get(id)} onAsking={onAsking} onQuery={setQ} onAsked={setAsked} placeholder="Search the documentation, or ask a question" />
      </section>

      {searching && c ? <SearchResults catalog={c} q={q} /> : (
        <div className={`dx-hub-grid${asking ? ' dim' : ''}`}>
          <div className="dx-hub-main">
            <section aria-label="Collections" className="dx-sect">
              <div className="dx-sect-h"><h2>Collections</h2>{c && <CollectionsNote catalog={c} />}</div>
              {catalog.isLoading ? <PageLoader /> : catalog.isError || !c ? <ErrorState error={catalog.error} retry={() => void catalog.refetch()} /> : c.projects.length === 0
                ? <EmptyState icon="layers" title="No collections yet" text="Every project gets a collection of guides, API reference and architecture." />
                : <ul className="dx-colls">{c.projects.map((p, i) => <CollectionCard key={pidOf(p)} p={p} i={i} />)}</ul>}
              {(c?.teams?.length ?? 0) > 0 && (
                <p className="dx-teams">Team spaces: {c!.teams!.map((t, i) => <span key={t.id}>{i > 0 && ' · '}<Link to={docsPath.project(null)}>{t.name}</Link> <small>{t.pages}</small></span>)}</p>
              )}
            </section>

            {shelf.length > 0 && (
              <section aria-label="Recently viewed" className="dx-sect">
                <ContinueShelf docs={shelf} onOpen={(id) => navigate(docsPath.doc(id))} />
              </section>
            )}

            {canCreate && (
              <section aria-label="Start a document" className="dx-sect">
                <div className="dx-sect-h"><h2>Start something</h2><button type="button" className="dx-link" onClick={() => setModal('wizard')}>All templates</button></div>
                <div className="dx-starts">
                  <button type="button" className="dx-start ai" onClick={() => setModal('ai')}><span className="dx-orb" aria-hidden="true" /><b>Write with AI</b><small>From a line, a meeting, project work or files</small></button>
                  <button type="button" className="dx-start" onClick={() => void newPage.create()}><span className="dx-start-i" aria-hidden="true">＋</span><b>Blank page</b><small>Type / for blocks</small></button>
                  {starters.map((t) => (
                    <button key={t.id} type="button" className="dx-start" style={{ '--dc': t.color } as CSSProperties} onClick={() => void newPage.create({ template: t })} title="Starts a page with this template's headings">
                      <span className="dx-start-i code" aria-hidden="true">{t.code.slice(0, 4)}</span><b>{t.name}</b>{t.description && <small>{t.description}</small>}
                    </button>
                  ))}
                </div>
              </section>
            )}

            <section aria-label="All documents" className="dx-sect">
              <div className="dx-sect-h"><h2>All documents</h2><Segmented label="Kind" value={kind} onChange={setKind} options={KIND_FILTERS} /></div>
              {docs.isLoading ? <PageLoader /> : docs.isError ? <ErrorState error={docs.error} retry={() => void docs.refetch()} /> : shown.length === 0 ? (
                <EmptyState icon={kind === 'all' ? 'note' : 'search'} title={kind === 'all' ? 'No documents yet' : 'Nothing of this kind yet'} text={kind === 'all' ? 'Write one with AI, paste a cURL, or start from a template.' : undefined} />
              ) : (
                <ul className="dx-list" data-testid="doc-list">
                  {shown.map((d) => (
                    <li key={d.id}>
                      <Link className="dx-li" data-doc={d.title} to={d.projectId ? docsPath.guide(d.projectId, d.id) : docsPath.doc(d.id)}>
                        <span className="dx-kc">{chipOf(d.typeCode)}</span>
                        <b>{d.title}</b>
                        <span className="dx-li-proj">{d.projectName ?? d.teamName ?? 'General'}</span>
                        <span className={`dx-st t-${STATUS[d.status].tone}`}>{STATUS[d.status].label}</span>
                        <time dateTime={d.updatedAt}>{updated(d.updatedAt)}</time>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
              {docs.data?.nextCursor && <p className="dx-note">Showing the latest {docs.data.items?.length ?? 0}. Search or open a collection to find older ones.</p>}
            </section>
          </div>

          <aside className="dx-hub-side" aria-label="Review and import">
            <NeedsReview canCreate={canCreate} projects={projects} onChanged={() => void invalidateWorkspace(wid, 'documents')} />
            <PasteCurl projectId={null} canCreate={canCreate} />
            {attention > 0 && c && (
              <section className="dx-card dx-attn" aria-label="Needs attention">
                <h3>Needs attention</h3>
                <p className="dx-note">Missing required documents, nothing updated in 90 days, never published.</p>
                <NeedsAttention canCreate={canCreate} isAdmin={c.isAdmin} onRequired={() => setModal('required')} />
              </section>
            )}
          </aside>
        </div>
      )}

      <NewDocFromLink projects={projects} canCreate={canCreate} />
      {modal === 'flows' && <WorkflowsModal onClose={() => setModal(null)} />}
      {modal === 'required' && <RequiredDocumentsModal onClose={() => setModal(null)} />}
      {modal === 'wizard' && <DocumentWizard onClose={() => setModal(null)} onCreated={(id) => navigate(docsPath.doc(id))} />}
      {modal === 'ai' && <AiDraftDialog projects={projects} useLabel="Create the page" onClose={() => setModal(null)}
        onUse={async (d, from) => { await newPage.create({ title: d.title, body: d.body, projectId: from.projectId }); setModal(null); }} />}
    </div>
  );
}

function CollectionsNote({ catalog }: { catalog: DtCatalog }) {
  const eps = catalog.projects.flatMap((p) => p.endpoints);
  if (!eps.length) return null;
  const weak = eps.filter((e) => e.score < 70).length;
  return <span className="dx-note">{plural(eps.length, 'endpoint')} · average health {avgScore(eps)}{weak ? ` · ${weak} need work` : ''}{catalog.truncated > 0 ? ` · ${catalog.truncated.toLocaleString()} more not scored` : ''}</span>;
}

function CollectionCard({ p, i }: { p: DtProject; i: number }) {
  const guides = p.documents.filter((d) => !d.isApi).length;
  const last = lastChange(p);
  return (
    <li className="dx-coll" style={{ '--i': i } as CSSProperties}>
      <Link to={docsPath.project(p.id)} data-testid="collection">
        <div className="dx-coll-top">
          <ProjectMark p={p} />
          {p.endpoints.length > 0 && <HealthRing score={avgScore(p.endpoints)} />}
        </div>
        <b>{p.name}</b>
        <small>{[guides && plural(guides, 'doc'), p.endpoints.length && plural(p.endpoints.length, 'endpoint'), p.diagrams && plural(p.diagrams, 'diagram')].filter(Boolean).join(' · ') || 'Nothing yet'}</small>
        <span className="dx-coll-foot">{last ? `Updated ${timeAgo(last)}` : p.key ?? 'General'}</span>
      </Link>
    </li>
  );
}

/** Live results while typing: collections, endpoints and documents by title, then words inside the pages. Enter asks instead. */
function SearchResults({ catalog, q }: { catalog: DtCatalog; q: string }) {
  const dq = q.trim().toLowerCase();
  const eps = catalog.projects.flatMap((p) => p.endpoints.filter((e) => `${e.method} ${e.path} ${e.summary} ${e.tag ?? ''}`.toLowerCase().includes(dq)).map((e) => ({ p, e }))).slice(0, 10);
  const docs = catalog.projects.flatMap((p) => p.documents.filter((d) => `${d.key} ${d.title} ${d.typeName}`.toLowerCase().includes(dq)).map((d) => ({ p, d }))).slice(0, 10);
  const projects = catalog.projects.filter((p) => `${p.name} ${p.key ?? ''}`.toLowerCase().includes(dq)).slice(0, 4);
  return (
    <section className="dx-results" aria-label="Search results">
      {eps.length + docs.length + projects.length === 0 && <p className="dx-note">No title matches “{q.trim()}”. Press Return to ask your docs instead.</p>}
      {projects.length > 0 && <><h3>Collections</h3><ul className="dx-list">{projects.map((p) => <li key={pidOf(p)}><Link className="dx-li" to={docsPath.project(p.id)}><ProjectMark p={p} size={22} /><b>{p.name}</b><span className="dx-li-proj">{p.key}</span></Link></li>)}</ul></>}
      {eps.length > 0 && <><h3>API reference</h3><ul className="dx-list">{eps.map(({ p, e }) => <li key={e.id}><Link className="dx-li" to={docsPath.endpoint(p.id, e.id)}><MethodPill m={e.method} /><code>{e.path}</code><span className="dx-li-proj">{e.summary || p.name}</span></Link></li>)}</ul></>}
      {docs.length > 0 && <><h3>Documents</h3><ul className="dx-list">{docs.map(({ p, d }) => <li key={d.id}><Link className="dx-li" to={p.id ? docsPath.guide(p.id, d.id) : docsPath.doc(d.id)}><span className="dx-kc">{d.typeCode}</span><b>{d.title}</b><span className="dx-li-proj">{p.name}</span></Link></li>)}</ul></>}
      <TextHits q={q} />
    </section>
  );
}

function NewDocMenu({ onAi, onBlank, onTemplate }: { onAi: () => void; onBlank: () => void; onTemplate: () => void }) {
  return <PopMenu label="New doc" icon="plus" tone="tint" items={[
    { label: 'Write with AI', hint: 'From a line, your voice, a meeting, project work or files', icon: 'sparkle', onSelect: onAi },
    { label: 'Blank page', hint: 'Type / for blocks', icon: 'note', onSelect: onBlank },
    { label: 'From a template', hint: 'Requirements, runbook, test plan…', icon: 'layers', onSelect: onTemplate },
  ]} />;
}

/** What waits for this person: documents sent to them for review and AI drafts (release notes, decision logs, API references); they can ask for a draft too. */
function NeedsReview({ onChanged, canCreate, projects }: { onChanged: () => void; canCreate: boolean; projects: { id: string; name: string }[] }) {
  const navigate = useNavigate();
  const drafts = useWsQuery(['documents', 'proposals', 'Proposed'], () => docAiApi.proposals(null, 'Proposed'), { staleTime: 30_000 });
  const inbox = useWsQuery(['documents', 'inbox'], documentApi.inbox, { staleTime: 30_000 });
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [make, setMake] = useState<{ kind: DocProposal['kind']; projectId: string } | null>(null);
  const items = Array.isArray(drafts.data) ? drafts.data : [];
  const reviews = inbox.data?.toReview ?? [];
  const count = items.length + reviews.length;
  const act = async (p: DocProposal, what: 'accept' | 'dismiss') => {
    setBusy(p.id);
    try {
      if (what === 'accept') { const r = await docAiApi.accept(p.id); toast(r.message, 'success', { label: 'Open', onClick: () => navigate(docsPath.doc(r.documentId)) }); }
      else { await docAiApi.dismiss(p.id); toast('Dismissed. It will not be suggested again.', 'info'); }
      setOpen(null); onChanged();
    } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not do that.', 'error'); }
    finally { setBusy(null); }
  };
  const generate = async () => {
    if (!make) return;
    setBusy('make');
    try { const p = await docAiApi.generate(make.kind, make.projectId); setOpen(p.id); setMake(null); onChanged(); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Could not make the draft.', 'error'); }
    finally { setBusy(null); }
  };
  const kindLabel = (k: DocProposal['kind']) => (k === 'api-reference' ? 'API reference' : k === 'release-notes' ? 'Release notes' : 'Decision log');
  return (
    <section className="dx-card dx-rev" aria-label="Needs your review" data-testid="needs-review">
      <div className="dx-card-h"><h3>Needs your review</h3>{count > 0 && <span className="dx-count">{count}</span>}
        {canCreate && projects.length > 0 && !make && <button type="button" className="dx-link" onClick={() => setMake({ kind: 'release-notes', projectId: projects[0].id })}>Make a draft</button>}</div>
      {make && (
        <form className="dx-make" onSubmit={(e) => { e.preventDefault(); void generate(); }}>
          <select className="input" aria-label="What to write" value={make.kind} onChange={(e) => setMake({ ...make, kind: e.target.value as DocProposal['kind'] })}>
            <option value="release-notes">Release notes from the last finished sprint</option>
            <option value="decision-log">Decision log from the last meeting with decisions</option>
          </select>
          <select className="input" aria-label="Project" value={make.projectId} onChange={(e) => setMake({ ...make, projectId: e.target.value })}>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
          <div className="dx-row"><button type="submit" className="dx-btn pri sm" disabled={busy === 'make'}>{busy === 'make' && <Spinner />}Write it</button><button type="button" className="dx-btn sm" onClick={() => setMake(null)}>Cancel</button></div>
        </form>
      )}
      {drafts.isLoading && inbox.isLoading ? <p className="dx-note"><Spinner /> Loading…</p> : count === 0 ? (
        <p className="dx-note">Nothing waiting. Finished sprints, meeting decisions and API changes are drafted here for you to approve.</p>
      ) : (
        <ul>
          {reviews.map((r, i) => (
            <li key={r.approvalId} className="dx-rv">
              <span className="dx-av" style={{ '--h': hue(r.submittedBy.name) } as CSSProperties} aria-hidden="true">{initials(r.submittedBy.name)}</span>
              <span className="dx-rv-main"><b>{r.document.title}</b><small>{r.submittedBy.name.split(' ')[0]} · {r.dueAt ? `before ${new Date(r.dueAt).toLocaleDateString(undefined, { weekday: 'long' })}` : `asked ${timeAgo(r.submittedAt)}`}{r.overdue ? ' · overdue' : ''}</small></span>
              <button type="button" className={`dx-btn sm${i === 0 ? ' tint' : ''}`} onClick={() => navigate(`${docsPath.doc(r.document.id)}?inspect=review`)}>Review</button>
            </li>
          ))}
          {items.map((p, i) => (
            <li key={p.id} className="dx-rv">
              <span className="dx-av ai" aria-hidden="true"><span className="dx-orb" /></span>
              <span className="dx-rv-main"><b>{p.title}</b><small>{kindLabel(p.kind)} · AI draft{p.projectKey ? ` · ${p.projectKey}` : ''}</small></span>
              <button type="button" className={`dx-btn sm${reviews.length === 0 && i === 0 && open !== p.id ? ' tint' : ''}`} aria-expanded={open === p.id} onClick={() => setOpen(open === p.id ? null : p.id)}>{open === p.id ? 'Close' : 'Review'}</button>
              {open === p.id && (
                <div className="dx-draft">
                  {p.summary && <p className="dx-note">{p.summary}</p>}
                  <div className="dx-draft-body"><RichEditor key={p.body} value={p.body} readOnly minimal label={`${p.title} draft`} /></div>
                  {canCreate && <div className="dx-row">
                    <button type="button" className="dx-btn pri sm" disabled={busy === p.id} onClick={() => void act(p, 'accept')}>{busy === p.id && <Spinner />}{p.action === 'create' ? 'Create page' : 'Add it'}</button>
                    <button type="button" className="dx-btn sm" disabled={busy === p.id} onClick={() => void act(p, 'dismiss')}>Dismiss</button>
                  </div>}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Paste a cURL (⌘V while it has focus), drop a .sh/.txt file, or click: the cURL → API reference import opens with it. */
export function PasteCurl({ projectId, canCreate }: { projectId: string | null; canCreate: boolean }) {
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
      <div className={`dx-curl${over ? ' over' : ''}`} role="button" tabIndex={0} aria-label="Paste a cURL" data-testid="paste-curl"
        onClick={() => void open()} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void open(); } }}
        onPaste={(e) => { const t = e.clipboardData.getData('text'); if (t.trim()) { e.preventDefault(); void open(t); } }}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files?.[0]; const t = e.dataTransfer.getData('text'); if (f) void f.text().then((x) => open(x)); else if (t) void open(t); }}>
        <span className="dx-curl-i" aria-hidden="true">{opening ? <Spinner /> : '$_'}</span>
        <span className="dx-curl-t"><b>Paste a cURL</b><small>It becomes an API doc — endpoint, headers, sample.</small></span>
        <kbd aria-hidden="true">⌘V</kbd>
      </div>
      {api && <ApiImportModal documentId={api.documentId} definitions={api.definitions} initialCurl={api.curl} onClose={() => setApi(null)}
        onDone={() => { const id = api.documentId; setApi(null); navigate(docsPath.doc(id)); }} />}
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
