import { useEffect } from 'react';

/**
 * How far into each document this person has read, kept on this device only (nothing is sent anywhere): the furthest point scrolled to,
 * 0..1. Library's Continue shelf draws it under each cover.
 */
const KEY = 'pt-doc-progress';
const MAX = 60;

type Store = Record<string, { p: number; at: number }>;

function load(): Store {
  try { const v = JSON.parse(localStorage.getItem(KEY) ?? '{}') as unknown; return v && typeof v === 'object' ? v as Store : {}; } catch { return {}; }
}

export function readingProgress(id: string): number | null {
  const v = load()[id];
  return v && Number.isFinite(v.p) ? Math.max(0, Math.min(1, v.p)) : null;
}

function save(id: string, p: number) {
  try {
    const s = load();
    if ((s[id]?.p ?? 0) >= p && s[id]) { s[id].at = Date.now(); } else s[id] = { p, at: Date.now() };
    const keep = Object.entries(s).sort((a, b) => b[1].at - a[1].at).slice(0, MAX);
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(keep)));
  } catch { /* storage unavailable */ }
}

/** Records the reading position of document `id` from whichever element scrolls the page. */
export function useReadingProgress(id: string) {
  useEffect(() => {
    if (!id) return;
    save(id, 0);
    let t = 0;
    const on = (e: Event) => {
      const el = (e.target instanceof Element ? e.target : document.scrollingElement) as Element | null;
      if (!el || el.scrollHeight - el.clientHeight < 200) return;
      const p = (el.scrollTop + el.clientHeight * 0.25) / (el.scrollHeight - el.clientHeight);
      window.clearTimeout(t);
      t = window.setTimeout(() => save(id, Math.min(1, p)), 300);
    };
    document.addEventListener('scroll', on, { capture: true, passive: true });
    return () => { window.clearTimeout(t); document.removeEventListener('scroll', on, { capture: true }); };
  }, [id]);
}
