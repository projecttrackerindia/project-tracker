import { ApiError } from '../../api/client';
import { connectedAppApi, type ConnectedApp } from '../../api/endpoints';
import { Icon } from '../../components/Icon';
import { EmptyState, ErrorState, PageLoader } from '../../components/ui';
import { timeAgo } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
import './connect.css';

const ORIGIN = typeof window === 'undefined' ? '' : window.location.origin;

/** Settings → Connected apps: AI assistants (Claude, ChatGPT and other MCP clients) connected to this workspace, and how to connect one. */
export function ConnectedApps() {
  const wid = useWorkspaceId();
  const q = useWsQuery(['connected-apps'], connectedAppApi.list);
  const disconnect = async (a: ConnectedApp) => {
    if (!(await confirmDialog({ title: `Disconnect ${a.clientName}?`, message: 'It stops working in this workspace at once. You can connect it again later.', confirmText: 'Disconnect' }))) return;
    try { await connectedAppApi.disconnect(a.id); invalidateWorkspace(wid, 'connected-apps'); toast('Disconnected.', 'warning'); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Could not disconnect.', 'error'); }
  };
  const url = `${ORIGIN}/api/v1/mcp`;
  return (
    <div className="cn-settings">
      <div className="card mb-22">
        <div className="card-head"><h3><Icon name="sparkle" size={16} /> Connect an AI assistant</h3></div>
        <div className="card-body cn-how">
          <p className="muted">Use ProjectTracker from Claude or ChatGPT: ask about your projects and work, and (if you allow it) create tasks and update status. It signs in as you, with your own permissions.</p>
          <div className="cn-url"><code>{url}</code><button className="btn btn-ghost btn-sm" onClick={() => { void navigator.clipboard?.writeText(url); toast('Copied.'); }}><Icon name="copy" size={14} /> Copy</button></div>
          <ol>
            <li><b>Claude:</b> Settings, Connectors, Add custom connector, paste the address, then Connect.</li>
            <li><b>ChatGPT:</b> Settings, Apps and connectors, Create (developer mode), paste the address and choose OAuth.</li>
            <li>Sign in here when asked, pick the workspace and what it may do.</li>
          </ol>
        </div>
      </div>
      <div className="card">
        <div className="card-head"><h3>Connected AI apps</h3></div>
        {q.isLoading ? <PageLoader /> : q.isError ? <ErrorState error={q.error} retry={() => q.refetch()} /> : (q.data ?? []).length === 0 ? (
          <EmptyState icon="link" title="No apps connected" text="When you connect Claude, ChatGPT or another assistant, it shows here." />
        ) : (
          <ul className="cn-list">{q.data!.map((a) => (
            <li key={a.id}>
              <span className="cn-app sm">{a.clientName.charAt(0).toUpperCase()}</span>
              <span className="cn-li-main"><b>{a.clientName}</b><small className="muted">{a.mine ? 'You' : a.person} · {a.scope.includes('mcp:write') ? 'Read and make changes' : 'Read only'} · connected {timeAgo(a.createdAt)}{a.lastUsedAt ? ` · used ${timeAgo(a.lastUsedAt)}` : ''}</small></span>
              <button className="btn btn-ghost btn-sm" onClick={() => void disconnect(a)}>Disconnect</button>
            </li>
          ))}</ul>
        )}
      </div>
    </div>
  );
}
