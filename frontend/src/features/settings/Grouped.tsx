import type { ReactNode } from 'react';
import './grouped.css';

/**
 * macOS System Settings building blocks: a grouped inset list (rounded white card of rows with hairline dividers), its small label above,
 * a row with an optional coloured icon tile, a real switch (role="switch") and a pop-up button (a native select styled as one).
 */
export function SGroup({ label, children, tone, id }: { label?: string; children: ReactNode; tone?: 'critical'; id?: string }) {
  return (
    <section className="sg-wrap" aria-label={label} id={id}>
      {label && <h3 className="sg-label">{label}</h3>}
      <div className={`sg${tone ? ` sg-${tone}` : ''}`}>{children}</div>
    </section>
  );
}

export function STile({ color, children, size = 26 }: { color: string; children: ReactNode; size?: number }) {
  // A text glyph is drawn by CSS (data-glyph), so it never becomes part of the row's or link's text.
  return typeof children === 'string'
    ? <span className="sg-tile" style={{ background: color, width: size, height: size }} aria-hidden="true" data-glyph={children} />
    : <span className="sg-tile" style={{ background: color, width: size, height: size }} aria-hidden="true">{children}</span>;
}

export function SRow({ icon, title, sub, children, dim, onClick }: { icon?: ReactNode; title: ReactNode; sub?: ReactNode; children?: ReactNode; dim?: boolean; onClick?: () => void }) {
  const body = (
    <>
      {icon}
      <span className="sg-tx"><b>{title}</b>{sub && <span>{sub}</span>}</span>
      {children && <span className="sg-end">{children}</span>}
    </>
  );
  return onClick
    ? <button type="button" className={`sg-row sg-link${dim ? ' dim' : ''}`} onClick={onClick}>{body}<span className="sg-chev" aria-hidden="true">›</span></button>
    : <div className={`sg-row${dim ? ' dim' : ''}`}>{body}</div>;
}

export function SSwitch({ on, onChange, label, disabled, locked }: { on: boolean; onChange?: (v: boolean) => void; label: string; disabled?: boolean; locked?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className={`sg-sw${on ? ' on' : ''}${locked ? ' lock' : ''}`}
      disabled={disabled || locked} onClick={() => onChange?.(!on)} />
  );
}

export function SPop<T extends string>({ value, options, onChange, label, disabled }: { value: T; options: { id: T; label: string }[]; onChange: (v: T) => void; label: string; disabled?: boolean }) {
  return (
    <span className="sg-pop">
      <select aria-label={label} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
    </span>
  );
}

/** The pane's header: a large icon tile, the title and one line under it. */
export function SPaneHead({ icon, color, title, sub }: { icon: ReactNode; color: string; title: string; sub: string }) {
  return (
    <header className="sg-head">
      <STile color={color} size={44}>{icon}</STile>
      <div><h2>{title}</h2><p>{sub}</p></div>
    </header>
  );
}
