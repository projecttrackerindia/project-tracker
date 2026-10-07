import { useEffect, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { apiDocApi, documentApi } from '../../api/endpoints';
import { API_STAGES, type ApiAuthScheme, type ApiStage, type ApiChange, ApiDefinition, ApiImportResult, ApiOverview } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Select } from '../../components/Select';
import { EmptyState, ErrorState, Field, Modal, PageLoader, SubmitButton } from '../../components/ui';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';

export const AUTH_LABEL: Record<ApiAuthScheme, string> = { None: 'No authentication', ApiKey: 'API key', Bearer: 'Bearer token', Basic: 'Basic (user and password)', OAuth2: 'OAuth 2.0' };

/** Describe an API: its name, version label, base path, how callers authenticate and where it is served from. */
export function DefinitionModal({ documentId, existing, onClose, onSaved }: { documentId: string; existing: ApiDefinition | null; onClose: () => void; onSaved: (o: ApiOverview) => void }) {
  const wid = useWorkspaceId();
  const [name, setName] = useState(existing?.name ?? '');
  const [version, setVersion] = useState(existing?.version ?? '');
  const [basePath, setBasePath] = useState(existing?.basePath ?? '');
  const [auth, setAuth] = useState<ApiAuthScheme>(existing?.auth ?? 'Bearer');
  const [authNote, setAuthNote] = useState(existing?.authNote ?? '');
  const [stage, setStage] = useState<ApiStage>(existing?.stage ?? 'Draft');
  const [servers, setServers] = useState((existing?.servers ?? []).join('\n'));
  const [description, setDescription] = useState(existing?.description ?? '');
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => {
      const b = { name: name.trim(), description: description.trim() || null, basePath: basePath.trim() || null, version: version.trim() || null, auth, stage, authNote: authNote.trim() || null, servers: servers.split('\n').map((s) => s.trim()).filter(Boolean) };
      return existing ? apiDocApi.updateDefinition(documentId, existing.id, b) : apiDocApi.addDefinition(documentId, b);
    },
    onSuccess: (o) => { invalidateWorkspace(wid, 'documents'); toast('Saved.'); onSaved(o); },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not save.'),
  });
  return (
    <Modal title={existing ? `Edit ${existing.name}` : 'Describe an API'} size="lg" onClose={onClose}
      onSubmit={(e) => { e.preventDefault(); if (!name.trim()) { setError('Name the API.'); return; } setError(null); save.mutate(); }}
      footer={<><button className="btn btn-ghost" type="button" onClick={onClose}>Cancel</button><SubmitButton busy={save.isPending}>Save</SubmitButton></>}>
      {error && <div className="doc-alert" role="alert"><Icon name="alert" size={16} /><div>{error}</div></div>}
      <div className="apx-grid">
        <Field label="Name" required><input className="input" value={name} maxLength={80} autoFocus onChange={(e) => setName(e.target.value)} placeholder="e.g. Payments API" /></Field>
        <Field label="Version" hint="The API's own version, such as v1 or 2024-05."><input className="input" value={version} maxLength={40} onChange={(e) => setVersion(e.target.value)} /></Field>
        <Field label="Base path" hint="Put in front of every path, such as /v1."><input className="input" value={basePath} maxLength={200} onChange={(e) => setBasePath(e.target.value)} /></Field>
        <Field label="Authentication"><Select className="select" value={auth} onChange={(e) => setAuth(e.target.value as ApiAuthScheme)} aria-label="Authentication">{(Object.keys(AUTH_LABEL) as ApiAuthScheme[]).map((a) => <option key={a} value={a}>{AUTH_LABEL[a]}</option>)}</Select></Field>
      </div>
      <Field label="Where it is in its life" hint="Shown on the API's page and in the PDF as a lifecycle ring.">
        <div className="stage-pick" role="radiogroup" aria-label="Lifecycle stage">{API_STAGES.map((st, i) => <button key={st.id} type="button" role="radio" aria-checked={stage === st.id} className={stage === st.id ? 'on' : i < API_STAGES.findIndex((x) => x.id === stage) ? 'past' : ''} onClick={() => setStage(st.id)}>{st.label}</button>)}</div>
      </Field>
      <Field label="How callers authenticate" hint="Where to get a key or token. Never write a real secret here."><textarea className="textarea" rows={2} maxLength={500} value={authNote} onChange={(e) => setAuthNote(e.target.value)} /></Field>
      <Field label="Servers" hint="One address per line, for example https://api.example.com."><textarea className="textarea" rows={3} value={servers} onChange={(e) => setServers(e.target.value)} /></Field>
      <Field label="About this API"><textarea className="textarea" rows={3} maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
    </Modal>
  );
}

