import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { apiDocApi, workspaceApi } from '../../api/endpoints';
import type { ApiBody, ApiDefinition, ApiMethod, ApiParam, ApiResponse, EndpointDetail, EndpointDetails } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Select } from '../../components/Select';
import { Field, Modal, SubmitButton } from '../../components/ui';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';

export const METHODS: ApiMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE'];
const TABS = ['Basics', 'Parameters', 'Request', 'Responses', 'Errors and samples', 'Depends on'] as const;
const LANGS = ['curl', 'javascript', 'python', 'csharp', 'java', 'text'];
export const emptyDetails = (): EndpointDetails => ({ description: null, auth: 'inherit', parameters: [], requestBody: null, responses: [{ status: '200', description: 'OK', contentType: 'application/json', schema: null, example: null }], errors: [], samples: [], dependencies: [] });

function Rows<T>({ items, onChange, blank, render, add }: { items: T[]; onChange: (v: T[]) => void; blank: () => T; render: (item: T, set: (v: T) => void) => React.ReactNode; add: string }) {
  return (
    <div className="epe-rows">
      {items.map((it, i) => (
        <div className="epe-row" key={i}>
          <div className="epe-row-main">{render(it, (v) => onChange(items.map((x, j) => (j === i ? v : x))))}</div>
          <button type="button" className="btn-icon" aria-label="Remove" onClick={() => onChange(items.filter((_, j) => j !== i))}><Icon name="close" size={14} /></button>
        </div>
      ))}
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => onChange([...items, blank()])}><Icon name="plus" size={14} /> {add}</button>
    </div>
  );
}

const Code = ({ value, onChange, rows = 4, label, hint, ph }: { value: string | null; onChange: (v: string | null) => void; rows?: number; label: string; hint?: string; ph?: string }) => (
  <Field label={label} hint={hint}><textarea className="textarea epe-code" rows={rows} spellCheck={false} value={value ?? ''} placeholder={ph} onChange={(e) => onChange(e.target.value || null)} /></Field>
);

