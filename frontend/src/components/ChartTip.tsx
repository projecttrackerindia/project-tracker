/** Tooltip body for Recharts charts, styled like the rest of the app (see .chart-tip in components.css). */
export function ChartTip({ active, payload, label, format }: {
  active?: boolean; payload?: { value: number; name?: string; color?: string }[]; label?: string; format?: (v: number) => string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="chart-tip">
      <b>{label}</b>
      {payload.map((p, i) => <span key={i} style={p.color ? { color: p.color } : undefined}>{p.name ? `${p.name}: ` : ''}{format ? format(p.value) : p.value}</span>)}
    </div>
  );
}
