import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ChangeEventHandler, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';

interface Opt { value: string; label: string; disabled: boolean; group?: string }
interface Snapshot { opts: Opt[]; value: string }

/** Reads the options (and the chosen value) back from the native select that renders the children. */
function readSelect(sel: HTMLSelectElement): Snapshot {
  const opts: Opt[] = [];
  for (const el of Array.from(sel.children)) {
    if (el instanceof HTMLOptGroupElement) {
      for (const o of Array.from(el.children)) if (o instanceof HTMLOptionElement) opts.push({ value: o.value, label: o.text, disabled: o.disabled || el.disabled, group: el.label });
    } else if (el instanceof HTMLOptionElement) opts.push({ value: el.value, label: el.text, disabled: el.disabled });
  }
  return { opts, value: sel.value };
}

const sameSnapshot = (a: Snapshot, b: Snapshot) =>
  a.value === b.value && a.opts.length === b.opts.length && a.opts.every((o, i) => o.value === b.opts[i].value && o.label === b.opts[i].label && o.disabled === b.opts[i].disabled && o.group === b.opts[i].group);

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** The props of a native select that this component supports (a single choice; the label and description attributes go on the visible field). */
interface Props {
  children?: ReactNode; className?: string; style?: CSSProperties; id?: string; title?: string; disabled?: boolean; name?: string; required?: boolean; autoFocus?: boolean;
  value?: string | number | readonly string[]; defaultValue?: string | number | readonly string[]; onChange?: ChangeEventHandler<HTMLSelectElement>;
  'aria-label'?: string; 'aria-labelledby'?: string; 'aria-describedby'?: string;
}

/**
 * A drop-in replacement for the native <select> that has a search box: it takes the same props and the same <option> / <optgroup> children
 * (including components that render options) and calls onChange with a real change event, so it can be swapped in anywhere.
 * Opening it shows the list with a search field; typing narrows the options, arrows move, Enter chooses, Escape closes.
 * The native select stays in the page, hidden, as the single source of truth (value, options, change events).
 */
