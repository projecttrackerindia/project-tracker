import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import { importApi } from '../../api/endpoints';
import type { ImportBatch, ImportSource } from '../../api/endpoints.planning';
import { useCustomFields } from '../customfields/CustomFieldsSection';
import type { ImportPreview, ImportResult } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Field, Modal } from '../../components/ui';
import { invalidateWorkspace } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { saveFile } from '../../lib/native';
import { Select } from '../../components/Select';

const FIELDS: { id: string; label: string; required?: boolean; hint?: string }[] = [
  { id: 'title', label: 'Title', required: true },
  { id: 'description', label: 'Description' },
  { id: 'status', label: 'Status', hint: 'must match a status name in this project' },
  { id: 'priority', label: 'Priority', hint: 'your priority names, or Critical / High / Medium / Low' },
  { id: 'assignee', label: 'Assignee', hint: 'e-mail address or full name of a member' },
  { id: 'startDate', label: 'Start date' },
  { id: 'dueDate', label: 'Due date' },
  { id: 'estimatedHours', label: 'Estimated hours' },
  { id: 'labels', label: 'Labels', hint: 'several separated by commas' },
  { id: 'milestone', label: 'Milestone', hint: 'must already exist' },
];

const TEMPLATE = 'Title,Description,Status,Priority,Assignee,Start date,Due date,Estimated hours,Labels,Milestone\r\n"Design the login page","Wireframes and copy",Yet To Start,High,,2026-10-01,2026-10-10,6,"Frontend, Design",\r\n';

