import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, uploadFile } from '../../api/client';
import { attachmentApi } from '../../api/endpoints';
import type { Attachment } from '../../api/types';
import { Icon, type IconName } from '../../components/Icon';
import { Avatar, EmptyState } from '../../components/ui';
import { formatBytes, timeAgo } from '../../lib/format';
import { useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';

const ICONS: [RegExp, IconName][] = [
  [/^image\//, 'image'], [/pdf/, 'note'], [/zip|compressed/, 'layers'],
  [/sheet|excel|csv/, 'grid'], [/word|document/, 'note'], [/presentation|powerpoint/, 'monitor'],
];
const iconFor = (type: string) => ICONS.find(([re]) => re.test(type))?.[1] ?? 'note';

/** Files on a task (taskId given), on a test issue (issueId given) or on the project itself. Upload by picking a file or dropping one here. */
export function Attachments({ projectId, taskId, issueId, canEdit, compact }: { projectId: string; taskId?: string; issueId?: string; canEdit: boolean; compact?: boolean }) {
  const wid = useWorkspaceId();
  const qc = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const key = ['attachments', projectId, issueId ? `issue:${issueId}` : taskId ?? 'project'];
  const q = useWsQuery(key, () => attachmentApi.list(projectId, taskId, issueId));
  const limits = useWsQuery(['attachments', 'limits'], attachmentApi.limits);
  const files = q.data ?? [];
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: [wid, ...key] }); void qc.invalidateQueries({ queryKey: [wid, 'attachments', 'limits'] });
    if (issueId) void qc.invalidateQueries({ queryKey: [wid, 'issues', projectId] });   // the issue list shows how many files each has
  };

  const send = async (list: FileList | null) => {
    if (!list?.length || !canEdit) return;
    setError(null);
    for (const file of Array.from(list)) {
      if (limits.data && file.size > limits.data.maxFileBytes) {
        setError(`“${file.name}” is ${formatBytes(file.size)}. Your plan allows files up to ${formatBytes(limits.data.maxFileBytes)}.`);
        continue;
      }
      setBusy(file.name);
      try { await uploadFile(attachmentApi.uploadPath(projectId, taskId, issueId), file); refresh(); }
      catch (e) { setError(e instanceof ApiError ? e.message : `Could not upload “${file.name}”.`); }
      finally { setBusy(null); }
    }
    if (input.current) input.current.value = '';
  };

  const remove = async (f: Attachment) => {
    if (!(await confirmDialog({ title: 'Remove file?', message: `“${f.fileName}” will be deleted for everyone.`, confirmText: 'Remove' }))) return;
    try { await attachmentApi.remove(f.id); toast('File removed.', 'warning'); refresh(); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Could not remove the file.', 'error'); }
  };

  const download = async (f: Attachment) => {
    try { await attachmentApi.download(f.id, f.fileName); }
    catch { toast('Could not download the file.', 'error'); }
  };

  const list = (
    <div className={`file-list ${dragging ? 'drag-over' : ''}`}
      onDragOver={(e) => { if (canEdit && e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false); }}
      onDrop={(e) => { if (!canEdit) return; e.preventDefault(); setDragging(false); void send(e.dataTransfer.files); }}>
      {error && <div className="form-error" role="alert">{error}</div>}
      {files.length === 0 && !busy && (
        compact
          ? <p className="muted" style={{ fontSize: 12.5, margin: '4px 0' }}>{canEdit ? 'No files yet — drop one here or use “Add file”.' : 'No files yet.'}</p>
          : <EmptyState icon="folder" title="No files yet" text={canEdit ? 'Drop files here, or use “Add file”.' : 'Nobody has attached a file to this project yet.'} />
      )}
      {files.map((f) => (
        <div className="file-item" key={f.id}>
          {f.isImage
            ? <button type="button" className="file-thumb" onClick={() => void download(f)} title={`Open ${f.fileName}`}><Thumb id={f.id} /></button>
            : <span className="file-ico"><Icon name={iconFor(f.contentType)} /></span>}
          <div className="file-main">
            <button type="button" className="file-name" onClick={() => void download(f)} title={`Download ${f.fileName}`}>{f.fileName}</button>
            <div className="file-meta">
              {formatBytes(f.sizeBytes)}
              {f.taskKey && !taskId && <> · <span className="file-task">{f.taskKey}</span></>}
              {f.uploadedBy && <> · <Avatar name={f.uploadedBy.name} size="sm" /> {f.uploadedBy.name}</>}
              {' '}· {timeAgo(f.createdAt)}
            </div>
          </div>
          <div className="td-actions">
            <button type="button" className="btn-icon" title="Download" aria-label={`Download ${f.fileName}`} onClick={() => void download(f)}><Icon name="download" /></button>
            {f.canDelete && <button type="button" className="btn-icon danger" title="Remove" aria-label={`Remove ${f.fileName}`} onClick={() => void remove(f)}><Icon name="trash" /></button>}
          </div>
        </div>
      ))}
      {busy && <div className="file-item uploading"><span className="spinner" /><div className="file-main"><div className="file-name">{busy}</div><div className="file-meta">Uploading…</div></div></div>}
    </div>
  );

  const picker = canEdit && (
    <>
      <input ref={input} type="file" multiple hidden onChange={(e) => void send(e.target.files)}
        accept={limits.data?.allowedExtensions.map((e) => `.${e}`).join(',')} />
      <button type="button" className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => input.current?.click()}><Icon name="upload" /> Add file</button>
    </>
  );

  if (compact) {
    return (
      <div className="form-section">
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
          <h4 className="section-title">Files {files.length > 0 && <span className="kb-count">{files.length}</span>}</h4>
          {picker}
        </div>
        {list}
      </div>
    );
  }

  return (
    <div className="card">
      <div className="card-head">
        <div><h3>Files</h3><p>{files.length ? `${files.length} file${files.length === 1 ? '' : 's'}` : 'Attach specs, designs and documents'}{limits.data && limits.data.storageLimitBytes >= 0 ? ` · ${formatBytes(limits.data.storageUsedBytes)} of ${formatBytes(limits.data.storageLimitBytes)} used` : ''}</p></div>
        {picker}
      </div>
      <div className="card-body">{list}</div>
    </div>
  );
}

/** Image preview. The file is protected, so it is fetched with the token rather than linked directly. */
function Thumb({ id }: { id: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    let objectUrl: string | null = null;
    attachmentApi.inlineBlob(id, abort.signal).then((u) => { objectUrl = u; setUrl(u); }).catch(() => { /* preview is optional */ });
    return () => { abort.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [id]);
  return url ? <img src={url} alt="" /> : <span className="thumb-skeleton" />;
}
