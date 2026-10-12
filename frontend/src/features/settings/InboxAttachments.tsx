import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, download } from '../../api/client';
import { personalInboxApi } from '../../api/endpoints.platform';
import type { InboxAttachment, InboxAttachments as Files } from '../../api/types';

export function InboxAttachments({ provider, messageId }: { provider: 'google' | 'microsoft'; messageId: string }) {
  const [files, setFiles] = useState<Files | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  const retire = useCallback(() => { sequence.current++; request.current?.abort(); }, []);
  useEffect(() => retire, [retire]);
  const size = (bytes: number) => bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} KiB`;
  const read = async (file?: InboxAttachment) => {
    if (busy || file && !file.downloadToken) return;
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    const current = ++sequence.current; setBusy(true); setError('');
    try {
      if (file) await download('/me/inbox/attachments/download?token=' + encodeURIComponent(file.downloadToken!), file.name, controller.signal);
      else { const result = await personalInboxApi.attachments(provider, messageId, controller.signal); if (current === sequence.current) setFiles(result); }
    } catch (e) { if (current === sequence.current && !controller.signal.aborted) setError(e instanceof ApiError ? e.errors[0]?.message ?? e.message : 'The attachment could not be retrieved. Reload its list and try again.'); }
    finally { if (current === sequence.current) setBusy(false); }
  };
  return <section className="inbox-attachments" aria-label="Message attachments" aria-busy={busy}>
    <header><strong>Attachments</strong><button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void read()}>{files ? 'Reload attachments' : 'Show attachment list'}</button></header>
    <p>Files download only when you choose them. They are not opened or shared with AI. Downloads up to 2 MiB.</p>
    {error && <p className="inbox-summary-error" role="alert">{error}</p>}
    {files && <>{files.truncated && <p role="status">This is a limited list. Open your mail provider for additional attachments.</p>}{!files.files.length ? <p>No downloadable attachments in this message.</p> : files.files.map((file, index) => <div className="inbox-attachment-file" key={index}><div><strong>{file.name}</strong><span>{size(file.size)}{file.inline ? ' / inline file' : ''}</span>{file.unavailableReason && <small>{file.unavailableReason}</small>}</div><button className="btn btn-sm" disabled={busy || !file.downloadToken} onClick={() => void read(file)} aria-label={`Download ${file.name}`}>Download</button></div>)}</>}
  </section>;
}
