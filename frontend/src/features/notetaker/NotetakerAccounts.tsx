import { useState } from 'react';
import { ApiError } from '../../api/client';
import { Icon } from '../../components/Icon';
import { Badge, Modal, Spinner } from '../../components/ui';
import { timeAgo } from '../../lib/format';
import { useWsQuery } from '../../lib/hooks';
import { confirmDialog, toast } from '../../stores/ui';
import { notetakerApi } from './notetakerApi';
import type { BotIdentity } from './notetakerApi';

const err = (e: unknown, fallback: string) => (e instanceof ApiError ? e.errors[0]?.message ?? e.message : fallback);

/**
 * Platform administration › System health: the Google accounts the meeting bot joins calls as. Signed in as a real account, the bot is let
 * straight into the company's own calls instead of waiting to be admitted as a guest.
 */
export function NotetakerAccountsCard() {
  const q = useWsQuery(['admin', 'notetaker-accounts'], notetakerApi.identities);
  const [editing, setEditing] = useState<BotIdentity | 'new' | null>(null);
  const toggle = async (i: BotIdentity) => {
    try { await notetakerApi.setIdentityActive(i.id, !i.active); await q.refetch(); } catch (e) { toast(err(e, 'Could not change it.'), 'error'); }
  };
  const remove = async (i: BotIdentity) => {
    if (!(await confirmDialog({ title: `Remove ${i.email}?`, message: 'Its stored cookies are deleted. The bot joins as a guest until another account is added.', confirmText: 'Remove', danger: true }))) return;
    try { await notetakerApi.removeIdentity(i.id); await q.refetch(); } catch (e) { toast(err(e, 'Could not remove it.'), 'error'); }
  };
  return (
    <div className="card mb-18" data-notetaker-accounts>
      <div className="card-head">
        <div><h3>Notetaker accounts</h3><p>Google accounts the bot joins Meet calls as. In your company's calls a signed-in account is let in without waiting.</p></div>
        <button className="btn btn-sm btn-primary" onClick={() => setEditing('new')}><Icon name="plus" size={14} /> Add account</button>
      </div>
      <div className="card-body">
        {!q.data || q.data.length === 0 ? <p className="muted" style={{ margin: 0 }}>No account yet: the bot joins as a guest and the host has to let it in.</p> : (
          <div className="table-wrap"><table>
            <thead><tr><th>Account</th><th>Shown as</th><th>State</th><th>Last used</th><th /></tr></thead>
            <tbody>{q.data.map((i) => (
              <tr key={i.id}><td>{i.email}</td><td>{i.displayName}</td>
                <td>{i.lastError ? <Badge tone="danger">Signed out</Badge> : i.active ? <Badge tone="success">In use</Badge> : <Badge tone="neutral">Paused</Badge>}
                  {i.lastError && <div className="muted" style={{ fontSize: 12 }}>{i.lastError}</div>}</td>
                <td className="muted">{i.lastUsedAt ? timeAgo(i.lastUsedAt) : '—'}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <button className="btn btn-sm" onClick={() => setEditing(i)}>{i.lastError ? 'Sign in again' : 'Update cookies'}</button>{' '}
                  <button className="btn btn-sm btn-ghost" onClick={() => void toggle(i)}>{i.active ? 'Pause' : 'Use'}</button>{' '}
                  <button className="btn btn-sm btn-ghost" onClick={() => void remove(i)}>Remove</button>
                </td></tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
      {editing && <IdentityModal identity={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void q.refetch(); }} />}
    </div>
  );
}

function IdentityModal({ identity, onClose, onSaved }: { identity: BotIdentity | null; onClose: () => void; onSaved: () => void }) {
  const [email, setEmail] = useState(identity?.email ?? '');
  const [name, setName] = useState(identity?.displayName ?? 'Aura Notetaker');
  const [cookies, setCookies] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try { await notetakerApi.saveIdentity({ email, displayName: name, cookies }, identity?.id); toast('Notetaker account saved.'); onSaved(); }
    catch (e) { toast(err(e, 'Could not save the account.'), 'error'); }
    finally { setBusy(false); }
  };
  return (
    <Modal title={identity ? `Sign in ${identity.email} again` : 'Add a notetaker account'} onClose={onClose} size="lg"
      footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy || !email || !name || !cookies.trim()} onClick={() => void save()}>{busy ? <Spinner /> : null} Save</button></>}>
      <ol className="nt-steps">
        <li>Create a Google Workspace user for the bot, for example <code>notetaker@yourcompany.com</code>, named the way it should appear in calls.</li>
        <li>In a private Chrome window, sign in to that account at <b>meet.google.com</b> (finish any 2-step check there yourself).</li>
        <li>With the <b>Cookie-Editor</b> extension, choose <b>Export › JSON</b> on meet.google.com and paste it below. Then close the window without signing out.</li>
      </ol>
      <div className="nt-mail">
        <label className="nt-field"><span>Account email</span><input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="notetaker@yourcompany.com" autoComplete="off" /></label>
        <label className="nt-field"><span>Name shown in calls</span><input value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="nt-field"><span>Exported cookies (JSON)</span><textarea rows={8} value={cookies} onChange={(e) => setCookies(e.target.value)} placeholder='[{"name":"SID","value":"…","domain":".google.com",…}]' spellCheck={false} /></label>
      </div>
      <p className="muted" style={{ fontSize: 12.5 }}><Icon name="lock" size={12} /> Only Google's cookies are kept, encrypted, and are never shown again. They let the bot act as this account, so use an account made only for the notetaker.</p>
    </Modal>
  );
}
