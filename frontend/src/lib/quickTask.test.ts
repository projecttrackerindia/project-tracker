import { describe, expect, it } from 'vitest';
import { parseQuickTask } from './quickTask';

const people = [{ id: 'u1', name: 'Ravi Kumar' }, { id: 'u2', name: 'Ravi Teja' }, { id: 'u3', name: 'Jyothsna Reddy' }, { id: 'u4', name: 'Stanley Paul' }];
const me = { id: 'me', name: 'Asha Rao' };
const thu = new Date(2026, 9, 22);   // Thursday 22 Oct 2026

describe('parseQuickTask', () => {
  it('reads person, day, priority and hours, and keeps the rest as the title', () => {
    const t = parseQuickTask('fix login bug for Ravi Teja by Friday, high, 3h', people, thu, me);
    expect(t).toMatchObject({ title: 'Fix login bug', assignee: { id: 'u2' }, dueDate: '2026-10-23', priority: 'High', estimatedHours: 3 });
  });
  it('matches a first name and @mentions, and "me"', () => {
    expect(parseQuickTask('Review deck @jyothsna', people, thu).assignee?.id).toBe('u3');
    expect(parseQuickTask('Call bank assign to me tomorrow', people, thu, me)).toMatchObject({ assignee: { id: 'me' }, dueDate: '2026-10-23', title: 'Call bank' });
  });
  it('does not take a person from an ordinary "to"', () => {
    const t = parseQuickTask('Move data to staging', people, thu);
    expect(t.assignee).toBeUndefined();
    expect(t.title).toBe('Move data to staging');
  });
  it('keeps words after the name in the title', () => {
    const t = parseQuickTask('Ask for Jyothsna about payments', people, thu);
    expect(t.assignee?.id).toBe('u3');
    expect(t.title).toBe('Ask about payments');
  });
  it('understands the common ways of writing a date', () => {
    const d = (s: string) => parseQuickTask(`x ${s}`, [], thu).dueDate;
    expect(d('today')).toBe('2026-10-22');
    expect(d('next week')).toBe('2026-10-26');
    expect(d('thursday')).toBe('2026-10-29');
    expect(d('next mon')).toBe('2026-11-02');
    expect(d('in 3 days')).toBe('2026-10-25');
    expect(d('end of month')).toBe('2026-10-31');
    expect(d('25 oct')).toBe('2026-10-25');
    expect(d('Oct 2')).toBe('2027-10-02');
    expect(d('5/11')).toBe('2026-11-05');
    expect(d('2026-12-01')).toBe('2026-12-01');
  });
  it('reads minutes and p-levels', () => {
    expect(parseQuickTask('Standup notes 45m p1', [], thu)).toMatchObject({ estimatedHours: 0.75, priority: 'Critical', title: 'Standup notes' });
  });
  it('leaves no stray commas when a part is kept in the title', () => {
    expect(parseQuickTask('fix login bug for Ravi Kumar by tomorrow, high, 3h', people, thu, me, new Set(['estimate'])).title).toBe('Fix login bug, 3h');
  });
  it('leaves a dismissed part in the title', () => {
    const t = parseQuickTask('High CPU alert on db', [], thu, undefined, new Set(['priority']));
    expect(t.priority).toBeUndefined();
    expect(t.title).toBe('High CPU alert on db');
  });
});
