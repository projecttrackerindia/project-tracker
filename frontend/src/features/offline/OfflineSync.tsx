import { useEffect, useState } from 'react';
import { refreshSession, replayQueued, setQueuedHandler } from '../../api/client';
import { dropQueued, flushOutbox, giveReason, idOfPath, onOutbox, patchById as patchSync } from '../../lib/outbox';
import { queryClient, useAuth } from '../../stores/auth';
import { toast } from '../../stores/ui';
import './offline.css';

/** Applies a queued edit to every cached answer of this workspace that holds the edited item, and returns the optimistic copy. */
function applyQueued(method: string, path: string, body: unknown, workspaceId: string | null): unknown {
  const id = idOfPath(path);
  const fields = body && typeof body === 'object' ? { ...(body as Record<string, unknown>) } : {};
  delete fields.version;
  if (method === 'DELETE' || !id) return method === 'POST' && !id ? { ...fields, id: `offline-${Date.now().toString(36)}`, pendingSync: true } : undefined;
  if (/\/done$/.test(path)) Object.assign(fields, { isDone: true, status: 'Done' });
  if (/\/reopen$/.test(path)) Object.assign(fields, { isDone: false });
  let hit: unknown = null;
  for (const q of queryClient.getQueryCache().getAll()) {
    if (workspaceId && q.queryKey[0] !== workspaceId) continue;
    const data = q.state.data;
    if (data === undefined) continue;
    let next: unknown = data;
    const r = patchSync(data, id, fields);
    next = r.data; hit ??= r.hit;
    if (next !== data) queryClient.setQueryData(q.queryKey, next);
  }
  return hit ?? { ...fields, id };
}

/**
 * Keeps the phone useful without a connection: a calm pill says it is offline (and how many edits wait), queued edits are sent as soon as
 * it is back, and an edit the server had a newer copy of gives way with a "changed elsewhere" notice. Started without a connection, the
 * session is renewed and the context reloaded when it returns.
 */
export function OfflineSync({ phone = false }: { phone?: boolean }) {
  const [state, setState] = useState({ pending: 0, online: typeof navigator === 'undefined' ? true : navigator.onLine });
  useEffect(() => {
    setQueuedHandler(applyQueued);
    const off = onOutbox(setState);
    const flush = async () => {
      if (!navigator.onLine) return;
      if (useAuth.getState().offlineSession) {
        const auth = await refreshSession();
        if (!auth) return;
        useAuth.setState({ offlineSession: false });
        await useAuth.getState().reloadContext().catch(() => undefined);
      }
      const r = await flushOutbox(replayQueued);
      if (r.conflicts) toast(r.conflicts === 1 ? 'One edit changed elsewhere - the newer version is shown' : `${r.conflicts} edits changed elsewhere - the newer versions are shown`, 'info');
      else if (r.sent) toast(r.sent === 1 ? 'Your offline edit is saved' : `${r.sent} offline edits saved`);
      for (const e of r.needReason) {
        toast('A date you pushed later offline needs a reason', 'warning', { label: 'Add reason', onClick: () => {
          const reason = window.prompt('Reason for extending')?.trim();
          if (reason) void giveReason(e.id, reason).then(flush); else void dropQueued(e.id).then(() => queryClient.invalidateQueries());
        } });
      }
      if (r.sent || r.conflicts || r.rejected) void queryClient.invalidateQueries();
    };
    window.addEventListener('online', flush);
    void flush();
    return () => { off(); setQueuedHandler(null); window.removeEventListener('online', flush); };
  }, []);
  if (state.online && state.pending === 0) return null;
  return (
    <div className={`offline-pill ${phone ? 'm' : ''}`} role="status" aria-live="polite" data-testid="offline-pill">
      <span className={`offline-dot ${state.online ? 'sync' : ''}`} aria-hidden />
      {state.online ? `Syncing ${state.pending} edit${state.pending === 1 ? '' : 's'}…`
        : state.pending ? `Offline · ${state.pending} edit${state.pending === 1 ? '' : 's'} will sync` : 'Offline · showing saved work'}
    </div>
  );
}
