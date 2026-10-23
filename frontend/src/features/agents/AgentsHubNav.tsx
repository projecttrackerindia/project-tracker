import { useEffect, useRef } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { agentApi } from '../../api/endpoints';
import { useHomeMode } from '../../stores/homeMode';
import { AgentMark } from '../../components/AgentMark';
import { Icon, type IconName } from '../../components/Icon';
import { useWsQuery } from '../../lib/hooks';
import { useAuth, useIsPersonal, useModule } from '../../stores/auth';
import { useAi } from '../ai/Assistant';
import './agents.css';

/**
 * The Agents hub: one place for every agent - the assistant you talk to, the proposals the project agent found, the background workflows
 * and (for owners and admins) how each agent is doing. Each part keeps its own address; this bar moves between them.
 */
export function AgentsHubNav({ sub, compact = false }: { sub?: string; compact?: boolean }) {
  const { pathname } = useLocation();
  const ai = useAi();
  const aiFirst = useHomeMode((s) => s.aiFirst);
  const personal = useIsPersonal();
  const role = useAuth((s) => s.ctx?.current?.role);
  const projects = useModule('projects') > 0;
  const proposals = projects && !personal && ai && role !== 'Guest';
  const admin = role === 'Owner' || role === 'Admin';
  const inbox = useWsQuery(['agent', 'inbox'], agentApi.inbox, { enabled: proposals, staleTime: 60_000 });
  const tabs: { to: string; label: string; icon: IconName | 'mark'; show: boolean; on: boolean; badge?: number }[] = [
    // With the AI-first Home, Ask is Home itself.
    { to: aiFirst ? '/' : '/ai', label: aiFirst ? 'Ask (Home)' : 'Ask', icon: 'mark', show: ai, on: pathname === '/ai' || (pathname.startsWith('/ai/') && pathname !== '/ai/operations') },
    { to: '/notetaker', label: 'Meetings', icon: 'video', show: projects && role !== 'Guest', on: pathname === '/notetaker' },
    { to: '/project-agent', label: 'Proposals', icon: 'sparkle', show: proposals, on: pathname.startsWith('/project-agent'), badge: inbox.data?.pending },
    { to: '/ai/operations', label: 'Workflows', icon: 'workflow', show: ai, on: pathname === '/ai/operations' },
    { to: '/agent-tracker', label: 'Tracker', icon: 'gauge', show: admin, on: pathname === '/agent-tracker' },
  ];
  const shown = tabs.filter((t) => t.show);
  const bar = useRef<HTMLElement>(null);
  // On a phone the tabs scroll sideways: bring the current one into view so the person can see where they are.
  useEffect(() => {
    const el = bar.current?.querySelector<HTMLElement>('.tab.active');
    const box = bar.current;
    if (!el || !box || box.scrollWidth <= box.clientWidth) return;
    box.scrollLeft = Math.max(0, el.offsetLeft - (box.clientWidth - el.offsetWidth) / 2);
  }, [pathname, shown.length]);
  if (shown.length < 2) return null;
  if (compact) return (
    // Inside the assistant's own header: the other agent places, without the hub's title.
    <nav className="tabs agh-tabs agh-compact" aria-label="Other agent places">
      {shown.filter((t) => !t.on).map((t) => (
        <NavLink key={t.to} to={t.to} end className="tab" title={t.label} aria-label={t.label}>
          {t.icon === 'mark' ? <AgentMark size={16} /> : <Icon name={t.icon} size={15} />}<span>{t.label}</span>{!!t.badge && <em>{t.badge > 99 ? '99+' : t.badge}</em>}
        </NavLink>
      ))}
    </nav>
  );
  return (
    <div className="agh">
      <div className="agh-title"><span className="agh-mark"><AgentMark size={20} animated /></span><div><b>Agents</b>{sub && <small>{sub}</small>}</div></div>
      <nav ref={bar} className="tabs agh-tabs" aria-label="Agents">
        {shown.map((t) => (
          <NavLink key={t.to} to={t.to} end className={`tab${t.on ? ' active' : ''}`} aria-current={t.on ? 'page' : undefined}>
            {t.icon === 'mark' ? <AgentMark size={16} /> : <Icon name={t.icon} size={15} />}<span>{t.label}</span>
            {!!t.badge && <em>{t.badge > 99 ? '99+' : t.badge}</em>}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
