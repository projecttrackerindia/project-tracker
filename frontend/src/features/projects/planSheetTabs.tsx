import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { get, put } from '../../api/client';
import { useWsQuery } from '../../lib/hooks';
import { toast } from '../../stores/ui';
import type { SheetRow } from './portfolioApi';
import { Floating, initials } from './planSheetParts';

/** The five project tints (design plansheet4–8): an accent, a header tint and a row tint, light and dark (planSheet.css .pc-*). */
export const COLOURS = ['blue', 'teal', 'violet', 'amber', 'rose'] as const;
export type Colour = (typeof COLOURS)[number];
export const COLOUR_LABEL: Record<Colour, string> = { blue: 'Blue', teal: 'Teal', violet: 'Violet', amber: 'Amber', rose: 'Rose' };

export interface TabPrefs { pins: string[]; colors: Record<string, Colour>; hidden: string[]; names: Record<string, string> }
const EMPTY: TabPrefs = { pins: [], colors: {}, hidden: [], names: {} };
const LS = 'pt.plansheet.tabs';
const readLocal = (): TabPrefs | null => { try { const v = localStorage.getItem(LS); return v ? { ...EMPTY, ...(JSON.parse(v) as Partial<TabPrefs>) } : null; } catch { return null; } };
const writeLocal = (p: TabPrefs) => { try { localStorage.setItem(LS, JSON.stringify(p)); } catch { /* private window */ } };

/**
 * Pins, colours, hidden tabs and display names, per person: kept with the account (the plan sheet's own layout, /me/ui/plansheet, next to the
 * default view) and mirrored in this browser so the strip draws at once.
 */
export function useTabPrefs() {
  const server = useWsQuery(['ui', 'plansheet'], async () => { try { return (await get<{ value: Record<string, unknown> | null }>('/me/ui/plansheet'))?.value ?? {}; } catch { return {}; } }, { staleTime: 300_000 });
  const [local, setLocal] = useState<TabPrefs | null>(() => readLocal());
  const prefs: TabPrefs = useMemo(() => local ?? { ...EMPTY, ...((server.data?.tabs as Partial<TabPrefs> | undefined) ?? {}) }, [local, server.data]);
  const save = useCallback((next: TabPrefs) => {
    setLocal(next); writeLocal(next);
    void put('/me/ui/plansheet', { value: { ...(server.data ?? {}), tabs: next } }).catch(() => toast('Your tabs are kept on this device only for now.', 'info'));
  }, [server.data]);
  return { prefs, save };
}

export const colourOf = (prefs: TabPrefs, projects: SheetRow[], id: string): Colour => {
  const stored = prefs.colors[id];
  if (stored && COLOURS.includes(stored)) return stored;
  const i = projects.findIndex((p) => p.id === id);
  return COLOURS[(i < 0 ? 0 : i) % COLOURS.length];
};

/** Two letters for a tab squeezed down to its colour: the project key when it is short, else the name's initials. */
const short = (p: SheetRow) => (p.key && p.key.length <= 3 ? p.key : initials(p.title));

export type TabId = 'actions' | string;

/**
 * The folder tabs above the sheet (design plansheet8): Action items first (fixed, ink, with its count), then pinned projects, then the rest in a
 * strip that scrolls sideways with soft edges and ‹ ›, squeezing to colour and initials when tight; ⌕ finds any project. Right-click or a long
 * press on a project: Pin, Rename (for you only), its colour, Hide, Filter to this colour. A colour filter beside the command field picks projects by
 * colour.
 */
