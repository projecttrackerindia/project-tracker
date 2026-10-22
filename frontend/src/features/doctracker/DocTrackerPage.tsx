import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { docTrackerApi } from '../../api/endpoints';
import type { DtCatalog, DtEndpoint, DtProject } from '../../api/types';
import { Icon, type IconName } from '../../components/Icon';
import { ErrorState, PageLoader } from '../../components/ui';
import { Menu } from '../../components/Menu';
import { useWsQuery } from '../../lib/hooks';
import { Method } from '../documents/ApiView';
import { DocShell } from '../documents/DocumentsSidebar';
import { avatarColor } from '../documents/docUi';
import { DtHome } from './DtHome';
import { DtProjectView } from './DtProject';
import { DtEndpointView } from './DtEndpoint';
import { DtSecurity } from './DtSecurity';
import { WorkflowsModal } from '../documents/DocumentWorkflows';
import { RequiredDocumentsModal } from '../documents/NeedsAttention';
import { DocumentWizard } from '../documents/DocumentWizard';
import './doctracker.css';

export const GENERAL = 'general';
export const pid = (p: DtProject) => p.id ?? GENERAL;
export type ProjectTab = 'overview' | 'apis' | 'architecture' | 'documents';

const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

export const scoreTone = (s: number) => (s >= 85 ? 'good' : s >= 60 ? 'ok' : 'low');

/** Where you are in DocTracker, kept in the address so links and the back button work. */
export function useDtNav() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const onTracker = useLocation().pathname === '/doctracker';
  const go = (next: { p?: string | null; t?: ProjectTab | null; ep?: string | null; view?: 'security' | null }) => {
    const q = new URLSearchParams();
    if (next.view) q.set('view', next.view);
    if (next.p) q.set('p', next.p);
    if (next.p && next.t && next.t !== 'overview') q.set('t', next.t);
    if (next.p && next.ep) q.set('ep', next.ep);
    navigate(`/doctracker${q.size ? `?${q}` : ''}`);
    window.scrollTo({ top: 0 });
  };
  return onTracker
    ? { p: params.get('p'), t: (params.get('t') as ProjectTab | null) ?? 'overview', ep: params.get('ep'), view: params.get('view'), go }
    : { p: null as string | null, t: 'overview' as ProjectTab, ep: null as string | null, view: null as string | null, go };
}

/** The DocTracker tree on its own (used beside a document), loading the catalog itself. */
export function DtTreeStandalone({ activeDocId }: { activeDocId?: string }) {
  const catalog = useWsQuery(['documents', 'doctracker', 'catalog'], docTrackerApi.catalog, { staleTime: 20_000 });
  return catalog.data ? <DtTree catalog={catalog.data} activeDocId={activeDocId} /> : <div className="ds-rail"><PageLoader /></div>;
}

/**
 * DocTracker: every project's APIs, documents and architecture in one workspace. The tree on the left lists projects; open one for its
 * overview, architecture, documents and its endpoints grouped by tag. The Control Center sums up how well everything is documented and
 * the Security Center holds masking, reveal time, access requests and the audit trail.
 */
