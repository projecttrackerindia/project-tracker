import { useEffect, useRef, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { CommandCenter } from '../../api/types';
import { Icon, type IconName } from '../../components/Icon';
import { formatDate, formatTime, timeAgo } from '../../lib/format';
import { useAuth } from '../../stores/auth';
import { AiPage } from '../ai/AiPage';
import { ReviewQueueCard } from '../github/GitHubApp';
import type { AiConversation } from '../ai/aiApi';

type Tab = 'dashboard' | 'today' | 'work' | 'decisions';

/** Questions a link can open Home with (the morning briefing uses "plan"). Only these: a link never carries free text to the assistant. */
const PRESETS: Record<string, string> = {
  plan: "Plan my day: my meetings today, what is late or due, and what waits on me. Put it in order with times, say why, and prepare what you can for me to confirm.",
  needs: 'What needs me right now? Go through it, most urgent first, and prepare what you can for me to confirm.',
};

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
  // The morning briefing opens Home with ?ask=plan: plan the day straight away, once.
  const [params, setParams] = useSearchParams();
  const asked = useRef(false);
  useEffect(() => {
    const preset = params.get('ask');
    if (asked.current || !preset || !PRESETS[preset]) return;
    asked.current = true;
    setParams((p) => { const n = new URLSearchParams(p); n.delete('ask'); return n; }, { replace: true });
    ask(PRESETS[preset]);
  }, [params]); // eslint-disable-line react-hooks/exhaustive-deps
  const atRisk = c?.health.filter((h) => h.level === 'high' || h.level === 'medium') ?? [];
  const next = c?.today.filter((m) => new Date(m.endUtc).getTime() > Date.now()).sort((a, b) => a.startUtc.localeCompare(b.startUtc))[0];
  // Today at a glance: four numbers found by rules. A number is coloured only when the colour means something (late is red, at risk amber);
  // an all-clear caption is green.
  const tiles: { icon: IconName; tone: '' | 'warning' | 'progress' | 'success'; value: number; label: string; sub: string; numTone?: 'danger' | 'warning'; clear: boolean; go: () => void }[] = c ? [
    { icon: 'target', tone: '', value: atRisk.length, label: atRisk.length === 1 ? 'Project at risk' : 'Projects at risk', sub: atRisk.slice(0, 2).map((h) => h.key).join(', ') || 'All on track', numTone: atRisk.length ? 'warning' : undefined, clear: !atRisk.length, go: () => onTab('today') },
    { icon: 'alert', tone: 'warning', value: c.counts.overdue, label: 'Late work', sub: c.counts.overdue ? 'Past its due date' : 'Nothing late', numTone: c.counts.overdue ? 'danger' : undefined, clear: !c.counts.overdue, go: () => onTab('work') },
    { icon: 'calendar', tone: 'progress', value: c.counts.dueToday, label: 'Due today', sub: c.counts.dueToday ? 'Yours, every kind' : 'Nothing due today', clear: !c.counts.dueToday, go: () => onTab('work') },
    { icon: 'check', tone: 'success', value: c.counts.toDecide, label: 'To decide', sub: c.counts.toDecide ? 'Proposals waiting on you' : 'Nothing waiting', clear: !c.counts.toDecide, go: () => onTab('decisions') },
  ] : [];
  const asks: { label: string; run: () => void }[] = [
    { label: 'What needs me', run: () => ask('What needs me right now? Go through it, most urgent first, and prepare what you can for me to confirm.') },
    { label: 'Catch me up', run: () => ask('Catch me up on my unread chat: the decisions, questions put to me and actions, with links.') },
    { label: 'Plan my day', run: () => ask('Plan my day: order my open and late work by what matters most, and say why.') },
    { label: 'Submit my week', run: () => ask('Submit my timesheet for the latest week that is ready to submit.') },
    { label: 'Delayed projects', run: () => ask('Which projects are delayed and why?') },
    { label: 'Approvals', run: () => onTab('decisions') },
  ];
  const today = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  return (
    <div className="aih">
      <section className="aih-hero">
        <span className="eyebrow aih-date">{today}</span>
        <h1>{greeting()}{first ? `, ${first}` : ''}.</h1>
        {composer}
        <div className="aih-chips" aria-label="Quick asks">
          {asks.map((a) => <button key={a.label} type="button" onClick={a.run}>{a.label}</button>)}
        </div>
        {recent.length > 0 && (
          <nav className="aih-recent" aria-label="Recent chats">
            <span className="aih-recent-label">Recent:</span>
            {recent.map((r) => (
              <button key={r.id} type="button" onClick={() => open(r.id)} title={r.title}>
                <span>{r.title}</span><time>· {timeAgo(r.lastMessageAt)}</time>
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
              <button key={t.label} type="button" className={`aih-tile${t.numTone ? ` ${t.numTone}` : ''}`} onClick={t.go}>
                <span className={`ds-tile-ico aih-tile-icon ${t.tone === 'progress' ? 'violet' : t.tone}`}><Icon name={t.icon} size={16} /></span>
                <b>{t.value}</b><span>{t.label}</span><small className={t.clear ? 'clear' : ''}>{t.sub}</small>
              </button>
            ))}
          </div>
          <div className="aih-lists">
            <section className="aih-list" aria-labelledby="aih-need">
              <header><h3 id="aih-need">Needs you</h3><button type="button" className="mb-link" onClick={() => onTab('today')}>All</button></header>
              {c.attention.length === 0 ? <p className="aih-empty">You&apos;re all caught up. Nothing needs you right now.</p> : (
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
              <header><h3 id="aih-work">My work</h3><button type="button" className="mb-link" onClick={() => onTab('work')}>All my work</button></header>
              {c.owe.length === 0 ? <p className="aih-empty">Nothing open on you. <button type="button" className="mb-link" onClick={() => ask('Create a task')}>Create a task</button></p> : (
                <ul>
                  {c.owe.slice(0, 6).map((w) => (
                    <li key={w.id} className={`st-${w.state}`}>
                      <span className="aih-dot" aria-hidden />
                      <div className="aih-item">
                        <Link to={`/work?item=${w.id}`}><span className="aih-key">{w.key}</span> {w.title}</Link>
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
              <header><span>Next meeting</span><Link className="mb-link" to="/meet">Open</Link></header>
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
