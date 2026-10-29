/** What the Notification Centre needs to know about a notification: its category, its source (for stacking), its icon, tint and sound. */
import type { AppNotification, NotificationCategory, NotificationCounts, NotificationType } from '../../../api/types';
import type { Cue } from '../../../lib/attention';
import type { IconName } from '../../../components/Icon';
import type { AlertPrefs } from './prefs';
import { CATEGORIES } from './prefs';

const MESSAGE_TYPES = new Set<NotificationType>(['Message', 'Mention', 'Call'] as NotificationType[]);
const REMINDER_TYPES = new Set<NotificationType>(['Reminder', 'Nudge', 'DueSoon', 'Overdue', 'TimesheetReminder', 'CertificationExpiry'] as NotificationType[]);
const isMeetingLink = (l: string | null | undefined) => !!l && (l.startsWith('/calls/meeting/') || l.startsWith('/meet?open='));

/** The server says which category; older answers do not, so the same split is worked out here. */
export function categoryOf(n: Pick<AppNotification, 'type' | 'link' | 'category'>): NotificationCategory {
  if (n.category) return n.category;
  if (n.type === 'Meeting' || (n.type === 'Reminder' && isMeetingLink(n.link))) return 'meetings';
  if (MESSAGE_TYPES.has(n.type)) return 'messages';
  if (REMINDER_TYPES.has(n.type)) return 'reminders';
  return 'work';
}

export const FILTERS: { id: NotificationCategory | 'all'; label: string; short: string }[] = [
  { id: 'all', label: 'All', short: 'All' },
  { id: 'messages', label: 'Mentions & messages', short: 'Messages' },
  { id: 'reminders', label: 'Reminders', short: 'Reminders' },
  { id: 'meetings', label: 'Meetings', short: 'Meetings' },
  { id: 'work', label: 'Work', short: 'Work' },
];

export const CATEGORY_META: Record<NotificationCategory, { label: string; icon: IconName; tint: string }> = {
  messages: { label: 'Messages', icon: 'message', tint: 'green' },
  reminders: { label: 'Reminders', icon: 'alarm', tint: 'orange' },
  meetings: { label: 'Meetings', icon: 'video', tint: 'indigo' },
  work: { label: 'Work', icon: 'checkCircle', tint: 'blue' },
};

const TYPE_ICON: Partial<Record<NotificationType, IconName>> = {
  Mention: 'message', Message: 'message', Call: 'phone', Reminder: 'alarm', Nudge: 'hand', DueSoon: 'clock', Overdue: 'alert', Meeting: 'video',
  TaskAssigned: 'checkCircle', Comment: 'message', Approval: 'checks', Security: 'shield', ServiceLevel: 'gauge', Support: 'target', Document: 'note',
  Issue: 'bug', ReportReady: 'chart', TimesheetReminder: 'timer', Invitation: 'userPlus', ProjectUpdated: 'folder', TaskUpdated: 'edit',
};
export const iconOf = (n: AppNotification): IconName => (n.type === 'Reminder' && isMeetingLink(n.link) ? 'video' : TYPE_ICON[n.type] ?? 'bell');

const CRITICAL = new Set<NotificationType>(['ServiceLevel', 'Security', 'Support', 'Overdue'] as NotificationType[]);
/** Which sound a notification gets. */
export function cueOf(n: Pick<AppNotification, 'type' | 'link' | 'category'>): Cue {
  if (CRITICAL.has(n.type)) return 'critical';
  if (n.type === 'Mention') return 'mention';
  const c = categoryOf(n);
  return c === 'messages' ? 'message' : c === 'meetings' ? 'meeting' : c === 'reminders' ? 'reminder' : 'message';
}

