import type { ReactNode } from 'react';
import './calm-kit.css';

export type CalmPill<T extends string> = { value: T; label: ReactNode; count?: number };

/** Segmented filters: a fill track with a solid thumb on the chosen one ("This week · Later · Done"). */
export function CalmPills<T extends string>({ options, value, onChange, label, size }: {
  options: CalmPill<T>[]; value: T; onChange: (v: T) => void; label: string; size?: 'lg';
}) {
  return (
    <div className={`calm-pills${size ? ` ${size}` : ''}`} role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}{o.count != null && <em>{o.count}</em>}
        </button>
      ))}
    </div>
  );
}
