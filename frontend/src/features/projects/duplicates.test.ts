import { describe, expect, it } from 'vitest';
import { duplicateGroups, groupKey, nameKey } from './duplicates';

describe('likely duplicate projects', () => {
  it('ignores case, spaces and punctuation', () => {
    expect(nameKey('Darwin box Api')).toBe(nameKey('Darwin Box api'));
    expect(nameKey('SBI-bulk  payments!')).toBe(nameKey('sbi bulk payments'));
    expect(nameKey('s-internal-api')).toBe('sinternalapi');
  });
  it('groups only names that match', () => {
    const groups = duplicateGroups([
      { id: '1', name: 'Darwin box Api' }, { id: '2', name: 'Darwin Box api' }, { id: '3', name: 'Razor pay' }, { id: '4', name: 'Razorpay API' },
    ]);
    expect(groups.map((g) => g.map((p) => p.id))).toEqual([['1', '2']]);
  });
  it('does not flag very short names', () => {
    expect(duplicateGroups([{ id: '1', name: 'QA' }, { id: '2', name: 'Q.A.' }])).toEqual([]);
  });
  it('keys a group the same way whatever the order', () => {
    expect(groupKey([{ id: 'b' }, { id: 'a' }])).toBe(groupKey([{ id: 'a' }, { id: 'b' }]));
  });
});
