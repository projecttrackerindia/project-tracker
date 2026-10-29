import { describe, expect, it } from 'vitest';
import { fuzzyPerson, interpret, noteParts, parseNatural, pastedDate, weekStart } from './planSheetQuery';

const people = [{ id: 'r', name: 'Ravi Menon' }, { id: 'j', name: 'Jonas Weber' }, { id: 't', name: 'Tomás Ortega' }, { id: 'a', name: 'Aisha Khan' }];
const projects = [{ id: 'aa', title: 'Account Aggregator', key: 'AA' }, { id: 'cb', title: 'Credit Bureau Integration', key: 'CB' }];

describe('plan sheet command field', () => {
  it('reads a sentence into tokens in the order owner, status, due', () => {
    expect(interpret('ravi late this week', people, projects).map((t) => `${t.kind}:${t.value}`)).toEqual(['owner:r', 'status:lateorrisk', 'due:this-week']);
    expect(interpret('late', people, projects).map((t) => t.value)).toEqual(['late']);
    expect(interpret('status:done project:cb', people, projects).map((t) => `${t.kind}:${t.value}`)).toEqual(['status:done', 'project:cb']);
    expect(interpret('mine overdue', people, projects).map((t) => `${t.kind}:${t.value}`)).toEqual(['owner:me', 'due:overdue']);
    expect(interpret('bureau mapping', people, projects)).toEqual([{ kind: 'text', value: 'bureau mapping', label: '“bureau mapping”' }]);
  });
  it('matches loosely typed names', () => {
    expect(fuzzyPerson('J. Weber', people)?.id).toBe('j');
    expect(fuzzyPerson('tomas.ortega', people)?.id).toBe('t');
    expect(fuzzyPerson('Aisha K', people)?.id).toBe('a');
    expect(fuzzyPerson('ops team', people)).toBeNull();
  });
  it('reads natural dates and pasted dates', () => {
    const today = '2026-10-29';   // a Thursday
    expect(weekStart(today)).toBe('2026-10-26');
    expect(parseNatural('fri', null, today)).toBe('2026-10-30');
    expect(parseNatural('next tue', null, today)).toBe('2026-11-03');
    expect(parseNatural('+1w', '2026-10-27', today)).toBe('2026-11-03');
    expect(parseNatural('+2d', '2026-10-27', today)).toBe('2026-10-29');
    expect(pastedDate('10/11/2026', 'dmy', today)).toBe('2026-11-10');
    expect(pastedDate('10/11/2026', 'mdy', today)).toBe('2026-10-11');
    expect(pastedDate('31/11/2026', 'dmy', today)).toBeNull();
  });
  it('marks mentions and links in a note', () => {
    expect(noteParts('ask @Lena see https://x.test/a').map((p) => p.t)).toEqual(['text', 'mention', 'text', 'link']);
  });
});
