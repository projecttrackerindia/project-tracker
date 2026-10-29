import { useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AiCard } from '../../components/v2/AiCard';
import { ErrorState, PageHead, PageLoader, Segmented } from '../../components/ui';
import { useWsQuery } from '../../lib/hooks';
import { useTeamLens } from '../../lib/teamLens';
import { toast } from '../../stores/ui';
import { aiWorkspaceApi } from '../ai/aiApi';
import { useAi, useAssistant } from '../ai/Assistant';
import { DotsMenu } from '../talk/DotsMenu';
import { PortfolioActionItems } from './PortfolioActionItems';
import { CapacityPlanView } from './CapacityPlan';
import { CapacitySection, filterCount, MoneySection, PortfolioFilters } from './PortfolioBoard';
import { BoardColumns, DecisionCard, Gantt, PresentOverlay, isoWeek, TimelineLegend } from './PortfolioViews';
import { decisionItems, type DecisionItem } from './portfolioDecisions';
import { portfolioApi, type PortfolioAiSummary, type PortfolioFilter } from './portfolioApi';
import { errText } from './projectParts';
import './portfolio.css';
import { SavedViewsBar } from '../platform/SavedViews';
import './projectsHome.css';

type Mode = 'board' | 'timeline' | 'capacity' | 'present';
const sentences = (t: string) => t.trim().split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter(Boolean);

/**
 * Projects › Portfolio: as-of line, title, Board · Timeline · Present (kept in ?view=portfolio&mode=timeline|present), three status tiles and one
 * AI sentence. Then one list of decisions this week (de-duplicated by project, each with a forecast or "No forecast yet" and an action),
 * then the chosen view. Present is a full-screen run-through of the decisions.
 */