const SOURCES: { id: ImportSource; label: string; sub: string; accept: string; api?: boolean }[] = [
  { id: 'csv', label: 'Spreadsheet', sub: 'Excel or CSV', accept: '.csv,.xlsx,text/csv,text/plain,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  { id: 'jira', label: 'Jira', sub: 'CSV export or API token', accept: '.csv,text/csv', api: true },
  { id: 'trello', label: 'Trello', sub: 'Board JSON export', accept: '.json,application/json' },
  { id: 'asana', label: 'Asana', sub: 'CSV export or API token', accept: '.csv,text/csv', api: true },
];

const SOURCE_NAME: Record<ImportSource, string> = { csv: 'CSV', excel: 'Excel', jira: 'Jira', trello: 'Trello', asana: 'Asana' };

/**
 * The import wizard: where from (a spreadsheet, Jira, Trello or Asana), match the columns and see a dry run of exactly what will happen,
 * import, and undo the whole import in one click if it was not what you wanted.
 */
export function ImportModal({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const wid = useWorkspaceId();
  const [source, setSource] = useState<ImportSource>('csv');
  const [via, setVia] = useState<'file' | 'api'>('file');
  const [cred, setCred] = useState({ site: '', email: '', token: '', query: '', project: '' });
  const [batches, setBatches] = useState<ImportBatch[] | null>(null);
  const [undoing, setUndoing] = useState<string | null>(null);
  const external = source !== 'csv' && source !== 'excel';
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [mapping, setMapping] = useState<Record<string, number | ''>>({});
  const [skipInvalid, setSkipInvalid] = useState(false);
  const [createLabels, setCreateLabels] = useState(true);
  const [dateFormat, setDateFormat] = useState<'dmy' | 'mdy'>('dmy');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const seq = useRef(0);
  const custom = useCustomFields();
  const allFields = [...FIELDS, ...(custom.data ?? []).map((c) => ({ id: `cf:${c.id}`, label: c.name, required: false, hint: c.type === 'Dropdown' ? `one of: ${c.options.join(', ')}` : `custom field (${c.type.toLowerCase()})` }))];

  const mappingJson = (m: Record<string, number | ''>) => JSON.stringify(Object.fromEntries(Object.entries(m).filter(([, v]) => v !== '')));
  // Other tools name statuses and people their own way: match statuses by meaning and leave unknown owners unassigned.
  const options = { skipInvalid, createMissingLabels: createLabels, dateFormat, matchStatuses: external, leaveUnknownOwners: external };
  const kindOf = (f: File): ImportSource => (source === 'csv' && /\.xlsx?$/i.test(f.name) ? 'excel' : source);

  const loadBatches = () => { importApi.batches(projectId).then(setBatches).catch(() => setBatches([])); };
  useEffect(loadBatches, [projectId]);

  const undo = async (id: string) => {
    setUndoing(id);
    try { await importApi.undo(projectId, id); toast('Import undone.'); void invalidateWorkspace(wid); loadBatches(); if (result?.batchId === id) onClose(); }
    catch (e) { toast(e instanceof ApiError ? e.errors[0]?.message ?? e.message : 'Could not undo the import.'); }
    finally { setUndoing(null); }
  };

  const fetchFromApi = async () => {
    if (source !== 'jira' && source !== 'asana') return;
    setBusy(true); setError(null);
    try {
      const r = await importApi.fetch(projectId, { source, token: cred.token, ...(source === 'jira' ? { site: cred.site, email: cred.email, query: cred.query } : { project: cred.project }) });
      setCred((c) => ({ ...c, token: '' }));   // used once; never kept in the page either
      await choose(new File([r.csv], r.fileName, { type: 'text/csv' }));
    } catch (e) { setError(e instanceof ApiError ? e.errors[0]?.message ?? e.message : 'Could not read from ' + SOURCE_NAME[source] + '.'); setBusy(false); }
  };

  const choose = async (f: File) => {
    setFile(f); setError(null); setBusy(true);
    try {
      const p = await importApi.preview(projectId, f, undefined, options, kindOf(f));
      setPreview(p);
      setMapping(Object.fromEntries(Object.entries(p.suggestedMapping)));
    } catch (e) { setFile(null); setError(e instanceof ApiError ? e.errors[0]?.message ?? e.message : 'Could not read the file.'); }
    finally { setBusy(false); }
  };

  // Re-check whenever the mapping or options change, so the counts and errors always describe what will really happen.
  useEffect(() => {
    if (!file || !preview) return;
    const mine = ++seq.current;
    const t = window.setTimeout(async () => {
      setChecking(true);
      try {
        const p = await importApi.preview(projectId, file, mappingJson(mapping), options, kindOf(file));
        if (mine === seq.current) { setPreview({ ...p, suggestedMapping: preview.suggestedMapping }); setError(null); }
      } catch (e) { if (mine === seq.current) setError(e instanceof ApiError ? e.errors[0]?.message ?? e.message : 'Could not check the file.'); }
      finally { if (mine === seq.current) setChecking(false); }
    }, 350);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapping, skipInvalid, createLabels, dateFormat]);

  const run = async () => {
    if (!file) return;
    setBusy(true); setError(null);
    try {
      const r = await importApi.run(projectId, file, mappingJson(mapping), options, kindOf(file));
      setResult(r);
      loadBatches();
      toast(`${r.created} task${r.created === 1 ? '' : 's'} imported.`);
      void invalidateWorkspace(wid);
    } catch (e) { setError(e instanceof ApiError ? e.errors[0]?.message ?? e.message : 'The import failed.'); }
    finally { setBusy(false); }
  };

  const downloadTemplate = () => {
    void saveFile(new Blob(['﻿' + TEMPLATE], { type: 'text/csv' }), 'tasks-template.csv');
  };

  const canImport = !!preview && mapping.title !== undefined && mapping.title !== '' && preview.validRows > 0 && (preview.invalidRows === 0 || skipInvalid) && !checking && !busy;

  // ---------------------------------------------------------------- step 3: result
  if (result) {
    return (
      <Modal size="lg" title="Import finished" onClose={onClose} footer={<>
        {result.batchId && <button type="button" className="btn btn-ghost" disabled={undoing !== null} onClick={() => void undo(result.batchId!)}>{undoing ? 'Undoing…' : 'Undo import'}</button>}
        <button type="button" className="btn btn-primary" onClick={onClose}>Done</button>
      </>}>
        <p style={{ marginTop: 0 }}><b>{result.created}</b> task{result.created === 1 ? '' : 's'} imported{result.labelsCreated ? `, ${result.labelsCreated} new label${result.labelsCreated === 1 ? '' : 's'} created` : ''}.
          {result.skipped > 0 && <> <b>{result.skipped}</b> row{result.skipped === 1 ? ' was' : 's were'} skipped.</>}</p>
        {result.errors.length > 0 && <ErrorList errors={result.errors} />}
      </Modal>
    );
  }

  // ---------------------------------------------------------------- step 1: where from
  if (!preview) {
    const src = SOURCES.find((x) => x.id === (source === 'excel' ? 'csv' : source))!;
    const recent = (batches ?? []).slice(0, 4);
    return (
      <Modal title="Import tasks" subtitle="Bring work in from a spreadsheet or another tool" onClose={onClose}
        footer={<>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          {via === 'api' && src.api && <button type="button" className="btn btn-primary" disabled={busy || !cred.token.trim()} onClick={() => void fetchFromApi()}>{busy ? 'Reading…' : `Read from ${src.label}`}</button>}
        </>}>
        {error && <div className="form-error" role="alert">{error}</div>}
        <div className="imp-sources" role="radiogroup" aria-label="Import from">
          {SOURCES.map((x) => (
            <button key={x.id} type="button" role="radio" aria-checked={src.id === x.id} className={`imp-source${src.id === x.id ? ' on' : ''}`}
              onClick={() => { setSource(x.id); setVia('file'); setError(null); }}>
              <b>{x.label}</b><span>{x.sub}</span>
            </button>
          ))}
        </div>
        {src.api && (
          <div className="imp-via" role="tablist" aria-label="How">
            <button type="button" role="tab" aria-selected={via === 'file'} className={via === 'file' ? 'on' : ''} onClick={() => setVia('file')}>Export file</button>
            <button type="button" role="tab" aria-selected={via === 'api'} className={via === 'api' ? 'on' : ''} onClick={() => setVia('api')}>API token</button>
          </div>
        )}
        {via === 'api' && src.api ? (
          <div className="imp-cred">
            {source === 'jira' ? <>
              <Field label="Jira site"><input className="input" placeholder="yourteam.atlassian.net" value={cred.site} onChange={(e) => setCred({ ...cred, site: e.target.value })} /></Field>
              <Field label="Atlassian e-mail"><input className="input" type="email" autoComplete="off" value={cred.email} onChange={(e) => setCred({ ...cred, email: e.target.value })} /></Field>
              <Field label="API token" hint="Used once for this read and never stored."><input className="input" type="password" autoComplete="off" value={cred.token} onChange={(e) => setCred({ ...cred, token: e.target.value })} /></Field>
              <Field label="Which issues (JQL)" hint="Leave empty for the latest issues."><input className="input" placeholder="project = WEB" value={cred.query} onChange={(e) => setCred({ ...cred, query: e.target.value })} /></Field>
            </> : <>
              <Field label="Asana project" hint="Paste the project's address."><input className="input" placeholder="https://app.asana.com/0/…" value={cred.project} onChange={(e) => setCred({ ...cred, project: e.target.value })} /></Field>
              <Field label="Personal access token" hint="Used once for this read and never stored."><input className="input" type="password" autoComplete="off" value={cred.token} onChange={(e) => setCred({ ...cred, token: e.target.value })} /></Field>
            </>}
          </div>
        ) : (
          <>
            <label className="dropzone">
              <Icon name="upload" size={22} />
              <span>{busy ? 'Reading the file…' : source === 'trello' ? 'Choose the board’s .json export' : source === 'csv' ? 'Choose an .xlsx or .csv file' : `Choose the ${src.label} .csv export`}</span>
              <input type="file" accept={src.accept} hidden disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; if (f) void choose(f); e.target.value = ''; }} />
            </label>
            <p className="imp-note">You will match columns and see a dry run before anything is imported. Owners are matched by e-mail. Up to 5,000 rows and 2 MB.{source === 'csv' && <> <button type="button" className="link" onClick={downloadTemplate}>Download a template</button></>}</p>
          </>
        )}
        {recent.length > 0 && (
          <div className="imp-recent">
            <h4>Recent imports</h4>
            {recent.map((b) => (
              <div key={b.id} className="imp-batch">
                <span><b>{b.created} task{b.created === 1 ? '' : 's'}</b> from {SOURCE_NAME[b.source] ?? b.source} · {new Date(b.createdAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</span>
                {b.undoneAt ? <span className="muted">Undone</span> : b.canUndo ? <button type="button" className="link" disabled={undoing !== null} onClick={() => void undo(b.id)}>{undoing === b.id ? 'Undoing…' : 'Undo'}</button> : <span className="muted">Removed</span>}
              </div>
            ))}
          </div>
        )}
      </Modal>
    );
  }

  // ---------------------------------------------------------------- step 2: match columns
  return (
    <Modal size="lg" title={`Import from ${SOURCE_NAME[file ? kindOf(file) : source]}`} subtitle={`${file?.name} · ${preview.totalRows} row${preview.totalRows === 1 ? '' : 's'} · dry run`} onClose={onClose}
      footer={<>
        <button type="button" className="btn btn-ghost" onClick={() => { setPreview(null); setFile(null); setResult(null); }}>Choose another file</button>
        <button type="button" className="btn btn-primary" disabled={!canImport} onClick={() => void run()}>{busy ? 'Importing…' : `Import ${preview.validRows} task${preview.validRows === 1 ? '' : 's'}`}</button>
      </>}>
      {error && <div className="form-error" role="alert">{error}</div>}
      <div className="import-map">
        {allFields.map((f) => {
          const col = mapping[f.id];
          return (
            <div className="import-row" key={f.id}>
              <label htmlFor={`map-${f.id}`}><b>{f.label}</b>{f.required && <span className="req"> *</span>}{f.hint && <span className="muted" style={{ display: 'block', fontSize: 11.5 }}>{f.hint}</span>}</label>
              <Select id={`map-${f.id}`} className="select" value={col === undefined ? '' : col}
                onChange={(e) => setMapping((m) => ({ ...m, [f.id]: e.target.value === '' ? '' : Number(e.target.value) }))}>
                <option value="">{f.required ? '— Choose a column —' : '— Do not import —'}</option>
                {preview.headers.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
              </Select>
              <span className="muted import-sample">{typeof col === 'number' ? preview.sample.map((r) => r[col]).filter(Boolean).slice(0, 2).join(' · ') : ''}</span>
            </div>
          );
        })}
      </div>

      <div className="import-options">
        <Field label="Date format">
          <Select className="select" value={dateFormat} onChange={(e) => setDateFormat(e.target.value as 'dmy' | 'mdy')}>
            <option value="dmy">Day first (31/12/2026)</option><option value="mdy">Month first (12/31/2026)</option>
          </Select>
        </Field>
        <label className="check"><input type="checkbox" checked={createLabels} onChange={(e) => setCreateLabels(e.target.checked)} /> Create labels that do not exist yet</label>
        <label className="check"><input type="checkbox" checked={skipInvalid} onChange={(e) => setSkipInvalid(e.target.checked)} /> Skip rows with problems and import the rest</label>
      </div>

      <div className={`import-summary ${preview.invalidRows > 0 ? 'bad' : 'good'}`} role="status">
        {checking ? 'Running the dry run…' : preview.validRows === 0 && preview.invalidRows === 0 ? 'Nothing to import yet.' : (
          <><b>{preview.validRows}</b> of {preview.totalRows} rows are ready{preview.invalidRows > 0 ? <> · <b>{preview.invalidRows}</b> have problems{skipInvalid ? ' and will be skipped' : ''}</> : ''}{preview.newLabels > 0 ? ` · ${preview.newLabels} new label${preview.newLabels === 1 ? '' : 's'}` : ''}</>
        )}
      </div>
      {(preview.warnings ?? []).map((w) => <p key={w} className="import-summary" role="note">{w}</p>)}
      {preview.errors.length > 0 && <ErrorList errors={preview.errors} />}
    </Modal>
  );
}

function ErrorList({ errors }: { errors: { row: number; field: string; message: string }[] }) {
  return (
    <div className="import-errors">
      {errors.map((e, i) => <div key={i}>{e.row > 0 ? <b>Row {e.row}</b> : null} {e.row > 0 ? '· ' : ''}{e.message}</div>)}
      {errors.length >= 50 && <div className="muted">Only the first 50 problems are shown.</div>}
    </div>
  );
}
