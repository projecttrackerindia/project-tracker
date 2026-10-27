import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { DocTrackerPage } from '../doctracker/DocTrackerPage';
import { DotsMenu } from '../talk/DotsMenu';
import { DocumentPage } from '../documents/DocumentPage';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { apiDocApi, docTrackerApi, documentApi } from '../../api/endpoints';
import { aiApi } from '../ai/Assistant';
import { attachmentApi } from '../../api/endpoints.work';
import type { ApiDefinition, DocumentItem, DocumentStatus, DocumentType } from '../../api/types';
import { Icon } from '../../components/Icon';
import { EmptyState, ErrorState, PageLoader, Segmented, Spinner } from '../../components/ui';
import { LibraryHead } from './LibraryHead';
import { formatBytes } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { AskAnswerCard, PageTextHits } from '../doctracker/DtAssist';
import { AiDraftDialog } from '../documents/AiDraft';
import { ImportModal as ApiImportModal } from '../documents/ApiTools';
import { docAiApi, type DocProposal } from '../documents/docAi';
import { PAGE_CODE, useNewPage } from '../documents/pages';
import { RichEditor } from '../documents/RichEditor';
import { LibraryVault } from './LibraryVault';
import './library.css';

export type LibraryTab = 'docs' | 'vault';
type DocKind = 'API' | 'Doc' | 'Design' | 'File';
const KINDS: DocKind[] = ['API', 'Doc', 'Design', 'File'];
const DESIGN_CODES = new Set(['ARCH', 'TECH', 'INTEG']);
const kindOf = (typeCode: string): DocKind => (typeCode === 'API' ? 'API' : DESIGN_CODES.has(typeCode) ? 'Design' : typeCode === 'ARTIFACT' ? 'File' : 'Doc');
const STATUS: Record<DocumentStatus, { label: string; tone: string }> = {
  Draft: { label: 'Draft', tone: 'neutral' }, InReview: { label: 'In review', tone: 'warning' }, ChangesRequested: { label: 'Changes asked', tone: 'danger' },
  Approved: { label: 'Approved', tone: 'success' }, Published: { label: 'Published', tone: 'success' }, Archived: { label: 'Archived', tone: 'neutral' },
};
/** The four templates offered under Start (by their codes), in this order. */
const START_CODES = ['API', 'BRD', 'TECH', 'TEST_PLAN'];
const START_LABEL: Record<string, string> = { API: 'API doc', BRD: 'BRD', TECH: 'Tech design', TEST_PLAN: 'Test plan' };
const shortDay = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: '2-digit', month: 'short' });

/**
 * Library: Docs and Vault, one tab each. Docs is one list of everything written (API references, documents, designs and files) with a big
 * "Search or ask" bar that answers from the pages, what needs your review, and the ways to start one. Vault is the password vault.
 * Addresses: /library (Docs), /library/docs/{id} (a document), /library/vault and /library/vault/{item id}.
 */
function LibraryHome({ tab: forced }: { tab?: LibraryTab } = {}) {
  const location = useLocation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const tab: LibraryTab = forced ?? (/\/library\/vault/.test(location.pathname) || params.get('tab') === 'vault' ? 'vault' : 'docs');
  const switcher = (
    <Segmented label="Library" value={tab} onChange={(t) => navigate(t === 'vault' ? '/library/vault' : '/library')}
      options={[{ id: 'docs', label: 'Docs' }, { id: 'vault', label: 'Vault' }]} />
  );
  return tab === 'vault'
    ? <LibraryVault switcher={switcher} />
    : <LibraryDocs switcher={switcher} />;
}

interface Row { id: string; kind: DocKind; title: string; sub: string; status: DocumentStatus | null; at: string; open: () => void; projectId: string | null }

