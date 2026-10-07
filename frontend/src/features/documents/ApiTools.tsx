import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { apiDocApi, documentApi } from '../../api/endpoints';
import type { ApiAuthScheme, ApiChange, ApiDefinition, ApiImportResult, ApiOverview } from '../../api/types';
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
  const [servers, setServers] = useState((existing?.servers ?? []).join('\n'));
  const [description, setDescription] = useState(existing?.description ?? '');
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () => {
      const b = { name: name.trim(), description: description.trim() || null, basePath: basePath.trim() || null, version: version.trim() || null, auth, authNote: authNote.trim() || null, servers: servers.split('\n').map((s) => s.trim()).filter(Boolean) };
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
      <Field label="How callers authenticate" hint="Where to get a key or token. Never write a real secret here."><textarea className="textarea" rows={2} maxLength={500} value={authNote} onChange={(e) => setAuthNote(e.target.value)} /></Field>
      <Field label="Servers" hint="One address per line, for example https://api.example.com."><textarea className="textarea" rows={3} value={servers} onChange={(e) => setServers(e.target.value)} /></Field>
      <Field label="About this API"><textarea className="textarea" rows={3} maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
    </Modal>
  );
}

/** Bring in an OpenAPI 3 file (JSON or YAML) or a Postman collection: check it first, then import it. */
export function ImportModal({ documentId, definitions, onClose, onDone }: { documentId: string; definitions: ApiDefinition[]; onClose: () => void; onDone: (o: ApiOverview | null) => void }) {
  const wid = useWorkspaceId();
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [target, setTarget] = useState('');
  const [newName, setNewName] = useState('');
  const [mode, setMode] = useState<'merge' | 'replace'>('merge');
  const [result, setResult] = useState<ApiImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
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
    setFile({ name: f.name, text: await f.text() });
  };
  const errors = result?.issues.filter((i) => i.severity === 'error') ?? [];
  const canImport = !!result?.success && !result.applied && (result.added + result.updated + result.removed > 0);
  return (
    <Modal title="Import an API" subtitle="OpenAPI 3 (JSON or YAML) or a Postman collection." size="lg" onClose={onClose}
      footer={<><button className="btn btn-ghost" onClick={onClose}>{result?.applied ? 'Close' : 'Cancel'}</button>
        {!result?.applied && <button className="btn btn-ghost" disabled={!file || run.isPending} onClick={() => run.mutate(true)}>Check the file</button>}
        {!result?.applied && <button className="btn btn-primary" disabled={!canImport || run.isPending} onClick={() => run.mutate(false)}>{run.isPending ? 'Working…' : 'Import'}</button>}</>}>
      {error && <div className="doc-alert" role="alert"><Icon name="alert" size={16} /><div>{error}</div></div>}
      <Field label="File" hint="Large files are fine: up to 6 MB and 10,000 endpoints."><input className="input" type="file" accept=".json,.yaml,.yml,application/json" onChange={(e) => pick(e.target.files?.[0])} /></Field>
      <div className="apx-grid">
        <Field label="Import into"><Select className="select" value={target} onChange={(e) => { setTarget(e.target.value); setResult(null); }} aria-label="Import into">
          <option value="">A new API</option>{definitions.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select></Field>
        {target ? (
          <Field label="What to do with the rest" hint={mode === 'merge' ? 'Endpoints already there are kept; the ones in the file are added or updated.' : 'Endpoints that are not in the file are removed.'}>
            <Select className="select" value={mode} onChange={(e) => { setMode(e.target.value as 'merge' | 'replace'); setResult(null); }} aria-label="Mode"><option value="merge">Add and update</option><option value="replace">Make it match the file</option></Select></Field>
        ) : <Field label="Name" hint="Leave empty to use the name in the file."><input className="input" value={newName} maxLength={80} onChange={(e) => { setNewName(e.target.value); setResult(null); }} /></Field>}
      </div>
      {run.isPending && !result && <PageLoader />}
      {result && (
        <div className="imp-result">
          {result.success ? (
            <div className={`doc-alert ${result.applied ? 'ok' : 'info'}`}><Icon name={result.applied ? 'checkCircle' : 'info'} size={16} />
              <div><b>{result.applied ? 'Imported' : 'Ready to import'}</b> into “{result.definition}”: {result.added} new, {result.updated} changed, {result.unchanged} unchanged{result.removed ? `, ${result.removed} removed` : ''} ({result.format === 'postman' ? 'Postman' : 'OpenAPI'}).</div></div>
          ) : <div className="doc-alert" role="alert"><Icon name="alert" size={16} /><div><b>This file cannot be imported.</b> Fix the problems below and choose it again.</div></div>}
          {result.issues.length > 0 && (
            <div className="table-wrap"><table className="table imp-table">
              <thead><tr><th>Line</th><th>Where</th><th>Problem</th></tr></thead>
              <tbody>{result.issues.slice(0, 200).map((i, n) => (
                <tr key={n} className={i.severity}><td>{i.line ? `${i.line}${i.column ? `:${i.column}` : ''}` : '–'}</td><td><code>{i.pointer ?? ''}</code></td><td><span className={`badge ${i.severity === 'error' ? 'badge-danger' : 'badge-warning'}`}>{i.severity}</span> {i.message}</td></tr>
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
