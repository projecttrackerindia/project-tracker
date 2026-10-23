import { useMemo, useState, type CSSProperties } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { API_STAGES, type DtCatalog, type DtEndpoint, type DtProject } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Menu } from '../../components/Menu';
import { EmptyState } from '../../components/ui';
import { timeAgo } from '../../lib/format';
import { Method } from '../documents/ApiView';
import { AUTH_LABEL } from '../documents/ApiTools';
import { DocumentWizard } from '../documents/DocumentWizard';
import { AiDraftDialog } from '../documents/AiDraft';
import { useNewPage } from '../documents/pages';
import { ClassificationBadge, DocStatusBadge, avatarColor } from '../documents/docUi';
import { pid, useDtNav, type ProjectTab } from './DocTrackerPage';
import { avg, Kpi, ScoreBar, ScoreRing } from './DtHome';
import { useApiActions } from './DtApiActions';
import { DtArchitecture } from './DtArchitecture';

const TABS: { id: ProjectTab; label: string }[] = [{ id: 'overview', label: 'Overview' }, { id: 'apis', label: 'APIs' }, { id: 'architecture', label: 'Architecture' }, { id: 'documents', label: 'Documents' }];

/** One project in DocTracker: its APIs and how well they are documented, its architecture and request flows, and its other documents. */
export function DtProjectView({ project: p, tab, catalog }: { project: DtProject; tab: ProjectTab; catalog: DtCatalog }) {
  const nav = useDtNav();
  const id = pid(p);
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [aiNew, setAiNew] = useState(false);
  const newPage = useNewPage();
  const actions = useApiActions(p, (ep) => nav.go({ p: id, ep }));
  const canWrite = catalog.canCreate || p.definitions.length > 0;
  const docs = p.documents.filter((d) => !d.isApi);
  const score = avg(p.endpoints);
  return (
    <div className="dt-project">
      <header className="dt-phead">
        <span className="ds-avatar lg" style={{ '--av': p.id ? avatarColor(p.id) : 'var(--text-3)' } as CSSProperties}>{(p.key ?? p.name).charAt(0).toUpperCase()}</span>
        <div className="dt-phead-main">
          <h2>{p.name}{p.key && <small>{p.key}</small>}</h2>
          <p className="muted">{p.endpoints.length ? `${p.endpoints.length} endpoints in ${p.definitions.length} API${p.definitions.length === 1 ? '' : 's'} · score ${score}/100` : 'No API described yet.'}{p.id && <> · <Link to={`/projects/${p.id}`}>Open the project</Link></>}</p>
        </div>
        <div className="dt-phead-actions">
          {canWrite && <Menu primary icon="plus" label={actions.busy ? 'Opening…' : 'New'} items={[
            { label: 'Endpoint', hint: 'Describe one by hand', icon: 'code', onSelect: actions.newEndpoint },
            { label: 'Import', hint: 'OpenAPI, Postman or cURL', icon: 'upload', onSelect: actions.importFile },
            { label: 'Architecture diagram', hint: 'Open Architecture Studio', icon: 'workflow', onSelect: () => nav.go({ p: id, t: 'architecture' }) },
            { label: 'Page written by AI', hint: 'From a line, your voice, a meeting, this project’s work or files', icon: 'sparkle', onSelect: () => setAiNew(true), hidden: !catalog.canCreate },
            { label: 'Document', hint: 'Requirements, runbook, test plan…', icon: 'note', onSelect: () => setCreating(true), hidden: !catalog.canCreate },
          ]} />}
          {actions.hasApi && <button className="btn btn-ghost btn-sm" onClick={() => actions.swagger()}><Icon name="code" size={14} /> Open in Swagger</button>}
          {actions.hasApi && <Menu label="Export" icon="download" items={[
            { label: 'OpenAPI (JSON)', icon: 'download', onSelect: () => actions.exportFile('openapi') },
            { label: 'Postman collection', icon: 'download', onSelect: () => actions.exportFile('postman') },
            { label: actions.pdfBusy ? 'Preparing PDF…' : 'PDF', hint: 'Masked values stay masked', icon: 'download', onSelect: actions.exportPdf },
          ]} />}
        </div>
      </header>
      <div className="tabs dt-tabs" role="tablist">
        {TABS.map((t) => <button key={t.id} role="tab" aria-selected={tab === t.id} className={`tab${tab === t.id ? ' active' : ''}`} onClick={() => nav.go({ p: id, t: t.id })}>{t.label}
          {t.id === 'apis' && p.endpoints.length > 0 && <i>{p.endpoints.length}</i>}{t.id === 'architecture' && p.diagrams > 0 && <i>{p.diagrams}</i>}{t.id === 'documents' && docs.length > 0 && <i>{docs.length}</i>}</button>)}
      </div>

      {tab === 'overview' && <Overview p={p} onTab={(t) => nav.go({ p: id, t })} onSwagger={actions.swagger} />}
      {tab === 'apis' && <Apis p={p} canWrite={canWrite} onNew={actions.newEndpoint} onImport={actions.importFile} />}
      {tab === 'architecture' && <DtArchitecture projectId={p.id} />}
      {tab === 'documents' && (
        docs.length === 0 ? <EmptyState icon="note" title="No documents in this project" text="Requirements, designs, test plans and runbooks live here, next to the APIs." action={catalog.canCreate ? <button className="btn btn-primary" onClick={() => setCreating(true)}><Icon name="plus" /> New document</button> : undefined} /> : (
          <div className="dt-docs">{docs.map((d) => (
            <Link key={d.id} to={`/documents/${d.id}`} className="dt-doc">
              <span className="ds-type-code" style={{ '--dc': d.typeColor } as CSSProperties}>{d.typeCode}</span>
              <b>{d.title}</b>
              <span className="dt-doc-meta"><span className="muted">{d.key} · {d.typeName}</span><DocStatusBadge status={d.status} />{(d.classification === 'Confidential' || d.classification === 'Restricted') && <ClassificationBadge classification={d.classification} />}</span>
              <small className="muted">Updated {timeAgo(d.updatedAt)}</small>
            </Link>
          ))}{catalog.canCreate && <button className="dt-doc add" onClick={() => setCreating(true)}><Icon name="plus" /> New document</button>}</div>
        )
      )}
      {actions.modal}
      {aiNew && <AiDraftDialog projects={catalog.projects.filter((x): x is DtProject & { id: string } => !!x.id).map((x) => ({ id: x.id, name: x.name }))} projectId={p.id} useLabel="Create the page"
        onClose={() => setAiNew(false)} onUse={async (d, from) => { await newPage.create({ title: d.title, body: d.body, projectId: from.projectId ?? p.id }); setAiNew(false); }} />}
      {creating && <DocumentWizard projectId={p.id ?? undefined} onClose={() => setCreating(false)} onCreated={(doc) => navigate(`/documents/${doc}`)} />}
    </div>
  );
}

