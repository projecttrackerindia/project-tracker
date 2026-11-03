import { describe, expect, it } from 'vitest';
import { dayWord, parseQuick } from './quickParse';

const people = [{ id: 'u1', name: 'Ravi Menon' }, { id: 'u2', name: 'Lena Park' }];
const projects = [{ id: 'p1', key: 'ATL', name: 'Atlas Payments' }, { id: 'p2', key: 'ORB', name: 'Orbit Mobile' }];

describe('quick add', () => {
  it('reads owner, day and project out of the words', () => {
    const q = parseQuick('Fix refund retries @Ravi fri #atlas', '2026-11-03', people, projects);
    expect(q).toEqual({ title: 'Fix refund retries', ownerId: 'u1', due: '2026-11-06', projectId: 'p1', priority: null });
  });
  it('keeps tokens that match nothing and reads priority', () => {
    const q = parseQuick('Email @nobody about #nothing !urgent', '2026-11-03', people, projects);
    expect(q.title).toBe('Email @nobody about #nothing');
    expect(q.priority).toBe('Critical');
  });
  it('day words land on or after today', () => {
    expect(dayWord('today', '2026-11-03')).toBe('2026-11-03');
    expect(dayWord('tomorrow', '2026-11-03')).toBe('2026-11-04');
    expect(dayWord('tue', '2026-11-03')).toBe('2026-11-10');
    expect(dayWord('monday', '2026-11-03')).toBe('2026-11-09');
    expect(dayWord('fix', '2026-11-03')).toBeNull();
  });
});
