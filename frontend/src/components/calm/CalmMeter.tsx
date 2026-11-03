import type { CSSProperties, ReactNode } from 'react';
import './calm-kit.css';

/** A meter row in a rail card ("Tests passing ▬▬▬ 96%"): label, a thin bar in a colour, the value on the right. */
export function CalmMeter({ label, value, max = 100, right, color }: { label: ReactNode; value: number; max?: number; right?: ReactNode; color?: string }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div className="calm-rr calm-meter">
      <span className="calm-meter-l">{label}</span>
      <span className="calm-mbar" style={color ? ({ '--calm-dot': color } as CSSProperties) : undefined}><i style={{ width: `${pct}%` }} /></span>
      <span className="calm-rr-r calm-meter-r">{right ?? value}</span>
    </div>
  );
}

/** A small status chip: plain, blue (on), green (done), orange or red. */
export function CalmChip({ children, tone }: { children: ReactNode; tone?: 'on' | 'dn' | 'or' | 'bl' }) {
  return <span className={`calm-chip${tone ? ` ${tone}` : ''}`}>{children}</span>;
}
