import { useState } from 'react';
import { Badge, EmptyState, ErrorState, PageLoader, StatCard } from '../../components/ui';
import { timeAgo } from '../../lib/format';
import { useWsQuery } from '../../lib/hooks';
import { aiAdminApi } from '../ai/aiApi';

const thisMonth = () => new Date().toISOString().slice(0, 7);
const money = (n: number, currency: string) => new Intl.NumberFormat(undefined, { style: 'currency', currency, minimumFractionDigits: 2 }).format(n);

/** Admin → AI usage: what each organization used this month and what it cost at the providers' prices. Counts only, never content. */
export function AiUsageTab() {
  const [month, setMonth] = useState(thisMonth());
  const q = useWsQuery(['admin', 'ai-usage', month], () => aiAdminApi.usage(month));
  const d = q.data;
  return (
    <>
      <div className="row" style={{ justifyContent: 'flex-end', marginBottom: 14 }}>
        <input type="month" className="input" style={{ width: 160 }} value={month} max={thisMonth()} aria-label="Month" onChange={(e) => e.target.value && setMonth(e.target.value)} />
      </div>
      {q.isLoading ? <PageLoader /> : q.isError || !d ? <ErrorState error={q.error} retry={() => q.refetch()} /> : (
        <>
          <div className="stat-grid mb-22">
            <StatCard icon="building" value={d.organizations} label="Organizations using AI" />
            <StatCard icon="message" value={d.answers.toLocaleString()} label="Answers" />
            <StatCard icon="gauge" value={d.creditsUsed.toLocaleString()} label="Credits used" />
            <StatCard icon="coin" value={money(d.estimatedCost, d.currency)} label="Estimated provider cost" foot={`${(d.tokensIn / 1000).toFixed(0)}k in · ${(d.tokensOut / 1000).toFixed(0)}k out tokens`} />
          </div>
          <div className="card">
            {d.rows.length === 0 ? <EmptyState icon="inbox" title="No AI use in this month" /> : (
              <div className="table-wrap"><table>
                <thead><tr><th>Organization</th><th>Plan</th><th>Answers (quick / standard / deep)</th><th>Credits</th><th>Tokens in / out</th><th>Est. cost</th><th>Last used</th></tr></thead>
                <tbody>{d.rows.map((r) => {
                  const pct = r.creditsLimit > 0 ? Math.round((r.creditsUsed / r.creditsLimit) * 100) : 0;
                  return (
                    <tr key={r.tenantId}>
                      <td><b>{r.name}</b>{r.failed > 0 && <div className="muted" style={{ fontSize: 12 }}>{r.failed} failed</div>}</td>
                      <td><Badge tone="purple">{r.planCode}</Badge></td>
                      <td>{r.answers} <span className="muted">({r.quick} / {r.standard} / {r.deep})</span></td>
                      <td>{r.creditsUsed.toLocaleString()}{r.creditsLimit < 0 ? <span className="muted"> / unlimited</span> : <span className="muted"> / {r.creditsLimit.toLocaleString()}</span>}
                        {r.creditsLimit > 0 && pct >= 80 && <> <Badge tone={pct >= 100 ? 'danger' : 'warning'}>{pct}%</Badge></>}</td>
                      <td>{(r.tokensIn / 1000).toFixed(1)}k / {(r.tokensOut / 1000).toFixed(1)}k</td>
                      <td>{money(r.estimatedCost, d.currency)}</td>
                      <td>{r.lastUsedAt ? timeAgo(r.lastUsedAt) : <span className="muted">never</span>}</td>
                    </tr>
                  );
                })}</tbody>
              </table></div>
            )}
          </div>
          <p className="muted" style={{ fontSize: 12.5 }}>Costs are estimates from the token counts and the per-million-token prices set in <code>Ai:Chat</code>; check them against your provider's invoice. Only counts are shown; what people asked is never visible here.</p>
        </>
      )}
    </>
  );
}
