import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { get, put } from '../api/client';
import { useAuth } from '../stores/auth';
import { navKey, inSidebar, type NavDef, type NavGroup } from './navigation';

/**
 * The person's own sidebar: the order inside each section, the places they pinned to the top, the ones they hid and the sections they
 * folded away. Saved with their account (`/me/ui/sidebar`) so it is the same on every device; a copy on this device paints it at once
 * while the account copy loads.
 */
export interface NavPrefs { version: 1; order: Record<string, string[]>; pinned: string[]; hidden: string[]; collapsed: string[] }
export const EMPTY_PREFS: NavPrefs = { version: 1, order: {}, pinned: [], hidden: [], collapsed: [] };
export const PINNED = 'Pinned';

const localKey = (uid: string) => `pm_sidebar_${uid}`;
const readLocal = (uid: string): NavPrefs | null => { try { const v = localStorage.getItem(localKey(uid)); return v ? normalize(JSON.parse(v)) : null; } catch { return null; } };
const writeLocal = (uid: string, p: NavPrefs) => { try { localStorage.setItem(localKey(uid), JSON.stringify(p)); } catch { /* storage unavailable */ } };

const strings = (v: unknown, max = 60): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length <= 120).slice(0, max) : []);
export function normalize(v: unknown): NavPrefs {
  if (!v || typeof v !== 'object') return EMPTY_PREFS;
  const o = v as Record<string, unknown>;
  const order: Record<string, string[]> = {};
  if (o.order && typeof o.order === 'object') for (const [k, list] of Object.entries(o.order as Record<string, unknown>).slice(0, 12)) order[k] = strings(list);
  return { version: 1, order, pinned: strings(o.pinned, 12), hidden: strings(o.hidden), collapsed: strings(o.collapsed, 12) };
}

export function useNavPrefs() {
  const uid = useAuth((s) => s.ctx?.user.id) ?? '';
  const client = useQueryClient();
  const remote = useQuery({
    queryKey: ['ui', 'sidebar', uid], enabled: !!uid, staleTime: 5 * 60_000,
    queryFn: async () => normalize((await get<{ value: unknown }>('/me/ui/sidebar')).value),
  });
  const [prefs, setPrefs] = useState<NavPrefs>(() => (uid && readLocal(uid)) || EMPTY_PREFS);
  const dirty = useRef(false);
  // The account copy wins once it arrives (unless the person changed something in the meantime).
  useEffect(() => { if (remote.data && !dirty.current) { setPrefs(remote.data); writeLocal(uid, remote.data); } }, [remote.data, uid]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const update = useCallback((change: (p: NavPrefs) => NavPrefs) => {
    setPrefs((current) => {
      const next = change(current);
      dirty.current = true;
      writeLocal(uid, next);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        const blank = !next.pinned.length && !next.hidden.length && !next.collapsed.length && !Object.keys(next.order).length;
        void put('/me/ui/sidebar', { value: blank ? null : next }).then(() => { dirty.current = false; client.setQueryData(['ui', 'sidebar', uid], next); }).catch(() => { /* kept on this device; saved next time */ });
      }, 500);
      return next;
    });
  }, [uid, client]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return { prefs, update, reset: () => update(() => EMPTY_PREFS) };
}

export interface NavSection { title: string; items: NavDef[]; collapsed: boolean; pinned?: boolean }

/** The sections as this person arranged them. With `editing`, hidden places stay in the list (to be shown again). */
export function arrange(groups: NavGroup[], prefs: NavPrefs, editing: boolean): NavSection[] {
  const all = groups.flatMap((g) => g.items.filter(inSidebar));
  const byKey = new Map(all.map((i) => [navKey(i), i]));
  const hidden = new Set(prefs.hidden);
  const pinnedKeys = prefs.pinned.filter((k) => byKey.has(k));
  const pinned = new Set(pinnedKeys);
  const sections: NavSection[] = [];
  if (pinnedKeys.length) sections.push({ title: PINNED, pinned: true, collapsed: prefs.collapsed.includes(PINNED), items: pinnedKeys.map((k) => byKey.get(k)!) });
  for (const g of groups) {
    const items = g.items.filter(inSidebar).filter((i) => !pinned.has(navKey(i)) && (editing || !hidden.has(navKey(i))));
    if (!items.length) continue;
    const saved = prefs.order[g.title] ?? [];
    const rank = (i: NavDef) => { const at = saved.indexOf(navKey(i)); return at < 0 ? saved.length + items.indexOf(i) : at; };
    sections.push({ title: g.title, collapsed: prefs.collapsed.includes(g.title), items: [...items].sort((a, b) => rank(a) - rank(b)) });
  }
  return sections;
}

/** Moves one place inside its section (or inside Pinned). */
export function moved(prefs: NavPrefs, section: NavSection, from: string, to: string): NavPrefs {
  const keys = section.items.map(navKey);
  const a = keys.indexOf(from), b = keys.indexOf(to);
  if (a < 0 || b < 0 || a === b) return prefs;
  const next = [...keys];
  next.splice(b, 0, next.splice(a, 1)[0]);
  if (section.pinned) return { ...prefs, pinned: next };
  return { ...prefs, order: { ...prefs.order, [section.title]: next } };
}

export const toggle = (list: string[], key: string) => (list.includes(key) ? list.filter((k) => k !== key) : [...list, key]);

/** The pinned places, for the phone's tab bar (it offers the person's own pins first). */
export function usePinned(groups: NavGroup[]): NavDef[] {
  const { prefs } = useNavPrefs();
  return useMemo(() => {
    const all = groups.flatMap((g) => g.items.filter(inSidebar));
    return prefs.pinned.map((k) => all.find((i) => navKey(i) === k)).filter((i): i is NavDef => !!i);
  }, [groups, prefs.pinned]);
}
