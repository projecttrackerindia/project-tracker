import type { BurndownPoint } from '../../api/types';

/** Remaining tasks per day against the ideal straight line. Plain SVG, no chart library. */
export function Burndown({ points }: { points: BurndownPoint[] }) {
  const W = 560, H = 150, L = 30, B = 22, T = 10, R = 10;
  const max = Math.max(1, ...points.map((p) => Math.max(p.remaining, p.ideal)));
  const n = Math.max(1, points.length - 1);
  const x = (i: number) => L + (i / n) * (W - L - R);
  const y = (v: number) => T + (1 - v / max) * (H - T - B);
  const line = (get: (p: BurndownPoint) => number) => points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(get(p)).toFixed(1)}`).join(' ');
  const label = (iso: string) => new Date(iso + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

  return (
    <svg className="burndown" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Sprint burndown chart">
      {[0, 0.5, 1].map((f) => (
        <g key={f}>
          <line x1={L} x2={W - R} y1={y(max * f)} y2={y(max * f)} className="bd-grid" />
          <text x={L - 6} y={y(max * f) + 4} textAnchor="end" className="bd-text">{Math.round(max * f)}</text>
        </g>
      ))}
      <path d={line((p) => p.ideal)} className="bd-ideal" />
      <path d={line((p) => p.remaining)} className="bd-actual" />
      {points.map((p, i) => <circle key={p.date} cx={x(i)} cy={y(p.remaining)} r={2.6} className="bd-dot"><title>{label(p.date)}: {p.remaining} left</title></circle>)}
      <text x={L} y={H - 4} className="bd-text">{label(points[0].date)}</text>
      <text x={W - R} y={H - 4} textAnchor="end" className="bd-text">{label(points[points.length - 1].date)}</text>
    </svg>
  );
}
