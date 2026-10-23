import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { CommandCenter } from '../../api/types';
import { Icon, type IconName } from '../../components/Icon';
import { formatDate, formatTime, timeAgo } from '../../lib/format';
import { useAuth } from '../../stores/auth';
import { AiPage } from '../ai/AiPage';
import { ReviewQueueCard } from '../github/GitHubApp';
import type { AiConversation } from '../ai/aiApi';

type Tab = 'dashboard' | 'today' | 'work' | 'meetings' | 'decisions';

/**
 * Home is the assistant, laid out like a modern chat app. A greeting, the ask box in the middle (attach and the
 * thinking level inside it), a few one-click asks, the latest chats as small tabs, then today's cards. Past chats are the "Chats" menu in the
 * top bar. The cards come from rules (no model call, no credits) and open the full views (Today, My work, Meetings, Decisions, Dashboard).
 */
export function AiFirstHome({ c, onTab }: { c: CommandCenter | undefined; onTab: (t: Tab) => void }) {
  const actions = (
    <button type="button" className="ai-chip-btn" onClick={() => onTab('dashboard')} title="Charts of your projects and tasks">
      <Icon name="dashboard" size={14} /><span>Dashboard</span>
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
          <button type="button" onClick={() => ask('Plan my day: order my open and late work by what matters most, and say why.')}><Icon name="list" size={13} /> Plan my day</button>
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
          <div className="aih-lists">
            <section className="aih-list" aria-labelledby="aih-need">
              <header><h3 id="aih-need"><Icon name="target" size={14} /> Needs you</h3><button type="button" className="mb-link" onClick={() => onTab('today')}>All</button></header>
              {c.attention.length === 0 ? <p className="aih-empty">Nothing needs you right now.</p> : (
                <ul>
                  {c.attention.slice(0, 5).map((a) => (
                    <li key={a.id} className={`sev-${a.severity}`}>
                      <span className="aih-dot" aria-hidden />
                      <div className="aih-item">
                        {a.link ? <Link to={a.link}>{a.title}</Link> : <button type="button" className="aih-item-btn" onClick={() => onTab('today')}>{a.title}</button>}
                        <small>{[a.projectKey, a.why[0] ?? a.detail].filter(Boolean).join(' · ')}</small>
                      </div>
                      <button type="button" className="aih-ask" onClick={() => ask(`Help me deal with this: ${a.title}${a.projectKey ? ` (${a.projectKey})` : ''}. What should I do, and can you prepare it?`)} title="Ask the assistant to handle it">
                        <Icon name="sparkle" size={12} /><span>Ask</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section className="aih-list" aria-labelledby="aih-work">
              <header><h3 id="aih-work"><Icon name="list" size={14} /> My work</h3><button type="button" className="mb-link" onClick={() => onTab('work')}>All my work</button></header>
              {c.owe.length === 0 ? <p className="aih-empty">Nothing open on you. <button type="button" className="mb-link" onClick={() => ask('Create a task')}>Create a task</button></p> : (
                <ul>
                  {c.owe.slice(0, 6).map((w) => (
                    <li key={w.id} className={`st-${w.state}`}>
                      <span className="aih-dot" aria-hidden />
                      <div className="aih-item">
                        <Link to={`/projects/${w.projectId}?task=${w.id}`}><span className="aih-key">{w.key}</span> {w.title}</Link>
                        <small>{w.state === 'overdue' ? `Late${w.daysLate ? ` by ${w.daysLate} day${w.daysLate === 1 ? '' : 's'}` : ''}` : w.state === 'due_today' ? 'Due today' : w.due ? `Due ${formatDate(w.due)}` : 'No due date'}{w.waiting.length ? ` · ${w.waiting.length} waiting on it` : ''}</small>
                      </div>
                      <button type="button" className="aih-ask" onClick={() => ask(`Help me finish ${w.key} "${w.title}": what is left, what is blocking it, and what should I do next?`)} title="Ask the assistant about it">
                        <Icon name="sparkle" size={12} /><span>Ask</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
          <ReviewQueueCard compact />
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
