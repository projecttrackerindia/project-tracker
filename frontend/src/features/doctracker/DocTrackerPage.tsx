import { createContext, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { docTrackerApi, documentApi } from '../../api/endpoints';
import type { DtCatalog, DtEndpoint, DtProject, DtTeam } from '../../api/types';
import { Icon, type IconName } from '../../components/Icon';
import { ErrorState, PageLoader } from '../../components/ui';
import { Menu } from '../../components/Menu';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { dropZone, planDrop, planStep, type DropPlan, type DropWhere } from './treeDrag';
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
import { pageTree, useNewPage } from '../documents/pages';
import './doctracker.css';
import './doctracker-ds.css';

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
  const path = useLocation().pathname;
  const onTracker = path === '/doctracker' || path === '/library' || path === '/library/docs';   // v2: DocTracker is Library › Docs
  const go = (next: { p?: string | null; t?: ProjectTab | null; ep?: string | null; view?: 'security' | null }) => {
    const q = new URLSearchParams();
    if (next.view) q.set('view', next.view);
    if (next.p) q.set('p', next.p);
    if (next.p && next.t && next.t !== 'overview') q.set('t', next.t);
    if (next.p && next.ep) q.set('ep', next.ep);
    navigate(`/library/docs${q.size ? `?${q}` : ''}`);
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
      const box = input.current ?? document.querySelector<HTMLInputElement>('.dl-search input');
      if (!box) return;
      e.preventDefault(); box.focus(); box.select();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  const onHome = !activeDocId && !nav.p && !nav.view;
  const dq = onHome ? '' : q.trim().toLowerCase();
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
      {/* On the front page the big search does this job, so the tree does not show a second box. */}
      {!onHome && <div className="ds-rail-search">
        <Icon name="search" size={14} />
        <input ref={input} type="search" autoComplete="off" placeholder="Search APIs and documents…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search APIs, endpoints and documents" />
        <kbd className="dt-kbd" title="Press / to search">/</kbd>
      </div>}
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
            {catalog.projects.map((p) => <ProjectNode key={pid(p)} p={p} activeDocId={activeDocId} canCreate={catalog.canCreate} />)}
          </ul>
          {(catalog.teams?.length ?? 0) > 0 && <>
            <div className="ds-rail-heading">Team spaces</div>
            <ul className="ds-rail-list ds-rail-projects ds-tree-projects">
              {catalog.teams!.map((t) => <TeamNode key={t.id} team={t} docs={(catalog.projects.find((p) => p.id === null)?.documents ?? []).filter((d) => d.teamId === t.id)} activeDocId={activeDocId} canCreate={catalog.canCreate && t.mine} />)}
            </ul>
          </>}
        </>
      )}
    </nav>
  );
}

