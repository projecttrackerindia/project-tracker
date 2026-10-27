import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQueryClient } from '@tanstack/react-query';
import { get, put } from '../../api/client';
import { useWsQuery } from '../../lib/hooks';
import { useAuth } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { Icon, type IconName } from '../Icon';
import '../../features/talk/dots.css';

/**
 * Sidebar project pins, per person per workspace. Saved with the account (/me/ui/pins, one object keyed by workspace id) so they follow
 * the person to every device, and mirrored in localStorage so they still work if that store is unreachable.
 * `pinned`: explicit pins in order (at most 8). `hidden`: recent projects the person unpinned, so they do not come straight back.
 */
export const MAX_PINS = 8;
const MAX_HIDDEN = 30;
export interface WsPins { pinned: string[]; hidden: string[] }
type AllPins = Record<string, WsPins>;

const localKey = (wid: string) => `pt_pins:${wid}`;
const clean = (v: unknown): WsPins => {
  const o = (v && typeof v === 'object' ? v : {}) as Partial<WsPins>;
  const ids = (a: unknown) => (Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string') : []);
  return { pinned: ids(o.pinned).slice(0, MAX_PINS), hidden: ids(o.hidden).slice(0, MAX_HIDDEN) };
};
function readLocal(wid: string): WsPins | null {
  try { const raw = localStorage.getItem(localKey(wid)); return raw ? clean(JSON.parse(raw)) : null; } catch { return null; }
}
function writeLocal(wid: string, p: WsPins) { try { localStorage.setItem(localKey(wid), JSON.stringify(p)); } catch { /* storage blocked */ } }

const KEY = ['ui', 'pins'];
async function loadAll(): Promise<AllPins | null> {
  try { const r = await get<{ value: AllPins | null }>('/me/ui/pins'); return r?.value ?? {}; } catch { return null; }
}

export function usePins() {
  const wid = useAuth((s) => s.ctx?.current?.id) ?? '';
  const qc = useQueryClient();
  const q = useWsQuery(KEY, loadAll, { staleTime: 5 * 60_000, retry: false });
  const server = q.data && q.data[wid] ? clean(q.data[wid]) : null;
  const mine: WsPins = server ?? readLocal(wid) ?? { pinned: [], hidden: [] };

  const save = (next: WsPins) => {
    writeLocal(wid, next);
    const all: AllPins = { ...(q.data ?? {}), [wid]: next };
    qc.setQueryData([wid, ...KEY], all);
    // Only once the account copy loaded, so other workspaces' pins are never overwritten; until then the device copy holds it.
    if (q.data) void put('/me/ui/pins', { value: all }).catch(() => toast('Could not save your pins to your account; they are kept on this device.', 'info'));
  };
  const pin = (id: string) => {
    if (mine.pinned.includes(id)) return;
    if (mine.pinned.length >= MAX_PINS) { toast(`You can pin up to ${MAX_PINS} projects. Unpin one first.`, 'info'); return; }
    save({ pinned: [...mine.pinned, id], hidden: mine.hidden.filter((x) => x !== id) });
  };
  const unpin = (id: string) => save({ pinned: mine.pinned.filter((x) => x !== id), hidden: [id, ...mine.hidden.filter((x) => x !== id)].slice(0, MAX_HIDDEN) });
  const move = (id: string, to: number) => {
    const rest = mine.pinned.filter((x) => x !== id);
    rest.splice(Math.max(0, Math.min(to, rest.length)), 0, id);
    save({ ...mine, pinned: rest });
  };
  return { pinned: mine.pinned, hidden: mine.hidden, isPinned: (id: string) => mine.pinned.includes(id), pin, unpin, move };
}

/** The menu item for a project's ··· menu or right-click menu. */
export function pinItem(pins: ReturnType<typeof usePins>, id: string): CtxItem {
  const on = pins.isPinned(id);
  return { label: on ? 'Unpin from sidebar' : 'Pin to sidebar', icon: on ? 'pinOff' : 'pin', onSelect: () => (on ? pins.unpin(id) : pins.pin(id)) };
}

export interface CtxItem { label: string; icon?: IconName; onSelect: () => void; danger?: boolean }

/** A small right-click menu at the pointer (same look as ···). Closes on choosing, a click outside, scroll and Escape. */
export function useContextMenu() {
  const [at, setAt] = useState<{ x: number; y: number; items: CtxItem[] } | null>(null);
  const ref = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (!at) return;
    const away = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setAt(null); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setAt(null); };
    const close = () => setAt(null);
    document.addEventListener('mousedown', away); document.addEventListener('keydown', esc); window.addEventListener('scroll', close, true); window.addEventListener('resize', close);
    ref.current?.querySelector<HTMLElement>('button')?.focus();
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); window.removeEventListener('scroll', close, true); window.removeEventListener('resize', close); };
  }, [at]);
  const open = (e: { clientX: number; clientY: number; preventDefault: () => void }, items: CtxItem[]) => {
    e.preventDefault();
    setAt({ x: Math.min(e.clientX, window.innerWidth - 250), y: Math.min(e.clientY, window.innerHeight - 20 - items.length * 40), items });
  };
  const menu = at ? createPortal(
    <ul ref={ref} className="v2-dots-list v2-ctx" role="menu" aria-label="Project actions" style={{ position: 'fixed', left: at.x, top: at.y, zIndex: 1200 }}>
      {at.items.map((i) => (
        <li key={i.label} role="none">
          <button type="button" role="menuitem" className={i.danger ? 'danger' : ''} onClick={() => { setAt(null); i.onSelect(); }}>
            {i.icon && <Icon name={i.icon} size={15} />}<span><b>{i.label}</b></span>
          </button>
        </li>
      ))}
    </ul>,
    document.body,
  ) : null;
  return { open, menu };
}