export function Select({ children, className = '', style, id, title, disabled, value, defaultValue, onChange, name, required, autoFocus, ...aria }: Props) {
  const native = useRef<HTMLSelectElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const listId = useId();
  const [snap, setSnap] = useState<Snapshot>({ opts: [], value: '' });
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [place, setPlace] = useState<{ left: number; width: number; top?: number; bottom?: number; maxHeight: number } | null>(null);

  // Whatever the children render (options, groups, components that return options) is read from the hidden native select after every
  // render - deliberately no dependency array, since there is no prop/state to list for "whatever JSX was just rendered as children".
  // Safe from an update loop: setSnap's updater returns the same object back (no re-render) whenever the read-back is unchanged.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const el = native.current;
    if (!el) return;
    const next = readSelect(el);
    setSnap((prev) => (sameSnapshot(prev, next) ? prev : next));
  });

  const selected = snap.opts.find((o) => o.value === snap.value);
  const shown = useMemo(() => {
    const q = fold(query.trim());
    return snap.opts.map((o, index) => ({ ...o, index })).filter((o) => !q || fold(o.label).includes(q));
  }, [snap.opts, query]);
  const enabled = useMemo(() => shown.filter((o) => !o.disabled), [shown]);

  // ---- placement: below the field, or above it when there is more room there; follows scrolling and resizing
  const reposition = useCallback(() => {
    const t = trigger.current;
    if (!t) return;
    const r = t.getBoundingClientRect();
    const vw = document.documentElement.clientWidth, vh = window.innerHeight;
    const width = Math.min(Math.max(r.width, 230), vw - 16);
    const left = Math.max(8, Math.min(r.left, vw - width - 8));
    const below = vh - r.bottom - 12, above = r.top - 12;
    if (below < 240 && above > below) setPlace({ left, width, bottom: vh - r.top + 4, maxHeight: Math.min(360, above) });
    else setPlace({ left, width, top: r.bottom + 4, maxHeight: Math.min(360, Math.max(below, 160)) });
  }, []);

  useLayoutEffect(() => { if (open) reposition(); }, [open, reposition, snap.opts.length]);
  useEffect(() => {
    if (!open) return;
    const onScroll = (e: Event) => { if (!pop.current?.contains(e.target as Node)) reposition(); };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!pop.current?.contains(t) && !trigger.current?.contains(t)) setOpen(false);
    };
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', reposition);
    document.addEventListener('mousedown', onDown);
    return () => { window.removeEventListener('scroll', onScroll, true); window.removeEventListener('resize', reposition); document.removeEventListener('mousedown', onDown); };
  }, [open, reposition]);

  useEffect(() => { if (open) search.current?.focus(); }, [open, place !== null]);   // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the highlighted option in view.
  useEffect(() => {
    if (!open) return;
    pop.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [open, active, query]);

  const openList = (prefill = '') => {
    if (disabled) return;
    setQuery(prefill);
    const at = snap.opts.filter((o) => !o.disabled).findIndex((o) => o.value === snap.value);
    setActive(prefill ? 0 : Math.max(0, at));
    setOpen(true);
  };
  const close = (refocus = true) => { setOpen(false); if (refocus) trigger.current?.focus(); };

  const choose = (opt: Opt) => {
    const el = native.current;
    if (opt.disabled) return;
    if (el && opt.value !== el.value) {
      el.value = opt.value;
      el.dispatchEvent(new Event('change', { bubbles: true }));   // React turns this into the usual onChange(event) with event.target.value
      setSnap(readSelect(el));                                       // (an uncontrolled select has nothing else to re-read it)
    }
    close();
  };

  // `active` counts the options that can be chosen among those shown.
  const activeOpt = enabled[Math.min(active, Math.max(0, enabled.length - 1))];

  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (enabled.length) setActive((a) => (Math.min(a, enabled.length - 1) + (e.key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length);
    } else if (e.key === 'Home' || e.key === 'End') {
      if (!query) { e.preventDefault(); setActive(e.key === 'Home' ? 0 : Math.max(0, enabled.length - 1)); }
    } else if (e.key === 'Enter') {
      e.preventDefault(); e.stopPropagation();
      if (activeOpt) choose(activeOpt);
    } else if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();   // closes the list only, not the dialog it may be in
      close();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      close();
    }
  };

  const onTriggerKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); openList(); }
    else if (e.key.length === 1 && e.key !== ' ' && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); openList(e.key); }   // just start typing to search
  };

  let lastGroup: string | undefined;

  return (
    <>
      <button {...aria} ref={trigger} type="button" id={id} title={title} disabled={disabled} autoFocus={autoFocus}
        className={`${className} ss-trigger`} style={style} role="combobox" aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined}
        onClick={() => (open ? close(false) : openList())} onKeyDown={onTriggerKey}>
        <span className="ss-value">{selected?.label ?? ' '}</span>
        {/* Every label, invisible, so the field is as wide as its longest option (like a native select) and does not jump when the choice changes. */}
        <span className="ss-sizer" aria-hidden="true">{snap.opts.map((o, i) => <span key={i}>{o.label}</span>)}</span>
      </button>
      <select ref={native} className="ss-native" tabIndex={-1} aria-hidden="true" name={name} required={required} disabled={disabled} value={value} defaultValue={defaultValue} onChange={onChange}>
        {children}
      </select>
      {open && place && createPortal(
        <div ref={pop} className="ss-pop" style={{ left: place.left, width: place.width, top: place.top, bottom: place.bottom, maxHeight: place.maxHeight }}>
          <div className="ss-search">
            <Icon name="search" size={14} />
            <input ref={search} value={query} onChange={(e) => { setQuery(e.target.value); setActive(0); }} onKeyDown={onSearchKey} placeholder="Search…"
              aria-label="Search options" role="searchbox" autoComplete="off" spellCheck={false} aria-controls={listId} aria-activedescendant={activeOpt ? `${listId}-${activeOpt.index}` : undefined} />
          </div>
          <ul className="ss-list" id={listId} role="listbox" aria-label={aria['aria-label']}>
            {shown.length === 0 && <li className="ss-empty" role="presentation">No matches</li>}
            {shown.map((o) => {
              const header = o.group && o.group !== lastGroup ? o.group : null;
              lastGroup = o.group;
              const isActive = activeOpt?.index === o.index;
              return (
                <li key={o.index} role="presentation" className="ss-row">
                  {header && <div className="ss-group">{header}</div>}
                  <div id={`${listId}-${o.index}`} role="option" aria-selected={o.value === snap.value} aria-disabled={o.disabled || undefined} data-active={isActive}
                    className={`ss-opt ${o.value === snap.value ? 'chosen' : ''} ${isActive ? 'active' : ''} ${o.disabled ? 'off' : ''}`}
                    onMouseDown={(e) => e.preventDefault()} onClick={() => choose(o)}
                    onMouseEnter={() => { const at = enabled.findIndex((x) => x.index === o.index); if (at >= 0) setActive(at); }}>
                    <Highlight text={o.label} query={query} />
                    {o.value === snap.value && <Icon name="tick" size={14} />}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>, document.body)}
    </>
  );
}

/** The label with the part that matches the search in bold. */
function Highlight({ text, query }: { text: string; query: string }) {
  const q = fold(query.trim());
  if (!q) return <span>{text}</span>;
  const at = fold(text).indexOf(q);
  if (at < 0) return <span>{text}</span>;
  return <span>{text.slice(0, at)}<mark>{text.slice(at, at + q.length)}</mark>{text.slice(at + q.length)}</span>;
}