export function DocTrackerPage() {
  const nav = useDtNav();
  const navigate = useNavigate();
  const [modal, setModal] = useState<null | 'flows' | 'required' | 'new'>(null);
  const [newType, setNewType] = useState<string | undefined>();
  const startNew = (typeId?: string) => { setNewType(typeId); setModal('new'); };
  const catalog = useWsQuery(['documents', 'doctracker', 'catalog'], docTrackerApi.catalog, { staleTime: 20_000 });
  const c = catalog.data;
  const project = c && nav.p ? c.projects.find((x) => pid(x) === nav.p) ?? null : null;
  const endpoint = project && nav.ep ? project.endpoints.find((e) => e.id === nav.ep) ?? null : null;

  let main;
  if (catalog.isLoading) main = <PageLoader />;
  else if (catalog.isError || !c) main = <ErrorState error={catalog.error} retry={() => catalog.refetch()} />;
  else if (nav.view === 'security') main = <DtSecurity isAdmin={c.isAdmin} />;
  else if (project && endpoint) main = <DtEndpointView project={project} endpoint={endpoint} catalog={c} />;
  else if (project) main = <DtProjectView project={project} tab={nav.t} catalog={c} />;
  else if (nav.p && !project) main = <div className="dt-missing"><Icon name="alert" /> That project is not here any more, or you can't open it. <Link to="/doctracker">Back to DocTracker</Link></div>;
  else main = <DtHome catalog={c} onRequired={() => setModal('required')} onNew={startNew} />;

  return (
    <div className="doc-scope ds-page dt-page">
      <header className="ds-head dt-head">
        <div className="ds-head-main">
          <h1><span className="dt-logo" aria-hidden><Icon name="layers" size={18} /></span> DocTracker</h1>
          <p>Your documents, APIs and architecture, in one place.</p>
        </div>
        <div className="ds-head-actions">
          <Menu label="Manage" icon="settings" items={[
            { label: 'Security Center', hint: 'Masking, reveals, access requests and the audit trail', icon: 'shield', onSelect: () => nav.go({ view: 'security' }) },
            { label: 'Approval workflows', hint: 'Who reviews before a document is published', icon: 'checks', onSelect: () => setModal('flows') },
            { label: 'Required documents', hint: 'Documents every project must have', icon: 'flag', onSelect: () => setModal('required'), hidden: !c?.isAdmin },
          ]} />
          {c?.canCreate && <button className="btn btn-primary" onClick={() => startNew()}><Icon name="plus" /> New document</button>}
        </div>
      </header>
      <DocShell browseLabel="Browse DocTracker" tree={c ? <DtTree catalog={c} /> : <div className="ds-rail"><PageLoader /></div>}>{main}</DocShell>
      {modal === 'flows' && <WorkflowsModal onClose={() => setModal(null)} />}
      {modal === 'required' && <RequiredDocumentsModal onClose={() => setModal(null)} />}
      {modal === 'new' && <DocumentWizard projectId={project?.id ?? undefined} typeId={newType} onClose={() => setModal(null)} onCreated={(id) => navigate(`/documents/${id}`)} />}
    </div>
  );
}

function DtTree({ catalog, activeDocId }: { catalog: DtCatalog; activeDocId?: string }) {
  const nav = useDtNav();
  const [q, setQ] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // "/" jumps to the search (Ctrl K stays the app-wide command palette).
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || t?.closest('input, textarea, select, [contenteditable="true"]')) return;
      e.preventDefault(); input.current?.focus(); input.current?.select();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  const dq = q.trim().toLowerCase();
  const hits = useMemo(() => {
    if (dq.length < 2) return null;
    const eps: { p: DtProject; e: DtEndpoint }[] = []; const docs: { p: DtProject; d: DtProject['documents'][number] }[] = [];
    for (const p of catalog.projects) {
      for (const e of p.endpoints) if (`${e.method} ${e.path} ${e.summary} ${e.tag ?? ''}`.toLowerCase().includes(dq)) eps.push({ p, e });
      for (const d of p.documents) if (`${d.key} ${d.title}`.toLowerCase().includes(dq)) docs.push({ p, d });
    }
    return { eps: eps.slice(0, 40), docs: docs.slice(0, 20), projects: catalog.projects.filter((p) => `${p.name} ${p.key ?? ''}`.toLowerCase().includes(dq)) };
  }, [catalog, dq]);
  // Home first; the Security Center shows here only while it is open (it is reached from Manage).
  const pinned: { id: 'home' | 'security'; label: string; icon: IconName }[] = [{ id: 'home', label: 'Home', icon: 'grid' }, ...(nav.view === 'security' ? [{ id: 'security' as const, label: 'Security Center', icon: 'shield' as IconName }] : [])];
  return (
    <nav className="doc-sidebar ds-rail ds-tree dt-tree" aria-label="DocTracker">
      <div className="ds-rail-search">
        <Icon name="search" size={14} />
        <input ref={input} type="search" placeholder="Search APIs and documents…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search APIs, endpoints and documents" />
        <kbd className="dt-kbd" title="Press / to search">/</kbd>
      </div>
      <ul className="ds-rail-list">
        {pinned.map((v) => {
          const on = v.id === 'home' ? !nav.p && !nav.view : nav.view === 'security';
          return (
            <li key={v.id}><button type="button" className={`ds-rail-row${on ? ' active' : ''}`} aria-current={on ? 'page' : undefined} onClick={() => nav.go({ view: v.id === 'security' ? 'security' : null })}>
              <span className="ds-rail-ic"><Icon name={v.icon} size={14} /></span><span className="ds-rail-label">{v.label}</span></button></li>
          );
        })}
      </ul>
      {hits ? (
        <>
          {hits.projects.length > 0 && <><div className="ds-rail-heading">Projects</div><ul className="ds-rail-list ds-tree-docs">{hits.projects.map((p) => (
            <li key={pid(p)} className="ds-doc"><button type="button" className="ds-doc-row" onClick={() => { nav.go({ p: pid(p) }); setQ(''); }}><Icon name="folder" size={12} /><span className="ds-doc-title">{p.name}</span></button></li>))}</ul></>}
          <div className="ds-rail-heading">Endpoints</div>
          <ul className="ds-rail-list ds-tree-docs">
            {hits.eps.map(({ p, e }) => (
              <li key={e.id} className="ds-doc"><button type="button" className="ds-doc-row dt-ep-row" onClick={() => { nav.go({ p: pid(p), ep: e.id }); setQ(''); }} title={e.summary}>
                <Method m={e.method} /><span className="ds-doc-title">{e.path}</span><span className="ds-rail-key">{p.key ?? 'GEN'}</span></button></li>
            ))}
            {hits.eps.length === 0 && <li className="ds-rail-empty">No endpoint matches.</li>}
          </ul>
          {hits.docs.length > 0 && <><div className="ds-rail-heading">Documents</div><ul className="ds-rail-list ds-tree-docs">{hits.docs.map(({ p, d }) => (
            <li key={d.id} className="ds-doc"><Link to={`/documents/${d.id}`} className="ds-doc-row"><span className="ds-type-code" style={{ '--dc': d.typeColor } as CSSProperties}>{d.typeCode}</span><span className="ds-doc-title">{d.title}</span><span className="ds-rail-key">{p.key ?? 'GEN'}</span></Link></li>))}</ul></>}
        </>
      ) : (
        <>
          <div className="ds-rail-heading">Projects</div>
          <ul className="ds-rail-list ds-rail-projects ds-tree-projects">
            {catalog.projects.map((p) => <ProjectNode key={pid(p)} p={p} activeDocId={activeDocId} />)}
          </ul>
        </>
      )}
    </nav>
  );
}

