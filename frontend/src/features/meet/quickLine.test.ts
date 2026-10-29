import { describe, expect, it } from 'vitest';
import { nextDay, parseMeetingSentence, parseQuickLine, resolveOwner } from './quickLine';

const monday = '2026-11-02';

describe('parseQuickLine (same reading as QuickLine.cs)', () => {
  it('takes @owner and a weekday out of the title', () => {
    expect(parseQuickLine('Confirm bank sandbox date @Ravi fri', monday)).toEqual({ title: 'Confirm bank sandbox date', ownerToken: 'Ravi', due: '2026-11-06', dateToken: 'fri' });
  });
  it('reads day-month, +Nd, tomorrow and "due mon" (next Monday when said on a Monday)', () => {
    expect(parseQuickLine('Book PCI assessor call @mira 7 nov', monday).due).toBe('2026-11-07');
    expect(parseQuickLine('Deploy +3d @kiran', monday).due).toBe('2026-11-05');
    expect(parseQuickLine('Ping NPCI tomorrow', monday).due).toBe('2026-11-03');
    expect(parseQuickLine('Draft comms due mon', monday)).toMatchObject({ title: 'Draft comms', due: '2026-11-09' });
  });
  it('leaves words that only look like dates', () => {
    expect(parseQuickLine('Review the monitoring dashboard', monday)).toMatchObject({ title: 'Review the monitoring dashboard', due: null });
  });
  it('nextDay keeps today only when asked', () => {
    expect(nextDay(monday, 1)).toBe('2026-11-09');
    expect(nextDay(monday, 1, true)).toBe(monday);
  });
});

describe('resolveOwner', () => {
  const people = [{ id: '1', name: 'Ravi Menon' }, { id: '2', name: 'Mira Okafor' }, { id: '3', name: 'Ravi Shah' }];
  it('refuses an ambiguous first name and accepts first name + initial', () => {
    expect(resolveOwner('ravi', people)).toEqual({ person: null, ambiguous: true });
    expect(resolveOwner('ravim', people).person?.id).toBe('1');
    expect(resolveOwner('@Mira', people).person?.id).toBe('2');
  });
});

describe('parseMeetingSentence', () => {
  it('reads the Aura sentence into the schedule fields', () => {
    const m = parseMeetingSentence('weekly sandbox sync with Mira and AutoPay team tomorrow 11:30 for 45m', monday);
    expect(m).toMatchObject({ repeat: 'Weekly', people: ['Mira', 'AutoPay team'], date: '2026-11-03', time: '11:30', minutes: 45 });
    expect(m.title).toBe('Sandbox sync');
  });
});
