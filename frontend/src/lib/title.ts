/**
 * The browser tab's title: "(3) Acme Bank · Project Tracker" - the unread chat messages first, so they show even from another tab, then the
 * organization (so tabs of different organizations can be told apart). A leading alarm mark set by the reminders is kept.
 */
let org: string | null = null;
let unread = 0;

function render() {
  const alarm = document.title.startsWith('⏰ ');
  const base = `${org ? `${org} · ` : ''}Project Tracker`;
  document.title = `${alarm ? '⏰ ' : ''}${unread > 0 ? `(${unread > 99 ? '99+' : unread}) ` : ''}${base}`;
}

export function setTitleParts(parts: { org?: string | null; unread?: number }) {
  if ('org' in parts) org = parts.org ?? null;
  if ('unread' in parts) unread = parts.unread ?? 0;
  render();
}