/** Bring in an OpenAPI 3 file (JSON or YAML), a Postman collection or pasted cURL commands: check it first, then import it. */
export function ImportModal({ documentId, definitions, onClose, onDone }: { documentId: string; definitions: ApiDefinition[]; onClose: () => void; onDone: (o: ApiOverview | null) => void }) {
  const wid = useWorkspaceId();
  const [file, setFile] = useState<{ name: string; text: string; size: number } | null>(null);
  const [target, setTarget] = useState('');
  const [newName, setNewName] = useState('');
  const [mode, setMode] = useState<'merge' | 'replace'>('merge');
  const [result, setResult] = useState<ApiImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [source, setSource] = useState<'file' | 'curl'>('file');
  const [pasted, setPasted] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const run = useMutation({
    mutationFn: (dryRun: boolean) => apiDocApi.import(documentId, { content: file!.text, fileName: file!.name, definitionId: target || null, newDefinitionName: target ? null : newName.trim() || null, mode, dryRun }),
    onSuccess: (r) => {
      setResult(r); setError(null);
      if (r.applied) { invalidateWorkspace(wid, 'documents'); toast(`Imported ${r.added + r.updated} endpoint${r.added + r.updated === 1 ? '' : 's'}.`); onDone(r.overview); }
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not import.'),
  });
  const pick = async (f: File | undefined) => {
    setResult(null); setError(null);
    if (!f) { setFile(null); return; }
    if (f.size > 6_000_000) { setError('That file is too large (6 MB at most).'); return; }
    setFile({ name: f.name, text: await f.text(), size: f.size });
  };
  // The file is checked as soon as it is chosen, and again when the destination changes, so the person always sees what would happen before importing.
  useEffect(() => {
    if (!file) return;
    const t = window.setTimeout(() => run.mutate(true), 250);
    return () => window.clearTimeout(t);
  }, [file, target, mode, newName]);   // eslint-disable-line react-hooks/exhaustive-deps
  const kind = file ? (/^\s*(#.*\n\s*)*curl(\.exe)?\s/i.test(file.text.slice(0, 2000)) ? 'cURL commands' : /"?openapi"?\s*:|"?swagger"?\s*:/.test(file.text.slice(0, 2000)) ? 'OpenAPI' : /postman|"item"\s*:/.test(file.text.slice(0, 4000)) ? 'Postman collection' : 'Unknown format') : null;
  const errors = result?.issues.filter((i) => i.severity === 'error') ?? [];
  const canImport = !!result?.success && !result.applied && (result.added + result.updated + result.removed > 0);
  const step = !file ? 1 : result?.success ? 3 : 2;
  return (
    <Modal title="Import an API" subtitle="Bring in an OpenAPI file, a Postman collection or cURL commands instead of typing it endpoint by endpoint." size="lg" onClose={onClose}
      footer={<><button className="btn btn-ghost" onClick={onClose}>{result?.applied ? 'Close' : 'Cancel'}</button>
        {!result?.applied && <button className="btn btn-primary" disabled={!canImport || run.isPending} onClick={() => run.mutate(false)}>{run.isPending ? <span className="spinner" /> : <Icon name="upload" size={15} />} Import{canImport ? ` ${result!.added + result!.updated} endpoint${result!.added + result!.updated === 1 ? '' : 's'}` : ''}</button>}</>}>
      <ol className="imp-steps" aria-label="Steps">{['Choose a file', 'Choose where it goes', 'Review and import'].map((t, i) => <li key={t} className={step === i + 1 ? 'on' : step > i + 1 ? 'done' : ''}><span>{step > i + 1 ? '✓' : i + 1}</span>{t}</li>)}</ol>
      {error && <div className="doc-alert" role="alert"><Icon name="alert" size={16} /><div>{error}</div></div>}

      {!file ? (
        <>
          <div className="seg imp-source" role="tablist" aria-label="Where it comes from">
            <button role="tab" aria-selected={source === 'file'} className={source === 'file' ? 'on' : ''} onClick={() => setSource('file')}>File</button>
            <button role="tab" aria-selected={source === 'curl'} className={source === 'curl' ? 'on' : ''} onClick={() => setSource('curl')}>cURL</button>
          </div>
          {source === 'file' ? (
            <div className={`imp-drop${over ? ' over' : ''}`} onClick={() => input.current?.click()} role="button" tabIndex={0} aria-label="Choose a file to import"
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') input.current?.click(); }}
              onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={(e) => { e.preventDefault(); setOver(false); void pick(e.dataTransfer.files?.[0]); }}>
              <div className="imp-drop-ico"><Icon name="upload" size={26} /></div>
              <b>Drop a file here, or click to choose</b>
              <span>Up to 6 MB and 10,000 endpoints</span>
              <div className="imp-formats"><span>OpenAPI 3 · JSON</span><span>OpenAPI 3 · YAML</span><span>Postman 2.1</span><span>cURL · .sh / .txt</span></div>
              <input ref={input} type="file" hidden accept=".json,.yaml,.yml,.sh,.txt,.curl,application/json,text/plain" onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ''; }} />
            </div>
          ) : (
            <div className="imp-curl">
              <textarea className="input mono" rows={8} value={pasted} onChange={(e) => setPasted(e.target.value)} aria-label="cURL commands" spellCheck={false}
                placeholder={"curl -X POST 'https://api.example.com/v1/orders' \\\n  -H 'Content-Type: application/json' \\\n  -d '{\"sku\":\"A1\"}'"} />
              <div className="imp-curl-foot">
                <span className="muted">Paste one or more commands. Each becomes an endpoint. Passwords, tokens and cookies are never kept.</span>
                <button className="btn btn-primary btn-sm" disabled={!/curl/i.test(pasted)} onClick={() => { setResult(null); setError(null); setFile({ name: 'cURL commands', text: pasted, size: pasted.length }); }}>Read commands</button>
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="imp-file">
          <div className="imp-file-ico"><Icon name="note" size={20} /></div>
          <div className="imp-file-main"><b>{file.name}</b><span>{kind} · {(file.size / 1024).toFixed(file.size > 102400 ? 0 : 1)} KB</span></div>
          <button className="btn btn-ghost btn-sm" onClick={() => { setFile(null); setResult(null); }} disabled={!!result?.applied}>Change</button>
        </div>
      )}

      {file && (
        <section className="imp-dest" aria-label="Where it goes">
          {definitions.length > 0 && (
            <div className="seg" role="tablist" aria-label="Destination">
              <button role="tab" aria-selected={!target} className={!target ? 'on' : ''} onClick={() => { setTarget(''); setResult(null); }}>A new API</button>
              <button role="tab" aria-selected={!!target} className={target ? 'on' : ''} onClick={() => { setTarget(definitions[0]?.id ?? ''); setResult(null); }}>An existing API</button>
            </div>
          )}
          {definitions.length === 0 && <p className="muted imp-dest-note">This document has no API yet, so the import creates the first one. Later imports can add to it or update it.</p>}
          {target ? (
            <div className="imp-dest-grid">
              <Field label="API"><Select className="select" value={target} onChange={(e) => { setTarget(e.target.value); setResult(null); }} aria-label="Import into">{definitions.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select></Field>
              <div className="imp-modes" role="radiogroup" aria-label="What to do with the rest">
                <button role="radio" aria-checked={mode === 'merge'} className={mode === 'merge' ? 'on' : ''} onClick={() => { setMode('merge'); setResult(null); }}><b>Add and update</b><span>Keep what is there; add and change what the file has.</span></button>
                <button role="radio" aria-checked={mode === 'replace'} className={mode === 'replace' ? 'on' : ''} onClick={() => { setMode('replace'); setResult(null); }}><b>Make it match the file</b><span>Endpoints that are not in the file are removed.</span></button>
              </div>
            </div>
          ) : <Field label="Name" hint="Leave empty to use the suggested name."><input className="input" value={newName} maxLength={80} placeholder={result?.definition || 'Name of the API'} onChange={(e) => { setNewName(e.target.value); setResult(null); }} /></Field>}
        </section>
      )}

      {run.isPending && !result && file && <p className="muted imp-checking"><span className="spinner" /> Reading the file…</p>}
      {result && (
        <div className="imp-result">
          {result.success ? (
            <>
              <div className="imp-tiles" aria-label="What would change">
                <div className="add"><b>{result.added}</b><span>new</span></div><div className="chg"><b>{result.updated}</b><span>changed</span></div>
                <div><b>{result.unchanged}</b><span>unchanged</span></div><div className={result.removed ? 'del' : ''}><b>{result.removed}</b><span>removed</span></div>
              </div>
              <div className={`doc-alert ${result.applied ? 'ok' : 'info'}`}><Icon name={result.applied ? 'checkCircle' : 'info'} size={16} /><div>{result.applied ? <><b>Imported</b> into “{result.definition}”.</> : <>Ready to import into “{result.definition}”.</>}{result.issues.length > 0 ? ` ${result.issues.length} note${result.issues.length === 1 ? '' : 's'} below.` : ''}</div></div>
            </>
          ) : <div className="doc-alert" role="alert"><Icon name="alert" size={16} /><div><b>This file cannot be imported.</b> Fix the problems below and choose it again.</div></div>}
          {result.issues.length > 0 && (
            <div className="table-wrap"><table className="table imp-table">
              <thead><tr><th>Line</th><th>Where</th><th>Problem</th></tr></thead>
              <tbody>{result.issues.slice(0, 200).map((i, n) => (
                <tr key={n} className={i.severity}><td>{i.line ? `${i.line}${i.column ? `:${i.column}` : ''}` : '–'}</td><td><code>{i.pointer ?? ''}</code></td><td><span className={`badge ${i.severity === 'error' ? 'badge-danger' : 'badge-warning'}`}>{i.severity === 'error' ? 'Error' : 'Note'}</span> {i.message}</td></tr>
              ))}</tbody>
            </table></div>
          )}
          {errors.length === 0 && result.issues.length > 200 && <p className="muted">{result.issues.length - 200} more notes not shown.</p>}
        </div>
      )}
    </Modal>
  );
}

const LEVEL: Record<ApiChange['level'], { label: string; tone: string }> = { Breaking: { label: 'Breaking', tone: 'badge-danger' }, Warning: { label: 'Worth a look', tone: 'badge-warning' }, Info: { label: 'Fine', tone: 'badge-neutral' } };

/** What changed in the API between two versions (or a version and the working copy): breaking changes first. */
export function ChangesModal({ documentId, canEdit, onClose }: { documentId: string; canEdit: boolean; onClose: () => void }) {
  const versions = useWsQuery(['documents', documentId, 'versions'], () => documentApi.versions(documentId));
  const items = versions.data?.items ?? [];
  const published = items.filter((v) => !v.isDraft);
  const draft = items.find((v) => v.isDraft);
  const [from, setFrom] = useState<string | null>(null);
  const [to, setTo] = useState<string | null>(null);
  const fromId = from ?? (canEdit ? published[0]?.id : published[1]?.id) ?? '';
  const toId = to ?? (canEdit ? draft?.id : published[0]?.id) ?? '';
  const q = useWsQuery(['documents', documentId, 'api-changes', fromId, toId], () => apiDocApi.changes(documentId, fromId, toId), { enabled: !!fromId && !!toId && fromId !== toId });
  const options = items.map((v) => <option key={v.id} value={v.id}>{v.isDraft ? 'Working copy' : `Version ${v.label}`}</option>);
  const d = q.data;
  return (
    <Modal title="API changes" subtitle="What callers of the API will notice between two versions." size="xl" onClose={onClose} footer={<button className="btn btn-ghost" onClick={onClose}>Close</button>}>
      {versions.isLoading ? <PageLoader /> : (
        <>
          <div className="chg-pick">
            <Field label="From"><Select className="select" value={fromId} onChange={(e) => setFrom(e.target.value)} aria-label="From">{options}</Select></Field>
            <Icon name="arrowRight" size={16} />
            <Field label="To"><Select className="select" value={toId} onChange={(e) => setTo(e.target.value)} aria-label="To">{options}</Select></Field>
          </div>
          {!fromId || !toId || fromId === toId ? <EmptyState icon="layers" title="Choose two different versions" text="Publish a version first if there is only one." /> :
            q.isLoading ? <PageLoader /> : q.isError || !d ? <ErrorState error={q.error} retry={() => q.refetch()} /> : (
              <div className="chg">
                <div className="chg-stats">
                  <span className={`chg-stat ${d.breaking ? 'bad' : ''}`}><b>{d.breaking}</b> breaking</span>
                  <span className={`chg-stat ${d.warnings ? 'warn' : ''}`}><b>{d.warnings}</b> worth a look</span>
                  <span className="chg-stat"><b>{d.info}</b> fine</span>
                  <span className="chg-stat muted">{d.added} added · {d.removed} removed · {d.modified} changed</span>
                </div>
                {d.items.length === 0 ? <EmptyState icon="checkCircle" title="The API is the same" /> : (
                  <ul className="chg-list">{d.items.map((c, i) => (
                    <li key={i} className={`chg-row ${c.level.toLowerCase()}`}>
                      <span className={`badge ${LEVEL[c.level].tone}`}>{LEVEL[c.level].label}</span>
                      <span className={`mth mth-${c.method.toLowerCase()}`}>{c.method}</span><code className="chg-path">{c.path}</code>
                      <span className="chg-msg">{c.message}{c.where && c.code !== 'endpoint.removed' && !c.message.startsWith(c.where) ? <small> · {c.where}</small> : null}</span>
                    </li>
                  ))}</ul>
                )}
              </div>
            )}
        </>
      )}
    </Modal>
  );
}
