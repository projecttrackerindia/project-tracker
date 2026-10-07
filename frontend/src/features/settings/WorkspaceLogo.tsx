import { useEffect, useRef, useState } from 'react';
import { ApiError, fetchBlobUrl } from '../../api/client';
import { workspaceApi } from '../../api/endpoints';
import { Icon } from '../../components/Icon';
import { useWsQuery, invalidateWorkspace } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';

/** The logo printed on the cover and every page of document PDFs. PNG or JPEG, up to 1 MB. */
export function WorkspaceLogoCard({ canEdit }: { canEdit: boolean }) {
  const wid = useWorkspaceId();
  const q = useWsQuery(['workspace-logo'], workspaceApi.logo);
  const [src, setSrc] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const has = q.data?.hasLogo;
  useEffect(() => {
    if (!has) { setSrc(null); return; }
    let url: string | null = null; let live = true;
    fetchBlobUrl('/workspace/logo/file').then((u) => { if (live) { url = u; setSrc(u); } else URL.revokeObjectURL(u); }).catch(() => undefined);
    return () => { live = false; if (url) URL.revokeObjectURL(url); };
  }, [has, q.dataUpdatedAt]);
  const upload = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true);
    try { await workspaceApi.uploadLogo(f); invalidateWorkspace(wid, 'workspace-logo'); toast('Logo saved.'); } catch (e) { toast(e instanceof ApiError ? e.errors[0]?.message ?? e.message : 'Could not save the logo.', 'error'); } finally { setBusy(false); }
  };
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="card-head"><div><h3>Logo</h3><p>Printed on the cover and every page of document PDFs.</p></div></div>
      <div className="card-body logo-card">
        <div className={`logo-drop${over ? ' over' : ''}${canEdit ? '' : ' ro'}`}
          onDragOver={canEdit ? (e) => { e.preventDefault(); setOver(true); } : undefined} onDragLeave={() => setOver(false)}
          onDrop={canEdit ? (e) => { e.preventDefault(); setOver(false); void upload(e.dataTransfer.files?.[0]); } : undefined}
          onClick={canEdit ? () => input.current?.click() : undefined} role={canEdit ? 'button' : undefined} tabIndex={canEdit ? 0 : undefined} aria-label={canEdit ? 'Choose a logo' : undefined}>
          {src ? <img src={src} alt="Workspace logo" /> : <span className="muted"><Icon name="image" size={22} /> {canEdit ? 'Drop a PNG or JPEG here' : 'No logo'}</span>}
        </div>
        {canEdit && (
          <div className="logo-actions">
            <input ref={input} type="file" hidden accept="image/png,image/jpeg" onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = ''; }} />
            <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => input.current?.click()}>{busy ? <span className="spinner" /> : <Icon name="upload" size={14} />} {has ? 'Replace' : 'Upload'}</button>
            {has && <button className="btn btn-ghost btn-sm danger" disabled={busy} onClick={async () => { if (await confirmDialog({ title: 'Remove the logo?', message: 'PDFs will show the workspace name only.', confirmText: 'Remove' })) { await workspaceApi.removeLogo(); invalidateWorkspace(wid, 'workspace-logo'); } }}>Remove</button>}
            <small className="muted">A wide logo on a transparent or white background works best. Up to 1 MB.</small>
          </div>
        )}
      </div>
    </div>
  );
}
