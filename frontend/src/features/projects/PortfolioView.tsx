import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { agentApi } from '../../api/endpoints';
import { AiCard } from '../../components/v2/AiCard';
import { ErrorState, PageHead, PageLoader, StatusBar } from '../../components/ui';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useTeamLens } from '../../lib/teamLens';
import { useAuth, useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { aiWorkspaceApi } from '../ai/aiApi';
import { useAi, useAssistant } from '../ai/Assistant';
import { DotsMenu } from '../talk/DotsMenu';
import { PortfolioActionItems } from './PortfolioActionItems';
import { CapacitySection, filterCount, MoneySection, PortfolioFilters, TimelineView } from './PortfolioBoard';
import { portfolioApi, type PortfolioAiSummary, type PortfolioDecision, type PortfolioFilter } from './portfolioApi';
import { BackLink, dayMonth, DuplicateFlags, errText, useAllProjects } from './projectParts';
import type { PortfolioBrief } from '../ai/aiApi';
import './portfolio.css';
import './projectsHome.css';

const days = (n: number) => `${Math.abs(n)} day${Math.abs(n) === 1 ? '' : 's'}`;

/**
 * Projects › Portfolio (v2 §3.4): the AI summary, then the decisions to take, each as old date → new date with one Accept that moves the date
 * and tells the team ("✓ team told"); the other ways to recover (move someone, cut scope) are one tap away and become proposals. Money,
 * capacity and what needs attention follow; filters, the roadmap, export, action items and the Monday brief are under ···.
 */
export function PortfolioView({ switcher }: { switcher: ReactNode }) {
  const ai = useAi();
  const nav = useNavigate();
  const { teamId } = useTeamLens();
  const [params, setParams] = useSearchParams();
  const filter: PortfolioFilter = { teamId, ownerId: params.get('owner'), groupId: params.get('group'), health: params.get('health'), dueFrom: params.get('from'), dueTo: params.get('to') };
  const setFilter = (f: PortfolioFilter) => {
    const n = new URLSearchParams(params);
    for (const [k, v] of [['owner', f.ownerId], ['group', f.groupId], ['health', f.health], ['from', f.dueFrom], ['to', f.dueTo]] as const) { if (v) n.set(k, v); else n.delete(k); }
    setParams(n, { replace: true });
  };
  const timeline = params.get('view') === 'timeline';
  const setTimeline = (on: boolean) => { const n = new URLSearchParams(params); n.set('view', on ? 'timeline' : 'portfolio'); setParams(n, { replace: true }); };
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [itemsOpen, setItemsOpen] = useState(false);
  const q = useWsQuery(['portfolio', 'board', filter], () => portfolioApi.board(filter), { refetchInterval: 120_000, staleTime: 60_000, placeholderData: (prev) => prev });
  const role = useAuth((s) => s.ctx?.current?.role);
  const oversees = role === 'Owner' || role === 'Admin' || role === 'Manager';
  const projects = useAllProjects({ mineOnly: !oversees, includeArchived: false });
  const nFilters = filterCount(filter);
  const sendBrief = async () => {
    try { const r = await aiWorkspaceApi.sendBrief(teamId); toast(r.sent ? 'The brief is on its way to you, in the app and by e-mail.' : r.reason ?? 'Nothing was sent.', r.sent ? 'success' : 'info'); }
    catch { toast('Could not send the brief.', 'error'); }
  };
  const exportAs = async (format: 'xlsx' | 'pdf') => { try { await portfolioApi.export(filter, format); } catch { toast('The export could not be made.', 'error'); } };
  const board = q.data;
  const b = board?.brief;
  return (
    <div className="pj2 pj2-portfolio">
      <PageHead eyebrow={<BackLink to="/work" label="Work" />} title="Portfolio">
        <div className="pj2-heads">
          {switcher}
          <DotsMenu label="More on Portfolio" items={[
            { label: timeline ? 'Decisions and summary' : 'Timeline', icon: timeline ? 'dashboard' : 'calendar', hint: timeline ? undefined : 'Every project on one roadmap, slips as ghosts', onSelect: () => setTimeline(!timeline) },
            { label: nFilters ? `Filters · ${nFilters}` : 'Filters', icon: 'search', hint: 'Owner, group, health and due dates', onSelect: () => setFiltersOpen((v) => !v) },
            { label: 'Export to Excel', icon: 'download', onSelect: () => void exportAs('xlsx') },
            { label: 'Export to PDF', icon: 'download', onSelect: () => void exportAs('pdf') },
            { label: 'Action items', icon: 'flag', hint: b?.openActionItems ? `${b.openActionItems} open across projects` : 'Follow-ups across projects', onSelect: () => setItemsOpen(true) },
            { label: 'Send me this', icon: 'send', hint: 'The brief, in the app and by e-mail', onSelect: () => void sendBrief() },
            { label: 'Risk review', icon: 'sparkle', hint: 'Ask the assistant which projects will miss their dates', hidden: !ai,
              onSelect: () => useAssistant.getState().ask('Portfolio risk review: rank the projects most likely to miss their dates, explain the causes using the history of date changes, and recommend one concrete action for each.') },
          ]} />
        </div>
      </PageHead>

      {board && (filtersOpen || nFilters > 0) && <div className="pj2-pfilters"><PortfolioFilters board={board} filter={filter} onChange={setFilter} /></div>}

      {q.isLoading ? <PageLoader /> : q.isError || !board || !b ? <ErrorState error={q.error} retry={() => q.refetch()} /> : timeline ? (
        <section className="pj2-section">
          <button type="button" className="pj2-back link-btn" onClick={() => setTimeline(false)}>‹ Decisions and summary</button>
          <TimelineView filter={filter} onPick={(id) => nav(`/work/projects/${id}`)} />
        </section>
      ) : (
        <>
          <Summary summary={board.summary} filter={filter} ai={ai} />
          <div className="pj2-status" aria-label="Where the projects stand">
            <StatusBar label={`${b.onTrack} on track, ${b.atRisk} at risk, ${b.delayed} delayed`} parts={[{ tone: 'ok', value: b.onTrack }, { tone: 'risk', value: b.atRisk }, { tone: 'late', value: b.delayed }]} />
            <span><i className="ok" />{b.onTrack} on track</span><span><i className="risk" />{b.atRisk} at risk</span><span><i className="late" />{b.delayed} delayed</span>
            {b.overdueTasks > 0 && <span className="muted">{b.overdueTasks} overdue task{b.overdueTasks === 1 ? '' : 's'}</span>}
          </div>

          <Decisions decisions={board.decisions} filter={filter} />
          <DuplicateFlags projects={projects.data?.items ?? []} />

          <Attention brief={b} />
          <MoneySection m={board.money} />
          <CapacitySection c={board.capacity} />
          {b.recentSlips.length > 0 && (
            <section className="pj2-section" aria-label="Delivery dates that moved">
              <h3 className="ds-section-title">Dates moved in the last 30 days <em>{b.dateChangesLast30Days}</em></h3>
              <ul className="pj2-slips">
                {b.recentSlips.slice(0, 6).map((s) => (
                  <li key={`${s.projectId}-${s.at}`}>
                    <Link to={`/work/projects/${s.projectId}`}><b>{s.project}</b></Link>
                    <span className="pj2-shift"><s>{dayMonth(s.previous)}</s> → <b>{dayMonth(s.revised)}</b></span>
                    <small>{s.reason ?? 'No reason given'}{s.dependency ? ` · waiting on ${s.dependency}` : ''}{s.by ? ` · ${s.by}` : ''}</small>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {b.stretched.length > 0 && (
            <p className="pj2-note"><b>Carrying several projects in trouble:</b> {b.stretched.map((p) => `${p.name} (${p.projects} projects, ${p.overdueTasks} overdue)`).join(' · ')}</p>
          )}
        </>
      )}
      {itemsOpen && <PortfolioActionItems onClose={() => setItemsOpen(false)} />}
    </div>
  );
}

/** ✦ The portfolio in a few sentences: from the numbers, or written by the AI for the meeting. */
function Summary({ summary, filter, ai }: { summary: string; filter: PortfolioFilter; ai: boolean }) {
  const [written, setWritten] = useState<PortfolioAiSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const write = async () => {
    setBusy(true);
    try { setWritten(await portfolioApi.summary(filter, !!written)); } catch (e) { toast(errText(e, 'The summary could not be written.'), 'error'); } finally { setBusy(false); }
  };
  return (
    <section aria-label="Summary" className="pj2-summary">
      <AiCard title="Summary" action={ai ? { label: written ? 'Write again' : 'Write it for the meeting', onClick: () => void write(), busy } : undefined}>
        {written ? written.text : summary}
        <small className="pj2-summary-by">{written ? `Written by the AI ${written.cached ? 'earlier today' : 'just now'} · ${written.model}` : 'From the numbers on this page. Owners and admins get it every Monday.'}</small>
      </AiCard>
    </section>
  );
}

/** The decisions this week: each late project with its date change as the hero and one Accept; the other options under "Other ways". */
function Decisions({ decisions, filter }: { decisions: PortfolioDecision[]; filter: PortfolioFilter }) {
  // Accepted cards stay, marked "✓ team told", even once the refreshed board no longer lists them.
  const [accepted, setAccepted] = useState<Record<string, PortfolioDecision>>({});
  const shown = [...decisions.filter((d) => !accepted[d.projectId]), ...Object.values(accepted)]
    .sort((a, b) => decisions.findIndex((d) => d.projectId === a.projectId) - decisions.findIndex((d) => d.projectId === b.projectId));
  return (
    <section aria-label="Decisions this week" className="pj2-section">
      <h3 className="ds-section-title">Decisions this week <em>{decisions.length}</em></h3>
      {shown.length === 0 ? <p className="pj2-calm">No project is forecast to miss its date.</p>
        : <div className="pj2-decisions">{shown.map((d) => <DecisionCard key={d.projectId} d={d} filter={filter} accepted={!!accepted[d.projectId]} onAccepted={(x) => setAccepted((m) => ({ ...m, [x.projectId]: x }))} />)}</div>}
    </section>
  );
}

function DecisionCard({ d, filter, accepted, onAccepted }: { d: PortfolioDecision; filter: PortfolioFilter; accepted: boolean; onAccepted: (d: PortfolioDecision) => void }) {
  const wid = useWorkspaceId();
  const isGuest = useAuth((s) => s.ctx?.current?.role === 'Guest');
  const [busy, setBusy] = useState<string | null>(null);
  const [others, setOthers] = useState(false);
  const [detail, setDetail] = useState<string | null>(null);
  const acceptDate = d.options.find((o) => o.kind === 'accept_date');
  const newDate = acceptDate?.finish ?? d.finish;
  const rest = d.options.filter((o) => o.kind !== 'accept_date');
  const refresh = () => { for (const k of ['portfolio', 'projects', 'project', 'agent', 'inbox']) void invalidateWorkspace(wid, k); };

  // Accept: the date decision is proposed (the portfolio's own step) and approved at once by the person accepting, so the due date moves with
  // the reason in its history and the team is told. A date proposal already waiting for this project is approved instead of a second one.
  const accept = async () => {
    if (!acceptDate) return;
    setBusy('accept');
    try {
      let ids: string[] = [];
      if (d.waitingProposals === 0) ids = (await portfolioApi.apply(d.projectId, acceptDate.id, filter)).findingIds ?? [];
      if (ids.length === 0) ids = (await agentApi.findings(d.projectId, 'proposed')).items.filter((f) => f.kind === 'Decision' && f.newStatus === 'project_due').map((f) => f.id);
      if (ids.length === 0) throw new Error('There is no date to accept any more. The board is refreshed.');
      for (const id of ids) {
        const r = await agentApi.approve(id);
        if (r.status === 'Failed') throw new Error(r.error ?? 'The new date could not be set.');
      }
      onAccepted({ ...d, finish: newDate });
      toast(`${d.key} is now due ${dayMonth(newDate)}. The team was told.`);
    } catch (e) { toast(errText(e, e instanceof Error ? e.message : 'Could not accept the new date.'), 'error'); }
    finally { setBusy(null); refresh(); }
  };
  const propose = async (option: string) => {
    setBusy(option);
    try { const r = await portfolioApi.apply(d.projectId, option, filter); toast(r.message); refresh(); }
    catch (e) { toast(errText(e, 'Could not propose it.'), 'error'); }
    finally { setBusy(null); }
  };

  return (
    <article className={`ds-decision pj2-decision ${accepted ? 'accepted' : ''}`} data-project={d.key} aria-label={`${d.name}: due ${dayMonth(d.dueDate)}, new date ${dayMonth(newDate)}`}>
      <div className="pj2-dec-text">
        <span className={`eyebrow ${d.slipDays > 14 ? 'danger' : 'warning'}`}>{d.slipDays > 0 ? `${days(d.slipDays)} late` : 'On the edge'}</span>
        <h3><Link to={`/work/projects/${d.projectId}`}>{d.name}</Link> <span className="pj2-key">{d.key}</span></h3>
        <p>{d.causes.length ? `${d.causes.slice(0, 2).map((c) => c.charAt(0).toUpperCase() + c.slice(1)).join('. ')}.` : d.headline}</p>
      </div>
      <div className="ds-shift">
        <div><small>Due</small><s>{dayMonth(d.dueDate)}</s></div>
        <span className="arrow" aria-hidden="true">→</span>
        <div><small>{accepted ? 'Now due' : 'New date'}</small><b>{dayMonth(newDate)}</b></div>
      </div>
      <div className="acts">
        {accepted ? <span className="ds-pill success pj2-told" role="status">✓ team told</span> : <>
          {rest.length > 0 && <button type="button" className="btn btn-ghost" aria-expanded={others} onClick={() => setOthers((v) => !v)}>Other ways</button>}
          {acceptDate && !isGuest && <button type="button" className="btn btn-primary" disabled={busy !== null} onClick={() => void accept()}>{busy === 'accept' ? 'Accepting…' : 'Accept'}</button>}
        </>}
      </div>
      {d.waitingProposals > 0 && !accepted && (
        <Link className="pj2-waiting" to={`/work/projects/${d.projectId}?tab=activity`}>{d.waitingProposals} proposal{d.waitingProposals === 1 ? '' : 's'} already waiting in {d.key} ›</Link>
      )}
      {others && !accepted && (
        <ul className="pj2-options">
          {rest.map((o) => (
            <li key={o.id}>
              <div className="pj2-option-main">
                <b>{o.title}</b>
                <span className={`pj2-effect ${o.slipDays != null && o.slipDays <= 0 ? 'ok' : 'late'}`}>{o.effect}</span>
                <button type="button" className="link-btn" aria-expanded={detail === o.id} onClick={() => setDetail(detail === o.id ? null : o.id)}>What changes</button>
              </div>
              {detail === o.id && <div className="pj2-option-detail"><ul>{o.steps.map((s) => <li key={s}>{s}</li>)}</ul>{o.why && <p className="muted">{o.why}</p>}</div>}
              {!isGuest && <button type="button" className="btn btn-soft btn-sm" disabled={busy !== null || d.waitingProposals > 0} onClick={() => void propose(o.id)}>{busy === o.id ? 'Proposing…' : 'Propose this'}</button>}
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

/** Projects that need attention, worked out by rules: the risk level, the likely finish and the first reason. */
function Attention({ brief }: { brief: PortfolioBrief }) {
  const list = brief.ranked.filter((r) => r.score >= 2).slice(0, 6);
  if (list.length === 0) return null;
  return (
    <section className="pj2-section" aria-label="Projects that need attention">
      <h3 className="ds-section-title">Needs attention <em>{list.length}</em></h3>
      <ul className="pj2-attention">
        {list.map((r) => (
          <li key={r.projectId}>
            <Link to={`/work/projects/${r.projectId}`}>
              <span className="pj2-att-head"><b>{r.name}</b><span className={`pj2-pill ${r.level === 'Critical' || r.level === 'High' ? 'late' : r.level === 'Medium' ? 'risk' : 'ok'}`}>{r.level}</span></span>
              <small>{r.key} · {r.progress}% · due {dayMonth(r.dueDate)}{r.projectedFinish ? ` · likely ${dayMonth(r.projectedFinish)}` : ''}</small>
              {r.reasons[0] && <span className="pj2-att-why">{r.reasons[0]}</span>}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