export function TabStrip({ projects, counts, actionCount, active, onPick, prefs, save, compact }: {
  projects: SheetRow[]; counts: Map<string, number>; actionCount: number | null; active: TabId | null; onPick: (t: TabId | null) => void;
  prefs: TabPrefs; save: (p: TabPrefs) => void; compact: boolean;
}) {
  const visible = projects.filter((p) => !prefs.hidden.includes(p.id) || p.id === active);
  const pinned = prefs.pins.map((id) => visible.find((p) => p.id === id)).filter((p): p is SheetRow => !!p);
  const rest = visible.filter((p) => !prefs.pins.includes(p.id));
  const scroller = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const [menu, setMenu] = useState<{ p: SheetRow; anchor: DOMRect } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [finder, setFinder] = useState<HTMLElement | null>(null);
  const [tight, setTight] = useState(false);
  const measure = useCallback(() => {
    const el = scroller.current; if (!el) return;
    setEdges({ left: el.scrollLeft > 4, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 4 });
    // Tight: the strip holds less than about 150px a tab, so the ones not chosen shrink to colour and initials.
    setTight(rest.length > 0 && el.clientWidth / rest.length < 150);
  }, [rest.length]);
  useEffect(() => {
    measure();
    const el = scroller.current; if (!el) return;
    const ro = new ResizeObserver(measure); ro.observe(el);
    el.addEventListener('scroll', measure, { passive: true });
    return () => { ro.disconnect(); el.removeEventListener('scroll', measure); };
  }, [measure]);
  useEffect(() => { scroller.current?.querySelector<HTMLElement>('.ft.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }, [active]);
  const nudge = (d: number) => scroller.current?.scrollBy({ left: d * Math.max(160, (scroller.current?.clientWidth ?? 300) * 0.6), behavior: 'smooth' });

  const press = useRef<number | null>(null);
  const tab = (p: SheetRow, mini: boolean) => {
    const c = colourOf(prefs, projects, p.id), on = active === p.id, name = prefs.names[p.id] || p.title, isPin = prefs.pins.includes(p.id);
    const openMenu = (r: DOMRect) => setMenu({ p, anchor: r });
    return (
      <button key={p.id} type="button" role="tab" aria-selected={on} data-tab={p.id} className={`ft pc-${c} ${on ? 'on' : ''} ${mini && !on ? 'mini' : ''}`}
        title={mini && !on ? name : undefined} aria-label={`${name}${counts.get(p.id) ? `, ${counts.get(p.id)} tasks` : ''}${isPin ? ', pinned' : ''}`}
        onClick={() => onPick(on ? null : p.id)}
        onContextMenu={(e) => { e.preventDefault(); openMenu(e.currentTarget.getBoundingClientRect()); }}
        onTouchStart={(e) => { const r = e.currentTarget.getBoundingClientRect(); press.current = window.setTimeout(() => { press.current = null; openMenu(r); }, 550); }}
        onTouchEnd={() => { if (press.current) { clearTimeout(press.current); press.current = null; } }}
        onTouchMove={() => { if (press.current) { clearTimeout(press.current); press.current = null; } }}>
        {isPin ? <span className="pin" aria-hidden="true">📌</span> : <span className="hd" aria-hidden="true" />}
        {renaming === p.id ? <RenameInput value={name} onDone={(v) => { setRenaming(null); if (v !== null) save({ ...prefs, names: { ...prefs.names, [p.id]: v } }); }} />
          : <span className="nm">{mini && !on ? short(p) : name}</span>}
        {!(mini && !on) && counts.get(p.id) != null && <span className="c">{counts.get(p.id)}</span>}
      </button>
    );
  };
  return (
    <div className={`ps4-tabs ${compact ? 'compact' : ''}`} role="tablist" aria-label="Plan sheet tabs">
      <button type="button" role="tab" aria-selected={active === 'actions'} data-tab="actions" className={`ft ai first ${active === 'actions' ? 'on' : ''}`} onClick={() => onPick(active === 'actions' ? null : 'actions')}
        title="Action items from meetings (⌘1)">✓ Action items{actionCount != null && <span className="c">{actionCount}</span>}<span className="lock" aria-label="fixed">🔒</span></button>
      {pinned.length > 0 && <span className="sep" aria-hidden="true" />}
      {pinned.map((p) => tab(p, false))}
      <span className="sep" aria-hidden="true" />
      {edges.left && <button type="button" className="nud" aria-label="Scroll tabs left" onClick={() => nudge(-1)}>‹</button>}
      <div ref={scroller} className={`tscroll ${edges.left ? 'fl' : ''} ${edges.right ? 'fr' : ''}`}>{rest.map((p) => tab(p, tight))}</div>
      {edges.right && <button type="button" className="nud" aria-label="Scroll tabs right" onClick={() => nudge(1)}>›</button>}
      <button type="button" className="ft plus" aria-label="Find a project" title="Find a project" aria-expanded={!!finder} onClick={(e) => setFinder(finder ? null : e.currentTarget)}>⌕</button>

      {menu && (
        <Floating anchor={menu.anchor} onClose={() => setMenu(null)} width={230} label={`${menu.p.title} tab`} role="menu" style={{ padding: 6 }}>
          <div className="ps4-mh">{prefs.names[menu.p.id] || menu.p.title}</div>
          <button type="button" role="menuitem" className="it" onClick={() => { const id = menu.p.id; setMenu(null); save({ ...prefs, pins: prefs.pins.includes(id) ? prefs.pins.filter((x) => x !== id) : [...prefs.pins, id] }); }}>
            📌 {prefs.pins.includes(menu.p.id) ? 'Unpin tab' : 'Pin tab'}</button>
          <button type="button" role="menuitem" className="it" onClick={() => { const id = menu.p.id; setMenu(null); setRenaming(id); }}>✎ Rename<span className="ps3-sp" /><span className="ps3-dim" style={{ fontSize: 11 }}>for you</span></button>
          {prefs.names[menu.p.id] && <button type="button" role="menuitem" className="it" onClick={() => { const id = menu.p.id; setMenu(null); const n = { ...prefs.names }; delete n[id]; save({ ...prefs, names: n }); }}>↺ Use the project’s name</button>}
          <div className="hr" />
          <div className="ps4-mh">Colour</div>
          <div className="ps4-pal" role="group" aria-label="Tab colour">{COLOURS.map((c) => <button key={c} type="button" className={`pc-${c} ${colourOf(prefs, projects, menu.p.id) === c ? 'on' : ''}`} aria-label={COLOUR_LABEL[c]}
            aria-pressed={colourOf(prefs, projects, menu.p.id) === c} onClick={() => save({ ...prefs, colors: { ...prefs.colors, [menu.p.id]: c } })} />)}</div>
          <div className="hr" />
          <button type="button" role="menuitem" className="it" onClick={() => { const id = menu.p.id; setMenu(null); if (active === id) onPick(null); save({ ...prefs, hidden: [...prefs.hidden.filter((x) => x !== id), id], pins: prefs.pins.filter((x) => x !== id) }); toast('Tab hidden. Find it again with ⌕.'); }}>◌ Hide tab</button>
          <button type="button" role="menuitem" className="it" onClick={() => { const c = colourOf(prefs, projects, menu.p.id); setMenu(null); window.dispatchEvent(new CustomEvent('ps4-colour', { detail: [c] })); }}>Filter to this colour</button>
        </Floating>
      )}
      {finder && <Finder anchor={finder} projects={projects} prefs={prefs} counts={counts} onClose={() => setFinder(null)}
        onPick={(id) => { setFinder(null); if (prefs.hidden.includes(id)) save({ ...prefs, hidden: prefs.hidden.filter((x) => x !== id) }); onPick(id); }} />}
    </div>
  );
}

function RenameInput({ value, onDone }: { value: string; onDone: (v: string | null) => void }) {
  const [v, setV] = useState(value);
  return <input autoFocus className="ps4-rename" aria-label="Tab name" value={v} maxLength={60} onChange={(e) => setV(e.target.value)} onClick={(e) => e.stopPropagation()}
    onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') onDone(v.trim() || null); else if (e.key === 'Escape') onDone(null); }} onBlur={() => onDone(v.trim() && v.trim() !== value ? v.trim() : null)} />;
}

/** ⌕: find any project (hidden ones too) by name or key, narrowed by colour. */
function Finder({ anchor, projects, prefs, counts, onClose, onPick }: {
  anchor: HTMLElement; projects: SheetRow[]; prefs: TabPrefs; counts: Map<string, number>; onClose: () => void; onPick: (id: string) => void;
}) {
  const [q, setQ] = useState('');
  const [col, setCol] = useState<Colour | null>(null);
  const [hi, setHi] = useState(0);
  const list = projects.filter((p) => (!col || colourOf(prefs, projects, p.id) === col)
    && (!q.trim() || `${p.title} ${p.key} ${prefs.names[p.id] ?? ''}`.toLowerCase().includes(q.trim().toLowerCase()))).slice(0, 8);
  return (
    <Floating anchor={anchor} onClose={onClose} width={340} label="Find a project" style={{ padding: 10 }}>
      <div className="ps3-cmd focus" style={{ height: 36 }}><span className="ic" aria-hidden="true">⌕</span>
        <input autoFocus aria-label="Project name or key" placeholder="Project name or key" value={q} onChange={(e) => { setQ(e.target.value); setHi(0); }}
          onKeyDown={(e) => { if (e.key === 'ArrowDown') { e.preventDefault(); setHi((x) => Math.min(list.length - 1, x + 1)); } else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((x) => Math.max(0, x - 1)); } else if (e.key === 'Enter' && list[hi]) onPick(list[hi].id); }} /></div>
      <div className="ps4-fcol"><div className="ps4-pal" role="group" aria-label="Filter by colour">{COLOURS.map((c) => <button key={c} type="button" className={`pc-${c} ${col === c ? 'on' : ''}`} aria-label={COLOUR_LABEL[c]} aria-pressed={col === c} onClick={() => setCol(col === c ? null : c)} />)}</div>
        <span className="ps3-sp" /><span className="ps3-dim" style={{ fontSize: 12 }}>Filter by colour</span></div>
      {list.length === 0 && <div className="it ps3-dim">No project matches</div>}
      {list.map((p, i) => <button key={p.id} type="button" className={`it pc-${colourOf(prefs, projects, p.id)} ${i === hi ? 'on' : ''}`} onMouseEnter={() => setHi(i)} onClick={() => onPick(p.id)}>
        <b className="ps4-sq" aria-hidden="true" /><span style={{ flex: 1, minWidth: 0 }}>{prefs.names[p.id] || p.title}<span className="ps3-dim" style={{ display: 'block', fontSize: 11.5 }}>{p.key} · {counts.get(p.id) ?? 0} tasks{prefs.pins.includes(p.id) ? ' · 📌' : ''}{prefs.hidden.includes(p.id) ? ' · hidden' : ''}</span></span>
        {i === hi && <span aria-hidden="true">↵</span>}</button>)}
    </Floating>
  );
}

/** The colour multi-filter beside the command field: a swatch per colour, "2 on" and ✕. */
export function ColourFilter({ on, set }: { on: Colour[]; set: (c: Colour[]) => void }) {
  return (
    <div className="ps4-sw" role="group" aria-label="Filter projects by colour"><span>Colours</span>
      {COLOURS.map((c) => <button key={c} type="button" className={`pc-${c} ${on.includes(c) ? 'on' : ''}`} aria-label={COLOUR_LABEL[c]} aria-pressed={on.includes(c)}
        onClick={() => set(on.includes(c) ? on.filter((x) => x !== c) : [...on, c])} />)}
      {on.length > 0 && <><b>{on.length} on</b><button type="button" className="x" aria-label="Clear the colour filter" onClick={() => set([])}>✕</button></>}
    </div>
  );
}

