import { useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { statusPageApi, type PublicStatus, type StatusState } from '../../api/platformApi';
import { formatDate, formatDateTime } from '../../lib/format';
import './platform.css';

const STATE_TEXT: Record<StatusState, string> = { operational: 'Operational', degraded: 'Degraded performance', outage: 'Major outage' };
const BANNER: Record<StatusState, string> = { operational: 'All systems operational', degraded: 'Some systems are degraded', outage: 'Some systems are down' };

/**
 * /status/{slug}: a workspace's public API status page, read without signing in. A banner with the overall state, each API with its state,
 * uptime and 90 days of bars (45 on a phone), and recent incidents. Refreshes every minute.
 */
export function PublicStatusPage() {
  const { slug = '' } = useParams();
  const q = useQuery({ queryKey: ['public-status', slug], queryFn: () => statusPageApi.public(slug), refetchInterval: 60_000, retry: 1 });
  const s = q.data;
  useEffect(() => { document.title = s ? `${s.title} · Status` : 'Status'; }, [s]);

  if (q.isLoading) return <div className="st-page"><div className="st-wrap"><p className="st-foot">Loading status…</p></div></div>;
  if (q.isError) return <div className="st-page"><div className="st-wrap"><div className="st-card"><p className="st-empty">The status could not be loaded. Try again in a minute.</p></div></div></div>;
  if (!s) return (
    <div className="st-page"><div className="st-wrap">
      <div className="st-head"><div><h1>Status page not found</h1><p>This address has no published status page.</p></div></div>
    </div></div>
  );
  return <StatusBody s={s} />;
}

function StatusBody({ s }: { s: PublicStatus }) {
  return (
    <main className="st-page">
      <div className="st-wrap">
        <header className="st-head">
          <div><h1>{s.title}</h1><p>{s.workspace}</p></div>
          <p>Updated {formatDateTime(s.updatedAt)}</p>
        </header>
        <div className={`st-banner ${s.state}`} role="status"><span className="st-dot" aria-hidden="true" />{BANNER[s.state]}</div>

        <section className="st-card" aria-label="Components">
          {s.components.length === 0 && <p className="st-empty">Nothing is listed yet.</p>}
          {s.components.map((c) => (
            <div key={c.name} className="st-comp">
              <div className="st-comp-h">
                <b>{c.name}</b>
                <span className={`st-state ${c.state}`}><span className="st-dot" aria-hidden="true" />{STATE_TEXT[c.state]}</span>
              </div>
              <div className="st-bars" role="img" aria-label={`${c.name}: ${c.uptime}% uptime over 90 days`}>
                {c.days.map((d) => <i key={d.date} className={d.state === 'up' ? '' : d.state} title={`${formatDate(d.date)} · ${d.state === 'up' ? 'No incidents' : d.state === 'down' ? 'Outage' : 'Degraded'}`} />)}
              </div>
              <div className="st-bars-foot"><span className="st-90">90 days ago</span><span className="st-45">45 days ago</span><span>{c.uptime}% uptime</span><span>Today</span></div>
            </div>
          ))}
        </section>

        <h2 className="st-h2">Recent incidents</h2>
        <section className="st-card" aria-label="Recent incidents">
          {s.incidents.length === 0 ? <p className="st-empty">No incidents in the last 90 days.</p> : s.incidents.map((i, k) => (
            <div key={k} className="st-inc">
              <b>{i.title}</b>
              <span>{i.severity === 'major' ? 'Major' : 'Minor'} · {i.components.join(', ')} · {formatDateTime(i.startedAt)}{i.resolvedAt ? ` – resolved ${formatDateTime(i.resolvedAt)}` : ' · ongoing'}</span>
            </div>
          ))}
        </section>
        <p className="st-foot">Uptime is worked out from reported incidents.</p>
      </div>
    </main>
  );
}
