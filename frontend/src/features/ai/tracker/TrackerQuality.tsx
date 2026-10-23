import { Icon, type IconName } from '../../../components/Icon';
import { EmptyState, ErrorState, PageLoader } from '../../../components/ui';
import { useWsQuery } from '../../../lib/hooks';
import { BarList, Spark } from './TrackerCharts';
import { series, trackerApi, type Quality } from './types';

const AREA: Record<string, string> = {
  day: 'Running the day', tasks: 'Tasks and tickets', projects: 'Projects', portfolio: 'Portfolio', workload: 'Workload and people', time: 'Time and leave', chat: 'Chat',
  mail: 'Mail', docs: 'Pages and knowledge', vault: 'Vault', reminders: 'Reminders and watches', meetings: 'Meetings', agent: 'Agent and decisions', reports: 'Reports', conversation: 'General questions',
};
const REASON: Record<string, string> = { too_long: 'Too long', too_short: 'Too short', wrong: 'Wrong', off_topic: 'Off topic', unspecified: 'No reason given' };
const pc = (x: number) => `${Math.round(x * 100)}%`;

function Stat({ icon, label, value, sub, tone }: { icon: IconName; label: string; value: string; sub: string; tone: string }) {
  return (
    <div className={`trk-kpi trk-tone-${tone}`}>
      <span className="trk-kpi-icon"><Icon name={icon} size={16} /></span>
      <div><b>{value}</b><span>{label}</span><small>{sub}</small></div>
    </div>
  );
}

/**
 * Assistant quality: what people did with the answers (marked not helpful, asked again within two minutes, dismissed or undid a card) and
 * where tools failed - by week and by area of the app - plus the scenario gradings run against this workspace. Counts only.
 */
export function QualityView({ from }: { from: string }) {
  const q = useWsQuery(['ai', 'tracker', 'quality', from], () => trackerApi.quality(from), { staleTime: 60_000 });
  if (q.isLoading) return <PageLoader />;
  if (q.isError || !q.data) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const d: Quality = q.data;
  const weak = d.areas.filter((a) => a.answers >= 3).slice(0, 3);
  const lastEval = d.evaluations[0];
  const prevEval = d.evaluations[1];
  return (
    <div className="trk-stack-page" data-testid="trk-quality">
      <div className="trk-kpis">
        <Stat icon="thumbsDown" label="Marked not helpful" value={pc(d.downRate)} sub={`of ${d.answers} answers`} tone="rose" />
        <Stat icon="refresh" label="Asked again within 2 min" value={pc(d.reaskRate)} sub="the answer did not land" tone="amber" />
        <Stat icon="xCircle" label="Cards dismissed" value={pc(d.dismissRate)} sub={`${pc(d.undoRate)} of confirmed ones undone`} tone="violet" />
        <Stat icon="alert" label="Answers with a failed tool" value={pc(d.toolFailureRate)} sub="a lookup or change did not work" tone="sky" />
      </div>
      {d.sampleLimited && <p className="trk-hint"><Icon name="info" size={13} /> Based on the latest 20,000 messages in this period.</p>}

      <div className="trk-grid-2">
        <section className="trk-panel">
          <header><h3><Icon name="target" size={15} />Weakest areas</h3></header>
          {weak.length === 0 ? <p className="trk-hint">Not enough answers yet to compare areas.</p> : (
            <ol className="trk-weak">
              {weak.map((a) => (
                <li key={a.area}>
                  <b>{AREA[a.area] ?? a.area}</b>
                  <span>{a.answers} answers · {pc(a.downRate)} not helpful · {pc(a.reaskRate)} asked again · {pc(a.dismissRate)} cards dismissed{a.toolFailureRate > 0 ? ` · ${pc(a.toolFailureRate)} tool failures` : ''}</span>
                </li>
              ))}
            </ol>
          )}
          <p className="trk-hint">Each 👎 answer can become a test case: run <code>collect-feedback</code> from tools/ai-evaluation (your own answers only).</p>
        </section>
        <section className="trk-panel">
          <header><h3><Icon name="thumbsDown" size={15} />Why answers missed</h3></header>
          {d.downReasons.length === 0 ? <p className="trk-hint">Nobody marked an answer as not helpful in this period.</p>
            : <BarList rows={d.downReasons.map((r) => ({ label: REASON[r.reason] ?? r.reason, value: r.count }))} color={series(5)} />}
        </section>
      </div>

      <section className="trk-panel">
        <header><h3><Icon name="chart" size={15} />Week by week</h3></header>
        {d.weeks.length === 0 ? <EmptyState icon="chart" title="No answers in this period" /> : (
          <div className="trk-table-wrap">
            <table className="trk-table">
              <thead><tr><th>Week of</th><th>Answers</th><th>Not helpful</th><th>Asked again</th><th>Cards confirmed</th><th>Dismissed</th><th>Undone</th><th>Tool failures</th></tr></thead>
              <tbody>
                {d.weeks.map((w) => (
                  <tr key={w.week}>
                    <td>{new Date(`${w.week}T00:00:00`).toLocaleDateString([], { day: 'numeric', month: 'short' })}</td>
                    <td>{w.answers}</td><td>{w.down}</td><td>{w.reasked}</td><td>{w.cardsConfirmed} of {w.cardsProposed}</td><td>{w.cardsDismissed}</td><td>{w.cardsUndone}</td><td>{w.toolFailures}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {d.weeks.length > 1 && <div className="trk-quality-spark"><span>Not helpful + asked again, per answer</span><Spark values={d.weeks.map((w) => (w.answers ? (w.down + w.reasked) / w.answers : 0))} color={series(5)} /></div>}
      </section>

      <section className="trk-panel">
        <header><h3><Icon name="checks" size={15} />Scenario gradings</h3></header>
        {d.evaluations.length === 0 ? (
          <p className="trk-hint">No grading recorded yet. Run <code>tools/ai-evaluation/run-scenarios.mjs</code> against a test workspace with <code>PT_REPORT=1</code> to see pass rates here and follow them over time.</p>
        ) : (
          <>
            <p className="trk-quality-eval"><b>{pc(lastEval.rate)}</b> of {lastEval.total} scenarios passed on {new Date(lastEval.ranAt).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })}
              {prevEval && <span className={lastEval.rate >= prevEval.rate ? 'up' : 'down'}> ({lastEval.rate >= prevEval.rate ? '+' : ''}{Math.round((lastEval.rate - prevEval.rate) * 100)} points since the one before)</span>}
              {lastEval.model ? ` · ${lastEval.model}` : ''}</p>
            {lastEval.summary.byArea && <BarList rows={Object.entries(lastEval.summary.byArea).sort((a, b) => a[1].pass / Math.max(1, a[1].total) - b[1].pass / Math.max(1, b[1].total)).map(([k, v]) => ({ label: AREA[k] ?? k, value: v.total, bad: v.total - v.pass, note: `${v.pass}/${v.total}` }))} color={series(1)} />}
            {d.evaluations.length > 1 && <div className="trk-quality-spark"><span>Pass rate, oldest to newest</span><Spark values={[...d.evaluations].reverse().map((e) => e.rate)} color={series(1)} /></div>}
          </>
        )}
      </section>
    </div>
  );
}