// The Projects · Portfolio switch is not shown here: the rail carries both Projects and Portfolio (design s-portfolio).
export function PortfolioView(_props: { switcher?: ReactNode }) {
  const ai = useAi();
  const { teamId } = useTeamLens();
  const [params, setParams] = useSearchParams();
  const filter: PortfolioFilter = { teamId, ownerId: params.get('owner'), groupId: params.get('group'), health: params.get('health'), dueFrom: params.get('from'), dueTo: params.get('to') };
  const setFilter = (f: PortfolioFilter) => {
    const n = new URLSearchParams(params);
    for (const [k, v] of [['owner', f.ownerId], ['group', f.groupId], ['health', f.health], ['from', f.dueFrom], ['to', f.dueTo]] as const) { if (v) n.set(k, v); else n.delete(k); }
    setParams(n, { replace: true });
  };
  // ?view=portfolio&mode=timeline|present (the rail keys Portfolio on view=portfolio); old ?view=timeline|present links still open.
  const v = params.get('mode') ?? params.get('view');
  const mode: Mode = v === 'timeline' ? 'timeline' : v === 'capacity' ? 'capacity' : v === 'present' ? 'present' : 'board';
  const setMode = (m: Mode) => { const n = new URLSearchParams(params); n.set('view', 'portfolio'); if (m === 'board') n.delete('mode'); else n.set('mode', m); setParams(n, { replace: true }); };
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [itemsOpen, setItemsOpen] = useState(false);
  const [timelineRange, setTimelineRange] = useState<string | null>(null);
  const q = useWsQuery(['portfolio', 'board', filter], () => portfolioApi.board(filter), { refetchInterval: 120_000, staleTime: 60_000, placeholderData: (prev) => prev });
  const nFilters = filterCount(filter);
  const sendBrief = async () => {
    try { const r = await aiWorkspaceApi.sendBrief(teamId); toast(r.sent ? 'The brief is on its way to you, in the app and by e-mail.' : r.reason ?? 'Nothing was sent.', r.sent ? 'success' : 'info'); }
    catch { toast('Could not send the brief.', 'error'); }
  };
  const exportAs = async (format: 'xlsx' | 'pdf') => { try { await portfolioApi.export(filter, format); } catch { toast('The export could not be made.', 'error'); } };
  const board = q.data;
  const b = board?.brief;
  const items: DecisionItem[] = useMemo(() => board && b ? decisionItems(board.decisions, b) : [], [board, b]);
  const asOf = board?.asOf ?? b?.asOf;
  const rankedOwner = useMemo(() => new Map((b?.ranked ?? []).map((r) => [r.projectId, r.owner])), [b]);
  const projectsN = b ? b.onTrack + b.atRisk + b.delayed + b.onHold : 0;
  const keysOf = (h: string) => (b?.ranked ?? []).filter((r) => r.health === h).slice(0, 2).map((r) => r.key).join(' · ');
  const eyebrow = mode === 'capacity' ? 'Next 6 weeks' : mode === 'timeline' && timelineRange ? timelineRange : `${b?.projects ?? projectsN} projects · Week ${isoWeek(asOf ? new Date(asOf) : new Date())}`;
  return (
    <div className="pj2 pj2-portfolio pf">
      <PageHead eyebrow={eyebrow} title={mode === 'capacity' ? 'Capacity' : 'Portfolio'}>
        <div className="pj2-heads pf-heads">
          {mode === 'timeline' && <TimelineLegend />}
          <Segmented<Mode> label="Portfolio view" value={mode} onChange={setMode}
            options={[{ id: 'board', label: 'Board' }, { id: 'timeline', label: 'Timeline' }, { id: 'capacity', label: 'Capacity' }, { id: 'present', label: 'Present' }]} />
          <DotsMenu label="More on Portfolio" items={[
            { label: nFilters ? `Filters · ${nFilters}` : 'Filters', icon: 'search', hint: 'Owner, group, health and due dates', onSelect: () => setFiltersOpen((x) => !x) },
            { label: 'Export to Excel', icon: 'download', onSelect: () => void exportAs('xlsx') },
            { label: 'Export to PDF', icon: 'download', onSelect: () => void exportAs('pdf') },
            { label: 'Action items', icon: 'flag', hint: b?.openActionItems ? `${b.openActionItems} open across projects` : 'Follow-ups across projects', onSelect: () => setItemsOpen(true) },
            { label: 'Send me this', icon: 'send', hint: 'The brief, in the app and by e-mail', onSelect: () => void sendBrief() },
            { label: 'Risk review', icon: 'sparkle', hint: 'Ask Aura which projects will miss their dates', hidden: !ai,
              onSelect: () => useAssistant.getState().ask('Portfolio risk review: rank the projects most likely to miss their dates, explain the causes using the history of date changes, and recommend one concrete action for each.') },
          ]} />
        </div>
      </PageHead>

      {mode !== 'present' && (
        <div className="pf-views">
          <SavedViewsBar scope="portfolio" current={{ mode: mode === 'board' ? undefined : mode, owner: filter.ownerId ?? undefined, group: filter.groupId ?? undefined,
            health: filter.health ?? undefined, from: filter.dueFrom ?? undefined, to: filter.dueTo ?? undefined }}
            onApply={(c) => {
              const n = new URLSearchParams(params);
              n.set('view', 'portfolio');
              for (const k of ['mode', 'owner', 'group', 'health', 'from', 'to']) { const val = c[k]; if (typeof val === 'string' && val) n.set(k, val); else n.delete(k); }
              setParams(n, { replace: true });
            }} />
        </div>
      )}
      {board && (filtersOpen || nFilters > 0) && <div className="pj2-pfilters"><PortfolioFilters board={board} filter={filter} onChange={setFilter} /></div>}

      {q.isLoading ? <PageLoader /> : q.isError || !board || !b ? <ErrorState error={q.error} retry={() => q.refetch()} /> : mode === 'capacity' ? (
        <CapacityPlanView />
      ) : mode === 'timeline' ? (
        <Gantt filter={filter} brief={b} decisions={board.decisions} onRange={setTimelineRange} />
      ) : (
        <>
          <div className="pf-big">
            <div className="pf-tile ok"><b>{b.onTrack}</b><span><strong>On track</strong><small>of {b.projects} projects{b.projects > projectsN ? ` · ${b.projects - projectsN} without a health yet` : ''}</small></span></div>
            <div className="pf-tile risk"><b>{b.atRisk}</b><span><strong>At risk</strong><small>{keysOf('AtRisk') || 'None at risk'}</small></span></div>
            <div className="pf-tile late"><b>{b.delayed}</b><span><strong>Late</strong><small>{keysOf('Delayed') || 'None late'}</small></span></div>
            <Summary summary={b.headlines[0] ?? board.summary} filter={filter} ai={ai} />
          </div>

          <div className="pf-lay">
            <BoardColumns filter={filter} brief={b} items={items} />
            <section aria-label="Decisions this week" className="pf-rail">
              <h3 className="pf-rail-head">Decisions this week <em>{items.length}</em></h3>
              {items.length === 0 ? <p className="pf-calm">No project is forecast to miss its date.</p>
                : <div className="pf-decs">{items.map((it) => <DecisionCard key={it.projectId} item={it} filter={filter} owner={rankedOwner.get(it.projectId) ?? null} />)}</div>}
            </section>
          </div>
          <MoneySection m={board.money} />
          <CapacitySection c={board.capacity} />
          {mode === 'present' && <PresentOverlay items={items} filter={filter} brief={b} asOf={asOf ?? null} onClose={() => setMode('board')} />}
        </>
      )}
      {itemsOpen && <PortfolioActionItems onClose={() => setItemsOpen(false)} />}
    </div>
  );
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