/** The conversation a message notification is about (direct and group chats: /chat/{id}). */
export const conversationOf = (link: string | null | undefined) => /^\/chat\/([0-9a-f-]{36})(?:[?#].*)?$/i.exec(link ?? '')?.[1] ?? null;

/**
 * Where it comes from, for stacking like Apple's Notification Centre: one conversation, one project, one ticket queue; otherwise the
 * category. The title says it best for messages ("Asha in #MuleSoft Support"), so a group chat's name is taken from there.
 */
export function sourceOf(n: AppNotification): { key: string; label: string } {
  const cat = categoryOf(n);
  const conv = conversationOf(n.link);
  if (conv) {
    const inName = / in (.+)$/.exec(n.title)?.[1];
    return { key: `chat:${conv}`, label: inName ?? n.title.replace(/ (mentioned you|replied).*$/, '') };
  }
  const project = /^\/projects\/([0-9a-f-]{36})/i.exec(n.link ?? '')?.[1];
  if (project) return { key: `project:${project}`, label: / on ([A-Z][A-Z0-9]+-\d+)/.exec(n.title)?.[1]?.replace(/-\d+$/, '') ?? 'Project' };
  if ((n.link ?? '').startsWith('/operations') || (n.link ?? '').startsWith('/desk')) return { key: 'desk', label: 'Desk' };
  return { key: `cat:${cat}`, label: CATEGORY_META[cat].label };
}

export interface Stack { key: string; label: string; items: AppNotification[]; unread: number }
export interface Section { id: 'today' | 'earlier'; label: string; stacks: Stack[] }

const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
const when = (n: AppNotification) => Date.parse(n.shownAt ?? n.createdAt);

/** Today and Earlier, each made of stacks by source, newest first (a stack sits where its newest notification is). */
export function arrange(items: AppNotification[], today = startOfToday()): Section[] {
  const sections: Section[] = [{ id: 'today', label: 'Today', stacks: [] }, { id: 'earlier', label: 'Earlier', stacks: [] }];
  const index = new Map<string, Stack>();
  for (const n of [...items].sort((a, b) => when(b) - when(a))) {
    const sec = when(n) >= today ? sections[0] : sections[1];
    const src = sourceOf(n);
    const k = `${sec.id}|${src.key}`;
    let s = index.get(k);
    if (!s) { s = { key: k, label: src.label, items: [], unread: 0 }; index.set(k, s); sec.stacks.push(s); }
    s.items.push(n);
    if (!n.isRead) s.unread += 1;
  }
  return sections.filter((s) => s.stacks.length > 0);
}

/** The number on the bell, the app icon and the tab: unread in the categories whose badge is on. */
export function badgeCount(c: NotificationCounts | undefined, prefs: AlertPrefs): number {
  if (!c) return 0;
  const split = CATEGORIES.map((k) => c[k]);
  if (split.some((v) => typeof v !== 'number')) return c.unread;   // an older server: everything
  return CATEGORIES.reduce((sum, k) => sum + (prefs.cats[k].badge ? (c[k] ?? 0) : 0), 0);
}

/**
 * The one total for the bell, the tab title, the app icon and the desktop app (docs/badges.md). Its message part is the Messages badge's
 * own number (unread chat messages), so the two never disagree; notices that are not in that number (project-chat mentions, thread replies)
 * still count when there are more of them than chat messages.
 */
export function totalBadge(c: NotificationCounts | undefined, prefs: AlertPrefs, chatUnread: number): number {
  const chat = Math.max(0, chatUnread);
  if (!c) return prefs.cats.messages.badge ? chat : 0;
  const split = CATEGORIES.map((k) => c[k]);
  if (split.some((v) => typeof v !== 'number')) return Math.max(c.unread, chat);
  const rest = CATEGORIES.reduce((sum, k) => sum + (k !== 'messages' && prefs.cats[k].badge ? (c[k] ?? 0) : 0), 0);
  return rest + (prefs.cats.messages.badge ? Math.max(c.messages ?? 0, chat) : 0);
}

export const badgeText = (n: number) => (n > 99 ? '99+' : String(n));

/** Short time like Apple's: "now", "4m", "2h", "Yesterday", "Mon", "12 Oct". */
export function shortTime(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  const mins = Math.floor((now - t) / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const d = new Date(t);
  if (t >= startOfToday()) return `${Math.floor(mins / 60)}h`;
  const y = startOfToday() - 86_400_000;
  if (t >= y) return 'Yesterday';
  if (now - t < 6 * 86_400_000) return d.toLocaleDateString(undefined, { weekday: 'short' });
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** Join is offered from ten minutes before the start until the meeting is an hour old. */
export const canJoin = (n: AppNotification, now = Date.now()) =>
  !!n.joinLink && !!n.startsAt && Date.parse(n.startsAt) - now <= 10 * 60_000 && now - Date.parse(n.startsAt) <= 60 * 60_000;

/** Snooze: 15 minutes, an hour, tomorrow at 9:00 (this device's clock). "Pick a time" is chosen in the menu. */
export function snoozePresets(now = new Date()): { label: string; until: Date }[] {
  const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(9, 0, 0, 0);
  return [
    { label: '15 minutes', until: new Date(now.getTime() + 15 * 60_000) },
    { label: '1 hour', until: new Date(now.getTime() + 60 * 60_000) },
    { label: 'Tomorrow 9:00', until: tomorrow },
  ];
}