/** Write or change one endpoint: where it is, what it takes, what it returns, how it fails, and an example. */
export function EndpointEditor({ documentId, definitions, existing, startDefinition, onClose, onSaved }: {
  documentId: string; definitions: ApiDefinition[]; existing: EndpointDetail | null; startDefinition: string; onClose: () => void; onSaved: (e: EndpointDetail) => void;
}) {
  const wid = useWorkspaceId();
  const members = useWsQuery(['members'], workspaceApi.members);
  const [tab, setTab] = useState<(typeof TABS)[number]>('Basics');
  const e0 = existing?.item;
  const [definitionId, setDefinitionId] = useState(e0?.definitionId ?? startDefinition);
  const [method, setMethod] = useState<ApiMethod>(e0?.method ?? 'GET');
  const [path, setPath] = useState(e0?.path ?? '/');
  const [summary, setSummary] = useState(e0?.summary ?? '');
  const [tag, setTag] = useState(e0?.tag ?? '');
  const [deprecated, setDeprecated] = useState(e0?.deprecated ?? false);
  const [ownerId, setOwnerId] = useState(e0?.owner?.id ?? '');
  const [d, setD] = useState<EndpointDetails>(existing?.details ?? emptyDetails());
  const [error, setError] = useState<string | null>(null);
  const set = (p: Partial<EndpointDetails>) => setD((x) => ({ ...x, ...p }));
  const save = useMutation({
    mutationFn: () => {
      const b = { definitionId, method, path: path.trim(), summary: summary.trim(), tag: tag.trim() || null, deprecated, ownerId: ownerId || null, details: d };
      return existing ? apiDocApi.updateEndpoint(documentId, existing.item.id, b) : apiDocApi.addEndpoint(documentId, b);
    },
    onSuccess: (r) => { invalidateWorkspace(wid, 'documents'); toast('Saved.'); onSaved(r); },
    onError: (e) => setError(e instanceof ApiError ? e.message + (e.errors?.[0]?.field ? ` (${e.errors[0].field})` : '') : 'Could not save.'),
  });
  const body: ApiBody | null = d.requestBody;
  return (
    <Modal title={existing ? `${e0!.method} ${e0!.path}` : 'New endpoint'} size="xl" onClose={onClose}
      onSubmit={(ev) => { ev.preventDefault(); setError(null); save.mutate(); }}
      footer={<><button className="btn btn-ghost" type="button" onClick={onClose}>Cancel</button><SubmitButton busy={save.isPending}>Save endpoint</SubmitButton></>}>
      {error && <div className="doc-alert" role="alert"><Icon name="alert" size={16} /><div>{error}</div></div>}
      <div className="seg epe-tabs" role="tablist">{TABS.map((t) => <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{t}</button>)}</div>

      {tab === 'Basics' && (
        <div className="epe-pane">
          <div className="epe-line">
            <Select className="select epe-method" value={method} onChange={(e) => setMethod(e.target.value as ApiMethod)} aria-label="Method">{METHODS.map((m) => <option key={m} value={m}>{m}</option>)}</Select>
            <input className="input epe-path" value={path} maxLength={400} onChange={(e) => setPath(e.target.value)} placeholder="/payments/{id}" aria-label="Path" autoFocus={!existing} />
          </div>
          <div className="apx-grid">
            <Field label="API"><Select className="select" value={definitionId} onChange={(e) => setDefinitionId(e.target.value)} aria-label="API">{definitions.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</Select></Field>
            <Field label="Group" hint="Endpoints with the same group are listed together."><input className="input" value={tag} maxLength={80} onChange={(e) => setTag(e.target.value)} placeholder="e.g. Payments" /></Field>
          </div>
          <Field label="Summary" hint="One line, shown in the list."><input className="input" value={summary} maxLength={300} onChange={(e) => setSummary(e.target.value)} /></Field>
          <Field label="Description"><textarea className="textarea" rows={4} maxLength={10000} value={d.description ?? ''} onChange={(e) => set({ description: e.target.value || null })} /></Field>
          <div className="apx-grid">
            <Field label="Authentication"><Select className="select" value={d.auth} onChange={(e) => set({ auth: e.target.value })} aria-label="Authentication">
              <option value="inherit">Same as the API</option><option value="none">None (open)</option><option value="ApiKey">API key</option><option value="Bearer">Bearer token</option><option value="Basic">Basic</option><option value="OAuth2">OAuth 2.0</option></Select></Field>
            <Field label="Owner" hint="Who answers questions about it."><Select className="select" value={ownerId} onChange={(e) => setOwnerId(e.target.value)} aria-label="Owner"><option value="">Nobody in particular</option>{members.data?.map((m) => <option key={m.userId} value={m.userId}>{m.displayName}</option>)}</Select></Field>
          </div>
          <label className="check-row"><input type="checkbox" checked={deprecated} onChange={(e) => setDeprecated(e.target.checked)} /> <span><b>Deprecated</b> <small>: still works, but callers should move away from it.</small></span></label>
        </div>
      )}

      {tab === 'Parameters' && (
        <div className="epe-pane">
          <p className="muted">Query, path, header and cookie parameters. Path parameters are always required.</p>
          <Rows<ApiParam> items={d.parameters} onChange={(parameters) => set({ parameters })} add="Add a parameter" blank={() => ({ name: '', in: 'query', required: false, type: 'string', description: null, example: null, schema: null })}
            render={(p, s) => (
              <>
                <div className="epe-line">
                  <input className="input" value={p.name} placeholder="name" maxLength={100} aria-label="Name" onChange={(e) => s({ ...p, name: e.target.value })} />
                  <Select className="select" value={p.in} onChange={(e) => s({ ...p, in: e.target.value, required: e.target.value === 'path' ? true : p.required })} aria-label="Where"><option value="query">query</option><option value="path">path</option><option value="header">header</option><option value="cookie">cookie</option></Select>
                  <input className="input" value={p.type ?? ''} placeholder="type" maxLength={60} aria-label="Type" onChange={(e) => s({ ...p, type: e.target.value || null })} />
                  <label className="check-row small"><input type="checkbox" checked={p.required || p.in === 'path'} disabled={p.in === 'path'} onChange={(e) => s({ ...p, required: e.target.checked })} /> required</label>
                </div>
                <div className="epe-line">
                  <input className="input" value={p.description ?? ''} placeholder="what it is" maxLength={1000} aria-label="Description" onChange={(e) => s({ ...p, description: e.target.value || null })} />
                  <input className="input" value={p.example ?? ''} placeholder="example" maxLength={1000} aria-label="Example" onChange={(e) => s({ ...p, example: e.target.value || null })} />
                </div>
              </>
            )} />
        </div>
      )}

      {tab === 'Request' && (
        <div className="epe-pane">
          {!body ? <button type="button" className="btn btn-ghost" onClick={() => set({ requestBody: { contentType: 'application/json', required: true, description: null, schema: null, example: null } })}><Icon name="plus" size={14} /> This endpoint takes a request body</button> : (
            <>
              <div className="epe-line">
                <input className="input" value={body.contentType ?? ''} placeholder="application/json" aria-label="Content type" onChange={(e) => set({ requestBody: { ...body, contentType: e.target.value || null } })} />
                <label className="check-row small"><input type="checkbox" checked={body.required} onChange={(e) => set({ requestBody: { ...body, required: e.target.checked } })} /> required</label>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => set({ requestBody: null })}>Remove the body</button>
              </div>
              <Field label="What it carries"><input className="input" value={body.description ?? ''} maxLength={1000} onChange={(e) => set({ requestBody: { ...body, description: e.target.value || null } })} /></Field>
              <Code label="Schema (JSON Schema)" hint="Must be valid JSON." rows={8} value={body.schema} ph='{"type":"object","properties":{"amount":{"type":"integer"}},"required":["amount"]}' onChange={(v) => set({ requestBody: { ...body, schema: v } })} />
              <Code label="Example" rows={5} value={body.example} onChange={(v) => set({ requestBody: { ...body, example: v } })} />
            </>
          )}
        </div>
      )}

      {tab === 'Responses' && (
        <div className="epe-pane">
          <Rows<ApiResponse> items={d.responses} onChange={(responses) => set({ responses })} add="Add a response" blank={() => ({ status: '400', description: null, contentType: 'application/json', schema: null, example: null })}
            render={(r, s) => (
              <>
                <div className="epe-line">
                  <input className="input epe-status" value={r.status} maxLength={12} aria-label="Status" placeholder="200" onChange={(e) => s({ ...r, status: e.target.value })} />
                  <input className="input" value={r.description ?? ''} maxLength={1000} aria-label="Description" placeholder="what it means" onChange={(e) => s({ ...r, description: e.target.value || null })} />
                  <input className="input" value={r.contentType ?? ''} maxLength={100} aria-label="Content type" placeholder="application/json" onChange={(e) => s({ ...r, contentType: e.target.value || null })} />
                </div>
                <div className="epe-line">
                  <textarea className="textarea epe-code" rows={4} spellCheck={false} aria-label="Schema" placeholder="Schema (JSON)" value={r.schema ?? ''} onChange={(e) => s({ ...r, schema: e.target.value || null })} />
                  <textarea className="textarea epe-code" rows={4} spellCheck={false} aria-label="Example" placeholder="Example" value={r.example ?? ''} onChange={(e) => s({ ...r, example: e.target.value || null })} />
                </div>
              </>
            )} />
        </div>
      )}

      {tab === 'Errors and samples' && (
        <div className="epe-pane">
          <h4>Errors it can return</h4>
          <Rows items={d.errors} onChange={(errors) => set({ errors })} add="Add an error" blank={() => ({ code: '', message: null, description: null })}
            render={(x, s) => (
              <div className="epe-line">
                <input className="input" value={x.code} maxLength={60} aria-label="Code" placeholder="CARD_DECLINED" onChange={(e) => s({ ...x, code: e.target.value })} />
                <input className="input" value={x.message ?? ''} maxLength={500} aria-label="Message" placeholder="message shown" onChange={(e) => s({ ...x, message: e.target.value || null })} />
                <input className="input" value={x.description ?? ''} maxLength={1000} aria-label="When" placeholder="when it happens" onChange={(e) => s({ ...x, description: e.target.value || null })} />
              </div>
            )} />
          <h4>Samples</h4>
          <Rows items={d.samples} onChange={(samples) => set({ samples })} add="Add a sample" blank={() => ({ title: 'Example', language: 'curl', code: '' })}
            render={(x, s) => (
              <>
                <div className="epe-line">
                  <input className="input" value={x.title} maxLength={100} aria-label="Title" onChange={(e) => s({ ...x, title: e.target.value })} />
                  <Select className="select" value={x.language} onChange={(e) => s({ ...x, language: e.target.value })} aria-label="Language">{LANGS.map((l) => <option key={l} value={l}>{l}</option>)}</Select>
                </div>
                <textarea className="textarea epe-code" rows={5} spellCheck={false} aria-label="Code" value={x.code} onChange={(e) => s({ ...x, code: e.target.value })} />
              </>
            )} />
        </div>
      )}

      {tab === 'Depends on' && (
        <div className="epe-pane">
          <p className="muted">Other services, endpoints or systems this one needs to do its work.</p>
          <Rows items={d.dependencies} onChange={(dependencies) => set({ dependencies })} add="Add a dependency" blank={() => ({ name: '', note: null })}
            render={(x, s) => (
              <div className="epe-line">
                <input className="input" value={x.name} maxLength={200} aria-label="Name" placeholder="e.g. Ledger service, GET /accounts/{id}" onChange={(e) => s({ ...x, name: e.target.value })} />
                <input className="input" value={x.note ?? ''} maxLength={500} aria-label="Note" placeholder="why" onChange={(e) => s({ ...x, note: e.target.value || null })} />
              </div>
            )} />
        </div>
      )}
    </Modal>
  );
}
