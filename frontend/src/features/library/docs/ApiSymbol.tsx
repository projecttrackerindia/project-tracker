import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { useEffect, useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError } from '../../../api/client';
import { apiDocApi } from '../../../api/endpoints';
import { API_STAGES, type ApiDefinition, type ApiParam, type DtEndpoint, type DtProject, type EndpointDetail, type LiveCheck } from '../../../api/types';
import { Icon } from '../../../components/Icon';
import { ErrorState, PageLoader } from '../../../components/ui';
import { invalidateWorkspace, useWsQuery } from '../../../lib/hooks';
import { useWorkspaceId } from '../../../stores/auth';
import { confirmDialog, toast } from '../../../stores/ui';
import { EndpointEditor } from '../../documents/ApiEndpointEditor';
import { AUTH_LABEL } from '../../documents/ApiTools';
import { mask, schemaRows } from '../../documents/ApiView';
import { DiagramFigure } from '../../documents/DiagramPreviews';
import { LinkedWork } from '../../documents/LinkedWork';
import { docsPath, envLabels } from './nav';
import { Reading } from './Reading';
import { HealthRing, MethodPill, PopMenu, RevealSheet, SwaggerSheet } from './shared';
import { docFresh, DriftPill, FreshPill } from './Fresh';
import { timeAgo } from '../../../lib/format';

const pretty = (text: string | null | undefined) => { if (!text) return ''; try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; } };
const joinUrl = (base: string, basePath: string | null, path: string) => `${base.replace(/\/$/, '')}${(basePath ?? '').replace(/\/$/, '')}${path.startsWith('/') ? '' : '/'}${path}`;

/** A cURL for the chosen environment, with values filled in where given; credentials keep their shape and hide the rest. */
export function buildCurl(def: ApiDefinition | undefined, ep: EndpointDetail, base: string, values: Record<string, string> = {}, body?: string): string {
  const { item: i, details: d } = ep;
  let path = i.path;
  for (const p of d.parameters.filter((x) => x.in === 'path')) if (values[`path:${p.name}`]) path = path.replace(`{${p.name}}`, encodeURIComponent(values[`path:${p.name}`]));
  const query = d.parameters.filter((x) => x.in === 'query' && values[`query:${x.name}`]).map((x) => `${encodeURIComponent(x.name)}=${encodeURIComponent(values[`query:${x.name}`])}`).join('&');
  const lines = [`curl --request ${i.method} "${joinUrl(base, def?.basePath ?? null, path)}${query ? `?${query}` : ''}"`];
  const headers = d.parameters.filter((x) => x.in === 'header');
  const auth = d.auth === 'inherit' ? def?.auth : d.auth;
  if ((auth === 'Bearer' || auth === 'OAuth2') && !headers.some((h) => /^authorization$/i.test(h.name))) lines.push('  --header "Authorization: Bearer <token>"');
  else if (auth === 'Basic' && !headers.some((h) => /^authorization$/i.test(h.name))) lines.push('  --user "<user>:<password>"');
  else if (auth === 'ApiKey' && !headers.some((h) => /key/i.test(h.name))) lines.push('  --header "X-API-Key: <key>"');
  if (d.requestBody?.contentType && !headers.some((h) => /^content-type$/i.test(h.name))) lines.push(`  --header "Content-Type: ${d.requestBody.contentType}"`);
  for (const h of headers) lines.push(`  --header "${h.name}: ${mask(h.name, values[`header:${h.name}`] || h.example || `<${h.name.toLowerCase()}>`)}"`);
  const b = body ?? d.requestBody?.example ?? '';
  if (b.trim()) lines.push(`  --data-raw '${pretty(b)}'`);
  return lines.join(' \\\n');
}

