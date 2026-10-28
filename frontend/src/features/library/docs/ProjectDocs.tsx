import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { ApiError } from '../../../api/client';
import { docTrackerApi, documentApi } from '../../../api/endpoints';
import { API_STAGES, type DtCatalog, type DtDocument, type DtEndpoint, type DtProject } from '../../../api/types';
import { Icon, type IconName } from '../../../components/Icon';
import { EmptyState, ErrorState, PageLoader } from '../../../components/ui';
import { timeAgo } from '../../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../../lib/hooks';
import { useWorkspaceId } from '../../../stores/auth';
import { toast } from '../../../stores/ui';
import { AiDraftDialog } from '../../documents/AiDraft';
import { AUTH_LABEL } from '../../documents/ApiTools';
import { DocumentPage } from '../../documents/DocumentPage';
import { DocumentWizard } from '../../documents/DocumentWizard';
import { pageTree, useNewPage } from '../../documents/pages';
import { ApiSymbol } from './ApiSymbol';
import { Reading } from './Reading';
import { Architecture } from './Architecture';
import { Designs } from './Designs';
import { docsPath, GENERAL, topicOf, type Topic } from './nav';
import { avgScore, HealthRing, MethodPill, pidOf, plural, PopMenu, ProjectMark, tone, useApiActions } from './shared';
import { dropZone, planDrop, planStep, type DropWhere } from './treeDrag';
import { docFresh, DriftPill, FreshPill, freshOf, freshOfMany } from './Fresh';
import './docs.css';

const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};
const isRelease = (d: DtDocument) => /RELEASE/i.test(d.typeCode) || /release notes?/i.test(d.title);

/** Endpoints grouped by tag (resource), tags A→Z, untagged last. */
export function byTag(eps: DtEndpoint[]): [string, DtEndpoint[]][] {
  const m = new Map<string, DtEndpoint[]>();
  for (const e of eps) { const k = e.tag ?? ''; (m.get(k) ?? m.set(k, []).get(k)!).push(e); }
  return [...m.entries()].sort((a, b) => (a[0] === '' ? 1 : b[0] === '' ? -1 : a[0].localeCompare(b[0])));
}

/**
 * A project's documentation, as developer.apple.com lays out a framework: a topic navigator on the left (Overview, Guides, API Reference by
 * resource, Architecture, Release notes), the reading column in the middle and "On this page" on the right. Topics change inside the
 * column with a short slide, so the navigator never jumps.
 */
