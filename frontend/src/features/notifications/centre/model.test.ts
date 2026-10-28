import { describe, expect, it } from 'vitest';
import type { AppNotification } from '../../../api/types';
import { arrange, badgeCount, canJoin, categoryOf, cueOf, sourceOf } from './model';
import { DEFAULT_PREFS, isMuted, muteUntil } from './prefs';

const N = (id: string, type: string, link: string | null, minsAgo: number, extra: Partial<AppNotification> = {}): AppNotification =>
  ({ id, type, title: `${id} title`, body: null, link, isRead: false, createdAt: new Date(Date.now() - minsAgo * 60_000).toISOString(), browser: false, ...extra }) as AppNotification;

describe('notification centre model', () => {
  it('splits categories like the server, meeting reminders included', () => {
    expect(categoryOf(N('a', 'Message', '/chat/x', 1))).toBe('messages');
    expect(categoryOf(N('b', 'Reminder', '/calls/meeting/w/1', 1))).toBe('meetings');
    expect(categoryOf(N('c', 'Reminder', '/r/tok', 1))).toBe('reminders');
    expect(categoryOf(N('d', 'TaskAssigned', '/my-work', 1))).toBe('work');
    expect(categoryOf(N('e', 'Comment', null, 1, { category: 'meetings' }))).toBe('meetings');
  });

  it('gives each kind its own sound', () => {
    expect(cueOf(N('a', 'Mention', null, 1))).toBe('mention');
    expect(cueOf(N('b', 'Message', '/chat/x', 1))).toBe('message');
    expect(cueOf(N('c', 'Reminder', '/meet?open=w:1', 1))).toBe('meeting');
    expect(cueOf(N('d', 'Reminder', null, 1))).toBe('reminder');
    expect(cueOf(N('e', 'ServiceLevel', null, 1))).toBe('critical');
  });

  it('stacks by conversation within Today and Earlier', () => {
    const conv = '/chat/11111111-1111-1111-1111-111111111111';
    const secs = arrange([N('a', 'Message', conv, 1, { title: 'Ravi in #MuleSoft Support' }), N('b', 'Message', conv, 3, { title: 'Meena in #MuleSoft Support' }),
      N('c', 'TaskAssigned', '/my-work', 2), N('d', 'Message', conv, 60 * 48)]);
    expect(secs.map((s) => s.id)).toEqual(['today', 'earlier']);
    expect(secs[0].stacks[0].items.map((n) => n.id)).toEqual(['a', 'b']);
    expect(secs[0].stacks[0].label).toBe('#MuleSoft Support');
    expect(secs[0].stacks[0].unread).toBe(2);
    expect(sourceOf(N('x', 'Comment', '/operations?task=1', 1)).label).toBe('Desk');
  });

  it('counts the badge over the categories whose badge is on', () => {
    const c = { unread: 9, needsYou: 9, forInfo: 0, messages: 4, reminders: 2, meetings: 1, work: 2 };
    expect(badgeCount(c, DEFAULT_PREFS)).toBe(9);
    expect(badgeCount(c, { ...DEFAULT_PREFS, cats: { ...DEFAULT_PREFS.cats, messages: { ...DEFAULT_PREFS.cats.messages, badge: false } } })).toBe(5);
    expect(badgeCount({ unread: 3, needsYou: 3, forInfo: 0 }, DEFAULT_PREFS)).toBe(3);   // an older server
  });

  it('offers Join from ten minutes before a meeting', () => {
    const at = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
    expect(canJoin(N('a', 'Reminder', null, 0, { startsAt: at(9), joinLink: '/calls/meeting/1' }))).toBe(true);
    expect(canJoin(N('b', 'Reminder', null, 0, { startsAt: at(30), joinLink: '/calls/meeting/1' }))).toBe(false);
    expect(canJoin(N('c', 'Reminder', null, 0, { startsAt: at(5), joinLink: null }))).toBe(false);
  });

  it('mutes for an hour, until tomorrow 8:00, or until switched back on', () => {
    const now = new Date(2026, 9, 28, 15, 0);
    expect(muteUntil('1h', now)).toBe(now.getTime() + 3_600_000);
    expect(new Date(muteUntil('tomorrow', now)).getHours()).toBe(8);
    expect(isMuted({ ...DEFAULT_PREFS, mutedUntil: -1 })).toBe(true);
    expect(isMuted({ ...DEFAULT_PREFS, mutedUntil: Date.now() - 1 })).toBe(false);
  });
});
