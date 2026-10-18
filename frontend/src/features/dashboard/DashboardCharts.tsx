import { Area, AreaChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { StatusCategory } from '../../api/types';
import { ChartTip } from '../../components/ChartTip';

/**
 * The home page's two charts, in a module of their own so the charting library is fetched only when there is something to chart (the
 * dashboard loads it lazily; the page and its numbers show straight away).
 */

/** Tasks completed per day over the chosen range. */
export function TrendChart({ trend, range }: { trend: { label: string; count: number }[]; range: number }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={trend} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="dashTrendFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#8b5cf6" stopOpacity={0.35} /><stop offset="100%" stopColor="#8b5cf6" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--border)" />
        <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--text-3)' }} axisLine={{ stroke: 'var(--border)' }} tickLine={false} interval={range <= 14 ? 0 : range <= 30 ? 2 : 6} minTickGap={12} />
        <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: 'var(--text-3)' }} axisLine={false} tickLine={false} width={24} />
        <Tooltip content={<ChartTip format={(v) => `${v} completed`} />} cursor={{ stroke: 'var(--border-strong)' }} />
        <Area type="monotone" dataKey="count" stroke="#8b5cf6" strokeWidth={2.5} fill="url(#dashTrendFill)" animationDuration={700} animationEasing="ease-out" />
      </AreaChart>
    </ResponsiveContainer>
  );
}

/** The ring of tasks by status category. */
export function StatusRing({ statusDist, statusTotal, colors }: {
  statusDist: { category: StatusCategory; count: number }[]; statusTotal: number; colors: Record<StatusCategory, string>;
}) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <PieChart>
        <Pie data={statusDist} dataKey="count" nameKey="category" innerRadius={31} outerRadius={46} paddingAngle={2} animationDuration={650} animationEasing="ease-out" fill="#8b5cf6" stroke="var(--surface-1)" strokeWidth={2}>
          {statusDist.map((s) => <Cell key={s.category} fill={colors[s.category]} />)}
        </Pie>
        <Tooltip content={<ChartTip format={(v) => `${v} (${statusTotal ? Math.round((v / statusTotal) * 100) : 0}%)`} />} />
      </PieChart>
    </ResponsiveContainer>
  );
}
