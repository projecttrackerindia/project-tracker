import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../../../api/client';
import { Icon, type IconName } from '../../../components/Icon';
import { EmptyState, ErrorState, PageLoader } from '../../../components/ui';
import { formatDate } from '../../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../../lib/hooks';
import { useWorkspaceId } from '../../../stores/auth';
import { toast } from '../../../stores/ui';
import { BarList, CostChart, Ring, StackBar } from './TrackerCharts';
import { COST_GROUPS, compact, KIND_LABEL, pct, REASON_LABEL, series, trackerApi, type AgentAlert, type Alerts, type AlertSettings, type Fleet } from './types';

/**
 * Watching the agents: what needs attention now (alerts, with their thresholds), what they cost in AI credits and when the credits run out,
 * the projects whose agent has earned more autonomy, and the Monday summary. Owners and admins.
 */

const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.errors[0]?.message ?? e.message : fallback);
const SEVERITY: Record<AgentAlert['severity'], { icon: IconName; label: string }> = {
  critical: { icon: 'alert', label: 'Needs action' }, warning: { icon: 'clock', label: 'Heading for trouble' }, info: { icon: 'info', label: 'Worth knowing' },
};
const n = (v: number) => v.toLocaleString();
const tabOf = (link: string) => new URLSearchParams(link.split('?')[1] ?? '').get('tab') ?? 'overview';

/** The alerts that are active now, compact (overview) or in full. */
export function AlertList({ alerts, compactView, onOpen }: { alerts: AgentAlert[]; compactView?: boolean; onOpen?: (tab: string) => void }) {
  if (alerts.length === 0) return <p className="trk-calm"><Icon name="checkCircle" size={15} />Every agent is fine - nothing needs attention.</p>;
  return (
    <ul className={`trk-alerts ${compactView ? 'compact' : ''}`}>
      {alerts.map((a) => (
        <li key={a.key} className={`trk-alert sev-${a.severity}`}>
          <span className="trk-alert-icon" aria-hidden><Icon name={SEVERITY[a.severity].icon} size={15} /></span>
          <div>
            <b>{a.title}</b>
            {!compactView && <p>{a.detail}</p>}
            <small>{SEVERITY[a.severity].label}{a.threshold != null && a.value != null ? ` · now ${a.value}, alert at ${a.threshold}` : ''}</small>
          </div>
          {onOpen && <button type="button" className="trk-link" onClick={() => onOpen(tabOf(a.link))}>Look<Icon name="arrowRight" size={12} /></button>}
        </li>
      ))}
    </ul>
  );
}

// ------------------------------------------------------------------ costs

