import { useMemo } from 'react';
import { API_STAGES, type ApiDefinition, type ApiParam, type EndpointDetail } from '../../api/types';
import { Icon } from '../../components/Icon';
import { toast } from '../../stores/ui';
import { AUTH_LABEL } from './ApiTools';
import { DiagramFigure } from './DiagramPreviews';

export const Method = ({ m }: { m: string }) => <span className={`mth mth-${m.toLowerCase()}`}>{m}</span>;

const SENSITIVE = /secret|token|password|passwd|authorization|api[-_]?key|client[-_]?id|signature/i;
/** Keeps the shape of a credential and hides the rest (78g65*******fa2b). */
export function mask(name: string, value?: string | null) {
  if (!value) return value ?? '';
  if (!SENSITIVE.test(name)) return value;
  const prefix = /^basic /i.test(value) ? 'Basic ' : /^bearer /i.test(value) ? 'Bearer ' : '';
  const v = value.slice(prefix.length);
  return prefix + (v.length > 10 ? `${v.slice(0, 5)}*******${v.slice(-4)}` : '*********');
}

const pretty = (text: string | null | undefined) => { if (!text) return ''; try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; } };

interface Row { name: string; required: boolean; type: string; example: string; description: string }

/** The fields a JSON schema describes, one row each; nested objects and arrays are flattened as a.b and a[].b (the same rows the PDF prints). */
export function schemaRows(schema: string | null, example: string | null): Row[] {
  const rows: Row[] = [];
  if (!schema) return rows;
  let root: unknown; let sample: unknown;
  try { root = JSON.parse(schema); } catch { return rows; }
  try { sample = example ? JSON.parse(example) : undefined; } catch { sample = undefined; }
  const walk = (node: any, s: any, prefix: string, depth: number) => {
    if (depth > 3 || !node || typeof node !== 'object') return;
    if (node.type === 'array' && node.items) { walk(node.items, Array.isArray(s) ? s[0] : undefined, `${prefix}[]`, depth + 1); return; }
    if (!node.properties || typeof node.properties !== 'object') return;
    const req: string[] = Array.isArray(node.required) ? node.required : [];
    for (const [key, p] of Object.entries<any>(node.properties)) {
      const name = prefix ? `${prefix}.${key}` : key;
      const type = typeof p?.type === 'string' ? p.type : 'object';
      const shown = type === 'integer' || type === 'number' ? 'Number' : type === 'string' ? 'String' : type === 'boolean' ? 'Boolean' : type === 'array' ? 'Array' : 'Object';
      const sv = s && typeof s === 'object' && !Array.isArray(s) ? s[key] : undefined;
      const ex = p?.example !== undefined ? String(p.example) : sv !== undefined && typeof sv !== 'object' ? String(sv) : Array.isArray(sv) && sv.length === 0 ? '[]' : '';
      rows.push({ name, required: req.includes(key), type: shown, example: mask(key, ex), description: p?.description ?? '' });
      if (type === 'object' || type === 'array') walk(p, sv, name, depth + 1);
      if (rows.length > 300) return;
    }
  };
  walk(root, sample, '', 0);
  return rows;
}

function curlOf(def: ApiDefinition | undefined, ep: EndpointDetail): string {
  const { item: i, details: d } = ep;
  const host = (def?.servers[0] ?? 'https://host').replace(/^(https?:\/\/)([^/]+)(\/.*)?$/, (_m, a, _b, c) => `${a}••••••••${c ? '/••••' : ''}`);
  const lines = [`curl --location --request ${i.method} "${host}${def?.basePath ? '/••••' : ''}/••••" \\`];
  const headers = d.parameters.filter((p) => p.in === 'header');
  if (d.requestBody?.contentType && !headers.some((h) => h.name.toLowerCase() === 'content-type')) lines.push(`  --header "Content-Type: ${d.requestBody.contentType}" \\`);
  for (const h of headers) lines.push(`  --header "${h.name}: ${mask(h.name, h.example ?? `<${h.name.toLowerCase()}>`)}" \\`);
  if (d.requestBody?.example) { const body = pretty(d.requestBody.example).split('\n'); lines.push(`  --data-raw '${body[0]}`, ...body.slice(1)); lines[lines.length - 1] += "'"; }
  else lines[lines.length - 1] = lines[lines.length - 1].replace(/ \\$/, '');
  return lines.join('\n');
}