function CodeTabs({ tabs, label }: { tabs: { id: string; label: string; code: string; hint?: string }[]; label: string }) {
  const still = useReducedMotion();
  const [on, setOn] = useState(tabs[0]?.id ?? '');
  const cur = tabs.find((t) => t.id === on) ?? tabs[0];
  if (!cur) return null;
  return (
    <div className="dx-code" data-testid={`code-${label.toLowerCase().replace(/\s+/g, '-')}`}>
      <div className="dx-code-bar">
        <div className="dx-code-tabs" role="tablist" aria-label={label}>
          {tabs.map((t) => <button key={t.id} type="button" role="tab" aria-selected={t.id === cur.id} onClick={() => setOn(t.id)}>{t.label}</button>)}
        </div>
        {cur.hint && <span className="dx-code-hint">{cur.hint}</span>}
        <button type="button" className="dx-code-copy" onClick={() => { void navigator.clipboard?.writeText(cur.code).then(() => toast('Copied.'), () => toast('Could not copy.', 'error')); }}><Icon name="copy" size={12} /> Copy</button>
      </div>
      <AnimatePresence initial={false} mode="wait">
        <motion.pre key={cur.id} initial={still ? false : { opacity: 0 }} animate={{ opacity: 1 }} exit={still ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0 }} transition={{ duration: still ? 0 : 0.16 }}>{cur.code}</motion.pre>
      </AnimatePresence>
    </div>
  );
}

/** Body fields from an example when no schema is written: names and types, nested as a.b and a[].b. */
function rowsFromExample(example: string | null | undefined) {
  const rows: { name: string; required: boolean; type: string; description: string; example: string }[] = [];
  let v: unknown; try { v = example ? JSON.parse(example) : undefined; } catch { return rows; }
  const typeOf = (x: unknown) => (Array.isArray(x) ? 'Array' : x === null ? 'Null' : typeof x === 'number' ? 'Number' : typeof x === 'boolean' ? 'Boolean' : typeof x === 'object' ? 'Object' : 'String');
  const walk = (o: unknown, prefix: string, depth: number) => {
    if (depth > 3 || rows.length > 200) return;
    if (Array.isArray(o)) { if (o.length) walk(o[0], `${prefix}[]`, depth + 1); return; }
    if (!o || typeof o !== 'object') return;
    for (const [k, x] of Object.entries(o)) {
      const name = prefix ? `${prefix}.${k}` : k;
      rows.push({ name, required: false, type: typeOf(x), description: '', example: x !== null && typeof x !== 'object' ? mask(k, String(x)) : '' });
      walk(x, name, depth + 1);
    }
  };
  walk(v, '', 0);
  return rows;
}

const IN_LABEL: Record<string, string> = { path: 'Path', query: 'Query', header: 'Header', cookie: 'Cookie', body: 'Body' };

/**
 * One endpoint as an API symbol page: its declaration, parameters, examples (cURL · JSON · DataWeave), the environment it is called on,
 * Try it, the status codes and what it relates to. Masked values stay masked until an audited reveal; editing works on the real values.
 */
