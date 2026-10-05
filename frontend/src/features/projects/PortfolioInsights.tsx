import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon } from '../../components/Icon';
import { toast } from '../../stores/ui';
import { Modal, PageLoader } from '../../components/ui';
import { useQuery } from '@tanstack/react-query';
import { formatDate } from '../../lib/format';
import { useWsQuery } from '../../lib/hooks';
import { useTeamLens } from '../../lib/teamLens';
import { aiWorkspaceApi, type PortfolioRisk, type ScenarioOutcome } from '../ai/aiApi';
import { PortfolioActionItems } from './PortfolioActionItems';
import { Sparkle, useAi } from '../ai/Assistant';

/** The portfolio worked out by rules over the projects the person may open: no model, no credits, every plan. Shared by the page and each project. */
export function usePortfolioBrief() {
  const { teamId } = useTeamLens();
  return useWsQuery(['project-status', 'brief', teamId], () => aiWorkspaceApi.portfolioBrief(teamId), { refetchInterval: 120_000, staleTime: 60_000, placeholderData: (prev) => prev });
}

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
  const q = usePortfolioBrief();
  const ai = useAi();
  const ask = useAsk();
  const [itemsOpen, setItemsOpen] = useState(false);
  const { teamId } = useTeamLens();
  const [sending, setSending] = useState(false);
  const sendBrief = async () => {
    setSending(true);
    try { const r = await aiWorkspaceApi.sendBrief(teamId); toast(r.sent ? 'The brief is on its way to you, in the app and by e-mail.' : r.reason ?? 'Nothing was sent.', r.sent ? 'success' : 'info'); }
    catch { toast('Could not send the brief.', 'error'); }
    finally { setSending(false); }
  };
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
        <div className="pi-ask">
          <button type="button" className="btn btn-soft btn-sm" onClick={() => setItemsOpen(true)}><Icon name="checkCircle" size={14} /> Action items{b.openActionItems > 0 && <span className="ps-count">{b.openActionItems}</span>}</button>
          <button type="button" className="btn btn-ghost btn-sm" disabled={sending} onClick={() => void sendBrief()} title="Send this brief to you as a notice, in the app and by e-mail"><Icon name="mail" size={14} /> Send me this</button>
          {ai && <>
            <button type="button" className="btn btn-soft btn-sm" onClick={() => ask('Give me an executive summary of the portfolio: what is going well, what is at risk and why, how late the worst projects are likely to land, and what I should escalate this week.')}><Sparkle size={14} /> Executive summary</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => ask('Portfolio risk review: rank the projects most likely to miss their dates, explain the causes using the history of date changes, and recommend one concrete action for each.')}>Risk review</button>
          </>}
        </div>
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
      {itemsOpen && <PortfolioActionItems onClose={() => setItemsOpen(false)} />}
    </div>
  );
}

/** One project's place in the portfolio, kept to one line: its risk and forecast. "Why" opens the reasons and the shortcuts to ask the assistant. */
export function ProjectInsight({ projectId, onActionItems }: { projectId: string; onActionItems: () => void }) {
  const q = usePortfolioBrief();
  const ai = useAi();
  const ask = useAsk();
  const [open, setOpen] = useState(false);
  const [whatIf, setWhatIf] = useState(false);
  const r = q.data?.ranked.find((x) => x.projectId === projectId);
  if (!r) return null;
  const more = r.reasons.length > 0 || ai;
  return (
    <section className={`pi-project ${r.level.toLowerCase()} ${open ? 'open' : ''}`} aria-label="Risk and forecast">
      <div className="pi-project-head">
        <span className={`pi-level ${r.level.toLowerCase()}`}>{r.level} risk</span>
        <Forecast r={r} />
        {r.overdueActionItems > 0 && <button type="button" className="pi-chip" onClick={onActionItems}>{r.overdueActionItems} overdue action item{r.overdueActionItems === 1 ? '' : 's'}</button>}
        <button type="button" className="pi-why pi-whatif-btn" onClick={() => setWhatIf(true)} title="See when it would finish if the work slipped, people joined or scope was cut">What if…</button>
        {more && <button type="button" className="pi-why" aria-expanded={open} onClick={() => setOpen((v) => !v)}>{open ? 'Hide' : 'Why?'} <span style={{ display: 'inline-flex', transform: open ? 'rotate(180deg)' : undefined }}><Icon name="chevronD" size={13} /></span></button>}
      </div>
      {open && r.reasons.length > 0 && <ul>{r.reasons.map((x) => <li key={x}>{x}</li>)}</ul>}
      {open && ai && (
        <div className="pi-ask">
          <button type="button" className="btn btn-soft btn-sm" onClick={() => ask(`Analyse ${r.name} (${r.key}): why is it ${r.health === 'OnTrack' ? 'where it is' : r.health === 'Delayed' ? 'delayed' : 'at risk'}, when will it really finish, and what should I do about it? Include its action items.`)}><Sparkle size={14} /> Analyse with AI</button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => ask(`Prepare the changes to get ${r.name} (${r.key}) back on track: reassign overloaded work, set reminders on its overdue action items, and propose realistic dates. Show me what you would change.`)}>Plan the recovery</button>
        </div>
      )}
      {whatIf && <WhatIf projectId={r.projectId} name={r.name} onClose={() => setWhatIf(false)} />}
    </section>
  );
}

