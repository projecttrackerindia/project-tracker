import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { connectedAppApi } from '../../api/endpoints';
import { Icon } from '../../components/Icon';
import { ErrorState, PageLoader } from '../../components/ui';
import { useWsQuery } from '../../lib/hooks';
import { useAuth } from '../../stores/auth';
import './connect.css';

/** Where an app such as Claude or ChatGPT asks to work in ProjectTracker for the signed-in person: choose the workspace and what it may do. */
export function ConnectPage() {
  const [p] = useSearchParams();
  const ctx = useAuth((s) => s.ctx);
  const activate = useAuth((s) => s.activateWorkspace);
  const clientId = p.get('client_id') ?? '', redirectUri = p.get('redirect_uri') ?? '';
  const asked = (p.get('scope') ?? '').split(' ');
  const [write, setWrite] = useState(asked.includes('mcp:write'));
  const [busy, setBusy] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const info = useWsQuery(['oauth-client', clientId, redirectUri], () => connectedAppApi.client(clientId, redirectUri), { enabled: !!clientId && !!redirectUri, retry: false });
  const workspaces = (ctx?.workspaces ?? []).filter((w) => w.type !== 'Personal' || ctx?.workspaces.length === 1);

  if (!clientId || !redirectUri) return <div className="cn-page"><div className="cn-card"><ErrorState error={new Error('This link is missing what the app needs. Start connecting again from the app.')} /></div></div>;
  if (info.isLoading) return <div className="cn-page"><PageLoader /></div>;
  if (info.isError || !info.data) return <div className="cn-page"><div className="cn-card"><ErrorState error={info.error} retry={() => info.refetch()} /></div></div>;
  const app = info.data;
  if (!app.known || !app.redirectAllowed)
    return (
      <div className="cn-page"><div className="cn-card">
        <div className="cn-bad"><Icon name="alert" size={22} /><div><b>This connection cannot continue</b><p>{app.known ? 'The app asked to send you to an address it did not register.' : 'This app is not registered with ProjectTracker.'} Nothing was shared. Start again from the app.</p></div></div>
      </div></div>
    );

  const decide = async (approve: boolean) => {
    setBusy(true); setError(null);
    try {
      const r = await connectedAppApi.consent({ clientId, redirectUri, state: p.get('state'), codeChallenge: p.get('code_challenge') ?? '', codeChallengeMethod: p.get('code_challenge_method'),
        scope: write ? 'mcp:read mcp:write' : 'mcp:read', resource: p.get('resource'), approve });
      window.location.assign(r.redirect);
    } catch (e) { setError(e instanceof ApiError ? e.message : 'Could not connect.'); setBusy(false); }
  };
  const host = (() => { try { return new URL(redirectUri).host; } catch { return redirectUri; } })();

  return (
    <div className="cn-page">
      <div className="cn-card" role="dialog" aria-labelledby="cn-title">
        <div className="cn-logos" aria-hidden>
          <span className="cn-app">{app.logoUri ? <img src={app.logoUri} alt="" /> : app.name.charAt(0).toUpperCase()}</span>
          <span className="cn-link"><i /><i /><i /></span>
          <span className="cn-us"><Icon name="check" size={20} /></span>
        </div>
        <h1 id="cn-title"><b>{app.name}</b> wants to work in ProjectTracker for you</h1>
        <p className="muted cn-sub">It will act as <b>{ctx?.user.displayName}</b>, with your own role and permissions. It never sees your password, and you can disconnect it at any time.</p>

        <label className="cn-field"><span>Workspace</span>
          <select className="select" value={ctx?.current?.id ?? ''} disabled={switching || busy} aria-label="Workspace"
            onChange={async (e) => { setSwitching(true); try { await activate(e.target.value); } finally { setSwitching(false); } }}>
            {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </label>

        <div className="cn-scopes" role="radiogroup" aria-label="What it may do">
          <button type="button" role="radio" aria-checked={!write} className={!write ? 'on' : ''} onClick={() => setWrite(false)}>
            <Icon name="eye" size={18} /><span><b>Read only</b><small>Projects, tasks, your work, operations and API docs.</small></span></button>
          <button type="button" role="radio" aria-checked={write} className={write ? 'on' : ''} onClick={() => setWrite(true)}>
            <Icon name="edit" size={18} /><span><b>Read and make changes</b><small>Also create tasks and work items, change status, comment and log time.</small></span></button>
        </div>

        {error && <div className="doc-alert" role="alert"><Icon name="alert" size={16} /><div>{error}</div></div>}
        <div className="cn-actions">
          <button className="btn btn-ghost" disabled={busy} onClick={() => void decide(false)}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || switching} onClick={() => void decide(true)}>{busy && <span className="spinner" />}Allow and connect</button>
        </div>
        <p className="cn-foot muted"><Icon name="lock" size={12} /> You will return to <b>{host}</b>. Manage it in Workspace settings › Connected AI apps.</p>
      </div>
    </div>
  );
}
