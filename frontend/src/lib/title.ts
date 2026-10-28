/**
 * The browser tab's title: "(3) Acme Bank · Project Tracker" - the unread chat messages first, so they show even from another tab, then the
 * organization (so tabs of different organizations can be told apart). A leading alarm mark set by the reminders is kept.
 */
import { useEffect } from 'react';

let org: string | null = null;
let unread = 0;
/** The Notification Centre's badge (unread notifications, messages included): when known it is the number in the title. */
let badge: number | null = null;
let page: string | null = null;

function render() {
  if (document.documentElement.classList.contains('landing')) return;   // the public page keeps its own title
  const alarm = document.title.startsWith('⏰ ');
  const base = org ? `${org} · Project Tracker` : page ? `${page} | Project Tracker` : 'Project Tracker';
  const n = badge ?? unread;
  document.title = `${alarm ? '⏰ ' : ''}${n > 0 ? `(${n > 99 ? '99+' : n}) ` : ''}${base}`;
}

export function setTitleParts(parts: { org?: string | null; unread?: number; badge?: number | null }) {
  if ('org' in parts) org = parts.org ?? null;
  if ('badge' in parts) badge = parts.badge ?? null;
  if ('unread' in parts) unread = parts.unread ?? 0;
  render();
}

/** The tab title of a public screen (Sign in, Create account ...): "Sign in | Project Tracker", as a search result and a bookmark show it. */
export function usePageTitle(title: string) {
  useEffect(() => { page = title; render(); return () => { page = null; }; }, [title]);
}
