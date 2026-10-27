import { useRef, useState } from 'react';
import { Icon, type IconName } from '../../components/Icon';
import { Popover } from '../../lib/popover';
import './dots.css';

export interface DotsItem { label: string; icon?: IconName; onSelect: () => void; hint?: string; danger?: boolean; hidden?: boolean }

/**
 * "···": the less-used actions of a screen, in one small list. The list floats above everything (lib/popover): it opens below the
 * button, or above it when there is no room, and stays inside the window. Closes on choosing, on a click outside, on Escape and when
 * the button scrolls away; arrow keys move between the actions and focus returns to the button.
 */
export function DotsMenu({ label, items, className = '', listClassName = '', align = 'right', icon = 'more' }: { label: string; items: DotsItem[]; className?: string; listClassName?: string; align?: 'left' | 'right'; icon?: IconName }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const shown = items.filter((i) => !i.hidden);
  if (shown.length === 0) return null;
  return (
    <div className={`v2-dots ${className}`} ref={ref}>
      <button type="button" className="v2-dots-btn" aria-label={label} title={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name={icon} size={16} />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={ref} align={align === 'right' ? 'end' : 'start'} className="v2-dots-pop">
        <ul className={`v2-dots-list ${listClassName}`} role="menu" aria-label={label}>
          {shown.map((i) => (
            <li key={i.label} role="none">
              <button type="button" role="menuitem" className={i.danger ? 'danger' : ''} onClick={() => { setOpen(false); i.onSelect(); }}>
                {i.icon && <Icon name={i.icon} size={15} />}<span><b>{i.label}</b>{i.hint && <small>{i.hint}</small>}</span>
              </button>
            </li>
          ))}
        </ul>
      </Popover>
    </div>
  );
}