function ProjectNode({ p, activeDocId }: { p: DtProject; activeDocId?: string }) {
  const nav = useDtNav();
  const id = pid(p);
  const hasDoc = !!activeDocId && p.documents.some((d) => d.id === activeDocId);
  const here = nav.p === id || hasDoc;
  const openKey = `pm_dt_open:${id}`;
  const [open, setOpen] = useState(() => store.get(openKey) === '1');
  useEffect(() => { if (here) setOpen(true); }, [here]);
  const toggle = () => setOpen((o) => { store.set(openKey, o ? '0' : '1'); return !o; });
  const tags = useMemo(() => {
    const m = new Map<string, DtEndpoint[]>();
    for (const e of p.endpoints) { const k = e.tag ?? ''; (m.get(k) ?? m.set(k, []).get(k)!).push(e); }
    return [...m.entries()].sort((a, b) => (a[0] === '' ? 1 : b[0] === '' ? -1 : a[0].localeCompare(b[0])));
  }, [p.endpoints]);
  const sub = (t: ProjectTab, label: string, icon: IconName, count?: number) => {
    const on = here && !nav.ep && nav.t === t;
    return <li className={`ds-doc${on ? ' active' : ''}`}><button type="button" className="ds-doc-row" aria-current={on ? 'page' : undefined} onClick={() => nav.go({ p: id, t })}><Icon name={icon} size={12} /><span className="ds-doc-title">{label}</span>{count !== undefined && count > 0 && <span className="ds-rail-count soft">{count}</span>}</button></li>;
  };
  return (
    <li className={`ds-node${open ? ' open' : ''}${here ? ' has-active' : ''}`}>
      <div className={`ds-rail-row ds-rail-project${here && !nav.ep && nav.t === 'overview' ? ' active' : ''}`}>
        <button type="button" className="ds-caret" aria-expanded={open} aria-label={`${open ? 'Close' : 'Open'} ${p.name}`} onClick={toggle}><Icon name="chevronR" size={12} /></button>
        <button type="button" className="ds-node-main" title={p.key ? `${p.key} · ${p.name}` : p.name} onClick={() => { nav.go({ p: id }); if (!open) toggle(); }}>
          <span className="ds-avatar" style={{ '--av': p.id ? avatarColor(p.id) : 'var(--text-3)' } as CSSProperties}>{(p.key ?? p.name).charAt(0).toUpperCase()}</span>
          <span className="ds-rail-label">{p.name}</span>
          {p.endpoints.length > 0 ? <span className="ds-rail-count soft">{p.endpoints.length}</span> : p.key ? <span className="ds-rail-key">{p.key}</span> : null}
        </button>
      </div>
      {open && (
        <ul className="ds-tree-children">
          <li><ul className="ds-tree-docs">
            {sub('overview', 'Overview', 'dashboard')}
            {sub('architecture', 'Architecture', 'workflow', p.diagrams)}
          </ul></li>
          {p.documents.length > 0 && <DocGroup projectId={id} docs={p.documents} activeDocId={activeDocId} />}
          {tags.map(([tag, eps]) => <TagGroup key={tag} projectId={id} tag={tag} eps={eps} />)}
          {p.endpoints.length === 0 && <li className="ds-rail-empty">No endpoints yet.</li>}
        </ul>
      )}
    </li>
  );
}

