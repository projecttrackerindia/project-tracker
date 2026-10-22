import type { ReactNode } from 'react';
import type { CommandCenter } from '../../api/types';
import { Icon, type IconName } from '../../components/Icon';
import { formatTime, timeAgo } from '../../lib/format';
import { useAuth } from '../../stores/auth';
import { AiPage } from '../ai/AiPage';
import type { AiConversation } from '../ai/aiApi';
import { useHomeMode } from '../../stores/homeMode';

type Tab = 'today' | 'work' | 'meetings' | 'decisions';

/**
 * The AI-first Home (opt-in): Home is the assistant, laid out like a modern chat app. A greeting, the ask box in the middle (attach and the
 * thinking level inside it), a few one-click asks, the latest chats as small tabs, then today's cards. Past chats are the "Chats" menu in the
 * top bar. The cards come from rules (no model call, no credits). "Classic view" returns to the tabs.
 */
export function AiFirstHome({ c, onTab }: { c: CommandCenter | undefined; onTab: (t: Tab) => void }) {
  const setAiFirst = useHomeMode((s) => s.setAiFirst);
  const actions = (
    <button type="button" className="ai-chip-btn" onClick={() => setAiFirst(false)} title="Back to the classic Home with tabs">
      <Icon name="dashboard" size={14} /><span>Classic view</span>
    </button>
  );
  return <AiPage home={{ actions, start: (p) => <HomeStart c={c} onTab={onTab} {...p} /> }} />;
}

function HomeStart({ c, onTab, ask, composer, recent, open, showAll }: {
  c: CommandCenter | undefined; onTab: (t: Tab) => void; ask: (q: string) => void; composer: ReactNode; recent: AiConversation[]; open: (id: string) => void; showAll: () => void;
}) {
  const first = useAuth((s) => s.ctx?.user.displayName?.split(' ')[0] ?? '');
  const atRisk = c?.health.filter((h) => h.level === 'high' || h.level === 'medium') ?? [];
  const next = c?.today.filter((m) => new Date(m.endUtc).getTime() > Date.now()).sort((a, b) => a.startUtc.localeCompare(b.startUtc))[0];
  const tiles: { icon: IconName; value: number; label: string; sub: string; tone?: 'danger' | 'warning'; go: () => void }[] = c ? [
    { icon: 'gauge', value: atRisk.length, label: atRisk.length === 1 ? 'Project at risk' : 'Projects at risk', sub: atRisk.slice(0, 2).map((h) => h.key).join(', ') || 'All on track', tone: atRisk.length ? 'danger' : undefined, go: () => onTab('today') },
    { icon: 'alert', value: c.counts.overdue, label: 'Late work', sub: c.counts.overdue ? 'Past its due date' : 'Nothing late', tone: c.counts.overdue ? 'warning' : undefined, go: () => onTab('work') },
    { icon: 'calendar', value: c.counts.dueToday, label: 'Due today', sub: c.counts.dueToday ? 'Yours, every kind' : 'Nothing due today', go: () => onTab('work') },
    { icon: 'checks', value: c.counts.toDecide, label: 'To decide', sub: c.counts.toDecide ? 'Proposals waiting on you' : 'Nothing waiting', go: () => onTab('decisions') },
  ] : [];
  return (
    <div className="aih">
      <section className="aih-hero">
        <h1><span className="aih-mark" aria-hidden="true"><Icon name="sparkle" size={18} /></span>{greeting()}{first ? `, ${first}` : ''}</h1>
        {composer}
        <div className="aih-chips">
          <button type="button" onClick={() => onTab('work')}><Icon name="list" size={13} /> My work today</button>
          <button type="button" onClick={() => ask('Which projects are delayed and why?')}><Icon name="gauge" size={13} /> Delayed projects</button>
          <button type="button" onClick={() => ask('Create a task')}><Icon name="plus" size={13} /> Create a task</button>
          <button type="button" onClick={() => onTab('decisions')}><Icon name="checks" size={13} /> Approvals</button>
        </div>
        {recent.length > 0 && (
          <nav className="aih-recent" aria-label="Recent chats">
            {recent.map((r) => (
              <button key={r.id} type="button" onClick={() => open(r.id)} title={r.title}>
                <Icon name="message" size={12} /><span>{r.title}</span><time>{timeAgo(r.lastMessageAt)}</time>
              </button>
            ))}
            <button type="button" className="aih-recent-all" onClick={showAll}>All chats <Icon name="chevronR" size={12} /></button>
          </nav>
        )}
      </section>
      {c && (
        <section className="aih-glance" aria-label="Today at a glance">
          <header><h2>Today at a glance</h2><span>Found by rules · no AI call</span></header>
          <div className="aih-tiles">
            {tiles.map((t) => (
              <button key={t.label} type="button" className={`aih-tile${t.tone ? ` ${t.tone}` : ''}`} onClick={t.go}>
                <span className="aih-tile-icon"><Icon name={t.icon} size={16} /></span>
                <b>{t.value}</b><span>{t.label}</span><small>{t.sub}</small>
              </button>
            ))}
          </div>
          {next && (
            <div className="aih-card">
              <header><span><Icon name="video" size={14} /> Next meeting</span><button type="button" className="mb-link" onClick={() => onTab('meetings')}>Open</button></header>
              <b>{next.title}</b>
              <small>{formatTime(next.startUtc)}{next.projectKey ? ` · ${next.projectKey}` : ''}{next.agentAttending ? ' · the agent is attending' : ''}</small>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}
