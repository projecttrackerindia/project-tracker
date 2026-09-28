import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { apiKeyApi } from '../../api/endpoints';
import type { ApiKey } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Badge, EmptyState, Field, Modal, SubmitButton } from '../../components/ui';
import { formatDate, timeAgo } from '../../lib/format';
import { useWsQuery } from '../../lib/hooks';
import { useAuth, useEntitlement, useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
import { Select } from '../../components/Select';

const tone = (s: string) => (s === 'Active' ? 'success' : s === 'Revoked' ? 'danger' : 'neutral');

/** Settings → API keys: secrets for scripts and integrations. Owners and admins only. */
export function ApiKeySettings() {
  const wid = useWorkspaceId();
  const qc = useQueryClient();
  const role = useAuth((s) => s.ctx?.current?.role);
  const included = useEntitlement('API_ACCESS') > 0;
  const isAdmin = role === 'Owner' || role === 'Admin';
  const q = useWsQuery(['api-keys'], apiKeyApi.list, { enabled: isAdmin && included });
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const keys = q.data ?? [];
  const refresh = () => void qc.invalidateQueries({ queryKey: [wid, 'api-keys'] });

  if (!isAdmin) return null;

  const revoke = async (k: ApiKey) => {
    if (!(await confirmDialog({ title: 'Revoke key?', message: `Anything using “${k.name}” (${k.prefix}…) stops working immediately.`, confirmText: 'Revoke' }))) return;
    try { await apiKeyApi.revoke(k.id); toast('Key revoked.', 'warning'); refresh(); } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not revoke the key.', 'error'); }
  };

  return (
    <div className="card mb-22">
      <div className="card-head">
        <div><h3>API keys</h3><p>Let scripts and other tools read or change this workspace's data, acting as the person who created the key.</p></div>
        {included && <button className="btn btn-primary btn-sm" onClick={() => setCreating(true)}><Icon name="plus" size={14} /> New key</button>}
      </div>
      <div className="card-body">
        {!included && <div className="notice">API keys are part of the Business plan and above. <Link className="link" to="/billing">See plans</Link></div>}
        {included && keys.length === 0 && !q.isLoading && <EmptyState icon="lock" title="No API keys" text="Create a key for each tool so you can revoke them separately." />}
        {keys.length > 0 && (
          <div className="cf-list">
            {keys.map((k) => (
              <div className="cf-row" key={k.id}>
                <div className="cf-main">
                  <b>{k.name}</b> <Badge tone={tone(k.status)}>{k.status}</Badge> <Badge tone={k.scope === 'ReadWrite' ? 'warning' : 'info'}>{k.scope === 'ReadWrite' ? 'Read & write' : 'Read only'}</Badge>
                  <div className="muted" style={{ fontSize: 12 }}>
                    <code>{k.prefix}…</code> · by {k.owner} · created {formatDate(k.createdAt)} · {k.expiresAt ? `expires ${formatDate(k.expiresAt)}` : 'no expiry'} · {k.lastUsedAt ? `last used ${timeAgo(k.lastUsedAt)}${k.lastUsedIp ? ` from ${k.lastUsedIp}` : ''}` : 'never used'}
                  </div>
                </div>
                {k.status === 'Active' && <button type="button" className="btn btn-ghost btn-sm" onClick={() => void revoke(k)}>Revoke</button>}
              </div>
            ))}
          </div>
        )}
      </div>
      {creating && <CreateModal onClose={() => setCreating(false)} onCreated={(s) => { setCreating(false); setSecret(s); refresh(); }} />}
      {secret && <SecretModal secret={secret} onClose={() => setSecret(null)} />}
    </div>
  );
}

function CreateModal({ onClose, onCreated }: { onClose: () => void; onCreated: (secret: string) => void }) {
  const [name, setName] = useState('');
  const [scope, setScope] = useState<'ReadOnly' | 'ReadWrite'>('ReadOnly');
  const [days, setDays] = useState('90');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!name.trim()) return setError('Name the tool that will use this key.');
    setBusy(true); setError(null);
    try { const r = await apiKeyApi.create({ name: name.trim(), scope, expiresInDays: days === '' ? null : Number(days) }); onCreated(r.secret); }
    catch (e) { setError(e instanceof ApiError ? e.errors[0]?.message ?? e.message : 'Could not create the key.'); }
    finally { setBusy(false); }
  };

  return (
    <Modal size="sm" title="New API key" onClose={onClose} onSubmit={(e) => { e.preventDefault(); void submit(); }}
      footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><SubmitButton busy={busy}>Create key</SubmitButton></>}>
      {error && <div className="form-error" role="alert">{error}</div>}
      <Field label="Name" required hint="For example “Nightly report script”."><input className="input" maxLength={60} autoFocus value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="Access" hint="Read & write can do everything you can do in this workspace, except manage keys, billing and accounts.">
        <Select className="select" value={scope} onChange={(e) => setScope(e.target.value as 'ReadOnly' | 'ReadWrite')}>
          <option value="ReadOnly">Read only</option><option value="ReadWrite">Read & write</option>
        </Select>
      </Field>
      <Field label="Expires">
        <Select className="select" value={days} onChange={(e) => setDays(e.target.value)}>
          <option value="30">In 30 days</option><option value="90">In 90 days</option><option value="365">In a year</option><option value="">Never</option>
        </Select>
      </Field>
    </Modal>
  );
}

function SecretModal({ secret, onClose }: { secret: string; onClose: () => void }) {
  const example = `curl -H "Authorization: Bearer ${secret}" ${window.location.origin}/api/v1/projects`;
  return (
    <Modal size="sm" title="Copy your key now" onClose={onClose} footer={<button type="button" className="btn btn-primary" onClick={onClose}>I've stored it</button>}>
      <p className="muted" style={{ marginTop: 0 }}>This is the only time the full key is shown. Store it like a password; if it leaks, revoke it.</p>
      <div className="secret-box"><code>{secret}</code></div>
      <button type="button" className="btn btn-ghost btn-sm" style={{ marginTop: 8 }} onClick={() => { void navigator.clipboard?.writeText(secret); toast('Key copied.'); }}>Copy key</button>
      <p className="muted" style={{ fontSize: 12.5, marginBottom: 4 }}>Try it:</p>
      <pre className="secret-box" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: 11.5 }}>{example}</pre>
    </Modal>
  );
}
