import { useMemo, useState, type ReactNode } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { AiCard } from '../../components/v2/AiCard';
import { Icon } from '../../components/Icon';
import { ErrorState } from '../../components/ui';
import { useWsQuery } from '../../lib/hooks';
import { useTeamLens } from '../../lib/teamLens';
import { toast } from '../../stores/ui';
import { aiWorkspaceApi, type PortfolioBrief } from '../ai/aiApi';
import { useAi, useAssistant } from '../ai/Assistant';
import type { DotsItem } from '../talk/DotsMenu';
import { CapacityPlanView } from './CapacityPlan';
import { CapacitySection, filterCount, MoneySection, PortfolioFilters } from './PortfolioBoard';
import { BoardColumns, DecisionCard, PresentOverlay, useProjects } from './PortfolioViews';
import { PortfolioPulse } from './PortfolioPulse';
import { PortfolioTimeline } from './PortfolioTimeline';
import { PlanSheetView } from './PlanSheet';
import { decisionItems, type DecisionItem } from './portfolioDecisions';
import { portfolioApi, type PortfolioAiSummary, type PortfolioFilter } from './portfolioApi';
import { PortfolioShell, PortfolioSkeleton, usePortfolio } from './PortfolioShell';
import { portfolioKeys, type PortfolioUrlState } from './portfolioShared';
import { errText } from './projectParts';
import './portfolio.css';
import './projectsHome.css';

const sentences = (t: string) => t.trim().split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter(Boolean);
const RISK_REVIEW = 'Portfolio risk review: rank the projects most likely to miss their dates, explain the causes using the history of date changes, and recommend one concrete action for each.';

/**
 * Projects › Portfolio: Board · Timeline · Plan sheet · Capacity · Present in one shell (PortfolioShell: the Plan sheet's head, folder tabs and
 * command field, shared by every tab). The mode is kept in the address (?view=portfolio&mode=timeline|sheet|capacity|present) with the filter, so a
 * switch keeps it; every tab reads the same `portfolio` queries, so an edit on one shows on the others.
 */
// The Projects · Portfolio switch is not shown here: the rail carries both Projects and Portfolio (design s-portfolio).
export function PortfolioView(_props: { switcher?: ReactNode }) {
  const ai = useAi();
  const { teamId } = useTeamLens();
  const [params] = useSearchParams();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const v = params.get('mode') ?? params.get('view');
  // Action items live only as the Plan sheet's first tab: an old link (?mode=actions, ?actions=1) opens it there.
  if (v === 'actions' || params.get('actions') === '1') {
    const n = new URLSearchParams(params); n.set('view', 'portfolio'); n.set('mode', 'sheet'); n.set('pt', 'actions'); n.delete('actions');
    return <Navigate to={`?${n}`} replace />;
  }
  const sendBrief = async () => {
    try { const r = await aiWorkspaceApi.sendBrief(teamId); toast(r.sent ? 'The brief is on its way to you, in the app and by e-mail.' : r.reason ?? 'Nothing was sent.', r.sent ? 'success' : 'info'); }
    catch { toast('Could not send the brief.', 'error'); }
  };
  const exportAs = async (filter: PortfolioFilter, format: 'xlsx' | 'pdf') => {
    try { await portfolioApi.export(filter, format); }
    catch { toast('The export could not be made.', 'error'); }
  };
  // ⋯: the Portfolio's own items on every tab (the Plan sheet lists its own above them and exports the sheet itself).
  const baseMenu = (url: PortfolioUrlState): DotsItem[] => {
    const n = filterCount(url.filter);
    const shared: DotsItem[] = [
      { label: 'Send me this', icon: 'send', hint: 'The brief, in the app and by e-mail', onSelect: () => void sendBrief() },
      { label: 'Risk review', icon: 'sparkle', hint: 'Ask Aura which projects will miss their dates', hidden: !ai, onSelect: () => useAssistant.getState().ask(RISK_REVIEW) },
    ];
    if (url.mode === 'sheet') return shared;
    return [
      { label: n ? `Filters · ${n}` : 'Filters', icon: 'search', hint: 'Lead, group, health and due dates', onSelect: () => setFiltersOpen((x) => !x) },
      { label: 'Export to Excel', icon: 'download', onSelect: () => void exportAs(url.filter, 'xlsx') },
      { label: 'Export to PDF', icon: 'download', onSelect: () => void exportAs(url.filter, 'pdf') },
      ...shared,
    ];
  };
  return (
    <div className="pj2 pj2-portfolio pf pf-shell">
      <PortfolioShell teamId={teamId} baseMenu={baseMenu} filters={(url) => <ServerFilters url={url} open={filtersOpen} />}>
        {({ url }) => url.mode === 'sheet' ? <PlanSheetView onPresent={() => url.setMode('present')} />
          : url.mode === 'timeline' ? <PortfolioTimeline filter={url.filter} />
          : url.mode === 'capacity' ? <CapacityPlanView />
          : <BoardTab ai={ai} />}
      </PortfolioShell>
    </div>
  );
}