function ProjectNode({ p, activeDocId, canCreate }: { p: DtProject; activeDocId?: string; canCreate: boolean }) {
  const nav = useDtNav();
  const id = pid(p);
  // The company's own pages here; a team's pages live in its space below.
  const docsHere = useMemo(() => (p.id === null ? p.documents.filter((d) => !d.teamId) : p.documents), [p]);
  const hasDoc = !!activeDocId && docsHere.some((d) => d.id === activeDocId);
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
          {(docsHere.length > 0 || canCreate) && <DocGroup projectId={id} realProjectId={p.id} docs={docsHere} activeDocId={activeDocId} canCreate={canCreate} />}
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

/** One space's pages being dragged: the pages (for working out where a drop goes) and the page in the hand. */
const DragCtx = createContext<{ docs: DtProject['documents']; dragging: React.MutableRefObject<string | null>; move: (id: string, plan: DropPlan) => void } | null>(null);

function usePlace() {
  const wid = useWorkspaceId();
  return async (id: string, plan: DropPlan) => {
    try { await documentApi.place(id, plan); invalidateWorkspace(wid, 'documents'); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Could not move the page.', 'error'); }
  };
}

/** A team's space: its pages (visible to the team), with "+" for the team's members. */
function TeamNode({ team, docs, activeDocId, canCreate }: { team: DtTeam; docs: DtProject['documents']; activeDocId?: string; canCreate: boolean }) {
  const openKey = `pm_dt_team:${team.id}`;
  const here = !!activeDocId && docs.some((d) => d.id === activeDocId);
  const [open, setOpen] = useState(() => store.get(openKey) === '1');
  useEffect(() => { if (here) setOpen(true); }, [here]);
  const toggle = () => setOpen((o) => { store.set(openKey, o ? '0' : '1'); return !o; });
  const newPage = useNewPage();
  return (
    <li className={`ds-node${open ? ' open' : ''}${here ? ' has-active' : ''}`}>
      <div className="ds-rail-row ds-rail-project">
        <button type="button" className="ds-caret" aria-expanded={open} aria-label={`${open ? 'Close' : 'Open'} ${team.name}`} onClick={toggle}><Icon name="chevronR" size={12} /></button>
        <button type="button" className="ds-node-main" title={`${team.name}: pages for this team`} onClick={toggle}>
          <span className="ds-avatar" style={{ '--av': avatarColor(team.id) } as CSSProperties}><Icon name="users" size={11} /></span>
          <span className="ds-rail-label">{team.name}</span>
          {team.pages > 0 && <span className="ds-rail-count soft">{team.pages}</span>}
        </button>
        {canCreate && <button type="button" className="dt-add" title={`New page for ${team.name}`} aria-label={`New page for ${team.name}`} onClick={() => void newPage.create({ teamId: team.id })}><Icon name="plus" size={12} /></button>}
      </div>
      {open && (docs.length === 0
        ? <ul className="ds-tree-children"><li className="ds-rail-empty">No pages yet.</li></ul>
        : <ul className="ds-tree-children"><PageList docs={docs} activeDocId={activeDocId} canCreate={canCreate} /></ul>)}
    </li>
  );
}

/** The pages of one space as a tree, with drag to reorder and nest (and Alt+↑/↓ from the keyboard). */
function PageList({ docs, activeDocId, canCreate }: { docs: DtProject['documents']; activeDocId?: string; canCreate: boolean }) {
  const tree = useMemo(() => pageTree(docs), [docs]);
  const dragging = useRef<string | null>(null);
  const place = usePlace();
  const ctx = useMemo(() => ({ docs, dragging, move: (id: string, plan: DropPlan) => void place(id, plan) }), [docs]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <DragCtx.Provider value={ctx}>
      <li><ul className="ds-tree-docs">{tree.roots.map((d) => <PageNode key={d.id} d={d} tree={tree} activeDocId={activeDocId} canCreate={canCreate} depth={0} />)}</ul></li>
    </DragCtx.Provider>
  );
}

function DocGroup({ projectId, realProjectId, docs, activeDocId, canCreate }: { projectId: string; realProjectId: string | null; docs: DtProject['documents']; activeDocId?: string; canCreate: boolean }) {
  const key = `pm_dt_docs:${projectId}`;
  const hasActive = !!activeDocId && docs.some((d) => d.id === activeDocId);
  const [closed, setClosed] = useState(() => store.get(key) !== '1');
  useEffect(() => { if (hasActive) setClosed(false); }, [hasActive]);
  const newPage = useNewPage();
  return (
    <li className={`ds-type${closed ? '' : ' open'}`}>
      <div className="dt-group-head">
        <button type="button" className="ds-type-head" aria-expanded={!closed} onClick={() => setClosed((c) => { store.set(key, c ? '1' : '0'); return !c; })}>
          <Icon name="note" size={11} /><span className="ds-type-name">Documents</span><span className="ds-rail-count soft">{docs.length}</span><Icon name="chevronR" size={11} />
        </button>
        {canCreate && <button type="button" className="dt-add" title="New page" aria-label="New page" onClick={() => void newPage.create({ projectId: realProjectId })}><Icon name="plus" size={12} /></button>}
      </div>
      {!closed && <ul className="ds-tree-docs"><PageList docs={docs} activeDocId={activeDocId} canCreate={canCreate} /></ul>}
    </li>
  );
}

type Tree = ReturnType<typeof pageTree<DtProject['documents'][number]>>;

/** One page in the tree: its icon (or type code), title, a caret when it has pages inside, and "+" to add one inside it. */
function PageNode({ d, tree, activeDocId, canCreate, depth }: { d: DtProject['documents'][number]; tree: Tree; activeDocId?: string; canCreate: boolean; depth: number }) {
  const kids = tree.children(d.id);
  const holdsActive = useMemo(() => {
    if (!activeDocId) return false;
    const walk = (id: string): boolean => tree.children(id).some((c) => c.id === activeDocId || walk(c.id));
    return walk(d.id);
  }, [activeDocId, d.id, tree]);
  const [open, setOpen] = useState(() => store.get(`pm_dt_page:${d.id}`) === '1');
  useEffect(() => { if (holdsActive) setOpen(true); }, [holdsActive]);
  const toggle = () => setOpen((o) => { store.set(`pm_dt_page:${d.id}`, o ? '0' : '1'); return !o; });
  const newPage = useNewPage();
  const drag = useContext(DragCtx);
  const [over, setOver] = useState<DropWhere | null>(null);
  const canDrag = canCreate && !!drag;
  const zoneOf = (e: DragEvent<HTMLDivElement>) => { const r = e.currentTarget.getBoundingClientRect(); return dropZone(e.clientY - r.top, r.height); };
  const plan = (e: DragEvent<HTMLDivElement>) => (drag?.dragging.current ? planDrop(drag.docs, drag.dragging.current, d.id, zoneOf(e)) : null);
  const dragProps = canDrag ? {
    draggable: true,
    onDragStart: (e: DragEvent<HTMLDivElement>) => { drag!.dragging.current = d.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', d.title); },
    onDragEnd: () => { drag!.dragging.current = null; setOver(null); },
    onDragOver: (e: DragEvent<HTMLDivElement>) => { if (!plan(e)) { setOver(null); return; } e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setOver(zoneOf(e)); },
    onDragLeave: () => setOver(null),
    onDrop: (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault(); setOver(null);
      const p = plan(e); const id = drag!.dragging.current; drag!.dragging.current = null;
      if (p && id) { if (p.parentId === d.id) { store.set(`pm_dt_page:${d.id}`, '1'); setOpen(true); } drag!.move(id, p); }
    },
  } : {};
  const keys = canDrag ? (e: ReactKeyboardEvent) => {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    const p = planStep(drag!.docs, d.id, e.key === 'ArrowUp' ? -1 : 1);
    if (p) drag!.move(d.id, p);
  } : undefined;
  return (
    <li className={`ds-doc dt-page${d.id === activeDocId ? ' active' : ''}`}>
      <div className={`dt-page-row${over ? ` drop-${over}` : ''}`} style={{ paddingLeft: depth * 12 } as CSSProperties} {...dragProps}
        title={canDrag ? 'Drag to move · Alt+↑/↓ to reorder' : undefined}>
        {kids.length > 0 ? <button type="button" className={`dt-caret${open ? ' open' : ''}`} aria-expanded={open} aria-label={`${open ? 'Hide' : 'Show'} pages inside ${d.title}`} onClick={toggle}><Icon name="chevronR" size={11} /></button> : <span className="dt-caret-gap" />}
        <Link to={`/documents/${d.id}`} className="ds-doc-row" aria-current={d.id === activeDocId ? 'page' : undefined} title={`${d.key} · ${d.title}`} onKeyDown={keys} draggable={false}>
          {d.icon ? <span className="dt-page-icon" aria-hidden="true">{d.icon}</span> : <span className="ds-type-code" style={{ '--dc': d.typeColor } as CSSProperties}>{d.typeCode}</span>}
          <span className="ds-doc-title">{d.title}</span>
        </Link>
        {canCreate && <button type="button" className="dt-add" title="Add a page inside" aria-label={`Add a page inside ${d.title}`} onClick={() => { void newPage.create({ parentId: d.id }); }}><Icon name="plus" size={12} /></button>}
      </div>
      {open && kids.length > 0 && <ul className="ds-tree-docs">{kids.map((c) => <PageNode key={c.id} d={c} tree={tree} activeDocId={activeDocId} canCreate={canCreate} depth={depth + 1} />)}</ul>}
    </li>
  );
}