export function ApiSymbol({ project: p, endpoint: e }: { project: DtProject; endpoint: DtEndpoint }) {
  const wid = useWorkspaceId();
  const navigate = useNavigate();
  const doc = e.documentId;
  const q = useWsQuery(['documents', doc, 'api-endpoint', e.id, ''], () => apiDocApi.endpoint(doc, e.id));
  const overview = useWsQuery(['documents', doc, 'api', ''], () => apiDocApi.overview(doc));
  const [shown, setShown] = useState<EndpointDetail | null>(null);
  const [left, setLeft] = useState(0);
  const [asking, setAsking] = useState(false);
  const [editing, setEditing] = useState<EndpointDetail | null>(null);
  const [json, setJson] = useState(false);
  const [swagger, setSwagger] = useState(false);
  const [env, setEnv] = useState(0);
  useEffect(() => { setShown(null); setLeft(0); setEditing(null); setJson(false); }, [e.id]);
  useEffect(() => {
    if (!shown || left <= 0) return;
    const t = setTimeout(() => { if (left <= 1) { setShown(null); toast('Masked again.'); } setLeft((s) => s - 1); }, 1000);
    return () => clearTimeout(t);
  }, [shown, left]);
  const remove = useMutation({
    mutationFn: () => apiDocApi.removeEndpoint(doc, e.id),
    onSuccess: () => { invalidateWorkspace(wid, 'documents'); toast('Endpoint removed.', 'warning'); navigate(docsPath.apiIndex(p.id)); },
    onError: (err) => toast(err instanceof ApiError ? err.message : 'Could not remove it.', 'error'),
  });
  const startEdit = async () => {
    try { setEditing(await apiDocApi.revealEndpoint(doc, e.id, { purpose: 'edit' })); }
    catch (err) { toast(err instanceof ApiError ? err.message : 'Could not open it for editing.', 'error'); }
  };
  const data = shown ?? q.data;
  const defs = useMemo(() => overview.data?.definitions ?? [], [overview.data]);
  const def = data ? defs.find((x) => x.id === data.item.definitionId) : undefined;
  const envs = useMemo(() => envLabels(def?.servers?.length ? def.servers : ['https://api.example.com']), [def]);
  const base = envs[Math.min(env, envs.length - 1)]?.url ?? '';
  const canEdit = !!overview.data?.canEdit && !!overview.data?.live && !data?.readOnly;
  const masked = q.data?.maskedCount ?? 0;
  const related = p.endpoints.filter((x) => x.id !== e.id && (x.tag ?? '') === (e.tag ?? '')).slice(0, 6);

  const title = data?.item.summary || `${e.method} ${e.path}`;
  // Freshness of the API document this endpoint lives in, and the last live check (this page's copy is newer than the catalog's).
  const [checked, setChecked] = useState<LiveCheck | null>(null);
  useEffect(() => { setChecked(null); }, [e.id]);
  const live = checked ?? q.data?.liveCheck ?? null;
  const drift = live ? { differs: live.differs, env: live.env, checkedAt: live.checkedAt, missing: live.fields.filter((f) => f.kind === 'missing').length, extra: live.fields.filter((f) => f.kind === 'extra').length, changed: live.fields.filter((f) => f.kind === 'type').length } : e.drift;
  const fresh = <><FreshPill state={docFresh(p.documents.find((x) => x.id === doc))} /><DriftPill drift={drift} /></>;
  const tools = (
    <>
      {overview.data && <span className={`dx-live${overview.data.live ? ' on' : ''}`} title={overview.data.live ? 'Showing the working copy' : `Reading ${overview.data.reading}`}>{overview.data.live ? 'Live' : overview.data.reading}</span>}
      {canEdit && <button type="button" className="dx-btn" onClick={() => void startEdit()}><Icon name="edit" size={13} /> Edit</button>}
      <PopMenu label="···" items={[
        { label: json ? 'Reference view' : 'Raw JSON', hint: 'The endpoint as data', icon: 'code', onSelect: () => setJson((j) => !j) },
        { label: 'Open in Swagger', hint: 'Read-only', icon: 'layers', onSelect: () => setSwagger(true), hidden: !def },
        { label: 'Open the API document', icon: 'note', onSelect: () => navigate(docsPath.guide(p.id, doc)) },
        { label: 'Delete endpoint', icon: 'trash', danger: true, hidden: !canEdit, onSelect: async () => { if (await confirmDialog({ title: 'Remove this endpoint?', message: `${e.method} ${e.path} is removed from the working copy. Published versions keep it.`, confirmText: 'Remove' })) remove.mutate(); } },
      ]} />
    </>
  );

  if (q.isLoading) return <Reading p={p} title={e.path} fresh={fresh}><PageLoader /></Reading>;
  if (q.isError || !data) return <Reading p={p} title={e.path} fresh={fresh}><ErrorState error={q.error} retry={() => void q.refetch()} /></Reading>;
  const d = data.details;
  const auth = d.auth === 'inherit' ? (def ? AUTH_LABEL[def.auth] : '') : d.auth === 'none' ? 'No authentication' : AUTH_LABEL[d.auth as keyof typeof AUTH_LABEL] ?? d.auth;
  const fromSchema = schemaRows(d.requestBody?.schema ?? null, d.requestBody?.example ?? null);
  const bodyRows = fromSchema.length ? fromSchema : rowsFromExample(d.requestBody?.example);
  const params: (ApiParam | { name: string; in: 'body'; required: boolean; type: string; description: string; example: string })[] = [
    ...['path', 'query', 'header', 'cookie'].flatMap((k) => d.parameters.filter((x) => x.in === k)),
    ...bodyRows.map((r) => ({ name: r.name, in: 'body' as const, required: r.required, type: r.type, description: r.description, example: r.example })),
  ];
  const dw = d.samples.filter((s) => /dataweave|dwl/i.test(`${s.language} ${s.title}`));
  const others = d.samples.filter((s) => !dw.includes(s));
  const requestTabs = [
    { id: 'curl', label: 'cURL', code: buildCurl(def, data, base), hint: shown ? 'real values' : 'credentials masked' },
    ...(d.requestBody?.example || d.requestBody?.schema ? [{ id: 'json', label: 'JSON', code: pretty(d.requestBody.example || d.requestBody.schema) }] : []),
    ...dw.map((s, i) => ({ id: `dw${i}`, label: dw.length > 1 ? `DataWeave · ${s.title}` : 'DataWeave', code: s.code })),
    ...others.map((s, i) => ({ id: `s${i}`, label: s.title || s.language, code: s.code, hint: s.language })),
  ];
  const responseTabs = d.responses.filter((r) => r.example || r.schema).map((r) => ({ id: r.status, label: r.status, code: pretty(r.example || r.schema), hint: r.contentType ?? undefined }));

  return (
    <Reading p={p} title={title} tools={tools} fresh={fresh}>
      <header className="dx-sym dx-reveal" data-testid="api-symbol">
        <p className="dx-eyebrow">{[e.definition, e.tag].filter(Boolean).join(' · ')}</p>
        <h1 className="dx-title">{title}</h1>
        <div className="dx-sym-path"><MethodPill m={data.item.method} size="lg" /><code>{data.item.path}</code>{data.item.deprecated && <span className="dx-tag warn">Deprecated</span>}</div>
        {d.description && <p className="dx-lede">{d.description}</p>}
        <div className="dx-chips">
          {auth && <span><Icon name="lock" size={11} /> {auth}</span>}
          {d.requestBody?.contentType && <span>{d.requestBody.contentType}</span>}
          {def && <span>{API_STAGES.find((s) => s.id === def.stage)?.label ?? def.stage}</span>}
          {def?.version && <span>v{def.version.replace(/^v/i, '')}</span>}
          {data.item.owner && <span>Owner: {data.item.owner.name}</span>}
        </div>
      </header>

      {masked > 0 && (
        <div className={`dx-mask${shown ? ' open' : ''}`} role="status">
          <Icon name={shown ? 'eye' : 'lock'} size={15} />
          {shown ? <span><b>Showing real values</b> · masked again in {left}s</span> : <span><b>{masked} value{masked === 1 ? '' : 's'} masked</b> · mobile numbers, IDs, account numbers and credentials are hidden</span>}
          {shown ? <button type="button" className="dx-btn sm" onClick={() => { setShown(null); setLeft(0); }}>Hide now</button>
            : q.data?.canReveal && <button type="button" className="dx-btn sm" onClick={() => setAsking(true)}>Reveal</button>}
        </div>
      )}

      {json ? (
        <section data-outline="JSON"><CodeTabs label="Raw" tabs={[{ id: 'raw', label: 'JSON', code: JSON.stringify({ method: data.item.method, path: data.item.path, summary: data.item.summary, tag: data.item.tag, deprecated: data.item.deprecated, ...d }, null, 2), hint: shown ? 'real values' : 'masked' }]} /></section>
      ) : <>
        <section className="dx-reveal" data-outline="Declaration">
          <div className="dx-sect-h"><h2 className="dx-h2">Declaration</h2>
            {envs.length > 0 && <div className="dx-seg" role="radiogroup" aria-label="Environment" data-testid="env-switch">{envs.map((x, i) => <button key={x.url} type="button" role="radio" aria-checked={i === env} title={x.url} onClick={() => setEnv(i)}>{x.label}</button>)}</div>}
          </div>
          <pre className="dx-decl"><span className={`k m-${data.item.method.toLowerCase()}`}>{data.item.method}</span> <span className="u">{joinUrl(base, def?.basePath ?? null, data.item.path)}</span></pre>
        </section>

        {params.length > 0 && (
          <section className="dx-reveal" data-outline="Parameters">
            <h2 className="dx-h2">Parameters</h2>
            <dl className="dx-params" data-testid="params">
              {params.map((x, n) => (
                <div key={`${x.in}:${x.name}:${n}`} className="dx-param">
                  <dt><code>{x.name}</code><span className="dx-in">{IN_LABEL[x.in] ?? x.in}</span><span className="dx-type">{x.type ?? 'String'}</span>{x.required && <span className="dx-req">Required</span>}</dt>
                  <dd>{x.description || <span className="dx-note">No description.</span>}{x.example && <small> Example: <code>{mask(x.name, x.example)}</code></small>}</dd>
                </div>
              ))}
            </dl>
          </section>
        )}

        {d.flow && <section className="dx-reveal" data-outline="Request flow"><h2 className="dx-h2">Request flow</h2><DiagramFigure source={d.flow} /></section>}

        <section className="dx-reveal" data-outline="Request"><h2 className="dx-h2">Request</h2><CodeTabs label="Request examples" tabs={requestTabs} /></section>
        {responseTabs.length > 0 && <section className="dx-reveal" data-outline="Response"><h2 className="dx-h2">Response</h2><CodeTabs label="Response examples" tabs={responseTabs} /></section>}

        <TryIt def={def} ep={data} base={base} envLabel={envs[Math.min(env, envs.length - 1)]?.label ?? ''} />

        <LiveCheckSection doc={doc} ep={data} live={live} canRun={canEdit} env={Math.min(env, envs.length - 1)} envLabel={envs[Math.min(env, envs.length - 1)]?.label ?? ''} hasServers={!!def?.servers?.length}
          onDone={(r) => { setChecked(r); invalidateWorkspace(wid, 'documents'); }} />

        {(d.responses.length > 0 || d.errors.length > 0) && (
          <section className="dx-reveal" data-outline="Status codes">
            <h2 className="dx-h2">Status codes</h2>
            <ul className="dx-codes">
              {d.responses.map((r, n) => <li key={`r${n}`}><span className={`dx-sc s${r.status[0]}`}>{r.status}</span><span>{r.description || 'Response'}</span>{r.contentType && <small>{r.contentType}</small>}</li>)}
              {d.errors.map((x, n) => <li key={`e${n}`}><span className={`dx-sc s${/^\d/.test(x.code) ? x.code[0] : '4'}`}>{x.code}</span><span>{x.message ?? ''}{x.description && <small> · {x.description}</small>}</span></li>)}
            </ul>
          </section>
        )}
      </>}

      <section className="dx-reveal" data-outline="Health">
        <h2 className="dx-h2">Documentation health</h2>
        <div className="dx-health"><HealthRing score={e.score} size={56} />
          <div>{e.gaps.length ? <ul>{e.gaps.map((g) => <li key={g}>{g}</li>)}</ul> : <p className="dx-note">Complete. Nothing to add.</p>}
            {canEdit && e.gaps.length > 0 && <button type="button" className="dx-btn sm" onClick={() => void startEdit()}>Fill the gaps</button>}</div>
        </div>
      </section>

      <section className="dx-reveal" data-outline="Relationships">
        <h2 className="dx-h2">Relationships</h2>
        {related.length > 0 && <><h3 className="dx-h3">Related endpoints</h3><ul className="dx-list">{related.map((x) => <li key={x.id}><Link className="dx-li" to={docsPath.endpoint(p.id, x.id)}><MethodPill m={x.method} /><code>{x.path}</code><span className="dx-li-proj">{x.summary}</span></Link></li>)}</ul></>}
        {d.dependencies.length > 0 && <><h3 className="dx-h3">Depends on</h3><ul className="dx-deps">{d.dependencies.map((x, n) => <li key={n}><b>{x.name}</b>{x.note && <span className="dx-note"> · {x.note}</span>}</li>)}</ul></>}
        <h3 className="dx-h3">Documents and work</h3>
        <p className="dx-note">Described in <Link to={docsPath.guide(p.id, doc)}>the API document</Link>.</p>
        <div className="dx-linked"><LinkedWork documentId={doc} canLink={false} /></div>
      </section>

      {asking && <RevealSheet onClose={() => setAsking(false)} onReveal={async (reason) => {
        const r = await apiDocApi.revealEndpoint(doc, e.id, { purpose: 'read', reason });
        setShown(r); setLeft(r.revealSeconds || 15); setAsking(false);
      }} />}
      {editing && defs.length > 0 && <EndpointEditor documentId={doc} definitions={defs} existing={editing} startDefinition={editing.item.definitionId} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); setShown(null); invalidateWorkspace(wid, 'documents'); }} />}
      {swagger && def && <SwaggerSheet documentId={doc} definitionId={def.id} title={def.name} onClose={() => setSwagger(false)} />}
    </Reading>
  );
}

