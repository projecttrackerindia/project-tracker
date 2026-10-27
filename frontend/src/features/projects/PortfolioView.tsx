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
import { CapacitySection, filterCount, MoneySection, PortfolioFilters } from './PortfolioBoard';
import { BoardColumns, DecisionCard, Gantt, PresentOverlay } from './PortfolioViews';
import { decisionItems, type DecisionItem } from './portfolioDecisions';
import { portfolioApi, type PortfolioAiSummary, type PortfolioFilter } from './portfolioApi';
import { BackLink, errText } from './projectParts';
import './portfolio.css';
import './projectsHome.css';

type Mode = 'board' | 'timeline' | 'present';
const firstSentence = (t: string) => (t.trim().split(/(?<=[.!?])\s+/)[0] ?? '').trim();

/**
 * Projects › Portfolio: as-of line, title, Board · Timeline · Present (kept in ?view=portfolio|timeline|present), three status tiles and one
 * AI sentence. Then one list of decisions this week (de-duplicated by project, each with a forecast or "No forecast yet" and an action),
 * then the chosen view. Present is a full-screen run-through of the decisions.
 */
export function PortfolioView({ switcher }: { switcher: ReactNode }) {
  const ai = useAi();
  const { teamId } = useTeamLens();
  const [params, setParams] = useSearchParams();
  const filter: PortfolioFilter = { teamId, ownerId: params.get('owner'), groupId: params.get('group'), health: params.get('health'), dueFrom: params.get('from'), dueTo: params.get('to') };
  const setFilter = (f: PortfolioFilter) => {
    const n = new URLSearchParams(params);
    for (const [k, v] of [['owner', f.ownerId], ['group', f.groupId], ['health', f.health], ['from', f.dueFrom], ['to', f.dueTo]] as const) { if (v) n.set(k, v); else n.delete(k); }
    setParams(n, { replace: true });
  };
  const v = params.get('view');
  const mode: Mode = v === 'timeline' ? 'timeline' : v === 'present' ? 'present' : 'board';
  const setMode = (m: Mode) => { const n = new URLSearchParams(params); n.set('view', m === 'board' ? 'portfolio' : m); setParams(n, { replace: true }); };
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [itemsOpen, setItemsOpen] = useState(false);
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
  return (
    <div className="pj2 pj2-portfolio pf">
      <PageHead eyebrow={<BackLink to="/work" label="Work" />} title="Portfolio">
        <div className="pj2-heads">
          {switcher}
          <DotsMenu label="More on Portfolio" items={[
            { label: nFilters ? `Filters · ${nFilters}` : 'Filters', icon: 'search', hint: 'Owner, group, health and due dates', onSelect: () => setFiltersOpen((x) => !x) },
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

      {q.isLoading ? <PageLoader /> : q.isError || !board || !b ? <ErrorState error={q.error} retry={() => q.refetch()} /> : (
        <>
          <div className="pf-top">
            {asOf && <p className="pf-asof">As of {new Date(asOf).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</p>}
            <Segmented<Mode> label="Portfolio view" value={mode} onChange={setMode}
              options={[{ id: 'board', label: 'Board' }, { id: 'timeline', label: 'Timeline' }, { id: 'present', label: 'Present' }]} />
          </div>
          <div className="pf-tiles" aria-label="Where the projects stand">
            <div className="pf-tile ok"><b>{b.onTrack}</b><span>On track</span></div>
            <div className="pf-tile risk"><b>{b.atRisk}</b><span>At risk</span></div>
            <div className="pf-tile late"><b>{b.delayed}</b><span>Late</span></div>
          </div>
          <Summary summary={b.headlines[0] ?? board.summary} filter={filter} ai={ai} />

          <section aria-label="Decisions this week" className="pj2-section">
            <h3 className="ds-section-title">Decisions this week <em>{items.length}</em></h3>
            {items.length === 0 ? <p className="pj2-calm">No project is forecast to miss its date.</p>
              : <div className="pf-decs">{items.map((it) => <DecisionCard key={it.projectId} item={it} filter={filter} />)}</div>}
          </section>

          {mode === 'timeline' ? <Gantt filter={filter} /> : (
            <>
              <BoardColumns filter={filter} brief={b} />
              <MoneySection m={board.money} />
              <CapacitySection c={board.capacity} />
            </>
          )}
          {mode === 'present' && <PresentOverlay items={items} filter={filter} onClose={() => setMode('board')} />}
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
  const text = firstSentence(written ? written.text : summary);
  return (
    <section aria-label="Summary" className="pj2-summary pf-summary">
      <AiCard title="Summary" action={ai ? { label: written ? 'Write again' : 'Write it for the meeting', onClick: () => void write(), busy } : undefined}>
        <span title={written?.text ?? summary}>{text}</span>
        {written && <small className="pj2-summary-by">Written by the AI {written.cached ? 'earlier today' : 'just now'}</small>}
      </AiCard>
    </section>
  );
}