function Overview({ p, onTab, onSwagger }: { p: DtProject; onTab: (t: ProjectTab) => void; onSwagger: (definitionId?: string) => void }) {
  const nav = useDtNav();
  const weak = [...p.endpoints].filter((e) => e.score < 70).sort((a, b) => a.score - b.score).slice(0, 6);
  const methods = useMemo(() => { const m: Record<string, number> = {}; for (const e of p.endpoints) m[e.method] = (m[e.method] ?? 0) + 1; return Object.entries(m).sort((a, b) => b[1] - a[1]); }, [p.endpoints]);
  return (
    <div className="dt-ov">
      <div className="dt-kpis">
        <div className="dt-kpi ring"><ScoreRing score={avg(p.endpoints)} size={50} /><div><span className="dt-kpi-label">Documentation score</span><small>{p.endpoints.length ? 'average of all endpoints' : 'no endpoints yet'}</small></div></div>
        <Kpi icon="layers" label="APIs" value={p.definitions.length} />
        <Kpi icon="code" label="Endpoints" value={p.endpoints.length} hint={methods.map(([m, n]) => `${n} ${m}`).join(' · ') || undefined} />
        <Kpi icon="alert" label="Need work" value={p.endpoints.filter((e) => e.score < 70).length} tone={weak.length ? 'warn' : 'good'} />
        <Kpi icon="workflow" label="Diagrams" value={p.diagrams} />
        <Kpi icon="note" label="Documents" value={p.documents.filter((d) => !d.isApi).length} />
      </div>
      {p.definitions.length > 0 && (
        <section className="dt-card">
          <div className="dt-card-head"><h3>APIs</h3></div>
          <div className="dt-apis">{p.definitions.map((d) => {
            const eps = p.endpoints.filter((e) => e.definitionId === d.id);
            const stage = API_STAGES.findIndex((s) => s.id === d.stage);
            return (
              <div key={d.id} className="dt-api">
                <div className="dt-api-top"><b>{d.name}</b>{d.version && <span className="badge badge-neutral">{d.version}</span>}<span className={`dt-stage s-${d.stage.toLowerCase()}`}>{API_STAGES[stage]?.label ?? d.stage}</span></div>
                <div className="dt-stages" aria-label={`Stage ${stage + 1} of ${API_STAGES.length}`}>{API_STAGES.map((s, i) => <i key={s.id} className={i < stage ? 'done' : i === stage ? 'now' : ''} title={s.label} />)}</div>
                <dl><div><dt>Auth</dt><dd>{AUTH_LABEL[d.auth]}</dd></div><div><dt>Endpoints</dt><dd>{eps.length}</dd></div><div><dt>Score</dt><dd>{eps.length ? <ScoreBar score={avg(eps)} /> : '–'}</dd></div></dl>
                <div className="dt-api-actions"><button className="btn btn-ghost btn-sm" onClick={() => onTab('apis')}>Endpoints</button><button className="btn btn-ghost btn-sm" onClick={() => onSwagger(d.id)}><Icon name="code" size={13} /> Swagger</button><Link className="btn btn-ghost btn-sm" to={`/documents/${d.documentId}`}>Document</Link></div>
              </div>
            );
          })}</div>
        </section>
      )}
      <div className="dt-split">
        <section className="dt-card">
          <div className="dt-card-head"><h3>Needs work</h3><button className="link-btn" onClick={() => onTab('apis')}>All endpoints</button></div>
          {weak.length === 0 ? <p className="muted dt-pad">{p.endpoints.length ? 'Every endpoint scores 70 or more.' : 'Add or import endpoints to see their score.'}</p> : (
            <ul className="dt-weak">{weak.map((e) => <li key={e.id}><button type="button" onClick={() => nav.go({ p: pid(p), ep: e.id })}><Method m={e.method} /><code>{e.path}</code><ScoreBar score={e.score} /><small className="dt-weak-gaps">{e.gaps.slice(0, 3).join(' · ')}</small></button></li>)}</ul>
          )}
        </section>
        <section className="dt-card dt-arch-teaser">
          <div className="dt-card-head"><h3>Architecture</h3><button className="link-btn" onClick={() => onTab('architecture')}>{p.diagrams ? 'Open' : 'Draw one'}</button></div>
          <button type="button" className="dt-arch-cta" onClick={() => onTab('architecture')}>
            <Icon name="workflow" size={26} />
            <span>{p.diagrams ? `${p.diagrams} diagram${p.diagrams === 1 ? '' : 's'}: system architecture and request flows.` : 'Draw how the system fits together and how a request flows, in Architecture Studio.'}</span>
          </button>
        </section>
      </div>
    </div>
  );
}

