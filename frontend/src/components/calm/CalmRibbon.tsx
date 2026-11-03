import type { CSSProperties, ReactNode } from 'react';
import { CalmDot } from './CalmRow';
import './calm-kit.css';

export type CalmTone = 'good' | 'warn' | 'bad' | 'quiet';

/**
 * A thin progress bar in the project's colour, with an optional label row above it (dot, name, and a status on the right in its tone).
 * `value` is 0-100.
 */
export function CalmRibbon({ value, color, label, status, tone = 'quiet', thin, className = '' }: {
  value: number; color?: string | null; label?: ReactNode; status?: ReactNode; tone?: CalmTone; thin?: boolean; className?: string;
}) {
  const pct = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
  const style = color ? ({ '--calm-dot': color } as CSSProperties) : undefined;
  return (
    <div className={`calm-ribbon ${className}`.trim()} style={style}>
      {(label || status) && (
        <div className="calm-ribbon-lab">
          {label && <><CalmDot color={color} /><span>{label}</span></>}
          {status && <span className={`calm-ribbon-r calm-tone-${tone}`}>{status}</span>}
        </div>
      )}
      <div className={`calm-bar${thin ? ' thin' : ''}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}><i style={{ width: `${pct}%` }} /></div>
    </div>
  );
}
