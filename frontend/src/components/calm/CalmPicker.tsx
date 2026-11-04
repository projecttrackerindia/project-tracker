import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useIsMobile } from '../../lib/mobile';
import { projectColor } from '../../lib/calm';
import './calm-picker.css';

/** One choice in a CalmPicker: a label, an optional quiet line, an optional project dot and a group heading. */
export interface PickItem { id: string; label: string; sub?: string | null; dot?: string | null; group?: string; keywords?: string }

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const LIMIT = 8;

function readRecent(key?: string): string[] {
  if (!key) return [];
  try { const v = JSON.parse(localStorage.getItem(`pt_pick_${key}`) ?? '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, LIMIT) : []; } catch { return []; }
}
function pushRecent(key: string | undefined, id: string) {
  if (!key) return;
  try { localStorage.setItem(`pt_pick_${key}`, JSON.stringify([id, ...readRecent(key).filter((x) => x !== id)].slice(0, LIMIT))); } catch { /* private window */ }
}

/**
 * The one calm picker (a combobox) for projects, tasks, people and work items, used instead of native selects and long dropdowns.
 * Opening it shows your recent picks, then the top 8; typing narrows the list (or asks the server with `search` for long lists, debounced);
 * arrows move, Enter picks, Escape closes. On a phone it opens as a bottom sheet with 44px rows.
 */
export function CalmPicker({ value, onChange, items = [], search, placeholder = 'Choose…', label, recentKey, allowClear, disabled, selected: selectedProp, className = '', testId, empty }: {
  value: string | null | undefined; onChange: (id: string | null, item: PickItem | null) => void;
  /** Every choice (filtered on the device). */ items?: PickItem[];
  /** Server search for large lists: called with what was typed (debounced); its results replace the local filter. */ search?: (q: string) => Promise<PickItem[]>;
  placeholder?: string; label: string; recentKey?: string; allowClear?: boolean; disabled?: boolean;
  /** The chosen item when it is not in `items` (an async list). */ selected?: PickItem | null;
  className?: string; testId?: string; empty?: ReactNode;
}) {
  const phone = useIsMobile();
  const listId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const [remote, setRemote] = useState<PickItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [place, setPlace] = useState<{ left: number; top: number; width: number; up: boolean } | null>(null);
  const known = useRef(new Map<string, PickItem>());
  for (const it of items) known.current.set(it.id, it);
  for (const it of remote ?? []) known.current.set(it.id, it);
  const chosen = (value ? known.current.get(value) : null) ?? selectedProp ?? null;

  // Server search, debounced; a stale answer is dropped. The latest `search` is read from a ref, so an inline function never re-fires it.
  const searchRef = useRef(search);
  searchRef.current = search;
  const hasSearch = !!search;
  useEffect(() => {
    const search = searchRef.current;
    if (!open || !search) return;
    let live = true;
    setLoading(true);
    const t = window.setTimeout(() => {
      search(q.trim()).then((r) => { if (live) setRemote(r); }).catch(() => { if (live) setRemote([]); }).finally(() => { if (live) setLoading(false); });
    }, q ? 200 : 0);
    return () => { live = false; window.clearTimeout(t); };
  }, [q, open, hasSearch]);

  const shown = useMemo(() => {
    const pool = search && remote ? remote : items;
    const f = fold(q.trim());
    if (f) return pool.filter((i) => fold(`${i.label} ${i.sub ?? ''} ${i.keywords ?? ''}`).includes(f)).slice(0, 50);
    const rec = readRecent(recentKey).map((id) => known.current.get(id)).filter((x): x is PickItem => !!x).map((x) => ({ ...x, group: 'Recent' }));
    const rest = pool.filter((i) => !rec.some((r) => r.id === i.id)).slice(0, Math.max(0, LIMIT - rec.length) + (rec.length ? 0 : 0));
    return [...rec, ...rest.slice(0, LIMIT)];
  }, [q, items, remote, search, recentKey, open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => setActive(0), [q, open]);
  useLayoutEffect(() => {
    if (!open || phone || !trigger.current) return;
    const r = trigger.current.getBoundingClientRect();
    const up = window.innerHeight - r.bottom < 340 && r.top > 340;
    setPlace({ left: Math.min(r.left, window.innerWidth - Math.max(r.width, 300) - 8), top: up ? r.top - 6 : r.bottom + 6, width: Math.max(r.width, 300), up });
  }, [open, phone]);
  useEffect(() => { if (open) requestAnimationFrame(() => input.current?.focus()); else setQ(''); }, [open]);
  useEffect(() => {
    if (!open || phone) return;
    const off = (e: MouseEvent) => { const t = e.target as Node; if (!trigger.current?.contains(t) && !document.getElementById(listId)?.parentElement?.contains(t)) setOpen(false); };
    const scroll = (e: Event) => { if (!document.getElementById(listId)?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', off); window.addEventListener('scroll', scroll, true);
    return () => { document.removeEventListener('mousedown', off); window.removeEventListener('scroll', scroll, true); };
  }, [open, phone, listId]);

  const pick = (it: PickItem | null) => {
    if (it) pushRecent(recentKey, it.id);
    onChange(it?.id ?? null, it);
    setOpen(false);
    trigger.current?.focus();
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(shown.length - 1, a + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === 'Home') { e.preventDefault(); setActive(0); }
    else if (e.key === 'End') { e.preventDefault(); setActive(shown.length - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); if (shown[active]) pick(shown[active]); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); trigger.current?.focus(); }
    else if (e.key === 'Tab') setOpen(false);
  };
  useEffect(() => { document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: 'nearest' }); }, [active, listId]);

  const list = (
    <>
      <div className="cpk-search">
        <input ref={input} type="search" className="cpk-input" role="combobox" aria-expanded="true" aria-controls={listId} aria-autocomplete="list" aria-label={`Search ${label.toLowerCase()}`}
          aria-activedescendant={shown[active] ? `${listId}-${active}` : undefined} autoComplete="off" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} />
      </div>
      <ul className="cpk-list" role="listbox" id={listId} aria-label={label}>
        {shown.map((it, i) => (
          <li key={`${it.group ?? ''}:${it.id}`} role="presentation">
            {it.group && (i === 0 || shown[i - 1].group !== it.group) && <div className="cpk-group" role="presentation">{it.group}</div>}
            <div role="option" id={`${listId}-${i}`} aria-selected={it.id === value} className={`cpk-opt${i === active ? ' active' : ''}${it.id === value ? ' on' : ''}`}
              onMouseMove={() => setActive(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(it)}>
              {it.dot !== undefined && <span className="cpk-dot" style={{ background: it.dot ?? projectColor(it.id) }} aria-hidden="true" />}
              <span className="cpk-t"><b>{it.label}</b>{it.sub && <small>{it.sub}</small>}</span>
              {it.id === value && <span className="cpk-tick" aria-hidden="true">✓</span>}
            </div>
          </li>
        ))}
        {shown.length === 0 && <li className="cpk-empty" role="presentation">{loading ? 'Searching…' : q ? `Nothing matches “${q.trim()}”.` : empty ?? 'Nothing to choose yet.'}</li>}
      </ul>
      {allowClear && value && <button type="button" className="cpk-clear" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(null)}>Clear</button>}
    </>
  );

  return (
    <>
      <button ref={trigger} type="button" className={`cpk-trigger ${className}`.trim()} disabled={disabled} aria-haspopup="listbox" aria-expanded={open} aria-label={`${label}: ${chosen?.label ?? placeholder}`}
        data-testid={testId} onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => { if (!open && (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setOpen(true); } }}>
        {chosen?.dot !== undefined && chosen && <span className="cpk-dot" style={{ background: chosen.dot ?? projectColor(chosen.id) }} aria-hidden="true" />}
        <span className={`cpk-v${chosen ? '' : ' ph'}`}>{chosen?.label ?? placeholder}</span>
        <span className="cpk-chev" aria-hidden="true">⌄</span>
      </button>
      {open && createPortal(phone
        ? <div className="cpk-scrim" data-keep-detail="" onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
            <div className="cpk-sheet" role="dialog" aria-label={label}><div className="cpk-grab" aria-hidden="true" /><h3 className="cpk-h">{label}</h3>{list}</div>
          </div>
        : place && <div data-keep-detail="" className={`cpk-pop${place.up ? ' up' : ''}`} style={{ left: place.left, width: place.width, ...(place.up ? { bottom: window.innerHeight - place.top } : { top: place.top }) }}>{list}</div>,
      document.body)}
    </>
  );
}