export function CostView() {
  const q = useWsQuery(['ai', 'tracker', 'cost'], () => trackerApi.cost(), { staleTime: 60_000 });
  if (q.isLoading) return <PageLoader />;
  if (q.isError || !q.data) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const c = q.data;
  const used = pct(c.spent + c.reserved, c.limit);
  const days = c.days.map((d) => ({ label: new Date(`${d.day}T00:00:00`).toLocaleDateString([], { day: 'numeric', month: 'short' }), assistant: d.assistant, agent: d.agent, meetings: d.meetings, other: d.other }));
  const total14 = c.days.reduce((s, d) => s + d.assistant + d.agent + d.meetings + d.other, 0);
  const tone = c.unlimited ? 'good' : c.available <= 0 ? 'bad' : c.runsOutBeforeReset ? 'warn' : 'good';
  return (
    <div className="trk-stack-page">
      <div className={`trk-forecast tone-${tone}`}>
        <Ring value={c.unlimited ? null : used} label="used" tone={tone === 'bad' ? 'var(--trk-bad)' : tone === 'warn' ? 'var(--trk-warn)' : 'var(--trk-s7)'} sub={c.month} />
        <div className="trk-forecast-text">
          <h3>{c.unlimited ? 'Unlimited AI credits on this plan'
            : c.available <= 0 ? 'The AI credits for this month are used up'
            : c.runsOutBeforeReset && c.runsOutOn ? `At this pace the credits run out around ${formatDate(c.runsOutOn)}`
            : `Enough credits until they renew on ${formatDate(c.resetsOn)}`}</h3>
          <p>{c.unlimited ? `${n(c.spent)} used this month.` : `${n(c.spent)} used${c.reserved ? ` and ${n(c.reserved)} in progress` : ''} of ${n(c.limit)} this month · ${n(c.available)} left.`}
            {' '}The last week used about <b>{c.dailyAverage}</b> a day{c.daysLeft != null && !c.unlimited ? ` - about ${c.daysLeft} day${c.daysLeft === 1 ? '' : 's'} left` : ''}. Credits renew on {formatDate(c.resetsOn)}.</p>
          {tone !== 'good' && <p className="trk-forecast-act"><Icon name="info" size={13} />Set a monthly cap per project agent (project › Agent), or add seats in <Link to="/settings/billing">Settings › Billing</Link>.</p>}
        </div>
      </div>

      <div className="trk-grid-2">
        <section className="trk-panel">
          <header><h3><Icon name="chart" size={15} />Credits per day</h3></header>
          <p className="trk-hint">The last 14 days, by the agent that used them ({compact(total14)} in all). Hover a bar for the numbers.</p>
          {total14 === 0 ? <EmptyState icon="bolt" title="No AI credits used in the last two weeks" /> : (
            <>
              <div className="trk-chart"><CostChart data={days} /></div>
              <ul className="trk-legend">{COST_GROUPS.map((g, i) => <li key={g.key}><i style={{ background: series(i) }} />{g.label}</li>)}</ul>
            </>
          )}
        </section>
        <section className="trk-panel">
          <header><h3><Icon name="layers" size={15} />This month by agent</h3></header>
          {c.features.length === 0 ? <p className="trk-hint">Nothing used this month yet.</p> : (
            <>
              <StackBar height={14} parts={c.features.map((f) => ({ label: f.label, value: f.credits, color: series(Math.max(0, COST_GROUPS.findIndex((g) => g.key === f.group))) }))} />
              <p className="trk-hint">Credits are the workspace's allowance for AI: a quick answer is 1, a standard one 4, a deep one 20. Meetings and follow-ups use none unless the bot posts live reminders.</p>
            </>
          )}
        </section>
      </div>

      <section className="trk-panel">
        <header><h3><Icon name="folder" size={15} />Project agents this month</h3></header>
        {c.projects.length === 0 ? <p className="trk-hint">No project agent has used credits this month.</p> : (
          <div className="trk-table-wrap">
            <table className="trk-table">
              <thead><tr><th>Project</th><th>Readings</th><th>Credits</th><th>Monthly cap</th><th aria-label="Share of the cap" /></tr></thead>
              <tbody>{c.projects.map((p) => {
                const share = p.cap > 0 ? Math.min(100, Math.round((p.credits / p.cap) * 100)) : null;
                return (
                  <tr key={p.projectId}>
                    <td><Link to={`/projects/${p.projectId}?tab=agent`}><b>{p.key}</b> {p.name}</Link></td>
                    <td>{p.readings}</td><td><b>{p.credits}</b></td>
                    <td>{p.cap > 0 ? p.cap : <span className="trk-dim">no cap</span>}</td>
                    <td className="trk-mini">{share != null && <span className={`trk-cap ${share >= 100 ? 'bad' : share >= 80 ? 'warn' : ''}`} title={`${share}% of the cap`}><i style={{ width: `${share}%` }} /></span>}</td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

// ------------------------------------------------------------------ alerts and the weekly summary

const THRESHOLDS: { key: keyof Omit<AlertSettings, 'enabled' | 'weeklyDigest'>; label: string; unit: string; min: number; max: number; step: number; text: string }[] = [
  { key: 'minSuccessRate', label: 'Assistant success below', unit: '%', min: 10, max: 100, step: 5, text: 'In a day with at least 10 answers' },
  { key: 'maxP95Seconds', label: 'Slowest answers above', unit: 's', min: 3, max: 120, step: 1, text: '1 in 20 answers takes longer than this' },
  { key: 'botFailures', label: 'Meeting bot misses', unit: '', min: 1, max: 20, step: 1, text: 'Sessions it could not attend in a day' },
  { key: 'readingFailures', label: 'Failed readings', unit: '', min: 1, max: 20, step: 1, text: 'Project agent readings that failed in a day' },
  { key: 'creditDays', label: 'Credits run out within', unit: ' days', min: 1, max: 31, step: 1, text: 'At the last week\'s pace, before they renew' },
];

export function AlertsView({ alerts, onOpen }: { alerts?: Alerts; onOpen: (tab: string) => void }) {
  const wid = useWorkspaceId();
  const [form, setForm] = useState<AlertSettings | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const digest = useWsQuery(['ai', 'tracker', 'digest'], () => trackerApi.digest(), { enabled: preview, staleTime: 60_000 });
  useEffect(() => { if (alerts && !form) setForm(alerts.settings); }, [alerts, form]);
  if (!alerts || !form) return <PageLoader />;
  const dirty = JSON.stringify(form) !== JSON.stringify(alerts.settings);
  const save = async () => {
    setBusy('save');
    try { const r = await trackerApi.saveAlerts(form); setForm(r.settings); void invalidateWorkspace(wid, 'ai', 'tracker', 'alerts'); toast('Saved. Owners and admins hear about each problem at most once a day.'); }
    catch (e) { toast(errText(e, 'Could not save.'), 'error'); }
    finally { setBusy(null); }
  };
  const send = async () => {
    setBusy('send');
    try { const r = await trackerApi.sendDigest(); toast(r.sent ? 'Sent to you - check your notifications (and e-mail, by your settings).' : 'You have switched this notice off in your notification settings.'); }
    catch (e) { toast(errText(e, 'Could not send it.'), 'error'); }
    finally { setBusy(null); }
  };
  return (
    <div className="trk-stack-page">
      <section className="trk-panel">
        <header><h3><Icon name="radar" size={15} />Needs attention now</h3><small className="trk-dim">checked {new Date(alerts.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small></header>
        <AlertList alerts={alerts.active} onOpen={onOpen} />
      </section>

      <div className="trk-grid-2">
        <section className="trk-panel">
          <header>
            <h3><Icon name="bell" size={15} />Alert me when</h3>
            <button type="button" className={`switch ${form.enabled ? 'on' : ''}`} role="switch" aria-checked={form.enabled} aria-label="Agent alerts" onClick={() => setForm({ ...form, enabled: !form.enabled })} />
          </header>
          <p className="trk-hint">Owners and admins get each problem once a day - in the app, by e-mail and on their phone, as each person chose in their notification settings.</p>
          <ul className={`trk-thresholds ${form.enabled ? '' : 'off'}`}>
            {THRESHOLDS.map((t) => (
              <li key={t.key}>
                <label htmlFor={`thr-${t.key}`}><b>{t.label}</b><small>{t.text}</small></label>
                <input id={`thr-${t.key}`} type="range" min={t.min} max={t.max} step={t.step} value={form[t.key]} disabled={!form.enabled}
                  onChange={(e) => setForm({ ...form, [t.key]: Number(e.target.value) })} />
                <output htmlFor={`thr-${t.key}`}>{form[t.key]}{t.unit}</output>
              </li>
            ))}
          </ul>
          <div className="trk-form-foot">
            <button type="button" className="btn btn-primary btn-sm" disabled={!dirty || busy !== null} onClick={() => void save()}>{busy === 'save' && <span className="spinner" />}Save</button>
            {dirty && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setForm(alerts.settings)}>Undo</button>}
          </div>
        </section>

        <section className="trk-panel">
          <header>
            <h3><Icon name="mail" size={15} />Monday summary</h3>
            <button type="button" className={`switch ${form.weeklyDigest ? 'on' : ''}`} role="switch" aria-checked={form.weeklyDigest} aria-label="Monday summary" onClick={() => setForm({ ...form, weeklyDigest: !form.weeklyDigest })} />
          </header>
          <p className="trk-hint">Every Monday morning: what the agents did last week, what was decided, what slipped and the credits used. Save to apply the switch.</p>
          <div className="trk-form-foot">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPreview((v) => !v)}><Icon name="eye" size={14} />{preview ? 'Hide preview' : 'Preview'}</button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy !== null} onClick={() => void send()}>{busy === 'send' ? <span className="spinner" /> : <Icon name="send" size={14} />}Send me one now</button>
          </div>
          {preview && (digest.isLoading ? <PageLoader /> : digest.data && (
            <article className="trk-digest">
              <b>{digest.data.title}</b>
              {digest.data.lines.length === 0 ? <p className="trk-hint">The agents did nothing last week, so no summary would go out.</p>
                : <ul>{digest.data.lines.map((l) => <li key={l}>{l}</li>)}</ul>}
              <small>{formatDate(digest.data.from)} – {formatDate(digest.data.to)}</small>
            </article>
          ))}
        </section>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ earned autonomy and why proposals are dismissed

export function TrustPanels({ f }: { f: Fleet }) {
  const hints = useWsQuery(['ai', 'tracker', 'autonomy-hints'], () => trackerApi.autonomyHints(), { staleTime: 120_000 });
  const reasons = f.dismissReasons ?? [];
  return (
    <div className="trk-grid-2">
      <section className="trk-panel">
        <header><h3><Icon name="sparkle" size={15} />Ready for more autonomy</h3></header>
        <p className="trk-hint">Safe kinds of proposal the team approved unchanged at least 95% of 30+ times in 90 days. The project lead decides in the project's Agent tab.</p>
        {!hints.data ? <PageLoader /> : hints.data.length === 0 ? <p className="trk-calm"><Icon name="info" size={15} />Nothing yet - suggestions appear as the team decides on proposals.</p> : (
          <ul className="trk-hints">
            {hints.data.map((h) => (
              <li key={`${h.projectId}-${h.kind}`}>
                <span className="trk-hint-rate">{h.rate}%</span>
                <div><b>{h.projectKey} · {KIND_LABEL[h.kind] ?? h.kind}</b><small>{h.decided} decisions · level {h.level} now</small></div>
                <Link className="trk-link" to={`/projects/${h.projectId}?tab=agent`}>Decide<Icon name="arrowRight" size={12} /></Link>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="trk-panel">
        <header><h3><Icon name="xCircle" size={15} />Why proposals were dismissed</h3></header>
        <p className="trk-hint">One tap when dismissing teaches the agent what to stop proposing.</p>
        {reasons.length === 0 ? <p className="trk-hint">Nothing dismissed in this period.</p>
          : <BarList rows={reasons.map((r) => ({ label: REASON_LABEL[r.reason] ?? r.reason, value: r.count }))} color="var(--trk-s8)" unit={(v) => `${v}`} />}
      </section>
    </div>
  );
}