function LibraryDocs({ switcher }: { switcher: ReactNode }) {
  const navigate = useNavigate();
  const wid = useWorkspaceId();
  const [q, setQ] = useState('');
  const [asked, setAsked] = useState<string | null>(null);
  const [kind, setKind] = useState<DocKind | null>(null);
  const [projectId, setProjectId] = useState('');
  const catalog = useWsQuery(['documents', 'doctracker', 'catalog'], docTrackerApi.catalog, { staleTime: 20_000 });
  const docs = useWsQuery(['documents', 'library', projectId || 'all'], () => documentApi.list({ projectId: projectId || undefined, limit: 100 }), { staleTime: 20_000, placeholderData: (p) => p });
  const files = useWsQuery(['attachments', projectId, 'project'], () => attachmentApi.list(projectId), { enabled: !!projectId, staleTime: 30_000 });
  const projects = useMemo(() => (catalog.data?.projects ?? []).filter((p): p is typeof p & { id: string } => !!p.id).map((p) => ({ id: p.id, name: p.name })), [catalog.data]);

  const rows: Row[] = useMemo(() => {
    const out: Row[] = (docs.data?.items ?? []).map((d: DocumentItem) => ({
      id: d.id, kind: kindOf(d.typeCode), title: d.title, sub: [d.projectName ?? d.teamName ?? 'General', d.owner?.name].filter(Boolean).join(' · '),
      status: d.status, at: d.updatedAt, projectId: d.projectId, open: () => navigate(`/library/docs/${d.id}`),
    }));
    for (const f of files.data ?? []) {
      out.push({ id: `file:${f.id}`, kind: 'File', title: f.fileName, sub: [projects.find((p) => p.id === f.projectId)?.name, f.taskKey, formatBytes(f.sizeBytes), f.uploadedBy?.name].filter(Boolean).join(' · '),
        status: null, at: f.createdAt, projectId: f.projectId, open: () => void attachmentApi.download(f.id, f.fileName).catch(() => toast('Could not download the file.', 'error')) });
    }
    return out.sort((a, b) => b.at.localeCompare(a.at));
  }, [docs.data, files.data, projects, navigate]);

  const needle = q.trim().toLowerCase();
  const filtersOn = rows.length > 10 || !!projectId || !!kind;
  const shown = rows.filter((r) => (!kind || r.kind === kind) && (!needle || `${r.title} ${r.sub}`.toLowerCase().includes(needle)));
  const ask = () => { const t = q.trim(); if (t.length >= 3) setAsked(t); };
  const total = docs.data?.total ?? docs.data?.items?.length ?? 0;

  return (
    <div className="page lib">
      <LibraryHead eyebrow={`${total.toLocaleString()} document${total === 1 ? '' : 's'} · ${projects.length} project${projects.length === 1 ? '' : 's'}`} switcher={switcher}>
        {/* DocTracker's API workspace (scores, endpoints, the tree, templates) and its Security Center keep their full views. */}
        <DotsMenu label="More in Docs" items={[
          { label: 'API workspace', hint: 'Projects, endpoints, scores and templates', icon: 'layers', onSelect: () => navigate('/library/docs?view=home') },
          { label: 'Security Center', hint: 'Masking, reveals, access requests and the audit trail', icon: 'shield', onSelect: () => navigate('/library/docs?view=security') },
        ]} />
      </LibraryHead>
      <form className="lib-ask" role="search" onSubmit={(e) => { e.preventDefault(); ask(); }}>
        <Icon name="sparkle" size={17} />
        <input type="search" value={q} autoComplete="off" onChange={(e) => { setQ(e.target.value); if (asked) setAsked(null); }}
          placeholder="Search or ask — “what headers does the Razorpay API need?”" aria-label="Search or ask your docs" />
        <button type="submit" className="btn btn-dark lib-ask-btn" disabled={q.trim().length < 3}>Ask</button>
      </form>
      {asked && <div className="lib-answer"><AskAnswerCard question={asked} onClose={() => setAsked(null)} /></div>}

      <div className="lib-grid">
        <section className="lib-card lib-list" aria-label="Documents">
          {filtersOn && (
            <div className="lib-filters">
              <div className="ds-chips" role="group" aria-label="Type">
                <button type="button" className={`ds-chip${kind === null ? ' on' : ''}`} aria-pressed={kind === null} onClick={() => setKind(null)}>All</button>
                {KINDS.map((k) => <button key={k} type="button" className={`ds-chip${kind === k ? ' on' : ''}`} aria-pressed={kind === k} onClick={() => setKind(kind === k ? null : k)}>{k}</button>)}
              </div>
              <select className="input lib-project" aria-label="Project" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                <option value="">All projects</option>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
          )}
          {needle.length >= 2 && <div className="lib-hits"><PageTextHits q={q} /></div>}
          {docs.isLoading ? <PageLoader /> : docs.isError ? <ErrorState error={docs.error} retry={() => void docs.refetch()} /> : shown.length === 0 ? (
            needle || kind || projectId
              ? <EmptyState icon="search" title="Nothing matches" text={needle.length >= 3 ? 'Ask instead: the answer comes from inside the pages.' : undefined}
                  action={needle.length >= 3 ? <button type="button" className="btn btn-ghost" onClick={ask}><Icon name="sparkle" size={14} /> Ask the docs</button> : undefined} />
              : <EmptyState icon="note" title="No documents yet" text="Write one with AI from a line, a meeting, a cURL or a spec, or start from a template." />
          ) : (
            <ul className="lib-rows">
              {shown.map((r) => (
                <li key={r.id}>
                  <button type="button" className="lib-row" onClick={r.open} data-doc={r.title}>
                    <span className={`lib-kind k-${r.kind.toLowerCase()}`}>{r.kind}</span>
                    <span className="lib-row-main"><b>{r.title}</b><small>{r.sub}</small></span>
                    {r.status ? <span className={`ds-pill ${STATUS[r.status].tone}`}>{STATUS[r.status].label}</span> : <span className="lib-dash" aria-hidden="true">—</span>}
                    <time dateTime={r.at}>{shortDay(r.at)}</time>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {docs.data?.nextCursor && <p className="lib-note">Showing the latest {docs.data.items?.length ?? 0}. Search, or choose a project, to find older ones.</p>}
        </section>

        <aside className="lib-side">
          <NeedsReview onChanged={() => void invalidateWorkspace(wid, 'documents')} />
          <StartCard projects={projects} projectId={projectId || null} canCreate={catalog.data?.canCreate ?? false} />
        </aside>
      </div>
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
  return (
    <section className="lib-card lib-review" aria-label="Needs your review" data-testid="needs-review">
      <h3>Needs your review{count > 0 && <span> · {count}</span>}</h3>
      {drafts.isLoading && inbox.isLoading ? <p className="lib-note"><Spinner /> Loading…</p> : count === 0 ? (
        <p className="lib-note">Nothing waiting. Finished sprints, meeting decisions and API changes are drafted here for you to approve.</p>
      ) : (
        <ul>
          {items.map((p) => (
            <li key={p.id} className="lib-draft">
              <b>{p.title}</b>
              <small>{p.kind === 'api-reference' ? 'API reference' : p.kind === 'release-notes' ? 'Release notes' : 'Decision log'} · AI draft{p.projectKey ? ` · ${p.projectKey}` : ''}</small>
              {open === p.id && <div className="lib-draft-body"><RichEditor key={p.body} value={p.body} readOnly minimal label={`${p.title} draft`} /></div>}
              <div className="lib-draft-acts">
                {open === p.id
                  ? <button type="button" className="btn btn-primary btn-sm" disabled={busy === p.id} onClick={() => void act(p, 'accept')}>{busy === p.id && <Spinner />}{p.action === 'create' ? 'Create page' : 'Add it'}</button>
                  : <button type="button" className="btn btn-primary btn-sm" onClick={() => setOpen(p.id)}>Review</button>}
                <button type="button" className="btn btn-ghost btn-sm" disabled={busy === p.id} onClick={() => void act(p, 'dismiss')}>Dismiss</button>
              </div>
            </li>
          ))}
          {reviews.map((r) => (
            <li key={r.approvalId} className="lib-draft human">
              <b>{r.document.title}</b>
              <small>{r.step} · from {r.submittedBy.name}{r.overdue ? ' · overdue' : ''}</small>
              <div className="lib-draft-acts"><button type="button" className="btn btn-primary btn-sm" onClick={() => navigate(`/library/docs/${r.document.id}`)}>Review</button></div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Start: write with AI (from a line, a meeting, files or a template), bring in an API from a cURL or a spec, or one of four templates. */
function StartCard({ projects, projectId, canCreate }: { projects: { id: string; name: string }[]; projectId: string | null; canCreate: boolean }) {
  const navigate = useNavigate();
  const types = useWsQuery(['document-types'], documentApi.types, { staleTime: 300_000 });
  const newPage = useNewPage();
  const [ai, setAi] = useState(false);
  const [api, setApi] = useState<{ documentId: string; definitions: ApiDefinition[] } | null>(null);
  const [opening, setOpening] = useState(false);
  // + New › Doc (?new=1&title=…): the AI draft opens with those words; without the AI, a page with that title is made and opened. Once.
  const [params, setParams] = useSearchParams();
  const aiStatus = useWsQuery(['ai', 'status'], aiApi.status, { staleTime: 5 * 60_000, retry: false });
  const [prompt, setPrompt] = useState('');
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current || params.get('new') !== '1' || !canCreate || aiStatus.isLoading) return;
    asked.current = true;
    const title = params.get('title') ?? '';
    setParams((p) => { const n = new URLSearchParams(p); n.delete('new'); n.delete('title'); return n; }, { replace: true });
    if (aiStatus.data?.enabled) { setPrompt(title); setAi(true); } else void newPage.create({ title: title || undefined, projectId });
  }, [params, setParams, canCreate, aiStatus.isLoading, aiStatus.data, newPage, projectId]);
  const all = (types.data ?? []).filter((t) => t.code !== PAGE_CODE && t.code !== 'ARTIFACT');
  const starters: DocumentType[] = [...START_CODES.map((c) => all.find((t) => t.code === c)).filter((t): t is DocumentType => !!t), ...all.filter((t) => !START_CODES.includes(t.code))].slice(0, 4);
  const fromSpec = async () => {
    setOpening(true);
    try {
      const home = await docTrackerApi.apiHome(projectId);
      const o = await apiDocApi.overview(home.documentId);
      setApi({ documentId: home.documentId, definitions: o.definitions });
    } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not open the API reference.', 'error'); }
    finally { setOpening(false); }
  };
  if (!canCreate) return null;
  return (
    <section className="lib-card lib-start" aria-label="Start">
      <h3>Start</h3>
      <button type="button" className="lib-ai" onClick={() => setAi(true)}>
        <b><Icon name="sparkle" size={14} /> Write with AI</b>
        <small>From a line, a meeting, a cURL or a spec</small>
      </button>
      <button type="button" className="lib-spec" disabled={opening} onClick={() => void fromSpec()}>{opening ? <Spinner /> : <Icon name="code" size={14} />} From a cURL or an API spec</button>
      <div className="lib-templates">
        {starters.map((t) => (
          <button key={t.id} type="button" style={{ '--dc': t.color } as CSSProperties} onClick={() => void newPage.create({ template: t, projectId })} title={t.description ?? undefined}>{START_LABEL[t.code] ?? t.name}</button>
        ))}
      </div>
      {ai && <AiDraftDialog projects={projects} projectId={projectId} initialPrompt={prompt} useLabel="Create the page" onClose={() => { setAi(false); setPrompt(''); }}
        onUse={async (d, from) => { await newPage.create({ title: d.title, body: d.body, projectId: from.projectId }); setAi(false); }} />}
      {api && <ApiImportModal documentId={api.documentId} definitions={api.definitions} onClose={() => setApi(null)}
        onDone={() => { const id = api.documentId; setApi(null); navigate(`/library/docs/${id}`); }} />}
    </section>
  );
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
