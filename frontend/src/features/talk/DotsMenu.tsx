import { useEffect, useRef, useState } from 'react';
import { Icon, type IconName } from '../../components/Icon';

export interface DotsItem { label: string; icon?: IconName; onSelect: () => void; hint?: string; danger?: boolean; hidden?: boolean }

/** "···": the less-used actions of a screen, in one small list. Closes on choosing, on a click outside and on Escape. */
export function DotsMenu({ label, items, className = '', align = 'right' }: { label: string; items: DotsItem[]; className?: string; align?: 'left' | 'right' }) {
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
    <div className={`v2-dots ${className}`} ref={ref}>
      <button type="button" className="v2-dots-btn" aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name="more" size={16} />
      </button>
      {open && (
        <ul className={`v2-dots-list ${align}`} role="menu" aria-label={label}>
          {shown.map((i) => (
            <li key={i.label} role="none">
              <button type="button" role="menuitem" className={i.danger ? 'danger' : ''} onClick={() => { setOpen(false); i.onSelect(); }}>
                {i.icon && <Icon name={i.icon} size={15} />}<span><b>{i.label}</b>{i.hint && <small>{i.hint}</small>}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
