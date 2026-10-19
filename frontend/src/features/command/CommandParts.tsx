import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { delegateApi } from '../../api/endpoints';
import type { AgentImpact, AgentPersonalSettings, BriefItem } from '../../api/types';
import { Icon, type IconName } from '../../components/Icon';
import { EmptyState, ErrorState, Field, Modal, PageLoader } from '../../components/ui';
import { formatDate, formatDateTime, formatTime } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { errText, useProjectsLite } from './shared';
import { ImpactView } from './Impact';

// ------------------------------------------------------------------ the brief before a meeting

const STATE: Record<BriefItem['state'], { label: string; cls: string }> = {
  done: { label: 'Done', cls: 'ok' }, overdue: { label: 'Late', cls: 'bad' }, blocked: { label: 'Blocked', cls: 'bad' }, due_today: { label: 'Today', cls: 'warn' }, open: { label: 'Open', cls: '' },
};

export function BriefModal({ meetingId, at, onClose, onDelegate }: { meetingId: string; at?: string | null; onClose: () => void; onDelegate: (d: { meetingId: string; at: string; title?: string }) => void }) {
  const q = useWsQuery(['agent', 'brief', meetingId, at ?? ''], () => delegateApi.brief(meetingId, at));
  const b = q.data;
  const total = b ? Math.max(1, b.actionsSinceLast) : 1;
  return (
    <Modal title={b ? `Brief: ${b.title}` : 'Meeting brief'} subtitle={b ? `${b.projectKey} · ${formatDate(b.startUtc)} ${formatTime(b.startUtc)}` : undefined} onClose={onClose} size="lg"
      footer={b && <>
        {!b.agentAttending && new Date(b.endUtc).getTime() > Date.now() && <button type="button" className="btn btn-ghost" onClick={() => onDelegate({ meetingId: b.meetingId, at: b.startUtc, title: b.title })}><Icon name="agent" size={14} />Send the agent</button>}
        {b.meetUrl && <a className="btn btn-primary" href={b.meetUrl} target="_blank" rel="noreferrer"><Icon name="video" size={14} />Join</a>}
      </>}>
      {q.isLoading ? <PageLoader /> : !b ? <ErrorState error={q.error} /> : (
        <div className="cmd-brief">
          <p className={`cmd-brief-headline ${b.maybeUnnecessary ? 'calm' : ''}`}><Icon name={b.maybeUnnecessary ? 'checkCircle' : 'info'} size={15} />{b.headline}</p>
          {b.actionsSinceLast > 0 && (
            <div className="cmd-brief-progress">
              <div className="cmd-stack" role="img" aria-label={`${b.done} done, ${b.overdue} late, ${b.blocked} blocked, ${b.open} open`}>
                {b.done > 0 && <i className="cmd-seg-kept" style={{ flexGrow: b.done / total }} />}
                {b.open > 0 && <i className="cmd-seg-open" style={{ flexGrow: b.open / total }} />}
                {b.blocked > 0 && <i className="cmd-seg-moved" style={{ flexGrow: b.blocked / total }} />}
                {b.overdue > 0 && <i className="cmd-seg-missed" style={{ flexGrow: b.overdue / total }} />}
              </div>
              <ul className="cmd-legend">
                <li><i className="cmd-seg-kept" />Done <b>{b.done}</b></li><li><i className="cmd-seg-open" />Open <b>{b.open}</b></li>
                <li><i className="cmd-seg-moved" />Blocked <b>{b.blocked}</b></li><li><i className="cmd-seg-missed" />Late <b>{b.overdue}</b></li>
              </ul>
            </div>
          )}
          {b.agenda.length > 0 && (
            <section><h4><Icon name="list" size={13} />Suggested agenda</h4><ol className="cmd-agenda">{b.agenda.map((a) => <li key={a}>{a}</li>)}</ol></section>
          )}
          {b.blockers.length > 0 && (
            <section><h4><Icon name="layers" size={13} />What is stuck</h4><ul className="cmd-why">{b.blockers.map((x) => <li key={x}>{x}</li>)}</ul></section>
          )}
          {b.items.length > 0 && (
            <section><h4><Icon name="checks" size={13} />From the last meeting{b.lastMeetingAt ? ` (${formatDate(b.lastMeetingAt)})` : ''}</h4>
              <ul className="cmd-brief-items">{b.items.map((i) => <li key={i.key}><b>{i.key}</b><span>{i.owner}</span>{i.due && <small>{formatDate(i.due)}</small>}<em className={`cmd-pill ${STATE[i.state].cls}`}>{STATE[i.state].label}</em></li>)}</ul>
            </section>
          )}
          {b.commitments.length > 0 && (
            <section><h4><Icon name="flag" size={13} />Commitments due</h4><ul className="cmd-why">{b.commitments.map((x) => <li key={x}>{x}</li>)}</ul></section>
          )}
          {b.pendingDecisions > 0 && <p className="cmd-muted"><Icon name="checks" size={12} /> {b.pendingDecisions} proposal{b.pendingDecisions === 1 ? '' : 's'} from the agent wait for a decision in this project.</p>}
        </div>
      )}
    </Modal>
  );
}