function Apis({ p, canWrite, onNew, onImport }: { p: DtProject; canWrite: boolean; onNew: () => void; onImport: () => void }) {
  const nav = useDtNav();
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<'path' | 'score'>('path');
  const groups = useMemo(() => {
    const dq = q.trim().toLowerCase();
    const list = p.endpoints.filter((e) => !dq || `${e.method} ${e.path} ${e.summary}`.toLowerCase().includes(dq));
    const m = new Map<string, DtEndpoint[]>();
    for (const e of list) { const k = e.tag ?? ''; (m.get(k) ?? m.set(k, []).get(k)!).push(e); }
    for (const v of m.values()) v.sort((a, b) => (sort === 'score' ? a.score - b.score : a.path.localeCompare(b.path)));
    return [...m.entries()].sort((a, b) => (a[0] === '' ? 1 : b[0] === '' ? -1 : a[0].localeCompare(b[0])));
  }, [p.endpoints, q, sort]);
  if (p.endpoints.length === 0)
    return <EmptyState icon="code" title="No endpoints yet" text="Describe an endpoint by hand, or import an OpenAPI file, a Postman collection or cURL commands." action={canWrite ? <div className="api-empty-actions"><button className="btn btn-primary" onClick={onNew}><Icon name="plus" /> New endpoint</button><button className="btn btn-ghost" onClick={onImport}><Icon name="upload" /> Import</button></div> : undefined} />;
  return (
    <div className="dt-apis-list">
      <div className="dt-filter">
        <div className="doc-search"><Icon name="search" size={16} /><input className="input" type="search" placeholder="Filter by path or summary…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter endpoints" /></div>
        <div className="seg" role="radiogroup" aria-label="Sort"><button role="radio" aria-checked={sort === 'path'} className={sort === 'path' ? 'on' : ''} onClick={() => setSort('path')}>By path</button><button role="radio" aria-checked={sort === 'score'} className={sort === 'score' ? 'on' : ''} onClick={() => setSort('score')}>Weakest first</button></div>
      </div>
      {groups.map(([tag, eps]) => (
        <section key={tag} className="dt-card">
          <div className="dt-card-head"><h3><Icon name="tag" size={13} /> {tag || 'Ungrouped'}</h3><span className="muted">{eps.length}</span></div>
          <ul className="dt-eps">{eps.map((e) => (
            <li key={e.id}><button type="button" className={e.deprecated ? 'dep' : ''} onClick={() => nav.go({ p: pid(p), ep: e.id })}>
              <Method m={e.method} /><code>{e.path}</code><span className="dt-eps-sum">{e.summary || <i className="muted">No summary</i>}</span>
              {e.deprecated && <span className="badge badge-warning">Deprecated</span>}<ScoreBar score={e.score} />
            </button></li>
          ))}</ul>
        </section>
      ))}
    </div>
  );
}
