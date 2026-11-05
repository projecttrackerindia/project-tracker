import { useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { insightApi } from '../../api/endpoints';
import { AuraLine, CalmCard, CalmGo, CalmInsights, CalmLink } from '../../components/calm';
import { useWsQuery } from '../../lib/hooks';
import { timeAgo } from '../../lib/format';
import { useAssistant } from '../ai/Assistant';
import { portfolioApi } from './portfolioApi';
import { usePortfolio } from './PortfolioShell';
import { portfolioKeys } from './portfolioShared';

/**
 * Portfolio › Overview (design #portfolio, shot 11): on the left the one thing that needs you (a hero card with one primary action), the next
 * changes ("Then"), the next 8 weeks as thin ribbons with the now line, and the insight line over one Aura sentence; on the right Health,
 * Milestones in the next 14 days and the workspace activity. Everything is real data: the board brief, the timeline and the activity feed.
 * The rest of the old Board (decisions, the project columns, money, capacity) follows below it, so nothing is lost.
 */
const DAY = 86_400_000;
const dn = (iso: string) => Math.floor(Date.parse(`${iso.slice(0, 10)}T00:00:00Z`) / DAY);
const short = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }).replace(/(\d+) (\w+)/, '$2 $1');
const wday = (iso: string, today: string) => {
  const d = dn(iso) - dn(today);
  if (d === 0) return 'Today';
  if (d > 0 && d < 7) return new Date(`${iso.slice(0, 10)}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'short' });
  return short(iso);
};
const HEALTH: Record<string, { label: string; tone: string }> = {
  AtRisk: { label: 'At risk', tone: 'red' }, Delayed: { label: 'Late', tone: 'red' }, OnTrack: { label: 'On track', tone: 'green' },
  Completed: { label: 'Done', tone: 'grey' }, OnHold: { label: 'On hold', tone: 'grey' }, NotStarted: { label: 'Not started', tone: 'grey' },
};
const initials = (n: string) => n.split(/\s+/).map((x) => x[0]).slice(0, 2).join('').toUpperCase();

export function PortfolioOverview({ ai, more }: { ai: boolean; more: ReactNode }) {
  const { url, colourOf, today, passes, review } = usePortfolio();
  const nav = useNavigate();
  const board = useWsQuery(portfolioKeys.board(url.filter), () => portfolioApi.board(url.filter), { staleTime: 60_000, placeholderData: (p) => p });
  const tl = useWsQuery(portfolioKeys.timeline(url.filter), () => portfolioApi.timeline(url.filter), { staleTime: 60_000, placeholderData: (p) => p });
  const act = useWsQuery(['activity', 'portfolio-overview'], () => insightApi.activity(1), { staleTime: 60_000, retry: false });
  const [later, setLater] = useState<string | null>(null);
  const b = board.data?.brief;
  const ranked = useMemo(() => (b?.ranked ?? []).filter((r) => passes({ id: r.projectId, name: r.name, key: r.key, owner: r.owner, health: r.health, due: r.dueDate })), [b, passes]);
  const focus = ranked.find((r) => (r.health === 'AtRisk' || r.health === 'Delayed') && r.projectId !== later) ?? null;
  const decision = focus ? board.data?.decisions?.find((d) => d.projectId === focus.projectId) : undefined;
  const tlProjects = useMemo(() => (Array.isArray(tl.data?.projects) ? tl.data.projects : []).filter((p) => passes({ id: p.id, name: p.name, key: p.key, health: p.health, due: p.due })), [tl.data, passes]);

  // The next 8 weeks: a week back, seven ahead.
  const from = dn(today) - 7, to = from + 56;
  const ribbons = tlProjects.filter((p) => p.due && dn(p.due) >= from && dn(p.start ?? p.due) <= to).slice(0, 6);
  const milestones = useMemo(() => tlProjects.flatMap((p) => (p.milestones ?? []).filter((m) => m.due && dn(m.due) >= dn(today) && dn(m.due) <= dn(today) + 14 && m.status !== 'Done')
    .map((m) => ({ ...m, project: p }))).sort((a, b2) => (a.due ?? '').localeCompare(b2.due ?? '')).slice(0, 5), [tlProjects, today]);
  const slips = (b?.recentSlips ?? []).slice(0, 2);
  // Date extensions this month: how many dates moved later and by how many days in all ("5 dates extended this month, +23 days").
  const month = today.slice(0, 7);
  const extThisMonth = (b?.recentSlips ?? []).filter((x) => x.at.slice(0, 7) === month && (x.daysShifted ?? 0) > 0);
  const extDays = extThisMonth.reduce((a, x) => a + (x.daysShifted ?? 0), 0);
  const showExtended = () => { url.setToks([{ kind: 'due', value: 'extended', label: 'Dates extended' }]); url.setMode('sheet'); };
  const avg = ranked.length ? Math.round(ranked.reduce((a, r) => a + r.progress, 0) / ranked.length) : 0;
  const decisionsOpen = (review.data?.items ?? []).filter((i) => i.state !== 'done' && i.state !== 'cancelled' && !i.decision).length;
  const goPlan = (pid: string) => { url.setMode('sheet'); window.setTimeout(() => url.setTab(pid), 0); };

  return (
    <div className="pfo">
      <div className="pfo-grid">
        <div className="pfo-main">
          {focus ? (
            <CalmCard variant="hero" className={`pfo-hero pc-${colourOf(focus.projectId)}`} aria-label="Needs you">
              <div className="pfo-tag"><i />{focus.name}{focus.dueDate && <> · due {wday(focus.dueDate, today)}</>}{focus.blockedTasks + focus.overdueTasks > 0 && <> · {focus.blockedTasks + focus.overdueTasks} blockers</>}</div>
              <h2 className="pfo-h">{decision?.headline ?? `${focus.name} is ${HEALTH[focus.health]?.label.toLowerCase() ?? 'at risk'}`}</h2>
              <p className="pfo-p">{(decision?.causes?.length ? decision.causes : focus.reasons ?? []).slice(0, 2).join(' ') || 'Its forecast is past the due date.'}</p>
              <div className="pfo-acts">
                <CalmGo onClick={() => goPlan(focus.projectId)}>Review plan</CalmGo>
                <CalmLink onClick={() => nav(`/work/projects/${focus.projectId}`)}>Open project</CalmLink>
                <CalmLink onClick={() => setLater(focus.projectId)}>Later</CalmLink>
              </div>
            </CalmCard>
          ) : (
            <CalmCard variant="hero" className="pfo-hero pc-none" aria-label="Needs you">
              <div className="pfo-tag"><i />{ranked.length} projects</div>
              <h2 className="pfo-h">{board.isLoading ? 'Reading the portfolio…' : 'Nothing needs you right now'}</h2>
              <p className="pfo-p">{b?.headlines?.[0] ?? 'Every project is on track for its date.'}</p>
              <div className="pfo-acts"><CalmGo onClick={() => url.setMode('sheet')}>Open the plan sheet</CalmGo><CalmLink onClick={() => url.setMode('timeline')}>Timeline</CalmLink></div>
            </CalmCard>
          )}

          <div className="pfo-then" aria-label="Then">
            <span className="pfo-then-l">Then</span>
            <button type="button" className="pfo-then-i pfo-ext" data-testid="extension-summary" onClick={showExtended}>
              <span className="xd-badge">{extThisMonth.length ? `${extThisMonth.length} date${extThisMonth.length === 1 ? '' : 's'} extended this month, +${extDays} days` : 'No dates extended this month'}</span>
            </button>
            {slips.length === 0 ? <span className="pfo-then-i">No date changes this month</span>
              : slips.map((s) => <span key={`${s.projectId}${s.at}`} className="pfo-then-i">{s.project} {s.revised ? <>moved to {short(s.revised)}</> : 'moved'}{s.daysShifted ? <small> {s.daysShifted > 0 ? '+' : ''}{s.daysShifted} days</small> : null}</span>)}
            <span className="ps3-sp" />
            <Link className="pfo-more" to="/work/projects">All projects ›</Link>
          </div>

          <div className="pfo-rib" aria-label="Next 8 weeks">
            <div className="pfo-rib-h"><span>Next 8 weeks</span><span className="ps3-sp" /><button type="button" className="pfo-more" onClick={() => url.setMode('timeline')}>Timeline ›</button></div>
            <div className="pfo-rib-rows">
              {ribbons.length === 0 && <p className="pfo-empty">No dated projects in the next 8 weeks.</p>}
              {ribbons.map((p, i) => {
                const s = Math.max(from, dn(p.start ?? p.due!)), e = Math.min(to, dn(p.due!));
                return (
                  <div key={p.id} className={`pfo-rib-r pc-${colourOf(p.id)}`}>
                    <em title={p.name}>{p.name.split(/\s+/)[0]}</em>
                    <span className="pfo-rib-t"><i style={{ left: `${((s - from) / 56) * 100}%`, width: `${Math.max(1.5, ((e - s + 1) / 56) * 100)}%`, animationDelay: `${i * 50}ms` }} className={i ? 'soft' : ''} /></span>
                  </div>
                );
              })}
              {ribbons.length > 0 && <span className="pfo-now" style={{ left: `calc(var(--pfo-lab) + (100% - var(--pfo-lab)) * ${7 / 56})` }} aria-hidden="true" />}
            </div>
          </div>

          <footer className="pfo-foot">
            <CalmInsights label="Portfolio facts" items={[
              { key: 'p', label: `${ranked.length} projects`, onClick: () => nav('/work/projects') },
              { key: 'a', label: `${avg}% average done`, onClick: () => url.setMode('timeline') },
              { key: 'o', label: `${b?.overdueTasks ?? 0} overdue tasks`, onClick: () => url.setMode('sheet') },
              { key: 'd', label: `${decisionsOpen} to decide`, onClick: () => url.setMode('actions') },
            ]} />
            <AuraLine text={b?.headlines?.[1] ?? b?.headlines?.[0] ?? board.data?.summary} action={ai ? 'Ask Aura' : undefined}
              onAction={() => useAssistant.getState().ask('Portfolio risk review: which projects will miss their dates, and one concrete action for each.')} />
          </footer>
        </div>

        <aside className="pfo-side" aria-label="Portfolio at a glance">
          <CalmCard variant="list" className="pfo-card" title="Health" aside={<Link to="/work/projects">Projects ›</Link>}>
            {ranked.slice(0, 6).map((r) => (
              <Link key={r.projectId} to={`/work/projects/${r.projectId}`} className={`pfo-li pc-${colourOf(r.projectId)}`}>
                <i className="pfo-bar" aria-hidden="true" />
                <span className="pfo-li-t">{r.name}<small>{r.dueDate ? `Due ${wday(r.dueDate, today)}` : 'No date'}{r.blockedTasks + r.overdueTasks > 0 ? ` · ${r.blockedTasks + r.overdueTasks} blockers` : ''}</small></span>
                <span className={`pfo-chip ${HEALTH[r.health]?.tone ?? 'grey'}`}>{HEALTH[r.health]?.label ?? r.health}</span>
              </Link>
            ))}
            {ranked.length === 0 && <p className="pfo-empty">No projects match.</p>}
          </CalmCard>
          <CalmCard variant="list" className="pfo-card" title={<>Milestones <small>· next 14 days</small></>}>
            {milestones.map((m) => (
              <Link key={m.id} to={`/work/projects/${m.project.id}`} className={`pfo-li pc-${colourOf(m.project.id)}`}>
                <i className="pfo-bar" aria-hidden="true" />
                <span className="pfo-li-t">{m.name}<small>{m.project.name}</small></span>
                <span className="pfo-li-r">{m.due ? wday(m.due, today) : ''}</span>
              </Link>
            ))}
            {milestones.length === 0 && <p className="pfo-empty">No milestones in the next 14 days.</p>}
          </CalmCard>
          <CalmCard variant="list" className="pfo-card pfo-feed" title="Workspace activity" aside={<Link to="/activity">All ›</Link>}>
            {(act.data?.items ?? []).slice(0, 6).map((a) => (
              <div key={a.id} className="pfo-li">
                <span className="pfo-av" aria-hidden="true">{initials(a.actor?.name ?? '·')}</span>
                <span className="pfo-li-t">{a.actor?.name ? `${a.actor.name.split(' ')[0]} ` : ''}{a.summary}</span>
                <span className="pfo-li-r">{timeAgo(a.createdAt)}</span>
              </div>
            ))}
            {act.data && (act.data.items ?? []).length === 0 && <p className="pfo-empty">Nothing yet today.</p>}
          </CalmCard>
        </aside>
      </div>
      <div className="pfo-below">{more}</div>
    </div>
  );
}