export function ProjectDocs() {
  const { projectId = GENERAL } = useParams();
  const loc = useLocation();
  const rest = loc.pathname.replace(/^\/library\/p\/[^/]+\/?/, '');
  const topic = topicOf(rest);
  const catalog = useWsQuery(['documents', 'doctracker', 'catalog'], docTrackerApi.catalog, { staleTime: 20_000 });
  const still = useReducedMotion();
  const c = catalog.data;
  const p = c?.projects.find((x) => pidOf(x) === projectId) ?? null;
  if (catalog.isLoading) return <div className="page dx"><PageLoader /></div>;
  if (catalog.isError || !c) return <div className="page dx"><ErrorState error={catalog.error} retry={() => void catalog.refetch()} /></div>;
  if (!p) return <div className="page dx"><EmptyState icon="alert" title="This collection is not here" text="It may have been removed, or you can't open it." action={<Link className="dx-btn" to={docsPath.hub()}>Back to Library</Link>} /></div>;
  const key = topic.kind === 'endpoint' || topic.kind === 'guide' ? `${topic.kind}:${topic.id}` : topic.kind;
  return (
    <div className="page dx dx-proj" data-testid="project-docs">
      <Navigator p={p} catalog={c} topic={topic} />
      <AnimatePresence initial={false} mode="popLayout">
        <motion.div key={key} className="dx-stage"
          initial={still ? false : { opacity: 0, x: 18 }} animate={{ opacity: 1, x: 0 }} exit={still ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, x: -12, transition: { duration: 0.14 } }}
          transition={still ? { duration: 0 } : { type: 'spring', duration: 0.34, bounce: 0.08 }}>
          <Topic p={p} catalog={c} topic={topic} />
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

function Topic({ p, catalog, topic }: { p: DtProject; catalog: DtCatalog; topic: Topic }) {
  if (topic.kind === 'guide') {
    const d = p.documents.find((x) => x.id === topic.id);
    return <div className="dx-guide">{d && <div className="dx-guide-fresh"><FreshPill state={docFresh(d)} /></div>}<DocumentPage id={topic.id} /></div>;
  }
  if (topic.kind === 'endpoint') {
    const e = p.endpoints.find((x) => x.id === topic.id);
    return e ? <ApiSymbol project={p} endpoint={e} /> : <Reading p={p} title="Endpoint"><EmptyState icon="code" title="This endpoint is not here any more" action={<Link className="dx-btn" to={docsPath.apiIndex(p.id)}>API reference</Link>} /></Reading>;
  }
  if (topic.kind === 'architecture') return <ArchReading p={p} />;
  if (topic.kind === 'designs') return <Reading p={p} title="Designs" wide fresh={<FreshPill state={freshOfMany(p.documents)} />}><Designs projectId={p.id} projectName={p.name} /></Reading>;
  if (topic.kind === 'api') return <ApiIndex p={p} catalog={catalog} />;
  return <Overview p={p} catalog={catalog} />;
}

/** Architecture with its freshness: the diagrams' last save is when someone last stood behind them. */
function ArchReading({ p }: { p: DtProject }) {
  const arch = useWsQuery(['documents', 'doctracker', 'architecture', p.id ?? 'general'], () => docTrackerApi.architecture(p.id));
  return <Reading p={p} title="Architecture" wide fresh={arch.data?.updatedAt ? <FreshPill state={freshOf({ updatedAt: arch.data.updatedAt })} /> : undefined}><Architecture projectId={p.id} projectName={p.name} /></Reading>;
}

// ---- navigator

function Navigator({ p, catalog, topic }: { p: DtProject; catalog: DtCatalog; topic: Topic }) {
  const [q, setQ] = useState('');
  const dq = q.trim().toLowerCase();
  const guides = useMemo(() => p.documents.filter((d) => !d.isApi && !isRelease(d)), [p.documents]);
  const releases = useMemo(() => p.documents.filter((d) => !d.isApi && isRelease(d)), [p.documents]);
  const apiDocs = useMemo(() => p.documents.filter((d) => d.isApi), [p.documents]);
  const tags = useMemo(() => byTag(dq ? p.endpoints.filter((e) => `${e.method} ${e.path} ${e.summary} ${e.tag ?? ''}`.toLowerCase().includes(dq)) : p.endpoints), [p.endpoints, dq]);
  const match = (d: DtDocument) => !dq || `${d.key} ${d.title}`.toLowerCase().includes(dq);
  const newPage = useNewPage();
  const teams = p.id === null ? catalog.teams ?? [] : [];
  const companyGuides = p.id === null ? guides.filter((d) => !d.teamId) : guides;
  const on = (k: Topic['kind'], id?: string) => topic.kind === k && (!id || ('id' in topic && topic.id === id));
  return (
    <nav className="dx-nav" aria-label={`${p.name} documentation`} data-testid="topic-nav">
      <Link to={docsPath.project(p.id)} className="dx-nav-head">
        <ProjectMark p={p} size={30} />
        <span><b>{p.name}</b><small>{p.key ?? 'General'}</small></span>
      </Link>
      <label className="dx-filter"><Icon name="search" size={13} /><input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter" aria-label="Filter topics" autoComplete="off" /></label>
      <ul className="dx-nav-list">
        <NavRow to={docsPath.project(p.id)} on={on('overview')} icon="dashboard">Overview</NavRow>
      </ul>
      <NavGroup id={`g:${pidOf(p)}`} title="Guides" count={guides.length} add={catalog.canCreate ? () => void newPage.create({ projectId: p.id }) : undefined}>
        {dq ? companyGuides.filter(match).map((d) => <NavRow key={d.id} to={docsPath.guide(p.id, d.id)} on={on('guide', d.id)} icon="note">{d.title}</NavRow>)
          : <PageTree p={p} docs={companyGuides} active={topic.kind === 'guide' ? topic.id : null} canCreate={catalog.canCreate} />}
        {apiDocs.filter(match).map((d) => <NavRow key={d.id} to={docsPath.guide(p.id, d.id)} on={on('guide', d.id)} icon="code">{d.title}</NavRow>)}
        {guides.length + apiDocs.length === 0 && <li className="dx-nav-empty">No guides yet.</li>}
      </NavGroup>
      {teams.map((t) => {
        const docs = guides.filter((d) => d.teamId === t.id);
        return (
          <NavGroup key={t.id} id={`t:${t.id}`} title={t.name} count={docs.length} add={catalog.canCreate && t.mine ? () => void newPage.create({ teamId: t.id }) : undefined}>
            {docs.length ? <PageTree p={p} docs={docs.filter(match)} active={topic.kind === 'guide' ? topic.id : null} canCreate={catalog.canCreate && t.mine} /> : <li className="dx-nav-empty">No pages yet.</li>}
          </NavGroup>
        );
      })}
      <NavGroup id={`a:${pidOf(p)}`} title="API Reference" count={p.endpoints.length} open={topic.kind === 'endpoint' || topic.kind === 'api' || !!dq}>
        <NavRow to={docsPath.apiIndex(p.id)} on={on('api')} icon="layers">All endpoints</NavRow>
        {tags.map(([tag, eps]) => (
          <NavGroup key={tag} id={`tag:${pidOf(p)}:${tag}`} title={tag || 'Ungrouped'} count={eps.length} sub open={!!dq || eps.some((e) => on('endpoint', e.id))}>
            {eps.map((e) => (
              <li key={e.id}><Link to={docsPath.endpoint(p.id, e.id)} className={`dx-nav-row ep${on('endpoint', e.id) ? ' on' : ''}${e.deprecated ? ' dep' : ''}`} aria-current={on('endpoint', e.id) ? 'page' : undefined} title={`${e.method} ${e.path}`}>
                <MethodPill m={e.method} /><span className="dx-nav-t">{e.summary || e.path}</span><i className={`dx-dot t-${tone(e.score)}`} title={`Health ${e.score}`} />
              </Link></li>
            ))}
          </NavGroup>
        ))}
        {p.endpoints.length === 0 && <li className="dx-nav-empty">No endpoints yet.</li>}
      </NavGroup>
      <ul className="dx-nav-list">
        <NavRow to={docsPath.architecture(p.id)} on={on('architecture')} icon="workflow" count={p.diagrams}>Architecture</NavRow>
        <NavRow to={docsPath.designs(p.id)} on={on('designs')} icon="layers" count={p.designs ?? 0}>Designs</NavRow>
      </ul>
      <NavGroup id={`r:${pidOf(p)}`} title="Release notes" count={releases.length}>
        {releases.filter(match).map((d) => <NavRow key={d.id} to={docsPath.guide(p.id, d.id)} on={on('guide', d.id)} icon="flag">{d.title}</NavRow>)}
        {releases.length === 0 && <li className="dx-nav-empty">None yet. Make one from a finished sprint in Library › Needs your review.</li>}
      </NavGroup>
    </nav>
  );
}

function NavRow({ to, on, icon, count, children }: { to: string; on: boolean; icon: IconName; count?: number; children: ReactNode }) {
  return <li><Link to={to} className={`dx-nav-row${on ? ' on' : ''}`} aria-current={on ? 'page' : undefined}><Icon name={icon} size={14} /><span className="dx-nav-t">{children}</span>{count ? <em>{count}</em> : null}</Link></li>;
}

function NavGroup({ id, title, count, children, open: force, sub, add }: { id: string; title: string; count?: number; children: ReactNode; open?: boolean; sub?: boolean; add?: () => void }) {
  const k = `pm_dx_nav:${id}`;
  const [open, setOpen] = useState(() => store.get(k) !== '0');
  useEffect(() => { if (force) setOpen(true); }, [force]);
  return (
    <div className={`dx-group${sub ? ' sub' : ''}${open ? ' open' : ''}`}>
      <div className="dx-group-h">
        <button type="button" aria-expanded={open} onClick={() => setOpen((o) => { store.set(k, o ? '0' : '1'); return !o; })}>
          <Icon name="chevronR" size={11} /><span>{title}</span>{count ? <em>{count}</em> : null}
        </button>
        {add && <button type="button" className="dx-add" aria-label={`New page in ${title}`} title="New page" onClick={add}><Icon name="plus" size={12} /></button>}
      </div>
      <div className="dx-group-b" hidden={!open}><ul className="dx-nav-list">{children}</ul></div>
    </div>
  );
}

/** Guides as a tree: drag to reorder and nest, Alt+↑/↓ from the keyboard, + to add a page inside. */
function PageTree({ p, docs, active, canCreate }: { p: DtProject; docs: DtDocument[]; active: string | null; canCreate: boolean }) {
  const tree = useMemo(() => pageTree(docs), [docs]);
  const dragging = useRef<string | null>(null);
  const wid = useWorkspaceId();
  const move = async (id: string, plan: { parentId: string | null; pageOrder: number }) => {
    try { await documentApi.place(id, plan); invalidateWorkspace(wid, 'documents'); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Could not move the page.', 'error'); }
  };
  const ctx = { p, docs, tree, active, canCreate, dragging, move };
  return <>{tree.roots.map((d) => <PageNode key={d.id} d={d} depth={0} ctx={ctx} />)}</>;
}

type TreeCtx = { p: DtProject; docs: DtDocument[]; tree: ReturnType<typeof pageTree<DtDocument>>; active: string | null; canCreate: boolean; dragging: { current: string | null }; move: (id: string, plan: { parentId: string | null; pageOrder: number }) => Promise<void> };
function PageNode({ d, depth, ctx }: { d: DtDocument; depth: number; ctx: TreeCtx }) {
  const { p, docs, tree, active, canCreate, dragging, move } = ctx;
  const kids = tree.children(d.id);
  const [open, setOpen] = useState(() => store.get(`pm_dx_page:${d.id}`) === '1' || (!!active && kids.some((k) => k.id === active)));
  const [over, setOver] = useState<DropWhere | null>(null);
  const newPage = useNewPage();
  const zone = (e: DragEvent<HTMLDivElement>) => { const r = e.currentTarget.getBoundingClientRect(); return dropZone(e.clientY - r.top, r.height); };
  const plan = (e: DragEvent<HTMLDivElement>) => (dragging.current ? planDrop(docs, dragging.current, d.id, zone(e)) : null);
  const drag = canCreate ? {
    draggable: true,
    onDragStart: (e: DragEvent<HTMLDivElement>) => { dragging.current = d.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', d.title); },
    onDragEnd: () => { dragging.current = null; setOver(null); },
    onDragOver: (e: DragEvent<HTMLDivElement>) => { if (!plan(e)) { setOver(null); return; } e.preventDefault(); setOver(zone(e)); },
    onDragLeave: () => setOver(null),
    onDrop: (e: DragEvent<HTMLDivElement>) => { e.preventDefault(); setOver(null); const pl = plan(e); const id = dragging.current; dragging.current = null; if (pl && id) void move(id, pl); },
  } : {};
  const keys = canCreate ? (e: ReactKeyboardEvent) => {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault(); const pl = planStep(docs, d.id, e.key === 'ArrowUp' ? -1 : 1); if (pl) void move(d.id, pl);
  } : undefined;
  const on = d.id === active;
  return (
    <li>
      <div className={`dx-tree-row${over ? ` drop-${over}` : ''}`} style={{ '--depth': depth } as CSSProperties} {...drag} title={canCreate ? 'Drag to move · Alt+↑/↓ to reorder' : undefined}>
        {kids.length > 0 ? <button type="button" className={`dx-caret${open ? ' open' : ''}`} aria-expanded={open} aria-label={`${open ? 'Hide' : 'Show'} pages inside ${d.title}`} onClick={() => setOpen((o) => { store.set(`pm_dx_page:${d.id}`, o ? '0' : '1'); return !o; })}><Icon name="chevronR" size={10} /></button> : <span className="dx-caret-gap" />}
        <Link to={docsPath.guide(p.id, d.id)} className={`dx-nav-row${on ? ' on' : ''}`} aria-current={on ? 'page' : undefined} onKeyDown={keys} draggable={false}>
          {d.icon ? <span className="dx-emoji" aria-hidden="true">{d.icon}</span> : <Icon name="note" size={14} />}<span className="dx-nav-t">{d.title}</span>
        </Link>
        {canCreate && <button type="button" className="dx-add" aria-label={`Add a page inside ${d.title}`} onClick={() => void newPage.create({ parentId: d.id })}><Icon name="plus" size={12} /></button>}
      </div>
      {open && kids.length > 0 && <ul className="dx-nav-list">{kids.map((k) => <PageNode key={k.id} d={k} depth={depth + 1} ctx={ctx} />)}</ul>}
    </li>
  );
}

// ---- overview

function Overview({ p, catalog }: { p: DtProject; catalog: DtCatalog }) {
  const navigate = useNavigate();
  const [modal, setModal] = useState<null | 'ai' | 'wizard'>(null);
  const newPage = useNewPage();
  const actions = useApiActions(p, (ep) => navigate(docsPath.endpoint(p.id, ep)));
  const canWrite = catalog.canCreate || p.definitions.length > 0;
  const guides = p.documents.filter((d) => !d.isApi);
  const weak = [...p.endpoints].filter((e) => e.score < 70).sort((a, b) => a.score - b.score).slice(0, 6);
  const methods = Object.entries(p.endpoints.reduce<Record<string, number>>((m, e) => ({ ...m, [e.method]: (m[e.method] ?? 0) + 1 }), {})).sort((a, b) => b[1] - a[1]);
  const tools = (
    <>
      {canWrite && <PopMenu label={actions.busy ? 'Opening…' : 'New'} icon="plus" tone="tint" items={[
        { label: 'Endpoint', hint: 'Describe one by hand', icon: 'code', onSelect: actions.newEndpoint },
        { label: 'Import', hint: 'OpenAPI, Postman or cURL', icon: 'upload', onSelect: actions.importFile },
        { label: 'Architecture diagram', hint: 'Open the studio', icon: 'workflow', onSelect: () => navigate(docsPath.architecture(p.id)) },
        { label: 'Design', hint: 'Figma link, picture or an AI screen', icon: 'layers', onSelect: () => navigate(docsPath.designs(p.id)) },
        { label: 'Page written by AI', hint: 'From a line, a meeting, this project’s work or files', icon: 'sparkle', onSelect: () => setModal('ai'), hidden: !catalog.canCreate },
        { label: 'Document', hint: 'Requirements, runbook, test plan…', icon: 'note', onSelect: () => setModal('wizard'), hidden: !catalog.canCreate },
      ]} />}
      {actions.hasApi && <PopMenu label="Export" icon="download" items={[
        { label: 'OpenAPI (JSON)', icon: 'download', onSelect: () => actions.exportFile('openapi') },
        { label: 'Postman collection', icon: 'download', onSelect: () => actions.exportFile('postman') },
        { label: actions.pdfBusy ? 'Preparing PDF…' : 'PDF', hint: 'Masked values stay masked', icon: 'download', onSelect: actions.exportPdf },
        { label: 'Open in Swagger', hint: 'Read-only view of the OpenAPI file', icon: 'code', onSelect: () => actions.swagger() },
      ]} />}
    </>
  );
  return (
    <Reading p={p} tools={tools} fresh={<><FreshPill state={freshOfMany(p.documents)} />{p.endpoints.some((e) => e.drift?.differs) && <DriftPill drift={p.endpoints.find((e) => e.drift?.differs)!.drift} />}</>}>
      <header className="dx-hero-p dx-reveal">
        <p className="dx-eyebrow">Collection</p>
        <h1 className="dx-title">{p.name}</h1>
        <p className="dx-lede">{p.endpoints.length ? `${plural(p.endpoints.length, 'endpoint')} in ${plural(p.definitions.length, 'API')}, ${plural(guides.length, 'guide')} and ${plural(p.diagrams, 'diagram')}.` : `${plural(guides.length, 'guide')} and ${plural(p.diagrams, 'diagram')}. No API described yet.`}
          {p.id && <> <Link to={`/projects/${p.id}`}>Open the project</Link></>}</p>
        <div className="dx-stats">
          <div className="dx-stat"><HealthRing score={avgScore(p.endpoints)} size={52} /><span><b>Documentation health</b><small>{p.endpoints.length ? 'average of all endpoints' : 'no endpoints yet'}</small></span></div>
          <div className="dx-stat"><b className="n">{p.endpoints.length}</b><small>{methods.map(([m, n]) => `${n} ${m}`).join(' · ') || 'Endpoints'}</small></div>
          <div className="dx-stat"><b className={`n${weak.length ? ' warn' : ''}`}>{p.endpoints.filter((e) => e.score < 70).length}</b><small>Need work</small></div>
        </div>
      </header>

      {p.definitions.length > 0 && (
        <section className="dx-reveal" data-outline="APIs">
          <h2 className="dx-h2">APIs</h2>
          <div className="dx-apis">{p.definitions.map((d) => {
            const eps = p.endpoints.filter((e) => e.definitionId === d.id);
            const stage = Math.max(0, API_STAGES.findIndex((s) => s.id === d.stage));
            return (
              <article key={d.id} className="dx-api">
                <div className="dx-api-top"><b>{d.name}</b>{d.version && <span className="dx-tag">{d.version}</span>}<span className="dx-apistage">{API_STAGES[stage]?.label ?? d.stage}</span></div>
                <div className="dx-track" aria-label={`Stage ${stage + 1} of ${API_STAGES.length}`}>{API_STAGES.map((s, i) => <i key={s.id} className={i < stage ? 'done' : i === stage ? 'now' : ''} title={s.label} />)}</div>
                <dl><div><dt>Auth</dt><dd>{AUTH_LABEL[d.auth]}</dd></div><div><dt>Endpoints</dt><dd>{eps.length}</dd></div><div><dt>Health</dt><dd>{eps.length ? avgScore(eps) : '–'}</dd></div></dl>
                <div className="dx-row"><Link className="dx-btn sm" to={docsPath.apiIndex(p.id)}>Endpoints</Link><button type="button" className="dx-btn sm" onClick={() => actions.swagger(d.id)}>Swagger</button><Link className="dx-btn sm" to={docsPath.guide(p.id, d.documentId)}>Document</Link></div>
              </article>
            );
          })}</div>
        </section>
      )}

      <section className="dx-reveal" data-outline="Guides">
        <h2 className="dx-h2">Guides</h2>
        {guides.length === 0 ? <p className="dx-note">Requirements, designs, test plans and runbooks live here, next to the APIs.</p> : (
          <ul className="dx-cards">{guides.slice(0, 8).map((d, i) => (
            <li key={d.id} style={{ '--i': i } as CSSProperties}><Link to={docsPath.guide(p.id, d.id)} className="dx-gcard">
              <span className="dx-kc" style={{ '--dc': d.typeColor } as CSSProperties}>{d.typeCode}</span><b>{d.title}</b><small>Updated {timeAgo(d.updatedAt)}</small>
            </Link></li>
          ))}</ul>
        )}
      </section>

      {p.endpoints.length > 0 && (
        <section className="dx-reveal" data-outline="Needs work">
          <h2 className="dx-h2">Needs work</h2>
          {weak.length === 0 ? <p className="dx-note">Every endpoint scores 70 or more.</p> : (
            <ul className="dx-list">{weak.map((e) => (
              <li key={e.id}><Link className="dx-li" to={docsPath.endpoint(p.id, e.id)}><MethodPill m={e.method} /><code>{e.path}</code><span className="dx-li-proj">{e.gaps.slice(0, 2).join(' · ')}</span><HealthRing score={e.score} size={26} /></Link></li>
            ))}</ul>
          )}
        </section>
      )}

      <section className="dx-reveal" data-outline="Architecture">
        <h2 className="dx-h2">Architecture</h2>
        <Link to={docsPath.architecture(p.id)} className="dx-teaser"><Icon name="workflow" size={22} /><span>{p.diagrams ? `${plural(p.diagrams, 'diagram')}: how the system fits together and how requests flow.` : 'Draw how the system fits together and how a request flows.'}</span><Icon name="chevronR" size={14} /></Link>
      </section>

      <section className="dx-reveal" data-outline="Designs">
        <h2 className="dx-h2">Designs</h2>
        <Link to={docsPath.designs(p.id)} className="dx-teaser"><Icon name="layers" size={22} /><span>{p.designs ? `${plural(p.designs, 'screen')} from Figma, pictures and AI drafts.` : 'Link Figma, upload screens, or describe one and let AI draft it.'}</span><Icon name="chevronR" size={14} /></Link>
      </section>
      {actions.modal}
      {modal === 'ai' && <AiDraftDialog projects={catalog.projects.filter((x): x is DtProject & { id: string } => !!x.id).map((x) => ({ id: x.id, name: x.name }))} projectId={p.id} useLabel="Create the page"
        onClose={() => setModal(null)} onUse={async (d, from) => { await newPage.create({ title: d.title, body: d.body, projectId: from.projectId ?? p.id }); setModal(null); }} />}
      {modal === 'wizard' && <DocumentWizard projectId={p.id ?? undefined} onClose={() => setModal(null)} onCreated={(id) => navigate(docsPath.guide(p.id, id))} />}
    </Reading>
  );
}

// ---- API reference index

function ApiIndex({ p, catalog }: { p: DtProject; catalog: DtCatalog }) {
  const navigate = useNavigate();
  const actions = useApiActions(p, (ep) => navigate(docsPath.endpoint(p.id, ep)));
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<'path' | 'score'>('path');
  const groups = useMemo(() => {
    const dq = q.trim().toLowerCase();
    const g = byTag(p.endpoints.filter((e) => !dq || `${e.method} ${e.path} ${e.summary}`.toLowerCase().includes(dq)));
    for (const [, v] of g) v.sort((a, b) => (sort === 'score' ? a.score - b.score : a.path.localeCompare(b.path)));
    return g;
  }, [p.endpoints, q, sort]);
  const canWrite = catalog.canCreate || p.definitions.length > 0;
  return (
    <Reading p={p} title="API Reference" fresh={<FreshPill state={freshOfMany(p.documents.filter((d) => d.isApi))} />} tools={canWrite ? <><button type="button" className="dx-btn" onClick={actions.importFile}>Import</button><button type="button" className="dx-btn tint" onClick={actions.newEndpoint}>New endpoint</button></> : undefined}>
      <header className="dx-hero-p dx-reveal"><p className="dx-eyebrow">API Reference</p><h1 className="dx-title">{p.name} API</h1>
        <p className="dx-lede">{plural(p.endpoints.length, 'endpoint')}, grouped by resource.</p></header>
      {p.endpoints.length === 0 ? <EmptyState icon="code" title="No endpoints yet" text="Describe an endpoint by hand, or import an OpenAPI file, a Postman collection or cURL commands." /> : (
        <>
          <div className="dx-row dx-idx-tools">
            <label className="dx-filter wide"><Icon name="search" size={13} /><input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by path or summary" aria-label="Filter endpoints" autoComplete="off" /></label>
            <div className="dx-seg" role="radiogroup" aria-label="Sort"><button type="button" role="radio" aria-checked={sort === 'path'} onClick={() => setSort('path')}>By path</button><button type="button" role="radio" aria-checked={sort === 'score'} onClick={() => setSort('score')}>Weakest first</button></div>
          </div>
          {groups.map(([tag, eps]) => (
            <section key={tag} className="dx-reveal" data-outline={tag || 'Ungrouped'}>
              <h2 className="dx-h2">{tag || 'Ungrouped'}</h2>
              <ul className="dx-list">{eps.map((e) => (
                <li key={e.id}><Link className={`dx-li${e.deprecated ? ' dep' : ''}`} to={docsPath.endpoint(p.id, e.id)}>
                  <MethodPill m={e.method} /><code>{e.path}</code><span className="dx-li-proj">{e.summary || 'No summary'}</span>{e.deprecated && <span className="dx-tag warn">Deprecated</span>}{e.drift?.differs && <span className="dx-tag warn" title="Docs differ from live API">Differs from live</span>}<HealthRing score={e.score} size={26} />
                </Link></li>
              ))}</ul>
            </section>
          ))}
        </>
      )}
      {actions.modal}
    </Reading>
  );
}
