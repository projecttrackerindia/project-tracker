import { useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import { meApi } from '../../api/endpoints';
import { Avatar, invalidateAvatarCache } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { confirmDialog, toast } from '../../stores/ui';
import { useAuth } from '../../stores/auth';

/** Your own photo, shown wherever you appear across the app (chat, teams, profile cards). PNG or JPEG, up to 3 MB. */
export function ProfilePhotoCard() {
  const ctx = useAuth((s) => s.ctx)!;
  const reload = useAuth((s) => s.reloadContext);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const has = ctx.user.hasAvatar;

  const upload = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true);
    try {
      await meApi.setAvatar(f);
      invalidateAvatarCache(ctx.user.id);
      toast('Photo saved.');
      await reload();
    } catch (e) {
      toast(e instanceof ApiError ? e.errors[0]?.message ?? e.message : 'Could not save the photo.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!(await confirmDialog({ title: 'Remove your photo?', message: 'Your initials will show instead.', confirmText: 'Remove' }))) return;
    setBusy(true);
    try { await meApi.removeAvatar(); invalidateAvatarCache(ctx.user.id); await reload(); } finally { setBusy(false); }
  };

  return (
    <div className="card mb-22">
      <div className="card-head"><div><h3>Profile photo</h3><p>Shown next to your name throughout the app.</p></div></div>
      <div className="card-body logo-card">
        <div className={`logo-drop photo-drop${over ? ' over' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
          onDrop={(e) => { e.preventDefault(); setOver(false); void upload(e.dataTransfer.files?.[0]); }}
          onClick={() => input.current?.click()} role="button" tabIndex={0} aria-label="Choose a photo">
          <Avatar name={ctx.user.displayName} size="lg" userId={ctx.user.id} hasAvatar={has} />
        </div>
        <div className="logo-actions">
          <input ref={input} type="file" hidden accept="image/png,image/jpeg" onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = ''; }} />
          <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => input.current?.click()}>{busy ? <span className="spinner" /> : <Icon name="upload" size={14} />} {has ? 'Replace' : 'Upload'}</button>
          {has && <button className="btn btn-ghost btn-sm danger" disabled={busy} onClick={remove}>Remove</button>}
          <small className="muted">A square, well-lit photo works best. Up to 3 MB.</small>
        </div>
      </div>
    </div>
  );
}