/** The server-side filters (lead, group, health, due dates) under ⋯ › Filters: the same panel on every tab, kept in the address. */
function ServerFilters({ url, open }: { url: PortfolioUrlState; open: boolean }) {
  const show = open || filterCount(url.filter) > 0;
  const q = useWsQuery(portfolioKeys.board(url.filter), () => portfolioApi.board(url.filter), { staleTime: 60_000, placeholderData: (p) => p, enabled: show });
  if (!show || !q.data) return null;
  return <div className="pj2-pfilters pfx-filters"><PortfolioFilters board={q.data} filter={url.filter} onChange={url.setFilter} /></div>;
}

/** Board (and Present over it): the three numbers and one AI sentence, the columns, the decisions, money and capacity. */
function BoardTab({ ai }: { ai: boolean }) {
  const { url, passes } = usePortfolio();
  const { filter, mode, setMode } = url;
  const q = useWsQuery(portfolioKeys.board(filter), () => portfolioApi.board(filter), { refetchInterval: 120_000, staleTime: 60_000, placeholderData: (prev) => prev });
  const board = q.data;
  const b = board?.brief;
  const ranked = useMemo(() => (b?.ranked ?? []).filter((r) => passes({ id: r.projectId, name: r.name, key: r.key, owner: r.owner, health: r.health, due: r.dueDate })), [b, passes]);
  const shownIds = useMemo(() => new Set(ranked.map((r) => r.projectId)), [ranked]);
  const items: DecisionItem[] = useMemo(() => board && b ? decisionItems(board.decisions, b).filter((i) => shownIds.has(i.projectId)) : [], [board, b, shownIds]);
  const asOf = board?.asOf ?? b?.asOf;
  const rankedOwner = useMemo(() => new Map(ranked.map((r) => [r.projectId, r.owner])), [ranked]);
  if (q.isLoading) return <PortfolioSkeleton label="Loading the board" />;
  if (q.isError || !board || !b) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const projectsN = b.onTrack + b.atRisk + b.delayed + b.onHold + (b.workComplete ?? 0);
  const keysOf = (h: string) => ranked.filter((r) => r.health === h).slice(0, 2).map((r) => r.key).join(' · ');
  return (
    <div className="pfx-board">
      <div className="pf-big">
        <div className="pf-tile ok"><b>{b.onTrack}</b><span><strong>On track</strong><small>of {b.projects} projects{(b.workComplete ?? 0) > 0 ? ` · ${b.workComplete} work complete; check sign-offs` : ''}{b.projects > projectsN ? ` · ${b.projects - projectsN} without a health yet` : ''}</small></span></div>
        <div className="pf-tile risk"><b>{b.atRisk}</b><span><strong>At risk</strong><small>{keysOf('AtRisk') || 'None at risk'}</small></span></div>
        <div className="pf-tile late"><b>{b.delayed}</b><span><strong>Late</strong><small>{keysOf('Delayed') || 'None late'}</small></span></div>
        <Summary summary={b.headlines[0] ?? board.summary} filter={filter} ai={ai} />
      </div>
      <SignOffNote done={ranked.filter((r) => r.health === 'Completed')} />
      <div className="pf-lay">
        <BoardColumns filter={filter} brief={b} items={items} />
        <section aria-label="Decisions this week" className="pf-rail">
          <h3 className="pf-rail-head">Decisions this week <em>{items.length}</em></h3>
          {items.length === 0 ? <div className="pf-calm pf-calm-empty"><Icon name="checkCircle" size={22} /><b>Nothing to decide</b><span>No project is forecast to miss its date.</span></div>
            : <div className="pf-decs">{items.map((it) => <DecisionCard key={it.projectId} item={it} filter={filter} owner={rankedOwner.get(it.projectId) ?? null} />)}</div>}
        </section>
      </div>
      <BoardPulse filter={filter} brief={b} />
      <MoneySection m={board.money} />
      <CapacitySection c={board.capacity} />
      {mode === 'present' && <PresentOverlay items={items} filter={filter} brief={b} asOf={asOf ?? null} onClose={() => setMode('board')} />}
    </div>
  );
}

