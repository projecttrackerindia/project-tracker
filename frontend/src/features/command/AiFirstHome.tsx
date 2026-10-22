import type { CommandCenter } from '../../api/types';
import { Icon, type IconName } from '../../components/Icon';
import { formatTime } from '../../lib/format';
import { useAuth } from '../../stores/auth';
import { AiPage } from '../ai/AiPage';
import { useHomeMode } from '../../stores/homeMode';

type Tab = 'today' | 'work' | 'meetings' | 'decisions';

/**
 * The AI-first Home (opt-in): Home is the assistant. Ask in the box at the bottom; answers, approval cards and your conversations stay here.
 * Before the first question it shows four counts from rules (no model call, no credits) and the next meeting. "Classic view" returns to the tabs.
 */
export function AiFirstHome({ c, onTab }: { c: CommandCenter | undefined; onTab: (t: Tab) => void }) {
  const setAiFirst = useHomeMode((s) => s.setAiFirst);
  const top = (
    <div className="aih-top">
      <span><Icon name="sparkle" size={14} /> Home · Assistant</span>
      <button type="button" className="btn btn-sm" onClick={() => setAiFirst(false)}><Icon name="dashboard" size={14} /> Classic view</button>
    </div>
  );
  return <AiPage home={{ top, start: (ask) => <HomeStart c={c} onTab={onTab} ask={ask} /> }} />;
}

function HomeStart({ c, onTab, ask }: { c: CommandCenter | undefined; onTab: (t: Tab) => void; ask: (q: string) => void }) {
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
        <span className="aih-mark" aria-hidden="true"><Icon name="sparkle" size={22} /></span>
        <h1>What do you want to get done{first ? `, ${first}` : ''}?</h1>
        <p>Ask about any project, task or person you can see, or tell the assistant what to change. Changes come back as cards you confirm.</p>
        <div className="aih-chips">
          <button type="button" onClick={() => onTab('work')}>Show my work today</button>
          <button type="button" onClick={() => ask('Which projects are delayed and why?')}>Which projects are delayed?</button>
          <button type="button" onClick={() => ask('Create a task')}>Create a task</button>
          <button type="button" onClick={() => onTab('decisions')}>Approve pending items</button>
        </div>
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
