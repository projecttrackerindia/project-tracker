import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFS } from './prefs';
import { totalBadge } from './model';
import { applyTabDelta, clearTabs, destinationOf, sumTabs, tabCounts } from './tabBadges';

describe('sidebar destinations (same table as the server, docs/badges.md)', () => {
  it.each([
    ['Message', '/chat/1b2c', 'messages'], ['Call', '/calls/x', 'messages'], ['Mention', '/projects/p?chat=1', 'messages'], ['Mention', '/projects/p/tasks/9', 'work'],
    ['Meeting', '/meet', 'meetings'], ['Reminder', '/meet?open=w:1', 'meetings'],
    ['TaskAssigned', '/projects/p', 'work'], ['TaskUpdated', '/projects/p', 'work'], ['Comment', '/projects/p', 'work'],
    ['DueSoon', '/projects/p', 'today'], ['Overdue', '/projects/p', 'today'], ['Approval', '/timesheet', 'today'], ['Approval', '/approvals?open=1', 'approvals'], ['Security', '/settings/security', 'today'],
    ['Document', '/documents/7', 'library'], ['Comment', '/library/pages/3', 'library'],
    ['PortfolioDigest', '/portfolio', 'portfolio'], ['ServiceLevel', '/desk/12', 'desk'],
    ['Reminder', '/mail/inbox', 'mail'], ['Reminder', '/?tab=calendar', 'calendar'],
  ])('%s %s → %s', (type, link, dest) => expect(destinationOf(type, link)).toBe(dest));
});

describe('tab counts', () => {
  const counts = { unread: 6, needsYou: 3, forInfo: 3, messages: 1, reminders: 2, meetings: 1, work: 2,
    tabs: { 'messages:messages': 1, 'today:reminders': 2, 'meetings:meetings': 1, 'work:work': 1, 'library:work': 1 } };

  it('every unread notification is on one place and the places add up to the bell', () => {
    const t = tabCounts(counts, DEFAULT_PREFS, 0);
    expect(t).toMatchObject({ messages: 1, today: 2, meetings: 1, work: 1, library: 1, mail: 0 });
    expect(sumTabs(t)).toBe(counts.unread);
    expect(totalBadge(counts, DEFAULT_PREFS, 0)).toBe(sumTabs(t));
  });

  it('Messages shows the unread chat number when that is higher (one notice per conversation)', () => {
    const t = tabCounts(counts, DEFAULT_PREFS, 4);
    expect(t.messages).toBe(4);
    expect(totalBadge(counts, DEFAULT_PREFS, 4)).toBe(9);
  });

  it('a category whose badge is off adds nothing anywhere', () => {
    const prefs = { ...DEFAULT_PREFS, cats: { ...DEFAULT_PREFS.cats, reminders: { ...DEFAULT_PREFS.cats.reminders, badge: false } } };
    expect(tabCounts(counts, prefs, 0).today).toBe(0);
  });

  it('an older server without tabs falls back to the categories', () => {
    const { tabs: _drop, ...old } = counts;
    void _drop;
    expect(tabCounts(old, DEFAULT_PREFS, 0)).toMatchObject({ messages: 1, today: 2, meetings: 1, work: 2 });
  });

  it('reading takes it off its place at once; mark all read clears the category', () => {
    expect(applyTabDelta(counts.tabs, { 'library:work': -1 })!['library:work']).toBe(0);
    const cleared = clearTabs(counts.tabs, 'work')!;
    expect(cleared['work:work'] + cleared['library:work']).toBe(0);
    expect(cleared['today:reminders']).toBe(2);
  });
});