/**
 * Try it: fill the parameters and the body, and the request is written for the chosen environment, ready to copy. Run unfurls the response
 * the documentation promises for the status you pick; ProjectTracker never sends requests to your servers (credentials stay out of the browser).
 */
function TryIt({ def, ep, base, envLabel }: { def: ApiDefinition | undefined; ep: EndpointDetail; base: string; envLabel: string }) {
  const still = useReducedMotion();
  const d = ep.details;
  const inputs = d.parameters.filter((x) => x.in === 'path' || x.in === 'query' || x.in === 'header');
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const [body, setBody] = useState(() => pretty(d.requestBody?.example));
  const [status, setStatus] = useState(d.responses[0]?.status ?? '200');
  const [ran, setRan] = useState<{ at: number; status: string } | null>(null);
  const curl = buildCurl(def, ep, base, values, d.requestBody ? body : undefined);
  const resp = d.responses.find((r) => r.status === (ran?.status ?? status));
  const missing = inputs.filter((x) => x.required && x.in === 'path' && !values[`path:${x.name}`]);
  return (
    <section className="dx-reveal" data-outline="Try it">
      <div className="dx-sect-h"><h2 className="dx-h2">Try it</h2><button type="button" className={`dx-btn sm${open ? '' : ' tint'}`} aria-expanded={open} onClick={() => setOpen((o) => !o)}>{open ? 'Close' : 'Try it'}</button></div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div className="dx-try" data-testid="try-it" initial={still ? false : { height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={still ? { opacity: 0, transition: { duration: 0 } } : { height: 0, opacity: 0 }} transition={still ? { duration: 0 } : { type: 'spring', duration: 0.36, bounce: 0.06 }}>
            <div className="dx-try-grid">
              {inputs.map((x) => (
                <label key={`${x.in}:${x.name}`} className="dx-try-f"><span>{x.name}<small>{IN_LABEL[x.in]}{x.required ? ' · required' : ''}</small></span>
                  <input className="input" value={values[`${x.in}:${x.name}`] ?? ''} placeholder={x.in === 'header' ? mask(x.name, x.example) || x.name : x.example ?? x.type ?? ''} onChange={(ev) => setValues((v) => ({ ...v, [`${x.in}:${x.name}`]: ev.target.value }))} />
                </label>
              ))}
              {d.requestBody && <label className="dx-try-f full"><span>Body<small>{d.requestBody.contentType ?? 'application/json'}</small></span><textarea className="textarea mono" rows={6} value={body} onChange={(ev) => setBody(ev.target.value)} spellCheck={false} /></label>}
            </div>
            <CodeTabs key={curl} label="Your request" tabs={[{ id: 'curl', label: `cURL · ${envLabel}`, code: curl }]} />
            <div className="dx-row">
              {d.responses.length > 1 && <select className="input dx-try-status" aria-label="Response to show" value={status} onChange={(ev) => { setStatus(ev.target.value); setRan(null); }}>{d.responses.map((r) => <option key={r.status} value={r.status}>{r.status} {r.description ?? ''}</option>)}</select>}
              <button type="button" className="dx-btn pri" disabled={missing.length > 0} title={missing.length ? `Fill ${missing.map((x) => x.name).join(', ')}` : undefined} onClick={() => setRan({ at: Date.now(), status })}><Icon name="play" size={12} /> Run</button>
              <span className="dx-note">Shows the documented response. Requests are not sent from ProjectTracker.</span>
            </div>
            <AnimatePresence initial={false}>
              {ran && (
                <motion.div key={ran.at} className="dx-resp" data-testid="try-response" initial={still ? false : { clipPath: 'inset(0 0 100% 0 round 14px)', opacity: 0.5 }} animate={{ clipPath: 'inset(0 0 0% 0 round 14px)', opacity: 1 }} exit={{ opacity: 0 }} transition={still ? { duration: 0 } : { type: 'spring', duration: 0.42, bounce: 0.1 }}>
                  <div className="dx-resp-h"><span className={`dx-sc s${ran.status[0]}`}>{ran.status}</span><b>{resp?.description || 'Response'}</b><span className="dx-note">documented · {envLabel}</span></div>
                  <dl className="dx-resp-hd"><dt>content-type</dt><dd>{resp?.contentType ?? 'application/json'}</dd></dl>
                  <pre>{pretty(resp?.example || resp?.schema) || 'No example body is documented for this status.'}</pre>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}

const KIND_LABEL: Record<string, string> = { missing: 'Missing', extra: 'Extra', type: 'Type' };

/**
 * API drift: the documented sample response against the live API. "Check against live" asks the server to call the chosen environment with
 * the document's stored credential (nothing leaves the browser, and only field names and types come back); "Paste a response" compares one
 * from Postman or the logs. Shows what is missing, extra or of another type. Readers see the last result.
 */
function LiveCheckSection({ doc, ep, live, canRun, env, envLabel, hasServers, onDone }: {
  doc: string; ep: EndpointDetail; live: LiveCheck | null; canRun: boolean; env: number; envLabel: string; hasServers: boolean; onDone: (r: LiveCheck) => void;
}) {
  const sample = ep.details.responses.find((r) => r.status.startsWith('2') && r.example);
  const [busy, setBusy] = useState(false);
  const [paste, setPaste] = useState<string | null>(null);
  if (!sample && !live) return null;
  const run = async (liveBody?: string) => {
    setBusy(true);
    try {
      const values: Record<string, string> = {};
      for (const x of ep.details.parameters) if (x.in === 'path' && x.example) values[`path:${x.name}`] = x.example;
      const r = await apiDocApi.liveCheck(doc, ep.item.id, liveBody ? { liveBody } : { env, values });
      onDone(r); setPaste(null);
      toast(r.error ? r.error : r.differs ? `${r.fields.length} field${r.fields.length === 1 ? '' : 's'} differ from the docs.` : 'The docs match the live API.', r.error ? 'warning' : r.differs ? 'warning' : 'success');
    } catch (err) { toast(err instanceof ApiError ? err.message : 'Could not check it.', 'error'); }
    finally { setBusy(false); }
  };
  return (
    <section className="dx-reveal" data-outline="Live check" data-testid="live-check">
      <div className="dx-sect-h"><h2 className="dx-h2">Live check</h2>
        {canRun && sample && <div className="dx-row">
          <button type="button" className="dx-btn sm" onClick={() => setPaste(paste === null ? '' : null)}>{paste === null ? 'Paste a response' : 'Cancel'}</button>
          {hasServers && ep.item.method === 'GET' && <button type="button" className="dx-btn sm tint" disabled={busy} onClick={() => void run()}>{busy && <span className="spinner" />}Check against live{envLabel ? ` · ${envLabel}` : ''}</button>}
        </div>}
      </div>
      <div className="dx-drift">
        {paste !== null && (
          <>
            <textarea className="textarea mono" rows={6} value={paste} onChange={(ev) => setPaste(ev.target.value)} placeholder="Paste a real JSON response for this call" aria-label="Live response" spellCheck={false} />
            <div className="dx-row"><button type="button" className="dx-btn pri sm" disabled={busy || !paste.trim()} onClick={() => void run(paste)}>Compare</button><span className="dx-note">Only field names and types are kept, never the values.</span></div>
          </>
        )}
        {!live ? <p className="dx-note">Compares the documented {sample?.status} response with what the API really answers. {!canRun ? 'Editors can run it.' : ep.item.method === 'GET' ? 'Credentials stay on the server.' : 'Only GET calls are made live; paste a real response for this one.'}</p> : (
          <>
            <div className="dx-drift-h">
              {live.error ? <span className="dx-drift-err">{live.error}</span> : live.differs ? <b>Docs differ from live API</b> : <span className="dx-drift-ok">Matches the docs</span>}
              <p className="dx-note">{live.source === 'pasted' ? 'Pasted response' : live.env} · against the documented {live.comparedWith ?? ''} · {timeAgo(live.checkedAt)}</p>
            </div>
            {live.fields.length > 0 && <ul aria-label="Differences">{live.fields.map((f) => (
              <li key={`${f.kind}:${f.path}`}><span className={`k ${f.kind}`}>{KIND_LABEL[f.kind] ?? f.kind}</span><code>{f.path}</code>
                <small>{f.kind === 'missing' ? `documented ${f.documented}, not returned` : f.kind === 'extra' ? `returned ${f.live}, not documented` : `${f.documented} in docs → ${f.live} live`}</small></li>
            ))}</ul>}
          </>
        )}
      </div>
    </section>
  );
}