function ParamTable({ title, list }: { title: string; list: ApiParam[] }) {
  if (list.length === 0) return null;
  return (
    <section className="apv-sec"><h4 className="apv-label">{title}</h4>
      <div className="apv-table-wrap"><table className="apv-table"><thead><tr><th>Name</th><th>Type</th><th>Example</th><th>Description</th></tr></thead>
        <tbody>{list.map((p, n) => <tr key={n}><td><b>{p.name}{p.required ? ' *' : ''}</b></td><td>{p.type ?? 'String'}</td><td className="mono">{mask(p.name, p.example)}</td><td>{p.description ?? ''}</td></tr>)}</tbody></table></div>
    </section>
  );
}

function FieldTable({ title, rows }: { title: string; rows: Row[] }) {
  if (rows.length === 0) return null;
  return (
    <section className="apv-sec"><h4 className="apv-label">{title}</h4>
      <div className="apv-table-wrap"><table className="apv-table"><thead><tr><th>Name</th><th>Type</th><th>Example</th><th>Description</th></tr></thead>
        <tbody>{rows.map((r, n) => <tr key={n}><td><b>{r.name}{r.required ? ' *' : ''}</b></td><td>{r.type}</td><td className="mono">{r.example}</td><td>{r.description}</td></tr>)}</tbody></table></div>
    </section>
  );
}

function Panel({ label, hint, text, copy }: { label: string; hint?: string; text: string; copy?: boolean }) {
  if (!text) return null;
  return (
    <div className="apv-panel"><div className="apv-panel-bar"><b>{label}</b>{hint && <span>{hint}</span>}{copy && <button className="link-btn" onClick={() => { void navigator.clipboard?.writeText(text); toast('Copied.'); }}><Icon name="copy" size={13} /> Copy</button>}</div><pre>{text}</pre></div>
  );
}

