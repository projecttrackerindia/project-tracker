import { lazy, Suspense, useEffect, useState } from 'react';
import { ReviewQueueCard } from '../github/GitHubApp';
import { GetStarted } from './GetStarted';
import { Link, useSearchParams } from 'react-router-dom';
import { delegateApi } from '../../api/endpoints';
import type {
  AgentCommitment, AgentDelegation, AttentionItem, AttentionKind, CcChange, CommandCenter, MyMeeting, CheckInAnswer,
} from '../../api/types';
import { AgentMark } from '../../components/AgentMark';
import { Icon, type IconName } from '../../components/Icon';
import { EmptyState, ErrorState, Field, Modal, PageLoader } from '../../components/ui';
import { dateOffset, formatDate, formatTime, timeAgo } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { haptic } from '../../lib/mobile';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { BriefModal, DecisionsView, AuditView, WhatIfModal, DelegateModal, ReportModal } from './CommandParts';
import { MyWorkPage } from '../workitems/MyWorkPage';
import { errText } from './shared';
import { AiFirstHome } from './AiFirstHome';
import { useAiStatus } from '../ai/Assistant';
import '../agent/agent.css';

// The classic dashboard (tasks, projects, charts) is the first tab of Home; loaded on its own so the other tabs stay light.
const DashboardPage = lazy(() => import('../dashboard/DashboardPage').then((m) => ({ default: m.DashboardPage })));
import './command.css';


const KIND: Record<AttentionKind, { icon: IconName; label: string }> = {
  decide: { icon: 'checks', label: 'Decide' },
  change_request: { icon: 'clock', label: 'Change request' },
  check_in: { icon: 'flag', label: 'Check-in' },
  overdue: { icon: 'alert', label: 'Late' },
  blocking: { icon: 'layers', label: 'Holding others up' },
  double_booked: { icon: 'calendar', label: 'Double-booked' },
  at_risk: { icon: 'gauge', label: 'At risk' },
  missed_commitments: { icon: 'xCircle', label: 'Missed commitments' },
  conflict: { icon: 'git', label: 'Dates disagree' },
  unresolved: { icon: 'repeat', label: 'Keeps coming up' },
};

type Tab = 'dashboard' | 'today' | 'work' | 'decisions' | 'audit';
const TABS: { id: Tab; label: string; icon: IconName }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: 'dashboard' }, { id: 'today', label: 'Today', icon: 'target' }, { id: 'work', label: 'My work', icon: 'inbox' },
  { id: 'decisions', label: 'Decisions', icon: 'checks' }, { id: 'audit', label: 'Audit trail', icon: 'shield' },
];

/**
 * The Command Center: what needs me today, across every project - each item with the evidence for it and one tap to act - then my meetings
 * (send the agent in my place, read the brief), the decision registry and the audit trail of everything the agent did.
 */
