import { useEffect, useId, useMemo, useRef, useState } from 'react';

/**
 * A small searchable picker (type to filter, ↑/↓ to move, Enter to choose, Esc to close). Local to the Calendar until the shared calm
 * picker lands; it takes the same shape of props (items with id/label/hint, value, onChange, placeholder) so it can be swapped for it.
 */
export interface PickItem { id: string; label: string; hint?: string | null }
export function CalPicker({ items, value, onChange, placeholder = 'Search…', label, multiple = false, values, testId }: {
  items: readonly PickItem[]; value?: string | null; onChange: (id: string) => void; placeholder?: string; label: string;
  /** Several can be chosen (attendees): `values` are the chosen ids, a choice toggles. */
  multiple?: boolean; values?: readonly string[]; testId?: string;
}) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const lid = useId();
  const chosen = items.find((i) => i.id === value) ?? null;
  const list = useMemo(() => {
    const k = q.trim().toLowerCase();
    return (k ? items.filter((i) => `${i.label} ${i.hint ?? ''}`.toLowerCase().includes(k)) : items).slice(0, 40);
  }, [items, q]);
  useEffect(() => { setHi(0); }, [q]);
  useEffect(() => {
    if (!open) return;
    const off = (e: PointerEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    window.addEventListener('pointerdown', off); return () => window.removeEventListener('pointerdown', off);
  }, [open]);
  const pick = (id: string) => { onChange(id); if (!multiple) { setOpen(false); setQ(''); } };
  return (
    <div className="cp-pick" ref={box} data-testid={testId}>
      <input className="ed-sel cp-pick-in" role="combobox" aria-expanded={open} aria-controls={lid} aria-label={label} autoComplete="off"
        placeholder={!multiple && chosen && !open ? chosen.label : placeholder} value={open ? q : !multiple && chosen ? chosen.label : q}
        onFocus={() => setOpen(true)} onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setHi((h) => Math.min(list.length - 1, h + 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(0, h - 1)); }
          else if (e.key === 'Enter' && open && list[hi]) { e.preventDefault(); pick(list[hi].id); }
          else if (e.key === 'Escape' && open) { e.stopPropagation(); setOpen(false); }
        }} />
      {open && (
        <ul className="cp-pick-l" id={lid} role="listbox" aria-label={label}>
          {list.length === 0 && <li className="cp-pick-none">No match</li>}
          {list.map((i, n) => {
            const on = multiple ? !!values?.includes(i.id) : i.id === value;
            return (
              <li key={i.id} role="option" aria-selected={on} className={`${n === hi ? 'hi' : ''}${on ? ' on' : ''}`}
                onPointerDown={(e) => { e.preventDefault(); pick(i.id); }} onMouseEnter={() => setHi(n)}>
                <span>{i.label}</span>{i.hint && <small>{i.hint}</small>}{on && <b aria-hidden="true">✓</b>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
