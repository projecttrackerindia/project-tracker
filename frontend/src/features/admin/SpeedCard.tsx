import { useMemo, useState } from 'react';
import { get } from '../../api/client';
import { Segmented } from '../../components/ui';
import { useWsQuery } from '../../lib/hooks';
import './speed.css';

type Row = { page: string; device: string; metric: string; count: number; p75: number; rating: 'good' | 'needs-improvement' | 'poor' | string };
type Report = { days: number; rows: Row[]; samples: number };
type Metric = 'LCP' | 'INP' | 'CLS' | 'TTFB';
type Device = 'all' | 'mobile' | 'tablet' | 'desktop';

const METRICS: { id: Metric; label: string; title: string }[] = [
  { id: 'LCP', label: 'Load', title: 'Largest Contentful Paint: when the main content is visible. Good ≤ 2.5 s' },
  { id: 'INP', label: 'Response', title: 'Interaction to Next Paint: how fast a tap or click shows its result. Good ≤ 200 ms' },
  { id: 'CLS', label: 'Stability', title: 'Cumulative Layout Shift: how much the page jumps while loading. Good ≤ 0.1' },
  { id: 'TTFB', label: 'Server', title: 'Time to First Byte: how fast the server answers. Good ≤ 0.8 s' },
];
const LIMIT: Record<Metric, number> = { LCP: 4000, INP: 500, CLS: 0.25, TTFB: 1800 };
const RATING = { good: 'Good', 'needs-improvement': 'Needs work', poor: 'Poor' } as Record<string, string>;
const fmt = (m: Metric, v: number) => (m === 'CLS' ? v.toFixed(2) : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`);

/** Real-user speed across every workspace (page patterns only): the 75th percentile per page, for one measure and device class. */
export function SpeedCard() {
  const q = useWsQuery(['admin', 'vitals'], () => get<Report>('/telemetry/vitals', { all: true, days: 7 }), { refetchInterval: 60_000 });
  const [metric, setMetric] = useState<Metric>('LCP');
  const [device, setDevice] = useState<Device>('all');
  const rows = useMemo(() => {
    const list = (q.data?.rows ?? []).filter((r) => r.metric === metric && (device === 'all' || r.device === device));
    // "All devices": the slowest device class decides, so a page fast on desktop but slow on phones still shows as slow.
    const byPage = new Map<string, Row>();
    for (const r of list) { const cur = byPage.get(r.page); if (!cur || r.p75 > cur.p75) byPage.set(r.page, { ...r, count: (cur?.count ?? 0) + r.count }); else cur.count += r.count; }
    return [...byPage.values()].sort((a, b) => b.p75 - a.p75).slice(0, 12);
  }, [q.data, metric, device]);
  const max = Math.max(LIMIT[metric], ...rows.map((r) => r.p75));

  return (
    <div className="card mb-18 speed-card">
      <div className="card-head speed-head">
        <h3>Real-user speed</h3>
        <span className="muted speed-sub">75th percentile · last 7 days · {q.data?.samples.toLocaleString() ?? 0} measurements</span>
      </div>
      <div className="card-body">
        <div className="speed-filters">
          <Segmented label="Measure" value={metric} onChange={setMetric} options={METRICS} />
          <Segmented label="Device" value={device} onChange={setDevice} options={[{ id: 'all', label: 'All' }, { id: 'mobile', label: 'Phone' }, { id: 'tablet', label: 'Tablet' }, { id: 'desktop', label: 'Desktop' }]} />
        </div>
        {rows.length === 0 ? (
          <p className="muted speed-empty">No measurements yet. They arrive as people use the app (sent when a page is closed or hidden).</p>
        ) : (
          <ul className="speed-list" aria-label={`${METRICS.find((m) => m.id === metric)!.title}, by page`}>
            {rows.map((r) => (
              <li key={r.page} className="speed-row" title={`${r.page} · ${fmt(metric, r.p75)} · ${RATING[r.rating] ?? r.rating} · ${r.count} measurements`}>
                <span className="speed-page">{r.page}</span>
                <span className="speed-track"><span className={`speed-bar is-${r.rating}`} style={{ width: `${Math.max(2, (r.p75 / max) * 100)}%` }} /></span>
                <span className="speed-value">{fmt(metric, r.p75)}</span>
                <span className={`speed-rating is-${r.rating}`}>{RATING[r.rating] ?? r.rating}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