export function CommandCenterPage() {
  const wid = useWorkspaceId();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'dashboard';
  const q = useWsQuery(['agent', 'command-center'], () => delegateApi.commandCenter(), { refetchInterval: 120_000 });
  const [checkIn, setCheckIn] = useState<string | null>(params.get('checkin'));
  const [delegate, setDelegate] = useState<{ meetingId: string; at: string; title?: string } | null>(params.get('delegate') && params.get('at') ? { meetingId: params.get('delegate')!, at: params.get('at')! } : null);
  const [brief, setBrief] = useState<{ meetingId: string; at?: string | null } | null>(params.get('brief') ? { meetingId: params.get('brief')!, at: params.get('at') } : null);
  const [report, setReport] = useState<string | null>(params.get('delegation'));
  const [whatIf, setWhatIf] = useState(false);
  const refresh = () => { void invalidateWorkspace(wid, 'agent'); };

  // Deep links from notifications open their dialog once, then leave the address clean.
  useEffect(() => {
    if (['checkin', 'delegate', 'brief', 'delegation', 'at'].some((k) => params.has(k))) {
      const next = new URLSearchParams(params);
      ['checkin', 'delegate', 'brief', 'delegation', 'at'].forEach((k) => next.delete(k));
      setParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Home is the assistant whenever AI is available here; the full views (Today, My work, Meetings…) open from it as ?tab=…, with a Home
  // tab back. Without AI (switched off, not in the plan) Home is those views, starting with the dashboard.
  const ai = useAiStatus();
  const aiHome = !!ai?.enabled;
  const setTab = (t: Tab | 'home') => {
    const next = new URLSearchParams(params);
    if (t === 'home' || (t === 'dashboard' && !aiHome)) next.delete('tab'); else next.set('tab', t);
    setParams(next, { replace: true });
  };
  const showAiFirst = aiHome && !params.get('tab');

  if (showAiFirst) return (
    <div className="cmd-page">
      <AiFirstHome c={q.data} onTab={(t) => setTab(t)} />
    </div>
  );
  return (
    <div className="cmd-page">
      <div className="cmd-tabbar">
      <nav className="tabs cmd-tabs" aria-label="Home">
        {aiHome && <button type="button" className="tab cmd-home-tab" onClick={() => { haptic(4); setTab('home'); }}><AgentMark size={15} /><span>Home</span></button>}
        {TABS.map((t) => (
          <button key={t.id} type="button" className={`tab${tab === t.id ? ' active' : ''}`} aria-pressed={tab === t.id} onClick={() => { haptic(4); setTab(t.id); }}>
            <Icon name={t.icon} size={15} /><span>{t.label}</span>
          </button>
        ))}
      </nav>
      </div>
      {tab === 'dashboard' ? <div className="cmd-dashboard"><Suspense fallback={<PageLoader />}><DashboardPage /></Suspense></div>
        : q.isLoading ? <PageLoader /> : q.isError || !q.data ? <ErrorState error={q.error} retry={() => q.refetch()} /> : (
        <>
          <Hero c={q.data} onWhatIf={() => setWhatIf(true)} />
          <GetStarted />
          {tab === 'today' && <TodayView c={q.data} onCheckIn={setCheckIn} onDelegate={setDelegate} onBrief={setBrief} onReport={setReport} />}
          {tab === 'work' && <div className="cmd-mywork"><MyWorkPage embedded /></div>}
          {tab === 'decisions' && <DecisionsView />}
          {tab === 'audit' && <AuditView />}
        </>
      )}
      {checkIn && <CheckInModal id={checkIn} onClose={() => setCheckIn(null)} onDone={() => { setCheckIn(null); refresh(); }} />}
      {delegate && <DelegateModal target={delegate} onClose={() => setDelegate(null)} onDone={() => { setDelegate(null); refresh(); }} />}
      {brief && <BriefModal meetingId={brief.meetingId} at={brief.at} onClose={() => setBrief(null)} onDelegate={(d) => { setBrief(null); setDelegate(d); }} />}
      {report && <ReportModal id={report} onClose={() => setReport(null)} />}
      {whatIf && <WhatIfModal onClose={() => setWhatIf(false)} />}
    </div>
  );
}

// ------------------------------------------------------------------ hero

function Hero({ c, onWhatIf }: { c: CommandCenter; onWhatIf: () => void }) {
  const stats: { label: string; value: number; tone?: string; icon: IconName }[] = [
    { label: 'Need you', value: c.counts.attention, tone: c.attention.some((a) => a.severity === 'high') ? 'danger' : 'primary', icon: 'target' },
    { label: 'To decide', value: c.counts.toDecide, icon: 'checks' },
    { label: 'Due today', value: c.counts.dueToday, icon: 'calendar' },
    { label: 'Late', value: c.counts.overdue, tone: c.counts.overdue > 0 ? 'danger' : undefined, icon: 'alert' },
    { label: 'Others waiting', value: c.counts.blocking, tone: c.counts.blocking > 0 ? 'warning' : undefined, icon: 'layers' },
    { label: 'Meetings', value: c.counts.meetingsToday, icon: 'video' },
  ];
  const today = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
  // The greeting leads; the headline is the one line under it; six numbers follow, coloured only when the colour means something.
  return (
    <header className="cmd-hero">
      <div className="cmd-hero-top">
        <div className="cmd-hero-text">
          <span className="eyebrow">{today}</span>
          <h1>{c.greeting}</h1>
          <p>{c.headline}</p>
        </div>
        <button type="button" className="btn btn-ghost cmd-whatif-btn" onClick={onWhatIf}><Icon name="git" size={14} />What if…</button>
      </div>
      <div className="cmd-stats" role="list">
        {stats.map((s) => (
          <div key={s.label} role="listitem" className={`cmd-stat ${s.tone ? `cmd-stat-${s.tone}` : ''} ${s.value === 0 ? 'zero' : ''}`}>
            <span>{s.label}</span>
            <b>{s.value}</b>
          </div>
        ))}
      </div>
    </header>
  );
}

// ------------------------------------------------------------------ today

function TodayView({ c, onCheckIn, onDelegate, onBrief, onReport }: {
  c: CommandCenter; onCheckIn: (id: string) => void; onDelegate: (d: { meetingId: string; at: string; title?: string }) => void;
  onBrief: (b: { meetingId: string; at?: string | null }) => void; onReport: (id: string) => void;
}) {
  return (
    <div className="cmd-grid">
      <section className="cmd-main" aria-label="What needs you">
        <h2 className="cmd-section-title"><Icon name="target" size={15} />Needs you<span>{c.attention.length}</span></h2>
        {c.attention.length === 0
          ? <EmptyState icon="checkCircle" title="You're clear" text="Nothing is waiting on you. The agent keeps watching your projects, meetings and commitments." />
          : <div className="cmd-attention">{c.attention.map((a) => <AttentionCard key={a.id} a={a} onCheckIn={onCheckIn} onDelegate={onDelegate} />)}</div>}

        {c.owe.length > 0 && (
          <>
            <h2 className="cmd-section-title"><Icon name="inbox" size={15} />What I owe<span>{c.owe.length}</span></h2>
            <ul className="cmd-owe card">
              {c.owe.map((w) => (
                <li key={w.id}>
                  <Link to={`/projects/${w.projectId}?task=${w.id}`} className="cmd-owe-main">
                    <b>{w.key}</b><span>{w.title}</span>
                  </Link>
                  <span className={`cmd-pill ${w.state === 'overdue' ? 'bad' : w.state === 'due_today' ? 'warn' : ''}`}>
                    {w.state === 'overdue' ? `${w.daysLate}d late` : w.state === 'due_today' ? 'Today' : w.due ? formatDate(w.due) : 'No date'}
                  </span>
                  {w.waiting.length > 0 && <small className="cmd-owe-waiting"><Icon name="layers" size={11} />{w.waiting.length} waiting: {w.waiting.slice(0, 2).join(', ')}{w.waiting.length > 2 ? '…' : ''}</small>}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <aside className="cmd-side">
        <ComingUp meetings={c.today} onDelegate={onDelegate} onBrief={onBrief} />
        <ReviewQueueCard compact />
        {c.delegations.length > 0 && <DelegationsCard items={c.delegations} onReport={onReport} />}
        <Changes changes={c.changes} since={c.since} />
        <Reliability r={c.reliability} />
        {c.health.length > 0 && <Health c={c} />}
        {c.checkIns.filter((x) => !x.awaitingAnswer && x.status === 'open').length > 0 && <Promises items={c.checkIns.filter((x) => x.status === 'open')} onCheckIn={onCheckIn} />}
      </aside>
    </div>
  );
}

function AttentionCard({ a, onCheckIn, onDelegate }: { a: AttentionItem; onCheckIn: (id: string) => void; onDelegate: (d: { meetingId: string; at: string; title?: string }) => void }) {
  const k = KIND[a.kind];
  const action = a.action === 'check_in' && a.entityId ? <button type="button" className="btn btn-primary btn-sm" onClick={() => onCheckIn(a.entityId!)}><Icon name="flag" size={14} />Answer</button>
    : a.action === 'delegate' && a.entityId && a.actionAt ? <button type="button" className="btn btn-primary btn-sm" onClick={() => onDelegate({ meetingId: a.entityId!, at: a.actionAt!, title: a.title.replace(/^Double-booked: /, '') })}><Icon name="agent" size={14} />Send the agent</button>
    : a.link ? <Link className={`btn btn-sm ${a.action === 'decide' || a.action === 'review' ? 'btn-primary' : 'btn-ghost'}`} to={a.link}>{a.action === 'decide' ? 'Decide' : a.action === 'review' ? 'Review' : 'Open'}<Icon name="arrowRight" size={13} /></Link>
    : null;
  return (
    <article className={`cmd-card cmd-sev-${a.severity}`} data-attention={a.kind}>
      <div className="cmd-card-icon" aria-hidden><Icon name={k.icon} size={16} /></div>
      <div className="cmd-card-body">
        <div className="cmd-card-meta">
          <span className="cmd-kind">{k.label}</span>
          {a.projectKey && <span className="cmd-proj">{a.projectKey}</span>}
          {a.severity === 'high' && <span className="cmd-urgent">Urgent</span>}
        </div>
        <h3>{a.title}</h3>
        {a.detail && <p className="cmd-card-detail">{a.detail}</p>}
        {a.why.length > 0 && (
          <ul className="cmd-why" aria-label="Why">
            {a.why.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        )}
      </div>
      {action && <div className="cmd-card-action">{action}</div>}
    </article>
  );
}

function ComingUp({ meetings, onDelegate, onBrief }: { meetings: MyMeeting[]; onDelegate: (d: { meetingId: string; at: string; title?: string }) => void; onBrief: (b: { meetingId: string; at?: string | null }) => void }) {
  return (
    <div className="card cmd-panel">
      <h3 className="cmd-panel-title"><Icon name="video" size={14} />Coming up<Link className="ag-link cmd-panel-more" to="/meet">All in Meet</Link></h3>
      {meetings.length === 0 ? <p className="cmd-muted">No meetings in the next day.</p> : (
        <ol className="cmd-timeline">
          {meetings.map((m) => {
            const now = Date.now(); const live = new Date(m.startUtc).getTime() <= now && new Date(m.endUtc).getTime() > now;
            return (
              <li key={m.id} className={`${live ? 'live' : ''} ${m.overlapsWith.length ? 'clash' : ''}`}>
                <time>{formatTime(m.startUtc)}</time>
                <div>
                  <b>{m.title}</b>
                  <small>{m.projectKey ?? 'Calendar'}{live ? ' · now' : ''}{m.overlapsWith.length > 0 ? ` · overlaps ${m.overlapsWith[0]}` : ''}</small>
                  <div className="cmd-timeline-actions">
                    {m.delegationId && m.delegationStatus !== 'cancelled'
                      ? <span className="cmd-pill ok"><Icon name="agent" size={11} />Agent going</span>
                      : m.project && m.agentEnabled && m.meetingId && new Date(m.endUtc).getTime() > now
                        ? <button type="button" className="ag-link" onClick={() => onDelegate({ meetingId: m.meetingId!, at: m.startUtc, title: m.title })}>Send the agent</button> : null}
                    {m.project && m.meetingId && <button type="button" className="ag-link" onClick={() => onBrief({ meetingId: m.meetingId!, at: m.startUtc })}>Brief</button>}
                    {m.meetUrl && <a className="ag-link" href={m.meetUrl} target="_blank" rel="noreferrer">Join</a>}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

function DelegationsCard({ items, onReport }: { items: AgentDelegation[]; onReport: (id: string) => void }) {
  return (
    <div className="card cmd-panel">
      <h3 className="cmd-panel-title"><Icon name="agent" size={14} />Sent in my place</h3>
      <ul className="cmd-list">
        {items.slice(0, 5).map((d) => (
          <li key={d.id}>
            <button type="button" className="cmd-list-btn" onClick={() => onReport(d.id)}>
              <span><b>{d.title}</b><small>{formatDate(d.startUtc)} {formatTime(d.startUtc)} · {d.projectKey}</small></span>
              <span className={`cmd-pill ${d.status === 'reported' ? 'ok' : ''}`}>{d.status === 'reported' ? (d.toDecide > 0 ? `${d.toDecide} to decide` : 'Report') : d.status === 'attending' ? 'Attending' : 'Going'}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

const CHANGE_ICON: Record<CcChange['kind'], IconName> = { done: 'checkCircle', assigned: 'userPlus', decision: 'checks', moved: 'clock', auto: 'sparkle', meeting: 'video' };

function Changes({ changes, since }: { changes: CcChange[]; since: string }) {
  return (
    <div className="card cmd-panel">
      <h3 className="cmd-panel-title"><Icon name="refresh" size={14} />Since {timeAgo(since)}</h3>
      {changes.length === 0 ? <p className="cmd-muted">Nothing changed in your projects since your last visit.</p> : (
        <ul className="cmd-changes">
          {changes.map((ch, i) => (
            <li key={i}>
              <Icon name={CHANGE_ICON[ch.kind]} size={13} />
              {ch.link ? <Link to={ch.link}>{ch.text}</Link> : <span>{ch.text}</span>}
              <time>{timeAgo(ch.at)}</time>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** How reliably commitments were kept (30 days): one stacked bar, every segment labelled. */
function Reliability({ r }: { r: CommandCenter['reliability'] }) {
  const total = r.kept + r.missed + r.moved + r.open;
  const decided = r.kept + r.missed;
  const rate = decided > 0 ? Math.round((r.kept / decided) * 100) : null;
  const parts = [
    { k: 'kept', v: r.kept, label: 'Kept' }, { k: 'moved', v: r.moved, label: 'Moved' }, { k: 'missed', v: r.missed, label: 'Missed' }, { k: 'open', v: r.open, label: 'Open' },
  ].filter((p) => p.v > 0);
  return (
    <div className="card cmd-panel">
      <h3 className="cmd-panel-title"><Icon name="gauge" size={14} />Commitments · 30 days</h3>
      {total === 0 ? <p className="cmd-muted">When meetings agree work with an owner and a date, the agent follows it up and you see how often it lands.</p> : (
        <>
          <div className="cmd-rate"><b>{rate == null ? '–' : `${rate}%`}</b><span>kept on time{decided > 0 ? ` (${r.kept} of ${decided})` : ''}</span></div>
          <div className="cmd-stack" role="img" aria-label={parts.map((p) => `${p.label} ${p.v}`).join(', ')}>
            {parts.map((p) => <i key={p.k} className={`cmd-seg-${p.k}`} style={{ flexGrow: p.v }} title={`${p.label}: ${p.v}`} />)}
          </div>
          <ul className="cmd-legend">{parts.map((p) => <li key={p.k}><i className={`cmd-seg-${p.k}`} />{p.label} <b>{p.v}</b></li>)}</ul>
        </>
      )}
    </div>
  );
}

function Health({ c }: { c: CommandCenter }) {
  return (
    <div className="card cmd-panel">
      <h3 className="cmd-panel-title"><Icon name="monitor" size={14} />Project health</h3>
      <ul className="cmd-health">
        {c.health.map((h) => (
          <li key={h.projectId}>
            <Link to={`/projects/${h.projectId}`} className="cmd-health-row" title={h.reasons.join(' · ') || 'No warning signs'}>
              <span className="cmd-health-name"><b>{h.key}</b>{h.name}</span>
              <span className={`cmd-health-level lv-${h.level}`}>{h.level === 'high' ? 'At risk' : h.level === 'medium' ? 'Watch' : 'On track'}</span>
              <span className="cmd-bar" aria-hidden><i style={{ width: `${Math.max(4, Math.min(100, h.progress))}%` }} /></span>
              <small>{h.progress}% done{h.overdueTasks > 0 ? ` · ${h.overdueTasks} late` : ''}{h.slipDays ? ` · ~${h.slipDays}d late` : ''}{h.kept + h.missed > 0 ? ` · ${h.kept}/${h.kept + h.missed} promises kept` : ''}</small>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Promises({ items, onCheckIn }: { items: AgentCommitment[]; onCheckIn: (id: string) => void }) {
  return (
    <div className="card cmd-panel">
      <h3 className="cmd-panel-title"><Icon name="flag" size={14} />My commitments</h3>
      <ul className="cmd-list">
        {items.slice(0, 6).map((p) => (
          <li key={p.id}>
            <button type="button" className="cmd-list-btn" onClick={() => onCheckIn(p.id)}>
              <span><b>{p.entityKey ?? p.title}</b><small>{p.title}</small></span>
              <span className="cmd-pill">{formatDate(p.dueDate)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ------------------------------------------------------------------ dialogs

const ANSWERS: { id: CheckInAnswer; label: string; icon: IconName; text: string }[] = [
  { id: 'on_track', label: 'On track', icon: 'checkCircle', text: 'It will be done by the date' },
  { id: 'done', label: 'Done', icon: 'checks', text: 'Mark it finished now' },
  { id: 'more_time', label: 'Need more time', icon: 'clock', text: 'Ask the lead for a new date' },
  { id: 'blocked', label: 'Blocked', icon: 'alert', text: 'Something is in the way' },
];

function CheckInModal({ id, onClose, onDone }: { id: string; onClose: () => void; onDone: () => void }) {
  const q = useWsQuery(['agent', 'commitment', id], () => delegateApi.commitment(id));
  const [answer, setAnswer] = useState<CheckInAnswer | null>(null);
  const [note, setNote] = useState('');
  const [date, setDate] = useState('');
  const [busy, setBusy] = useState(false);
  const c = q.data;
  const submit = async () => {
    if (!answer) return;
    setBusy(true);
    try {
      await delegateApi.checkIn(id, { answer, note: note.trim() || undefined, newDate: answer === 'more_time' ? date : undefined });
      haptic(10);
      toast(answer === 'more_time' ? 'Sent to the lead with what the new date would move.' : answer === 'blocked' ? 'The lead knows it is blocked.' : answer === 'done' ? 'Done - nicely kept.' : 'Thanks - noted as on track.');
      onDone();
    } catch (e) { toast(errText(e, 'Could not send that.'), 'error'); }
    finally { setBusy(false); }
  };
  const needsNote = answer === 'more_time' || answer === 'blocked';
  return (
    <Modal title={c ? `Is ${c.entityKey ?? c.title} on track?` : 'Check-in'} subtitle={c ? `${c.projectName} · due ${formatDate(c.dueDate)}` : undefined} onClose={onClose}
      footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Later</button>
        <button type="button" className="btn btn-primary" disabled={!answer || busy || (needsNote && !note.trim()) || (answer === 'more_time' && !date)} onClick={() => void submit()}>{busy && <span className="spinner" />}Send</button></>}>
      {q.isLoading ? <PageLoader /> : !c ? <ErrorState error={q.error} /> : (
        <div className="cmd-checkin">
          <p className="cmd-checkin-title">{c.title}</p>
          {c.quote && <blockquote className="ag-quote"><p>“{c.quote}”</p><footer>{c.sourceLabel ?? 'From a meeting'}</footer></blockquote>}
          {c.answeredAt && <p className="cmd-muted">Last answer: {c.checkInAnswer?.replace('_', ' ')} · {timeAgo(c.answeredAt)}</p>}
          <div className="cmd-answers" role="radiogroup" aria-label="How is it going?">
            {ANSWERS.map((a) => (
              <button key={a.id} type="button" role="radio" aria-checked={answer === a.id} className={`cmd-answer ${answer === a.id ? 'on' : ''} cmd-answer-${a.id}`} onClick={() => { haptic(4); setAnswer(a.id); }}>
                <Icon name={a.icon} size={18} /><b>{a.label}</b><small>{a.text}</small>
              </button>
            ))}
          </div>
          {answer === 'more_time' && (
            <Field label="New date"><input className="input" type="date" aria-label="New date" min={dateOffset(1)} value={date} onChange={(e) => setDate(e.target.value)} /></Field>
          )}
          {(needsNote || answer === 'on_track') && (
            <Field label={answer === 'blocked' ? 'What is it waiting on?' : answer === 'more_time' ? 'Why?' : 'Anything to add? (optional)'}>
              <textarea className="input" rows={3} maxLength={500} value={note} aria-label="Note" onChange={(e) => setNote(e.target.value)} />
            </Field>
          )}
          {needsNote && <p className="cmd-muted"><Icon name="info" size={12} /> Nothing changes until the project lead approves - they see what a new date would move.</p>}
        </div>
      )}
    </Modal>
  );
}
