import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { passkeyApi } from '../../api/endpoints';
import { Icon } from '../../components/Icon';
import { timeAgo } from '../../lib/format';
import { createPasskey, passkeysSupported, wasCancelled } from '../../lib/passkeys';
import { queryClient } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';

const KEY = ['me', 'passkeys'];

/** A name to start from, so a list of passkeys reads as devices and not as "Passkey, Passkey, Passkey". */
const deviceName = () => {
  const ua = navigator.userAgent;
  const os = /Android/.test(ua) ? 'Android phone' : /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Mac OS/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows PC' : /Linux/.test(ua) ? 'Linux computer' : 'This device';
  return os;
};

/** Settings → Security: sign in with the device's fingerprint, face or screen lock. No plan needed: it is safety, not a feature to sell. */
export function PasskeysRow() {
  const list = useQuery({ queryKey: KEY, queryFn: passkeyApi.list, enabled: passkeysSupported() });
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState('');
  const add = useMutation({
    mutationFn: async () => {
      const { challengeId, options } = await passkeyApi.registerOptions();
      const response = await createPasskey(options);
      return passkeyApi.add(challengeId, response, deviceName());
    },
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: KEY }); toast('Passkey added. Next time, sign in with your fingerprint or face.'); },
    onError: (e) => { if (!wasCancelled(e)) toast(e instanceof ApiError ? e.message : 'Could not add a passkey on this device.', 'error'); },
  });
  const rename = useMutation({
    mutationFn: (v: { id: string; name: string }) => passkeyApi.rename(v.id, v.name),
    onSuccess: () => { setEditing(null); void queryClient.invalidateQueries({ queryKey: KEY }); },
    onError: (e) => toast(e instanceof ApiError ? e.message : 'Could not rename it.', 'error'),
  });
  const remove = async (id: string, label: string) => {
    if (!(await confirmDialog({ title: 'Remove this passkey?', confirmText: 'Remove', danger: true, message: `${label} will no longer sign you in. You can add it again later.` }))) return;
    await passkeyApi.remove(id); void queryClient.invalidateQueries({ queryKey: KEY }); toast('Passkey removed.', 'warning');
  };

  return (
    <div className="setting-row" style={{ alignItems: 'flex-start' }}>
      <div className="setting-info" style={{ flex: 1 }}>
        <h4>Passkeys</h4>
        <p>Sign in with your fingerprint, face or screen lock. Nothing to type, nothing to steal: a passkey only works on this site and counts as two-step verification.</p>
        {!passkeysSupported() ? <p className="muted" style={{ marginTop: 8 }}>This browser cannot create passkeys here. Use a current Chrome, Edge, Safari or Firefox on an https address.</p> : (
          <div className="pk-list">
            {list.data?.map((p) => (
              <div className="pk-item" key={p.id}>
                <span className="pk-ico"><Icon name="key" size={17} /></span>
                {editing === p.id ? (
                  <form className="pk-edit" onSubmit={(e) => { e.preventDefault(); if (name.trim()) rename.mutate({ id: p.id, name: name.trim() }); }}>
                    <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus aria-label="Passkey name" />
                    <button className="btn btn-primary btn-sm" disabled={rename.isPending}>Save</button>
                  </form>
                ) : (
                  <div className="pk-main"><b>{p.name}</b><small>{p.lastUsedAt ? `Used ${timeAgo(p.lastUsedAt)}` : 'Not used yet'} · added {timeAgo(p.createdAt)}{p.backedUp ? ' · synced' : ''}</small></div>
                )}
                {editing !== p.id && <>
                  <button className="btn btn-ghost btn-sm" onClick={() => { setEditing(p.id); setName(p.name); }}>Rename</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => void remove(p.id, p.name)} aria-label={`Remove ${p.name}`}><Icon name="trash" size={15} /></button>
                </>}
              </div>
            ))}
            <button className="btn btn-primary" disabled={add.isPending} onClick={() => add.mutate()}>{add.isPending && <span className="spinner" />}<Icon name="plus" size={16} />Add a passkey</button>
          </div>
        )}
      </div>
    </div>
  );
}
