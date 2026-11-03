/**
 * Which sidebar place a notification belongs to, and the one number each place shows (docs/badges.md has the table). The server counts the
 * same way (NotificationDestinations in NotificationService.cs) and sends `counts.tabs` = unread per "destination:category"; every
 * notification lands on exactly one place, so the places add up to the bell, the tab title "(3)", the app icon and the dock / taskbar.
 */
import type { NotificationCategory, NotificationCounts, NotificationType } from '../../../api/types';
import type { AlertPrefs } from './prefs';
import { CATEGORIES } from './prefs';

export type Destination = 'today' | 'work' | 'desk' | 'portfolio' | 'calendar' | 'meetings' | 'messages' | 'mail' | 'library' | 'approvals';
export const DESTINATIONS: Destination[] = ['today', 'work', 'desk', 'portfolio', 'calendar', 'meetings', 'messages', 'mail', 'library', 'approvals'];

/** The sidebar item (Rail.tsx `key`) each destination's badge sits on. */
export const SIDEBAR_KEY: Record<Destination, string> = {
  today: 'home', work: 'work', desk: 'desk', portfolio: 'portfolio', calendar: 'calendar', meetings: 'meetings', messages: 'talk', mail: 'mail', library: 'library', approvals: 'approvals',
};

const starts = (l: string | null | undefined, p: string) => !!l && l.toLowerCase().startsWith(p);
const isMeetingLink = (l: string | null | undefined) => starts(l, '/calls/meeting/') || starts(l, '/meet?open=') || starts(l, '/meetings?open=');

/** The same rules as the server's NotificationDestinations.Of (keep the two in step; tabBadges.test.ts pins them). */
export function destinationOf(type: NotificationType | string, link: string | null | undefined): Destination {
  if (type === 'Meeting' || (type === 'Reminder' && isMeetingLink(link))) return 'meetings';
  if (starts(link, '/mail')) return 'mail';
  if (starts(link, '/?tab=calendar') || starts(link, '/calendar')) return 'calendar';
  if (starts(link, '/approvals')) return 'approvals';
  if (type === 'Message' || type === 'Call') return 'messages';
  if (type === 'Mention' && (starts(link, '/chat/') || starts(link, '/messages') || (link ?? '').includes('chat=1'))) return 'messages';
  if (type === 'Document' || starts(link, '/documents') || starts(link, '/library')) return 'library';
  if (type === 'PortfolioDigest' || starts(link, '/portfolio') || (link ?? '').includes('view=portfolio')) return 'portfolio';
  if (type === 'ServiceLevel' || type === 'Support' || starts(link, '/desk') || starts(link, '/operations')) return 'desk';
  if (['TaskAssigned', 'TaskUpdated', 'Comment', 'Mention', 'Issue', 'ProjectUpdated'].includes(type)) return 'work';
  return 'today';
}

export const tabKey = (d: Destination, c: NotificationCategory) => `${d}:${c}`;

/** An older server sends no `tabs`: each category goes to its natural place. */
const FALLBACK: Record<NotificationCategory, Destination> = { messages: 'messages', meetings: 'meetings', reminders: 'today', work: 'work' };

export type TabCounts = Record<Destination, number>;
const zero = (): TabCounts => ({ today: 0, work: 0, desk: 0, portfolio: 0, calendar: 0, meetings: 0, messages: 0, mail: 0, library: 0, approvals: 0 });

/**
 * The red number on each place. Messages is the Messages badge's own number (unread chat messages, docs/badges.md) when that is higher than
 * its notices (one notice per conversation), so the sidebar, the bell and the title agree. A category whose Badge switch is off here adds
 * nothing anywhere.
 */
export function tabCounts(c: NotificationCounts | undefined, prefs: AlertPrefs, chatUnread: number): TabCounts {
  const out = zero();
  const chat = Math.max(0, chatUnread);
  if (c?.tabs) {
    for (const [k, v] of Object.entries(c.tabs)) {
      const [d, cat] = k.split(':') as [Destination, NotificationCategory];
      if (!(d in out) || !CATEGORIES.includes(cat) || !prefs.cats[cat].badge) continue;
      out[d] += Math.max(0, v);
    }
  } else if (c && CATEGORIES.every((k) => typeof c[k] === 'number')) {
    for (const k of CATEGORIES) if (prefs.cats[k].badge) out[FALLBACK[k]] += c[k] ?? 0;
  } else if (c) {
    out.today = Math.max(0, c.unread, chat);   // a very old server: one number, on Today
    return out;
  }
  if (prefs.cats.messages.badge) out.messages = Math.max(out.messages, chat);
  return out;
}

export const sumTabs = (t: TabCounts) => DESTINATIONS.reduce((n, d) => n + t[d], 0);

/** Takes read (or deleted) notifications off `tabs` at once, before the server answers. `delta` is keyed like `tabs`, negative to remove. */
export function applyTabDelta(tabs: Record<string, number> | undefined, delta: Record<string, number>): Record<string, number> | undefined {
  if (!tabs) return tabs;
  const next = { ...tabs };
  for (const [k, d] of Object.entries(delta)) next[k] = Math.max(0, (next[k] ?? 0) + d);
  return next;
}

/** Mark-all-read of one category (or all): those keys go to zero. */
export function clearTabs(tabs: Record<string, number> | undefined, cat: NotificationCategory | 'all'): Record<string, number> | undefined {
  if (!tabs) return tabs;
  return Object.fromEntries(Object.entries(tabs).map(([k, v]) => [k, cat === 'all' || k.endsWith(`:${cat}`) ? 0 : v]));
}
