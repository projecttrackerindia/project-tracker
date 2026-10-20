import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { ReactNode } from 'react';
import { COST_GROUPS, series, STATUS } from './types';

/**
 * The Agent Tracker's charts. Colour follows the thing it stands for and is never the only cue: outcomes use the status colours with their
 * names in the legend and tooltip; categories use the validated categorical palette in a fixed order (CSS custom properties on .trk, with
 * their own dark steps); a single measure uses one hue. Text always wears text colours.
 */

type TipRow = { name?: string; value?: number | string; color?: string; dataKey?: string | number };
export function VizTip({ active, payload, label, format }: { active?: boolean; payload?: TipRow[]; label?: ReactNode; format?: (v: number, key: string) => string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="trk-tip">
      {label != null && <b>{label}</b>}
      {payload.filter((p) => p.value !== 0 || payload.length === 1).map((p, i) => (
        <span key={i}><i style={{ background: p.color }} />{p.name}<em>{typeof p.value === 'number' && format ? format(p.value, String(p.dataKey)) : p.value}</em></span>
      ))}
    </div>
  );
}

const axis = { tick: { fontSize: 11, fill: 'var(--text-3)' }, tickLine: false } as const;

/** Runs over time, stacked by outcome. */
export function ActivityChart({ data, unit }: { data: { label: string; succeeded: number; partial: number; awaiting: number; failed: number }[]; unit: 'hour' | 'day' }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 8, right: 4, left: -18, bottom: 0 }} barCategoryGap={unit === 'hour' ? 2 : '18%'}>
        <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 3" />
        <XAxis dataKey="label" {...axis} axisLine={{ stroke: 'var(--border)' }} minTickGap={18} />
        <YAxis allowDecimals={false} {...axis} axisLine={false} width={40} />
        <Tooltip content={<VizTip />} cursor={{ fill: 'var(--hover-bg)' }} />
        {STATUS.map((s, i) => (
          <Bar key={s.key} dataKey={s.key} name={s.label} stackId="o" fill={s.color} stroke="var(--surface)" strokeWidth={1}
            radius={i === STATUS.length - 1 ? [4, 4, 0, 0] : 0} animationDuration={600} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

/** AI credits per day, stacked by the agent that used them (categorical slots in fixed order). */
export function CostChart({ data }: { data: { label: string; assistant: number; agent: number; meetings: number; other: number }[] }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 8, right: 4, left: -18, bottom: 0 }} barCategoryGap="20%">
        <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 3" />
        <XAxis dataKey="label" {...axis} axisLine={{ stroke: 'var(--border)' }} minTickGap={14} />
        <YAxis allowDecimals={false} {...axis} axisLine={false} width={40} />
        <Tooltip content={<VizTip format={(v) => `${v} credit${v === 1 ? '' : 's'}`} />} cursor={{ fill: 'var(--hover-bg)' }} />
        {COST_GROUPS.map((g, i) => (
          <Bar key={g.key} dataKey={g.key} name={g.label} stackId="c" fill={series(i)} stroke="var(--surface)" strokeWidth={1}
            radius={i === COST_GROUPS.length - 1 ? [4, 4, 0, 0] : 0} animationDuration={600} />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

/** p50 and p95 duration over time. */
export function LatencyTrend({ data }: { data: { label: string; p50: number; p95: number }[] }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 3" />
        <XAxis dataKey="label" {...axis} axisLine={{ stroke: 'var(--border)' }} minTickGap={18} />
        <YAxis {...axis} axisLine={false} width={44} tickFormatter={(v: number) => `${(v / 1000).toFixed(v < 10_000 ? 1 : 0)}s`} />
        <Tooltip content={<VizTip format={(v) => `${(v / 1000).toFixed(1)}s`} />} cursor={{ stroke: 'var(--border-strong)' }} />
        <Line type="monotone" dataKey="p50" name="Typical (p50)" stroke={series(0)} strokeWidth={2} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--surface)' }} connectNulls />
        <Line type="monotone" dataKey="p95" name="Slow (p95)" stroke={series(1)} strokeWidth={2} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--surface)' }} connectNulls />
      </LineChart>
    </ResponsiveContainer>
  );
}

/** Several counts per day (the agent fleet): one line each, categorical slots in fixed order. */
export function FleetTrend({ data, lines }: { data: Record<string, string | number>[]; lines: { key: string; label: string }[] }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={data} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 3" />
        <XAxis dataKey="label" {...axis} axisLine={{ stroke: 'var(--border)' }} minTickGap={18} />
        <YAxis allowDecimals={false} {...axis} axisLine={false} width={40} />
        <Tooltip content={<VizTip />} cursor={{ stroke: 'var(--border-strong)' }} />
        {lines.map((l, i) => (
          <Line key={l.key} type="monotone" dataKey={l.key} name={l.label} stroke={series(i)} strokeWidth={2} dot={false}
            activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--surface)' }} animationDuration={600} />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

/** How long runs take: one hue, one bar per range. */
export function Histogram({ data }: { data: { label: string; count: number }[] }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 8, right: 4, left: -18, bottom: 0 }} barCategoryGap="16%">
        <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 3" />
        <XAxis dataKey="label" {...axis} axisLine={{ stroke: 'var(--border)' }} interval={0} />
        <YAxis allowDecimals={false} {...axis} axisLine={false} width={40} />
        <Tooltip content={<VizTip format={(v) => `${v} run${v === 1 ? '' : 's'}`} />} cursor={{ fill: 'var(--hover-bg)' }} />
        <Bar dataKey="count" name="Runs" fill={series(6)} radius={[4, 4, 0, 0]} animationDuration={600} />
      </BarChart>
    </ResponsiveContainer>
  );
}

// ------------------------------------------------------------------ small hand-drawn pieces (no library)

/** A single percentage as a ring, with its number in the middle. */
export function Ring({ value, size = 92, stroke = 9, tone = 'var(--trk-good)', label, sub }: { value: number | null; size?: number; stroke?: number; tone?: string; label: string; sub?: string }) {
  const r = (size - stroke) / 2; const c = 2 * Math.PI * r;
  const v = value == null ? 0 : Math.max(0, Math.min(100, value));
  return (
    <div className="trk-ring" role="img" aria-label={`${label}: ${value == null ? 'no data' : `${value}%`}`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface-2)" strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={tone} strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={`${(v / 100) * c} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} className="trk-ring-arc" />
      </svg>
      <div className="trk-ring-text"><b>{value == null ? '–' : `${value}%`}</b><span>{label}</span>{sub && <small>{sub}</small>}</div>
    </div>
  );
}

/** A tiny trend line for a card. */
export function Spark({ values, color }: { values: number[]; color: string }) {
  const w = 120, h = 34;
  if (values.length < 2 || values.every((v) => v === 0)) return <svg className="trk-spark" width={w} height={h} aria-hidden><line x1="0" y1={h - 2} x2={w} y2={h - 2} stroke="var(--border)" strokeWidth="2" strokeDasharray="3 4" /></svg>;
  const max = Math.max(...values, 1);
  const pts = values.map((v, i) => [(i / (values.length - 1)) * w, h - 3 - (v / max) * (h - 8)] as const);
  const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const id = `sp${color.replace(/[^a-z0-9]/gi, '')}`;
  return (
    <svg className="trk-spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden>
      <defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={color} stopOpacity=".28" /><stop offset="100%" stopColor={color} stopOpacity="0" /></linearGradient></defs>
      <path d={`${d} L${w},${h} L0,${h} Z`} fill={`url(#${id})`} />
      <path d={d} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/** One 100% bar split into labelled parts (2px gaps), with a legend underneath. */
export function StackBar({ parts, height = 12, legend = true }: { parts: { label: string; value: number; color: string; hint?: string }[]; height?: number; legend?: boolean }) {
  const shown = parts.filter((p) => p.value > 0);
  const total = shown.reduce((a, p) => a + p.value, 0);
  return (
    <div className="trk-stack-wrap">
      <div className="trk-stack" style={{ height }} role="img" aria-label={shown.map((p) => `${p.label} ${p.value}`).join(', ') || 'Nothing yet'}>
        {total === 0 ? <i className="empty" /> : shown.map((p) => <i key={p.label} style={{ flexGrow: p.value, background: p.color }} title={`${p.label}: ${p.hint ?? p.value}`} />)}
      </div>
      {legend && (
        <ul className="trk-legend">
          {parts.map((p) => <li key={p.label} className={p.value === 0 ? 'zero' : ''}><i style={{ background: p.color }} />{p.label}<b>{p.hint ?? p.value}</b></li>)}
        </ul>
      )}
    </div>
  );
}

/** A ranked list of horizontal bars (one measure, one hue); optional second, darker part for failures. */
export function BarList({ rows, color, unit }: { rows: { label: string; value: number; bad?: number; note?: string }[]; color: string; unit?: (v: number) => string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="trk-barlist">
      {rows.map((r) => (
        <li key={r.label} title={`${r.label}: ${unit ? unit(r.value) : r.value}${r.bad ? `, ${r.bad} failed` : ''}`}>
          <div className="trk-barlist-head"><span>{r.label}</span><b>{unit ? unit(r.value) : r.value}</b></div>
          <div className="trk-barlist-track">
            <i style={{ width: `${(r.value / max) * 100}%`, background: color }} />
            {!!r.bad && <i className="bad" style={{ width: `${(r.bad / max) * 100}%` }} />}
          </div>
          {r.note && <small>{r.note}</small>}
        </li>
      ))}
    </ul>
  );
}
