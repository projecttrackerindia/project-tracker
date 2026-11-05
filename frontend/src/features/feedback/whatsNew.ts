/** The "What's new" changelog (whats-new.md), parsed: releases newest first, each with its changes. */
export interface Release { version: string; name: string; items: { title: string; text: string }[] }

export function parseChangelog(md: string): Release[] {
  const out: Release[] = [];
  for (const raw of md.replace(/<!--[\s\S]*?-->/g, '').split('\n')) {
    const line = raw.trim();
    const head = /^##\s+([^·]+?)(?:\s*·\s*(.+))?$/.exec(line);
    if (head) { out.push({ version: head[1].trim(), name: (head[2] ?? '').trim(), items: [] }); continue; }
    const item = /^[-*]\s+(?:\*\*(.+?)\*\*\s*(?:[—–-]\s*)?)?(.*)$/.exec(line);
    if (item && out.length) out[out.length - 1].items.push({ title: (item[1] ?? '').trim(), text: item[2].trim() });
  }
  return out.filter((r) => r.items.length > 0);
}

const SEEN = 'pt_whats_new_seen';
export const seenVersion = (): string | null => { try { return localStorage.getItem(SEEN); } catch { return null; } };
export const markSeen = (v: string) => { try { localStorage.setItem(SEEN, v); } catch { /* storage unavailable: it may show again */ } };

/**
 * Whether to show the note now: once per release, and never to someone opening the app for the first time on this device (there is nothing
 * "new" to them yet; the release is just marked seen).
 */
export function shouldShow(latest: string | undefined, seen: string | null): 'show' | 'mark' | 'none' {
  if (!latest) return 'none';
  if (seen === null) return 'mark';
  return seen === latest ? 'none' : 'show';
}
