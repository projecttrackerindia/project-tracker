import { useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ApiError, download } from '../../api/client';
import { documentApi } from '../../api/endpoints';
import { Icon } from '../../components/Icon';
import { formatBytes, timeAgo } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';

/** Files that belong to a document (pictures for the text, specifications, spreadsheets). */
export function DocumentFiles({ documentId, canEdit }: { documentId: string; canEdit: boolean }) {
  const wid = useWorkspaceId();
  const q = useWsQuery(['documents', documentId, 'files'], () => documentApi.files(documentId));
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const refresh = () => invalidateWorkspace(wid, 'documents');
  const upload = useMutation({
    mutationFn: async (files: File[]) => { for (const f of files) await documentApi.uploadFile(documentId, f); },
    onSuccess: () => { refresh(); toast('File added.'); },
    onError: (e) => { refresh(); toast(e instanceof ApiError ? e.message : 'Could not add the file.', 'error'); },
  });
  const items = q.data ?? [];
  return (
    <div className={`card doc-side-card${over ? ' drop' : ''}`}
      onDragOver={canEdit ? (e) => { e.preventDefault(); setOver(true); } : undefined} onDragLeave={() => setOver(false)}
      onDrop={canEdit ? (e) => { e.preventDefault(); setOver(false); const files = Array.from(e.dataTransfer.files); if (files.length) upload.mutate(files); } : undefined}>
      <div className="card-head">
        <div><h3>Files</h3><p>Pictures, specifications and other attachments.</p></div>
        {canEdit && <><input ref={input} type="file" hidden multiple onChange={(e) => { const f = Array.from(e.target.files ?? []); e.target.value = ''; if (f.length) upload.mutate(f); }} />
          <button className="btn btn-ghost btn-sm" onClick={() => input.current?.click()} disabled={upload.isPending}>{upload.isPending ? <span className="spinner" /> : <Icon name="upload" size={15} />} Add</button></>}
      </div>
      <div className="card-body">
        {q.isLoading ? <p className="muted">Loading…</p> : items.length === 0 ? <p className="muted">{canEdit ? 'Drop files here or choose Add.' : 'No files.'}</p> : (
          <ul className="doc-files">
            {items.map((f) => (
              <li key={f.id}>
                <Icon name={f.isImage ? 'image' : 'paperclip'} size={16} />
                <button className="link-btn" onClick={() => download(`/documents/${documentId}/files/${f.id}/download`, f.fileName).catch(() => toast('Could not download the file.', 'error'))}>{f.fileName}</button>
                <span className="muted">{formatBytes(f.sizeBytes)} · {timeAgo(f.createdAt)}</span>
                {f.canDelete && <button className="btn-icon danger" aria-label={`Remove ${f.fileName}`} onClick={async () => {
                  if (!(await confirmDialog({ title: 'Remove this file?', message: `“${f.fileName}” is removed from the document. A picture in the text will stop showing.`, confirmText: 'Remove' }))) return;
                  try { await documentApi.removeFile(documentId, f.id); refresh(); } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not remove.', 'error'); }
                }}><Icon name="close" size={14} /></button>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