// ------------------------------------------------------------------ what if

export function WhatIfModal({ onClose }: { onClose: () => void }) {
  const projects = useProjectsLite();
  const [projectId, setProjectId] = useState('');
  const tasks = useWsQuery(['agent', 'what-if', projectId], () => delegateApi.whatIfTasks(projectId), { enabled: !!projectId });
  const [taskId, setTaskId] = useState('');
  const [days, setDays] = useState(3);
  const [result, setResult] = useState<AgentImpact | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setTaskId(''); setResult(null); }, [projectId]);
  useEffect(() => { if (!projectId && projects.data?.items.length) setProjectId(projects.data.items[0].id); }, [projects.data, projectId]);
  const run = async () => {
    if (!taskId) return;
    setBusy(true);
    try { setResult(await delegateApi.whatIf({ taskId, slipDays: days })); }
    catch (e) { toast(errText(e, 'Could not work that out.'), 'error'); }
    finally { setBusy(false); }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (taskId) void run(); }, [taskId, days]);
  return (
    <Modal title="What if a task slips?" subtitle="Worked out from the task dependencies - nothing is changed." onClose={onClose} size="lg"
      footer={<button type="button" className="btn btn-primary" onClick={onClose}>Done</button>}>
      <div className="cmd-whatif">
        <div className="form-grid">
          <Field label="Project">
            <select className="input" aria-label="Project" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              {(projects.data?.items ?? []).map((p) => <option key={p.id} value={p.id}>{p.key} · {p.name}</option>)}
            </select>
          </Field>
          <Field label="Task">
            <select className="input" aria-label="Task" value={taskId} onChange={(e) => setTaskId(e.target.value)} disabled={!tasks.data?.length}>
              <option value="">{tasks.isLoading ? 'Loading…' : tasks.data?.length ? 'Choose a task' : 'No open tasks'}</option>
              {(tasks.data ?? []).map((t) => <option key={t.id} value={t.id}>{t.key} · {t.title}{t.dependents ? ` (${t.dependents} depend on it)` : ''}</option>)}
            </select>
          </Field>
          <Field label={`Slips by ${days} day${days === 1 ? '' : 's'}`} full>
            <input type="range" min={1} max={30} value={days} aria-label="Days" className="cmd-range" onChange={(e) => setDays(Number(e.target.value))} />
          </Field>
        </div>
        {busy && !result ? <PageLoader /> : result ? <ImpactView impact={result} /> : <p className="cmd-muted">Pick a task to see what else would move, which milestones would be missed and whether the project would finish late.</p>}
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------ personal settings

export function SettingsCard() {
  const wid = useWorkspaceId();
  const q = useWsQuery(['agent', 'me-settings'], () => delegateApi.settings());
  const [busy, setBusy] = useState(false);
  const s = q.data;
  const save = async (patch: Partial<AgentPersonalSettings>) => {
    setBusy(true);
    try { await delegateApi.saveSettings(patch); await invalidateWorkspace(wid, 'agent', 'me-settings'); }
    catch (e) { toast(errText(e, 'Could not save.'), 'error'); }
    finally { setBusy(false); }
  };
  const row = (key: 'autoDelegate' | 'meetingBriefs' | 'checkIns', icon: IconName, title: string, text: string) => s && (
    <li>
      <Icon name={icon} size={15} />
      <span><b>{title}</b><small>{text}</small></span>
      <button type="button" className={`switch ${s[key] ? 'on' : ''}`} role="switch" aria-checked={s[key]} aria-label={title} disabled={busy} onClick={() => void save({ [key]: !s[key] })} />
    </li>
  );
  return (
    <div className="card cmd-panel">
      <h3 className="cmd-panel-title"><Icon name="settings" size={14} />My agent</h3>
      {!s ? <PageLoader /> : (
        <>
          <ul className="ag-sources">
            {row('autoDelegate', 'agent', 'Go when I am double-booked', 'Sends the agent to the project meeting you do not organize, and tells you')}
            {row('meetingBriefs', 'note', 'Brief before meetings', 'What is late, stuck and waiting - before each project meeting')}
            {row('checkIns', 'flag', 'Check-ins on my commitments', 'On the due day: on track, done, need more time or blocked')}
          </ul>
          {s.meetingBriefs && (
            <Field label="Brief arrives">
              <select className="input" aria-label="Brief arrives" value={s.briefMinutes} disabled={busy} onChange={(e) => void save({ briefMinutes: Number(e.target.value) })}>
                {[5, 10, 15, 30, 60].map((m) => <option key={m} value={m}>{m} minutes before</option>)}
              </select>
            </Field>
          )}
          {!s.googleConnected && <p className="ag-hint"><Icon name="info" size={12} />Connect Google (Settings › Integrations) so calls on your calendar count when spotting double-bookings.</p>}
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ decisions and audit

export function DecisionsView() {
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  useEffect(() => { const t = setTimeout(() => setTerm(q.trim()), 300); return () => clearTimeout(t); }, [q]);
  const list = useWsQuery(['agent', 'decisions', term], () => delegateApi.decisions(term ? { q: term } : undefined));
  return (
    <section className="cmd-registry" aria-label="Decisions">
      <div className="cmd-search"><Icon name="search" size={15} /><input className="input" placeholder="Search decisions - e.g. release, vendor, scope" aria-label="Search decisions" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      {list.isLoading ? <PageLoader /> : list.isError ? <ErrorState error={list.error} retry={() => list.refetch()} /> : !list.data?.length
        ? <EmptyState icon="checks" title={term ? 'No decision matches' : 'No decisions yet'} text="Decisions the agent hears in meetings, mail and chat are kept here with who made them, when, and the words they came from." />
        : (
          <ol className="cmd-decisions">
            {list.data.map((d) => (
              <li key={d.id} className="card">
                <div className="cmd-dec-head"><span className="cmd-proj">{d.projectKey}</span>{d.taskKey && <span className="cmd-pill">{d.taskKey}</span>}<time>{formatDate(d.decidedAt ?? d.at)}</time></div>
                <h3>{d.title}</h3>
                {d.detail && <p>{d.detail}</p>}
                {d.evidence && <blockquote className="ag-quote"><p>“{d.evidence}”</p><footer>{d.sourceLabel ?? 'Source'}</footer></blockquote>}
                <p className="cmd-muted">{d.status === 'Applied' ? `Recorded${d.decidedBy ? ` by ${d.decidedBy.name}` : ''}` : 'Waiting to be confirmed'}{!d.evidence && d.sourceLabel ? ` · ${d.sourceLabel}` : ''}</p>
              </li>
            ))}
          </ol>
        )}
    </section>
  );
}

export function AuditView() {
  const projects = useProjectsLite();
  const [projectId, setProjectId] = useState('');
  const list = useWsQuery(['agent', 'audit', projectId], () => delegateApi.audit(projectId || undefined));
  const auto = useMemo(() => (list.data ?? []).filter((a) => a.auto).length, [list.data]);
  return (
    <section className="cmd-registry" aria-label="Audit trail">
      <div className="cmd-audit-bar">
        <select className="input" aria-label="Project" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
          <option value="">All projects I may decide on</option>
          {(projects.data?.items ?? []).map((p) => <option key={p.id} value={p.id}>{p.key} · {p.name}</option>)}
        </select>
        {list.data && <span className="cmd-muted">{list.data.length} decisions · {auto} carried out by the agent</span>}
      </div>
      {list.isLoading ? <PageLoader /> : list.isError ? <ErrorState error={list.error} retry={() => list.refetch()} /> : !list.data?.length
        ? <EmptyState icon="shield" title="Nothing decided yet" text="Every proposal approved, changed, dismissed or carried out by the agent itself is listed here - who, when, what it was before and after, and why." />
        : (
          <ol className="cmd-audit">
            {list.data.map((a) => (
              <li key={a.id} className={a.auto ? 'auto' : a.status === 'Dismissed' ? 'dismissed' : a.status === 'Failed' ? 'failed' : ''}>
                <span className="cmd-audit-dot" aria-hidden><Icon name={a.auto ? 'sparkle' : a.status === 'Dismissed' ? 'xCircle' : a.status === 'Failed' ? 'alert' : 'checkCircle'} size={12} /></span>
                <div>
                  <p className="cmd-audit-line"><b>{a.action}</b> · {a.title}{a.key ? <> · <Link to={`/projects/${a.projectId}`}>{a.key}</Link></> : null}</p>
                  {(a.before || a.after) && <p className="cmd-audit-change">{a.before && <span className="was">{a.before}</span>}{a.before && a.after && <Icon name="arrowRight" size={11} />}{a.after && <span className="now">{a.after}</span>}</p>}
                  <p className="cmd-muted">{a.projectKey} · {a.by ? a.by.name : 'the agent'}{a.auto ? ` (auto, ${a.confidence}% sure)` : ''}{a.at ? ` · ${formatDateTime(a.at)}` : ''}{a.sourceLabel ? ` · from ${a.sourceLabel}` : ''}</p>
                  {a.error && <p className="form-error">{a.error}</p>}
                </div>
              </li>
            ))}
          </ol>
        )}
    </section>
  );
}
