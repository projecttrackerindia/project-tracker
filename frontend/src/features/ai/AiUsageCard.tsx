import { useState } from 'react';
import { ErrorState, PageLoader, Progress } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { useWsQuery } from '../../lib/hooks';
import { aiWorkspaceApi } from './aiApi';
import { useAiStatus } from './Assistant';
import { AiBudgetCard } from './AiBudgetCard';

const thisMonth = () => new Date().toISOString().slice(0, 7);
const LEVELS = [['quick', 'Quick'], ['standard', 'Standard'], ['deep', 'Deep']] as const;

/** Settings → General (Owners and Admins): who used the assistant this month, at which level, and how much of the credits is gone. Counts only. */
export function AiUsageCard() {
  const status = useAiStatus();
  const [month, setMonth] = useState(thisMonth());
  const q = useWsQuery(['ai', 'report', month], () => aiWorkspaceApi.report(month), { enabled: !!status?.configured && !!status?.entitled, staleTime: 30_000 });
  if (!status?.configured || !status.entitled) return null;
  const d = q.data;
  const pct = d && !d.unlimited && d.creditsLimit > 0 ? Math.min(100, Math.round((d.creditsUsed / d.creditsLimit) * 100)) : 0;

  return (
    <><div className="card" style={{ marginTop: 18 }}><div className="card-body">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div className="setting-info" style={{ flex: 1, minWidth: 240 }}>
          <h4><Icon name="sparkle" size={14} /> AI usage</h4>
          <p>How the assistant was used in this workspace. Only counts are shown, never what anyone asked or was answered.</p>
        </div>
        <input type="month" className="input" style={{ width: 160 }} value={month} max={thisMonth()} aria-label="Month" onChange={(e) => e.target.value && setMonth(e.target.value)} />
      </div>
      {q.isLoading ? <PageLoader /> : q.isError || !d ? <ErrorState error={q.error} retry={() => q.refetch()} /> : (
        <>
          <div style={{ margin: '14px 0 6px', display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
            <span><b>{d.creditsUsed.toLocaleString()}</b> credits used{d.unlimited ? ' (unlimited plan)' : ` of ${d.creditsLimit.toLocaleString()}`}</span>
            <span className="muted">{d.answers.toLocaleString()} answers{d.failed > 0 ? ` · ${d.failed} failed` : ''}</span>
          </div>
          {!d.unlimited && <Progress value={pct} tone={pct >= 90 ? 'red' : pct >= 70 ? 'amber' : 'green'} />}
          {!d.unlimited && <p className="muted" style={{ fontSize: 12, margin: '6px 0 0' }}>Credits are per person and shared by the whole team; they renew on the 1st. More people (seats) means a bigger pool: see Settings → Billing.</p>}
          <div className="row" style={{ gap: 8, margin: '12px 0', flexWrap: 'wrap' }}>
            {LEVELS.map(([id, label]) => {
              const t = d.byTier.find((x) => x.tier === id);
              return <span key={id} className={`ai-route ${id}`}>{label}<em>{t?.answers ?? 0} answers · {(t?.credits ?? 0).toLocaleString()} credits</em></span>;
            })}
          </div>
          {!!d.features?.length && <p className="muted">Other AI features: {d.features.map(f => `${f.feature.replaceAll('_', ' ')}: ${f.answers} answers, ${f.credits} credits`).join(' · ')}</p>}
          {d.people.length === 0 ? <p className="muted" style={{ margin: '8px 0 0' }}>Nobody used the assistant in this month.</p> : (
            <div className="table-wrap"><table>
              <thead><tr><th>Person</th><th>Answers</th><th>Credits</th>{LEVELS.map(([id, label]) => <th key={id}>{label}</th>)}</tr></thead>
              <tbody>{d.people.map((p) => (
                <tr key={p.userId}>
                  <td><b>{p.name}</b></td><td>{p.answers}</td><td>{p.credits.toLocaleString()}</td>
                  {LEVELS.map(([id]) => <td key={id}>{p.byTier.find((x) => x.tier === id)?.answers ?? 0}</td>)}
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </>
      )}
    </div></div><AiBudgetCard /></>
  );
}
