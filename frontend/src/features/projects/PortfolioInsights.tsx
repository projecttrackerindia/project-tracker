import { useNavigate } from 'react-router-dom';
import { Icon } from '../../components/Icon';
import { PageLoader } from '../../components/ui';
import { formatDate } from '../../lib/format';
import { useWsQuery } from '../../lib/hooks';
import { aiWorkspaceApi, type PortfolioRisk } from '../ai/aiApi';
import { Sparkle, useAi } from '../ai/Assistant';

/** The portfolio worked out by rules over the projects the person may open: no model, no credits, every plan. Shared by the page and each project. */
export const usePortfolioBrief = () => useWsQuery(['project-status', 'brief'], aiWorkspaceApi.portfolioBrief, { refetchInterval: 120_000, staleTime: 60_000 });

/** Opens the AI workspace with a question ready (the assistant then reads the same figures through its own tool and reasons from them). */
function useAsk() {
  const nav = useNavigate();
  return (ask: string) => nav('/ai', { state: { ask, ts: Date.now() } });
}

const days = (n: number) => `${n} day${n === 1 ? '' : 's'}`;

function Forecast({ r }: { r: PortfolioRisk }) {
  if (r.projectedFinish === null) return <span className="pi-forecast none">{r.openTasks === 0 ? 'Nothing left to do' : 'No forecast: nothing finished in the last 4 weeks'}</span>;
  const late = r.projectedSlipDays ?? 0;
  return (
    <span className={`pi-forecast ${late > 0 ? 'late' : 'ok'}`} title="Remaining open tasks at the pace of the last 28 days. An estimate, not a commitment.">
      Likely finish {formatDate(r.projectedFinish)}{r.projectedSlipDays !== null && <> · {late > 0 ? `${days(late)} late` : late < 0 ? `${days(-late)} early` : 'on time'}</>} · {r.confidence} confidence
    </span>
  );
}

function RiskCard({ r, onPick }: { r: PortfolioRisk; onPick: (id: string) => void }) {
  return (
    <button type="button" className={`pi-card ${r.level.toLowerCase()}`} onClick={() => onPick(r.projectId)}>
      <span className="pi-card-head"><b>{r.name}</b><em className={`pi-level ${r.level.toLowerCase()}`}>{r.level}</em></span>
      <span className="pi-card-meta">{r.key} · {r.progress}% done{r.inProgressTasks > 0 ? ` · ${r.inProgressTasks} in progress` : ''} · due {formatDate(r.dueDate)}{r.owner ? ` · ${r.owner}` : ''}</span>
      <Forecast r={r} />
      <ul>{r.reasons.slice(0, 3).map((x) => <li key={x}>{x}</li>)}</ul>
    </button>
  );
}