function TagGroup({ projectId, tag, eps }: { projectId: string; tag: string; eps: DtEndpoint[] }) {
  const nav = useDtNav();
  const key = `pm_dt_tag:${projectId}:${tag}`;
  const hasActive = nav.p === projectId && eps.some((e) => e.id === nav.ep);
  const [closed, setClosed] = useState(() => store.get(key) === '0');
  useEffect(() => { if (hasActive) setClosed(false); }, [hasActive]);
  return (
    <li className={`ds-type${closed ? '' : ' open'}`}>
      <button type="button" className="ds-type-head" aria-expanded={!closed} onClick={() => setClosed((c) => { store.set(key, c ? '1' : '0'); return !c; })}>
        <Icon name="tag" size={11} /><span className="ds-type-name">{tag || 'Ungrouped'}</span><span className="ds-rail-count soft">{eps.length}</span><Icon name="chevronR" size={11} />
      </button>
      {!closed && (
        <ul className="ds-tree-docs">
          {eps.map((e) => {
            const on = nav.p === projectId && nav.ep === e.id;
            return (
              <li key={e.id} className={`ds-doc${on ? ' active' : ''}`}>
                <button type="button" className={`ds-doc-row dt-ep-row${e.deprecated ? ' dep' : ''}`} aria-current={on ? 'page' : undefined} title={e.summary || e.path} onClick={() => nav.go({ p: projectId, ep: e.id })}>
                  <Method m={e.method} /><span className="ds-doc-title">{e.path}</span><span className={`dt-dot ${scoreTone(e.score)}`} title={`Documentation score ${e.score}`} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}

function DocGroup({ projectId, docs, activeDocId }: { projectId: string; docs: DtProject['documents']; activeDocId?: string }) {
  const key = `pm_dt_docs:${projectId}`;
  const hasActive = !!activeDocId && docs.some((d) => d.id === activeDocId);
  const [closed, setClosed] = useState(() => store.get(key) !== '1');
  useEffect(() => { if (hasActive) setClosed(false); }, [hasActive]);
  return (
    <li className={`ds-type${closed ? '' : ' open'}`}>
      <button type="button" className="ds-type-head" aria-expanded={!closed} onClick={() => setClosed((c) => { store.set(key, c ? '1' : '0'); return !c; })}>
        <Icon name="note" size={11} /><span className="ds-type-name">Documents</span><span className="ds-rail-count soft">{docs.length}</span><Icon name="chevronR" size={11} />
      </button>
      {!closed && (
        <ul className="ds-tree-docs">
          {docs.map((d) => (
            <li key={d.id} className={`ds-doc${d.id === activeDocId ? ' active' : ''}`}>
              <Link to={`/documents/${d.id}`} className="ds-doc-row" aria-current={d.id === activeDocId ? 'page' : undefined} title={`${d.key} · ${d.title}`}>
                <span className="ds-type-code" style={{ '--dc': d.typeColor } as CSSProperties}>{d.typeCode}</span><span className="ds-doc-title">{d.title}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