/** One endpoint, laid out like a printed reference: a banner, what it does, the request flow and request, then tables of what goes in and comes out. */
export function EndpointArticle({ ep, definition, canEdit, onEdit, onDelete }: { ep: EndpointDetail; definition: ApiDefinition | undefined; canEdit: boolean; onEdit: () => void; onDelete: () => void }) {
  const { item: i, details: d } = ep;
  const auth = d.auth === 'inherit' ? (definition ? AUTH_LABEL[definition.auth] : '') : d.auth === 'none' ? 'Open: no authentication' : AUTH_LABEL[d.auth as keyof typeof AUTH_LABEL] ?? d.auth;
  const curl = useMemo(() => curlOf(definition, ep), [definition, ep]);
  const headers = d.parameters.filter((p) => p.in === 'header');
  const body = useMemo(() => schemaRows(d.requestBody?.schema ?? null, d.requestBody?.example ?? null), [d.requestBody]);
  const chips = [i.tag, d.requestBody?.contentType, definition ? API_STAGES.find((s) => s.id === definition.stage)?.label : null, i.owner ? `Owner: ${i.owner.name}` : null, auth ? `Auth: ${auth}` : null].filter(Boolean) as string[];
  return (
    <article className="apv">
      <header className={`apv-banner m-${i.method.toLowerCase()}`}>
        <Method m={i.method} /><code>{i.path}</code>{i.deprecated && <span className="badge badge-warning">Deprecated</span>}
        {definition?.version && <span className="apv-ver">v{definition.version.replace(/^v/i, '')}</span>}
        {canEdit && !ep.readOnly && <div className="apv-tools"><button className="btn btn-ghost btn-sm" onClick={onEdit}><Icon name="edit" size={14} /> Edit</button><button className="btn-icon" aria-label="Delete endpoint" onClick={onDelete}><Icon name="trash" size={14} /></button></div>}
      </header>
      {i.summary && <h3 className="apv-lead">{i.summary}</h3>}
      {d.description && <p className="apv-desc">{d.description}</p>}
      {chips.length > 0 && <div className="apv-chips">{chips.map((c) => <span key={c}>{c}</span>)}</div>}

      {d.flow && <section className="apv-sec"><h4 className="apv-label">Request flow</h4><DiagramFigure source={d.flow} /></section>}

      <section className="apv-sec"><Panel label="Request" hint="host and credentials are masked" text={curl} copy /></section>
      <ParamTable title="Headers" list={headers} />
      <ParamTable title="Path parameters" list={d.parameters.filter((p) => p.in === 'path')} />
      <ParamTable title="Query parameters" list={d.parameters.filter((p) => p.in === 'query')} />
      <ParamTable title="Cookies" list={d.parameters.filter((p) => p.in === 'cookie')} />
      {d.requestBody && (
        <>
          {d.requestBody.description && <p className="apv-desc">{d.requestBody.description}</p>}
          <FieldTable title="Request fields" rows={body} />
          {d.requestBody.example ? <Panel label="Example request body" text={pretty(d.requestBody.example)} copy /> : body.length === 0 ? <Panel label="Request schema" text={pretty(d.requestBody.schema)} /> : null}
        </>
      )}

      {d.responses.length > 0 && (
        <section className="apv-sec"><h4 className="apv-label">Responses</h4>
          {d.responses.map((r, n) => {
            const rows = schemaRows(r.schema, r.example);
            return (
              <div className="apv-resp" key={n}>
                <div className="apv-resp-head"><span className={`apv-status s${r.status[0]}`}>{r.status}</span><span>{r.description}</span>{r.contentType && <small>{r.contentType}</small>}</div>
                <FieldTable title="Response fields" rows={rows} />
                {rows.length === 0 && r.schema && <Panel label="Response schema" hint={`status ${r.status}`} text={pretty(r.schema)} />}
                {r.example && <Panel label="Example response" hint={`status ${r.status}`} text={pretty(r.example)} copy />}
              </div>
            );
          })}
        </section>
      )}
      {d.errors.length > 0 && (
        <section className="apv-sec"><h4 className="apv-label">Errors</h4>
          <div className="apv-table-wrap"><table className="apv-table"><thead><tr><th>Code</th><th>Message</th><th>What the caller should do</th></tr></thead>
            <tbody>{d.errors.map((e, n) => <tr key={n}><td><b>{e.code}</b></td><td>{e.message ?? ''}</td><td>{e.description ?? ''}</td></tr>)}</tbody></table></div>
        </section>
      )}
      {d.samples.map((s, n) => <Panel key={n} label={`Sample: ${s.title}`} hint={s.language} text={s.code} copy />)}
      {d.dependencies.length > 0 && <section className="apv-sec"><h4 className="apv-label">Depends on</h4><ul className="apr-deps">{d.dependencies.map((x, n) => <li key={n}><b>{x.name}</b>{x.note ? <span className="muted"> · {x.note}</span> : null}</li>)}</ul></section>}
    </article>
  );
}

/** Where an API is in its life: a ring of nine stages, filled up to the current one. */
export function LifecycleCard({ definition }: { definition: ApiDefinition }) {
  const n = API_STAGES.length; const cur = Math.max(0, API_STAGES.findIndex((s) => s.id === definition.stage));
  const R = 44, r = 29, cx = 52, cy = 52, gap = 0.04;
  const seg = (i: number) => {
    const a0 = -Math.PI / 2 + (i * 2 * Math.PI) / n + gap, a1 = -Math.PI / 2 + ((i + 1) * 2 * Math.PI) / n - gap;
    const p = (a: number, rad: number) => `${(cx + rad * Math.cos(a)).toFixed(2)} ${(cy + rad * Math.sin(a)).toFixed(2)}`;
    return `M${p(a0, R)} A${R} ${R} 0 0 1 ${p(a1, R)} L${p(a1, r)} A${r} ${r} 0 0 0 ${p(a0, r)}Z`;
  };
  return (
    <div className="lc" aria-label={`Lifecycle: ${API_STAGES[cur].label}`}>
      <svg viewBox="0 0 104 104" width="112" height="112" role="img" aria-hidden="true">
        {API_STAGES.map((s, i) => <path key={s.id} d={seg(i)} className={i < cur ? 'done' : i === cur ? 'now' : ''} />)}
        <text x="52" y="46" textAnchor="middle" className="lc-s">STAGE {cur + 1} / {n}</text>
        <text x="52" y="60" textAnchor="middle" className="lc-n">{API_STAGES[cur].label}</text>
      </svg>
      <div className="lc-chips">{API_STAGES.map((s, i) => <span key={s.id} className={i < cur ? 'done' : i === cur ? 'now' : ''}><i />{s.label}</span>)}</div>
    </div>
  );
}