/**
 * When the work is done but release sign-offs are still open: one calm inline status in the shell's card language — an icon, one sentence,
 * one action. It names the projects; the action opens the first one, where the stages are signed off.
 */
function SignOffNote({ done }: { done: { projectId: string; name: string }[] }) {
  if (done.length === 0) return null;
  const [first] = done;
  const names = done.length === 1 ? first!.name : `${done.length} projects`;
  return (
    <section className="pfx-note" role="status" aria-label="Work complete, check sign-offs">
      <span className="pfx-note-ic" aria-hidden="true"><Icon name="checkCircle" size={18} /></span>
      <span className="pfx-note-txt">
        <b>All work is done on {names}.</b>
        <span>{done.length > 1 ? <>{done.map((d, i) => <span key={d.projectId}>{i > 0 && ', '}<Link to={`/work/projects/${d.projectId}`}>{d.name}</Link></span>)} — release</> : 'Release'} sign-offs are still open.</span>
      </span>
      <Link className="pfx-note-act" to={`/work/projects/${first!.projectId}`}>Review sign-offs</Link>
    </section>
  );
}

/** Under the columns, the room they leave: the next dates and when work lands, each project in its one colour. */
function BoardPulse({ filter, brief }: { filter: PortfolioFilter; brief: PortfolioBrief }) {
  const { projects } = useProjects(filter, brief);
  const today = brief.asOf?.slice(0, 10) ?? new Date().toISOString().slice(0, 10);
  if (projects.length === 0) return null;
  return <PortfolioPulse projects={projects} today={today} kinds={['coming', 'months']} />;
}

/** ✦ One sentence: from the brief, or written by the AI for the meeting. */
function Summary({ summary, filter, ai }: { summary: string; filter: PortfolioFilter; ai: boolean }) {
  const [written, setWritten] = useState<PortfolioAiSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const write = async () => {
    setBusy(true);
    try { setWritten(await portfolioApi.summary(filter, !!written)); } catch (e) { toast(errText(e, 'The summary could not be written.'), 'error'); } finally { setBusy(false); }
  };
  const [first, second] = sentences(written ? written.text : summary);
  return (
    <section aria-label="Summary" className="pf-summary">
      <AiCard action={ai ? { label: written ? 'Write again' : 'Write it for the meeting', onClick: () => void write(), busy } : undefined}>
        <span title={written?.text ?? summary}><b>{first}</b>{second && <> {second}</>}</span>
        {written && <small className="pj2-summary-by">Written by the AI {written.cached ? 'earlier today' : 'just now'}</small>}
      </AiCard>
    </section>
  );
}
