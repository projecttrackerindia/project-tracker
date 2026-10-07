import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

export interface MenuItem { label: string; icon?: IconName; onSelect: () => void; hint?: string; danger?: boolean; hidden?: boolean }

/** A button that opens a small list of actions; closes on choosing, on a click outside and on Escape. */
export function Menu({ label, icon, items, primary, align = 'right' }: { label: ReactNode; icon?: IconName; items: MenuItem[]; primary?: boolean; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', away); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  const shown = items.filter((i) => !i.hidden);
  if (shown.length === 0) return null;
  return (
    <div className="menu" ref={ref}>
      <button type="button" className={`btn ${primary ? 'btn-primary' : 'btn-ghost'}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {icon && <Icon name={icon} size={15} />} {label} <Icon name="chevronD" size={13} />
      </button>
      {open && (
        <ul className={`menu-list ${align}`} role="menu">
          {shown.map((i) => (
            <li key={i.label} role="none"><button type="button" role="menuitem" className={i.danger ? 'danger' : ''} onClick={() => { setOpen(false); i.onSelect(); }}>
              {i.icon && <Icon name={i.icon} size={15} />}<span><b>{i.label}</b>{i.hint && <small>{i.hint}</small>}</span></button></li>
          ))}
        </ul>
      )}
    </div>
  );
}