/** The Portfolio page's front: where the projects stand, which need attention and why, what moved, and who is stretched. */
export function PortfolioBriefPanel({ onPick }: { onPick: (id: string) => void }) {
  const q = useWsQuery(['project-status', 'brief'], aiWorkspaceApi.portfolioBrief, { refetchInterval: 120_000, staleTime: 60_000 });
  const ai = useAi();
  const ask = useAsk();
  if (q.isLoading) return <PageLoader />;
  const b = q.data;
  if (!b || b.projects === 0) {
    return (
      <div className="ps-placeholder"><Icon name="monitor" size={40} /><h2>Portfolio</h2><p>Open a group on the left and choose a project to see where it stands. Once there are active projects, this page also shows which need attention, and why.</p></div>
    );
  }
  const attention = b.ranked.filter((r) => r.score >= 2).slice(0, 6);
  return (
    <div className="pi">
      <header className="pi-head">
        <div><h2>Portfolio today</h2><span>As of {formatDate(b.asOf)} · {b.projects} active project{b.projects === 1 ? '' : 's'} you can open</span></div>
        {ai && (
          <div className="pi-ask">
            <button type="button" className="btn btn-soft btn-sm" onClick={() => ask('Give me an executive summary of the portfolio: what is going well, what is at risk and why, how late the worst projects are likely to land, and what I should escalate this week.')}><Sparkle size={14} /> Executive summary</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => ask('Portfolio risk review: rank the projects most likely to miss their dates, explain the causes using the history of date changes, and recommend one concrete action for each.')}>Risk review</button>
          </div>
        )}
      </header>

      <div className="pi-kpis">
        <div className="pi-kpi"><label>On track</label><b className="ok">{b.onTrack}</b></div>
        <div className="pi-kpi"><label>At risk</label><b className={b.atRisk ? 'warn' : ''}>{b.atRisk}</b></div>
        <div className="pi-kpi"><label>Delayed</label><b className={b.delayed ? 'bad' : ''}>{b.delayed}</b></div>
        <div className="pi-kpi"><label>Overdue tasks</label><b className={b.overdueTasks ? 'bad' : ''}>{b.overdueTasks}</b></div>
        <div className="pi-kpi"><label>Blocked tasks</label><b className={b.blockedTasks ? 'warn' : ''}>{b.blockedTasks}</b></div>
        <div className="pi-kpi"><label>Action items overdue</label><b className={b.overdueActionItems ? 'bad' : ''}>{b.overdueActionItems}</b><small>of {b.openActionItems} open</small></div>
      </div>

      {b.headlines.length > 0 && <ul className="pi-headlines">{b.headlines.map((h) => <li key={h}>{h}</li>)}</ul>}

      <section aria-label="Projects that need attention">
        <h3>Needs attention <em>{attention.length}</em></h3>
        {attention.length === 0 ? <p className="ps-ok"><Icon name="checkCircle" size={14} /> Nothing needs attention right now.</p> : (
          <div className="pi-cards">{attention.map((r) => <RiskCard key={r.projectId} r={r} onPick={onPick} />)}</div>
        )}
      </section>

      {b.recentSlips.length > 0 && (
        <section aria-label="Delivery dates that moved">
          <h3>Delivery dates moved in the last 30 days <em>{b.dateChangesLast30Days}</em></h3>
          <ul className="pi-slips">
            {b.recentSlips.slice(0, 5).map((s) => (
              <li key={`${s.projectId}-${s.at}`}>
                <b>{s.project}</b> {formatDate(s.previous)} → {formatDate(s.revised)}{s.daysShifted !== null && <em className={s.daysShifted > 0 ? 'late' : 'early'}>{s.daysShifted > 0 ? '+' : ''}{s.daysShifted}d</em>}
                <span>{s.reason ?? 'No reason given'}{s.dependency ? ` · waiting on ${s.dependency}` : ''}{s.by ? ` · ${s.by}` : ''}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {b.stretched.length > 0 && (
        <section aria-label="People carrying several troubled projects">
          <h3>Carrying several projects in trouble</h3>
          <p className="pi-people">{b.stretched.map((p) => `${p.name}: ${p.projects} projects, ${p.openTasks} open tasks, ${p.overdueTasks} overdue`).join('  ·  ')}</p>
        </section>
      )}
    </div>
  );
}

/** One project's place in the portfolio: its risk, why, the forecast and its action items, with shortcuts to ask the assistant. */
export function ProjectInsight({ projectId, onActionItems }: { projectId: string; onActionItems: () => void }) {
  const q = usePortfolioBrief();
  const ai = useAi();
  const ask = useAsk();
  const r = q.data?.ranked.find((x) => x.projectId === projectId);
  if (!r) return null;
  return (
    <section className={`pi-project ${r.level.toLowerCase()}`} aria-label="Risk and forecast">
      <div className="pi-project-head">
        <span className={`pi-level ${r.level.toLowerCase()}`}>{r.level} risk</span>
        <Forecast r={r} />
        {r.overdueActionItems > 0 && <button type="button" className="pi-chip" onClick={onActionItems}>{r.overdueActionItems} overdue action item{r.overdueActionItems === 1 ? '' : 's'}</button>}
      </div>
      {r.reasons.length > 0 && <ul>{r.reasons.map((x) => <li key={x}>{x}</li>)}</ul>}
      {ai && (
        <div className="pi-ask">
          <button type="button" className="btn btn-soft btn-sm" onClick={() => ask(`Analyse ${r.name} (${r.key}): why is it ${r.health === 'OnTrack' ? 'where it is' : r.health === 'Delayed' ? 'delayed' : 'at risk'}, when will it really finish, and what should I do about it? Include its action items.`)}><Sparkle size={14} /> Analyse with AI</button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => ask(`Prepare the changes to get ${r.name} (${r.key}) back on track: reassign overloaded work, set reminders on its overdue action items, and propose realistic dates. Show me what you would change.`)}>Plan the recovery</button>
        </div>
      )}
    </section>
  );
}