const outcome = (o: ScenarioOutcome) => o.finish ? formatDate(o.finish) : 'Cannot be forecast';
const lateness = (o: ScenarioOutcome) => o.slipDays == null ? null : o.slipDays > 0 ? `${o.slipDays} day${o.slipDays === 1 ? '' : 's'} after the due date` : o.slipDays < 0 ? `${-o.slipDays} day${o.slipDays === -1 ? '' : 's'} before the due date` : 'on the due date';

/** "What if": when the project would finish if the work started later, more people joined or some tasks were cut. Arithmetic over its own pace; nothing is changed. */
function WhatIf({ projectId, name, onClose }: { projectId: string; name: string; onClose: () => void }) {
  const { teamId } = useTeamLens();
  const [slip, setSlip] = useState(0); const [add, setAdd] = useState(0); const [cut, setCut] = useState(0);
  const q = useQuery({
    queryKey: ['scenario', projectId, slip, add, cut, teamId],
    queryFn: () => aiWorkspaceApi.scenario({ projectId, slipDays: slip, addPeople: add, cutTasks: cut, teamId }),
    placeholderData: (prev) => prev,
  });
  const d = q.data;
  const num = (v: string, max: number) => Math.max(0, Math.min(max, Math.floor(Number(v) || 0)));
  const changed = slip > 0 || add > 0 || cut > 0;
  return (
    <Modal size="lg" title={`What if… ${name}`} onClose={onClose} footer={<button type="button" className="btn btn-primary" onClick={onClose}>Close</button>}>
      <p className="muted" style={{ marginTop: 0 }}>Change one or more of these to see when the project would finish. Nothing is changed in the project.</p>
      <div className="pi-whatif-inputs">
        <label>The work starts later by<span><input className="input" type="number" min={0} max={365} value={slip} onChange={(e) => setSlip(num(e.target.value, 365))} /> days</span></label>
        <label>People added<span><input className="input" type="number" min={0} max={50} value={add} onChange={(e) => setAdd(num(e.target.value, 50))} /> people</span></label>
        <label>Tasks taken out of the plan<span><input className="input" type="number" min={0} max={d?.openTasks ?? 500} value={cut} onChange={(e) => setCut(num(e.target.value, d?.openTasks ?? 500))} /> of {d?.openTasks ?? '…'}</span></label>
      </div>
      {!d ? <PageLoader /> : (
        <div className="pi-whatif-out">
          <div className="pi-whatif-card">
            <label>Today's plan</label><b>{outcome(d.baseline)}</b>
            <small>{lateness(d.baseline) ?? `Due ${d.dueDate ? formatDate(d.dueDate) : 'not set'}`}{d.baseline.finish ? ` · ${d.baseline.confidence} confidence` : ''}</small>
          </div>
          <div className={`pi-whatif-card ${changed ? 'on' : ''} ${d.scenario.slipDays != null && d.scenario.slipDays > 0 ? 'late' : ''}`}>
            <label>With your change</label><b>{outcome(d.scenario)}</b>
            <small>{lateness(d.scenario) ?? (d.dueDate ? '' : 'No due date set')}{d.scenario.finish ? ` · ${d.scenario.confidence} confidence` : ''}</small>
            {changed && d.changeDays != null && <em className={d.changeDays > 0 ? 'late' : 'ok'}>{d.changeDays === 0 ? 'No change' : d.changeDays > 0 ? `${d.changeDays} day${d.changeDays === 1 ? '' : 's'} later` : `${-d.changeDays} day${d.changeDays === -1 ? '' : 's'} sooner`}</em>}
          </div>
        </div>
      )}
      {d?.toMeetDue && <p className="pi-whatif-need"><Icon name="target" size={15} /> {d.toMeetDue.note}</p>}
      {d && d.notes.length > 0 && <ul className="pi-whatif-notes">{d.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
      <p className="muted" style={{ fontSize: 12.5, marginBottom: 0 }}>An estimate from the pace of the last 4 weeks ({d?.finishedLast28Days ?? '…'} tasks finished), not a commitment.</p>
    </Modal>
  );
}
