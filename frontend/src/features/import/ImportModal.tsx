import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import { importApi } from '../../api/endpoints';
import { useCustomFields } from '../customfields/CustomFieldsSection';
import type { ImportPreview, ImportResult } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Field, Modal } from '../../components/ui';
import { invalidateWorkspace } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
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

/** Import tasks from a CSV file in three steps: choose the file, match its columns, see the result. */
export function ImportModal({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const wid = useWorkspaceId();
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
  const options = { skipInvalid, createMissingLabels: createLabels, dateFormat };

  const choose = async (f: File) => {
    setFile(f); setError(null); setBusy(true);
    try {
      const p = await importApi.preview(projectId, f, undefined, options);
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
        const p = await importApi.preview(projectId, file, mappingJson(mapping), options);
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
      const r = await importApi.run(projectId, file, mappingJson(mapping), options);
      setResult(r);
      toast(`${r.created} task${r.created === 1 ? '' : 's'} imported.`);
      void invalidateWorkspace(wid);
    } catch (e) { setError(e instanceof ApiError ? e.errors[0]?.message ?? e.message : 'The import failed.'); }
    finally { setBusy(false); }
  };

  const downloadTemplate = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + TEMPLATE], { type: 'text/csv' }));
    a.download = 'tasks-template.csv'; a.click(); URL.revokeObjectURL(a.href);
  };

  const canImport = !!preview && mapping.title !== undefined && mapping.title !== '' && preview.validRows > 0 && (preview.invalidRows === 0 || skipInvalid) && !checking && !busy;

  // ---------------------------------------------------------------- step 3: result
  if (result) {
    return (
      <Modal size="lg" title="Import finished" onClose={onClose} footer={<button type="button" className="btn btn-primary" onClick={onClose}>Done</button>}>
        <p style={{ marginTop: 0 }}><b>{result.created}</b> task{result.created === 1 ? '' : 's'} imported{result.labelsCreated ? `, ${result.labelsCreated} new label${result.labelsCreated === 1 ? '' : 's'} created` : ''}.
          {result.skipped > 0 && <> <b>{result.skipped}</b> row{result.skipped === 1 ? ' was' : 's were'} skipped.</>}</p>
        {result.errors.length > 0 && <ErrorList errors={result.errors} />}
      </Modal>
    );
  }

  // ---------------------------------------------------------------- step 1: choose a file
  if (!preview) {
    return (
      <Modal size="sm" title="Import tasks from CSV" onClose={onClose} footer={<button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>}>
        {error && <div className="form-error" role="alert">{error}</div>}
        <p className="muted" style={{ marginTop: 0 }}>Choose a CSV file exported from a spreadsheet or another tool. You will match its columns to task fields and see any problems before anything is imported.</p>
        <label className="dropzone">
          <Icon name="upload" size={22} />
          <span>{busy ? 'Reading the file…' : 'Choose a .csv file'}</span>
          <input type="file" accept=".csv,text/csv,text/plain" hidden disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; if (f) void choose(f); e.target.value = ''; }} />
        </label>
        <p style={{ fontSize: 12.5 }}>Up to 5,000 rows and 2 MB. <button type="button" className="link" onClick={downloadTemplate}>Download a template</button></p>
      </Modal>
    );
  }

  // ---------------------------------------------------------------- step 2: match columns
  return (
    <Modal size="lg" title="Import tasks from CSV" subtitle={`${file?.name} · ${preview.totalRows} row${preview.totalRows === 1 ? '' : 's'}`} onClose={onClose}
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
        {checking ? 'Checking…' : preview.validRows === 0 && preview.invalidRows === 0 ? 'Nothing to import yet.' : (
          <><b>{preview.validRows}</b> of {preview.totalRows} rows are ready{preview.invalidRows > 0 ? <> · <b>{preview.invalidRows}</b> have problems{skipInvalid ? ' and will be skipped' : ''}</> : ''}{preview.newLabels > 0 ? ` · ${preview.newLabels} new label${preview.newLabels === 1 ? '' : 's'}` : ''}</>
        )}
      </div>
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
