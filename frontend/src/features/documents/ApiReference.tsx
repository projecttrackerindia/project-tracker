import { useMemo, useState } from 'react';
import { useInfiniteQuery, useMutation } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { apiDocApi, documentApi } from '../../api/endpoints';
import type { ApiDefinition, ApiMethod, DocumentDetail, EndpointDetail, EndpointItem } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Select } from '../../components/Select';
import { EmptyState, ErrorState, PageLoader } from '../../components/ui';
import { invalidateWorkspace, useDebounced, useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
import { ChangesModal, DefinitionModal, ImportModal, AUTH_LABEL } from './ApiTools';
import { EndpointEditor, METHODS } from './ApiEndpointEditor';

export const Method = ({ m }: { m: string }) => <span className={`mth mth-${m.toLowerCase()}`}>{m}</span>;

function Block({ label, text }: { label: string; text: string | null }) {
  if (!text) return null;
  let shown = text;
  try { shown = JSON.stringify(JSON.parse(text), null, 2); } catch { /* shown as written */ }
  return <div className="apr-block"><span className="apr-lab">{label}</span><pre>{shown}</pre></div>;
}

function Detail({ ep, definition, canEdit, onEdit, onDelete }: { ep: EndpointDetail; definition: ApiDefinition | undefined; canEdit: boolean; onEdit: () => void; onDelete: () => void }) {
  const { item: i, details: d } = ep;
  const auth = d.auth === 'inherit' ? (definition ? AUTH_LABEL[definition.auth] : '') : d.auth === 'none' ? 'Open: no authentication' : AUTH_LABEL[d.auth as keyof typeof AUTH_LABEL] ?? d.auth;
  const server = definition?.servers[0];
  return (
    <article className="apr">
      <header className="apr-head">
        <div className="apr-title"><Method m={i.method} /><code>{i.path}</code>{i.deprecated && <span className="badge badge-warning">Deprecated</span>}</div>
        {canEdit && !ep.readOnly && <div className="apr-actions"><button className="btn btn-ghost btn-sm" onClick={onEdit}><Icon name="edit" size={14} /> Edit</button><button className="btn-icon" aria-label="Delete endpoint" onClick={onDelete}><Icon name="trash" size={14} /></button></div>}
      </header>
      {i.summary && <p className="apr-sum">{i.summary}</p>}
      <div className="apr-meta">
        <span>{i.definition}{definition?.version ? ` · ${definition.version}` : ''}</span>{i.tag && <span>Group: {i.tag}</span>}<span><Icon name="lock" size={12} /> {auth}</span>{i.owner && <span>Owner: {i.owner.name}</span>}
        {server && <span className="apr-server" title="Server">{server}{definition?.basePath ?? ''}{i.path}</span>}
      </div>
      {d.description && <p className="apr-desc">{d.description}</p>}

      {d.parameters.length > 0 && (
        <section><h4>Parameters</h4>
          <div className="table-wrap"><table className="table apr-table"><thead><tr><th>Name</th><th>In</th><th>Type</th><th>Required</th><th>Description</th></tr></thead>
            <tbody>{d.parameters.map((p, n) => <tr key={n}><td><code>{p.name}</code></td><td>{p.in}</td><td>{p.type ?? '–'}</td><td>{p.required ? 'Yes' : 'No'}</td><td>{p.description ?? ''}{p.example ? <small className="muted"> e.g. <code>{p.example}</code></small> : null}</td></tr>)}</tbody></table></div>
        </section>
      )}
      {d.requestBody && (
        <section><h4>Request body <small className="muted">{d.requestBody.contentType}{d.requestBody.required ? ' · required' : ''}</small></h4>
          {d.requestBody.description && <p>{d.requestBody.description}</p>}<Block label="Schema" text={d.requestBody.schema} /><Block label="Example" text={d.requestBody.example} /></section>
      )}
      {d.responses.length > 0 && (
        <section><h4>Responses</h4>
          {d.responses.map((r, n) => (
            <div className="apr-resp" key={n}>
              <div className="apr-resp-head"><span className={`apr-status s${r.status[0]}`}>{r.status}</span><span>{r.description}</span>{r.contentType && <small className="muted">{r.contentType}</small>}</div>
              <Block label="Schema" text={r.schema} /><Block label="Example" text={r.example} />
            </div>
          ))}
        </section>
      )}
      {d.errors.length > 0 && (
        <section><h4>Errors</h4>
          <div className="table-wrap"><table className="table apr-table"><thead><tr><th>Code</th><th>Message</th><th>When</th></tr></thead>
            <tbody>{d.errors.map((e, n) => <tr key={n}><td><code>{e.code}</code></td><td>{e.message ?? ''}</td><td>{e.description ?? ''}</td></tr>)}</tbody></table></div>
        </section>
      )}
      {d.samples.length > 0 && <section><h4>Samples</h4>{d.samples.map((s, n) => (
        <div className="apr-block" key={n}><span className="apr-lab">{s.title} · {s.language}<button className="link-btn" onClick={() => { void navigator.clipboard?.writeText(s.code); toast('Copied.'); }}>Copy</button></span><pre>{s.code}</pre></div>
      ))}</section>}
      {d.dependencies.length > 0 && <section><h4>Depends on</h4><ul className="apr-deps">{d.dependencies.map((x, n) => <li key={n}><b>{x.name}</b>{x.note ? <span className="muted"> · {x.note}</span> : null}</li>)}</ul></section>}
    </article>
  );
}

/** The API reference of a document: its APIs on the left, endpoints grouped under them (a page at a time), the chosen endpoint on the right. */
export function ApiReference({ detail, editable }: { detail: DocumentDetail; editable: boolean }) {
  const wid = useWorkspaceId();
  const id = detail.item.id;
  const [versionId, setVersionId] = useState('');
  const [defId, setDefId] = useState('');
  const [q, setQ] = useState('');
  const [method, setMethod] = useState('');
  const [epId, setEpId] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [modal, setModal] = useState<null | 'def' | 'editDef' | 'import' | 'changes' | 'endpoint' | 'editEndpoint'>(null);
  const dq = useDebounced(q.trim(), 250);

  const versions = useWsQuery(['documents', id, 'versions'], () => documentApi.versions(id));
  const overview = useWsQuery(['documents', id, 'api', versionId], () => apiDocApi.overview(id, versionId || null));
  const o = overview.data;
  const live = o?.live ?? true;
  const canEdit = !!o?.canEdit && live && editable;
  const defs = o?.definitions ?? [];
  const def = defs.find((d) => d.id === defId) ?? defs[0];
  const published = (versions.data?.items ?? []).filter((v) => !v.isDraft);

  const list = useInfiniteQuery({
    queryKey: [wid, 'documents', id, 'api-endpoints', def?.id, dq, method, versionId],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => apiDocApi.endpoints(id, { definitionId: def!.id, q: dq || undefined, method: method || undefined, versionId: versionId || null, cursor: pageParam, limit: 100 }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: !!wid && !!def,
  });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const total = list.data?.pages[0]?.total ?? null;
  const groups = useMemo(() => {
    const m = new Map<string, EndpointItem[]>();
    for (const it of items) { const k = it.tag ?? ''; (m.get(k) ?? m.set(k, []).get(k)!).push(it); }
    return [...m.entries()].sort((a, b) => (a[0] === '' ? 1 : b[0] === '' ? -1 : a[0].localeCompare(b[0])));
  }, [items]);
  const ep = useWsQuery(['documents', id, 'api-endpoint', epId, versionId], () => apiDocApi.endpoint(id, epId, versionId || null), { enabled: !!epId });

  const refresh = () => invalidateWorkspace(wid, 'documents');
  const removeEp = useMutation({
    mutationFn: () => apiDocApi.removeEndpoint(id, epId),
    onSuccess: () => { setEpId(''); refresh(); toast('Endpoint removed.', 'warning'); },
    onError: (e) => toast(e instanceof ApiError ? e.message : 'Could not remove it.', 'error'),
  });
  const removeDef = useMutation({
    mutationFn: (d: ApiDefinition) => apiDocApi.removeDefinition(id, d.id),
    onSuccess: () => { setDefId(''); setEpId(''); refresh(); toast('API removed.', 'warning'); },
    onError: (e) => toast(e instanceof ApiError ? e.message : 'Could not remove it.', 'error'),
  });
  const exportFile = (format: 'openapi' | 'postman') => def && apiDocApi.export(id, format, def.id, versionId || null, `${def.name.replace(/[^\w.-]+/g, '-')}.${format === 'openapi' ? 'openapi' : 'postman_collection'}.json`).catch((e) => toast(e instanceof ApiError ? e.message : 'Could not export.', 'error'));

  if (overview.isLoading) return <PageLoader />;
  if (overview.isError || !o) return <ErrorState error={overview.error} retry={() => overview.refetch()} />;

  const overLimit = o.limit >= 0 && o.used >= o.limit;
  return (
    <div className="api">
      <div className="api-bar">
        <div className="api-bar-main">
          {published.length > 0 && (
            <Select className="select" value={versionId} onChange={(e) => { setVersionId(e.target.value); setEpId(''); }} aria-label="Version to read">
              {editable && <option value="">Working copy</option>}{!editable && <option value="">Latest published</option>}
              {published.map((v) => <option key={v.id} value={v.id}>Version {v.label}</option>)}
            </Select>
          )}
          <div className="doc-search"><Icon name="search" size={16} /><input className="input" type="search" placeholder="Find a path, summary or group…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find an endpoint" /></div>
          <Select className="select" value={method} onChange={(e) => setMethod(e.target.value)} aria-label="Method"><option value="">Any method</option>{METHODS.map((m) => <option key={m} value={m}>{m}</option>)}</Select>
        </div>
        <div className="api-bar-actions">
          {defs.length > 0 && <button className="btn btn-ghost" onClick={() => setModal('changes')}><Icon name="layers" size={15} /> API changes</button>}
          {def && <><button className="btn btn-ghost" onClick={() => exportFile('openapi')}><Icon name="download" size={15} /> OpenAPI</button><button className="btn btn-ghost" onClick={() => exportFile('postman')}><Icon name="download" size={15} /> Postman</button></>}
          {canEdit && <><button className="btn btn-ghost" onClick={() => setModal('import')}><Icon name="upload" size={15} /> Import</button><button className="btn btn-primary" onClick={() => setModal(def ? 'endpoint' : 'def')}><Icon name="plus" size={15} /> {def ? 'Endpoint' : 'Describe an API'}</button></>}
        </div>
      </div>
      {!live && <div className="doc-alert info"><Icon name="info" size={16} /><div>You are reading version {o.reading}. It cannot be changed.</div></div>}
      {canEdit && o.limit >= 0 && <p className={`muted api-limit${overLimit ? ' over' : ''}`}>{o.used.toLocaleString()} of {o.limit.toLocaleString()} endpoints used in this workspace.{overLimit ? ' Upgrade the plan to document more.' : ''}</p>}

      {defs.length === 0 ? (
        <EmptyState icon="git" title="No API described yet" text={canEdit ? 'Describe an API by hand, or import an OpenAPI or Postman file and edit from there.' : 'The owner has not described an API in this document yet.'}
          action={canEdit ? <div className="api-empty-actions"><button className="btn btn-primary" onClick={() => setModal('def')}><Icon name="plus" /> Describe an API</button><button className="btn btn-ghost" onClick={() => setModal('import')}><Icon name="upload" /> Import a file</button></div> : undefined} />
      ) : (
        <div className="api-body">
          <aside className="api-tree" aria-label="APIs and endpoints">
            <ul className="api-defs">{defs.map((d) => (
              <li key={d.id}><button className={`api-def${d.id === def?.id ? ' on' : ''}`} onClick={() => { setDefId(d.id); setEpId(''); }}><b>{d.name}</b><span>{d.version ?? ''}</span><i>{d.endpoints.toLocaleString()}</i></button></li>
            ))}{canEdit && <li><button className="api-def add" onClick={() => setModal('def')}><Icon name="plus" size={13} /> Another API</button></li>}</ul>
            {def && (
              <div className="api-eps">
                <div className="api-eps-head"><span className="muted">{total !== null ? `${items.length.toLocaleString()} of ${total.toLocaleString()}` : `${items.length} shown`}</span>
                  {canEdit && <span className="api-def-tools"><button className="btn-icon sm" aria-label="Edit this API" onClick={() => setModal('editDef')}><Icon name="edit" size={13} /></button>
                    <button className="btn-icon sm" aria-label="Remove this API" onClick={async () => { if (await confirmDialog({ title: `Remove ${def.name}?`, message: `Its ${def.endpoints.toLocaleString()} endpoint${def.endpoints === 1 ? '' : 's'} go with it. Published versions keep their copy.`, confirmText: 'Remove' })) removeDef.mutate(def); }}><Icon name="trash" size={13} /></button></span>}
                </div>
                {list.isLoading ? <PageLoader /> : list.isError ? <ErrorState error={list.error} retry={() => list.refetch()} /> : items.length === 0 ? <p className="muted api-none">{dq || method ? 'Nothing matches.' : 'No endpoints yet.'}</p> : (
                  <>
                    {groups.map(([tag, eps]) => (
                      <div className="api-group" key={tag}>
                        <button className="api-group-head" aria-expanded={!collapsed.has(tag)} onClick={() => setCollapsed((s) => { const n = new Set(s); n.has(tag) ? n.delete(tag) : n.add(tag); return n; })}>
                          <Icon name={collapsed.has(tag) ? 'chevronR' : 'chevronD'} size={13} /> {tag || 'Ungrouped'} <i>{eps.length}</i></button>
                        {!collapsed.has(tag) && <ul>{eps.map((e) => (
                          <li key={e.id}><button className={`api-ep${e.id === epId ? ' on' : ''}${e.deprecated ? ' dep' : ''}`} onClick={() => setEpId(e.id)} title={e.summary}><Method m={e.method} /><code>{e.path}</code></button></li>
                        ))}</ul>}
                      </div>
                    ))}
                    {list.hasNextPage && <button className="btn btn-ghost btn-sm api-more" disabled={list.isFetchingNextPage} onClick={() => list.fetchNextPage()}>{list.isFetchingNextPage ? 'Loading…' : 'Show more'}</button>}
                  </>
                )}
              </div>
            )}
          </aside>
          <section className="api-main">
            {epId && ep.isLoading ? <PageLoader /> : epId && ep.data ? (
              <Detail ep={ep.data} definition={defs.find((d) => d.id === ep.data!.item.definitionId)} canEdit={canEdit} onEdit={() => setModal('editEndpoint')}
                onDelete={async () => { if (await confirmDialog({ title: 'Remove this endpoint?', message: `${ep.data!.item.method} ${ep.data!.item.path} is removed from the working copy. Published versions keep it.`, confirmText: 'Remove' })) removeEp.mutate(); }} />
            ) : def ? (
              <div className="api-def-card">
                <h3>{def.name}{def.version && <span className="badge badge-neutral">{def.version}</span>}</h3>
                {def.description && <p>{def.description}</p>}
                <dl className="doc-facts">
                  <div><dt>Authentication</dt><dd>{AUTH_LABEL[def.auth]}</dd></div>
                  {def.basePath && <div><dt>Base path</dt><dd><code>{def.basePath}</code></dd></div>}
                  {def.servers.length > 0 && <div><dt>Servers</dt><dd>{def.servers.map((s) => <code key={s} className="api-srv">{s}</code>)}</dd></div>}
                  <div><dt>Endpoints</dt><dd>{def.endpoints.toLocaleString()}</dd></div>
                </dl>
                {def.authNote && <p className="muted">{def.authNote}</p>}
                <p className="muted">Choose an endpoint on the left to read it.</p>
              </div>
            ) : null}
          </section>
        </div>
      )}

      {modal === 'def' && <DefinitionModal documentId={id} existing={null} onClose={() => setModal(null)} onSaved={(r) => { setDefId(r.definitions[r.definitions.length - 1]?.id ?? ''); setModal(null); }} />}
      {modal === 'editDef' && def && <DefinitionModal documentId={id} existing={def} onClose={() => setModal(null)} onSaved={() => setModal(null)} />}
      {modal === 'import' && <ImportModal documentId={id} definitions={defs} onClose={() => setModal(null)} onDone={(r) => { if (r) setDefId(r.definitions[r.definitions.length - 1]?.id ?? def?.id ?? ''); }} />}
      {modal === 'changes' && <ChangesModal documentId={id} canEdit={editable} onClose={() => setModal(null)} />}
      {modal === 'endpoint' && def && <EndpointEditor documentId={id} definitions={defs} existing={null} startDefinition={def.id} onClose={() => setModal(null)} onSaved={(r) => { setEpId(r.item.id); setModal(null); }} />}
      {modal === 'editEndpoint' && def && ep.data && <EndpointEditor documentId={id} definitions={defs} existing={ep.data} startDefinition={def.id} onClose={() => setModal(null)} onSaved={() => setModal(null)} />}
    </div>
  );
}

export type { ApiMethod };
