import { delegateApi, workspaceAutomationApi } from '../../api/endpoints';
import { aiWorkspaceApi } from '../../features/ai/aiApi';
import { useWsQuery } from '../../lib/hooks';
import { timeAgo } from '../../lib/format';
import { Icon } from '../Icon';

export type AuraTab = 'chat' | 'recent' | 'automations' | 'activity';
export const AURA_TABS: { id: AuraTab; label: string }[] = [
  { id: 'chat', label: 'Chat' }, { id: 'recent', label: 'Recent' }, { id: 'automations', label: 'Automations' }, { id: 'activity', label: 'Activity' },
];

/**
 * The Aura panel's other tabs, from real data: Recent (your Aura conversations), Automations (the workspace's rules) and Activity (what
 * the agent did, its audit trail). Each row opens its full page; a "›" link at the foot opens the whole list.
 */
export function AuraTabBody({ tab, conversationId, onGo }: { tab: Exclude<AuraTab, 'chat'>; conversationId: string | null; onGo: (to: string) => void }) {
  return (
    <div className="gc-body gc-tab-body" role="tabpanel" aria-label={AURA_TABS.find((x) => x.id === tab)?.label}>
      {tab === 'recent' && <Recent current={conversationId} onGo={onGo} />}
      {tab === 'automations' && <Automations onGo={onGo} />}
      {tab === 'activity' && <Activity onGo={onGo} />}
    </div>
  );
}

function Empty({ text }: { text: string }) { return <p className="gc-tab-empty">{text}</p>; }
function Loading() { return <div className="gc-tab-skel" aria-label="Loading"><i /><i /><i /></div>; }

function Recent({ current, onGo }: { current: string | null; onGo: (to: string) => void }) {
  const q = useWsQuery(['ai', 'conversations'], aiWorkspaceApi.conversations, { staleTime: 30_000, retry: false });
  const list = (q.data ?? []).slice(0, 12);
  return (
    <>
      {q.isLoading ? <Loading /> : list.length === 0 ? <Empty text="No conversations yet. Ask Aura anything in Chat." /> : (
        <ul className="gc-tab-list">
          {list.map((c) => (
            <li key={c.id}><button type="button" className={`gc-tab-row${c.id === current ? ' on' : ''}`} onClick={() => onGo(`/?tab=assistant&c=${encodeURIComponent(c.id)}`)}>
              <Icon name={c.isPinned ? 'pin' : 'message'} size={15} /><span className="t"><b>{c.title || 'Untitled'}</b></span><small>{timeAgo(c.lastMessageAt)}</small>
            </button></li>
          ))}
        </ul>
      )}
      <button type="button" className="gc-tab-more" onClick={() => onGo('/?tab=assistant')}>All conversations ›</button>
    </>
  );
}

function Automations({ onGo }: { onGo: (to: string) => void }) {
  const q = useWsQuery(['automations', 'workspace'], workspaceAutomationApi.list, { staleTime: 60_000, retry: false });
  const list = (q.data ?? []).slice(0, 12);
  return (
    <>
      {q.isLoading ? <Loading /> : list.length === 0 ? <Empty text="No automations yet. Ask Aura to set one up: “when a ticket waits a day, remind the owner”." /> : (
        <ul className="gc-tab-list">
          {list.map((r) => (
            <li key={r.id}><button type="button" className="gc-tab-row" onClick={() => onGo('/insights?tab=workflows')}>
              <span className={`gc-dot${r.isEnabled ? ' on' : ''}`} aria-label={r.isEnabled ? 'On' : 'Off'} /><span className="t"><b>{r.name}</b><small>{r.summary}</small></span><small>{r.runCount} runs</small>
            </button></li>
          ))}
        </ul>
      )}
      <button type="button" className="gc-tab-more" onClick={() => onGo('/insights?tab=workflows')}>All automations ›</button>
    </>
  );
}

function Activity({ onGo }: { onGo: (to: string) => void }) {
  const q = useWsQuery(['agent', 'audit', 'aura-panel'], () => delegateApi.audit(), { staleTime: 60_000, retry: false });
  const list = (q.data ?? []).slice(0, 15);
  return (
    <>
      {q.isLoading ? <Loading /> : list.length === 0 ? <Empty text="Nothing yet. What Aura does for you shows here, with an undo where it can." /> : (
        <ul className="gc-tab-list">
          {list.map((a) => (
            <li key={a.id}><button type="button" className="gc-tab-row" onClick={() => onGo('/?tab=audit')}>
              <Icon name={a.error ? 'alert' : 'check'} size={15} /><span className="t"><b>{a.title}</b><small>{[a.projectKey, a.action].filter(Boolean).join(' · ')}</small></span><small>{timeAgo(a.at)}</small>
            </button></li>
          ))}
        </ul>
      )}
      <button type="button" className="gc-tab-more" onClick={() => onGo('/?tab=audit')}>Full audit trail ›</button>
    </>
  );
}
