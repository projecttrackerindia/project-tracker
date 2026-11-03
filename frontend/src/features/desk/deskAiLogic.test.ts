import { describe, expect, it } from 'vitest';
import { isObj } from '../../api/deskAiApi';
import { acceptState, fromTime, toTime } from './deskAiLogic';

describe('desk ai logic', () => {
  it('converts shift times both ways', () => {
    expect(toTime(570)).toBe('09:30');
    expect(toTime(null)).toBe('');
    expect(fromTime('22:15')).toBe(1335);
    expect(fromTime('')).toBeNull();
  });

  it('says how long is left to accept, and when it is late or done', () => {
    const now = Date.parse('2026-11-03T10:00:00Z');
    expect(acceptState({ acceptDueAt: '2026-11-03T10:08:00Z', acceptedAt: null, escalatedAt: null }, now)).toEqual({ text: 'Accept within 8m', tone: '' });
    expect(acceptState({ acceptDueAt: '2026-11-03T10:02:00Z', acceptedAt: null, escalatedAt: null }, now)?.tone).toBe('warn');
    expect(acceptState({ acceptDueAt: '2026-11-03T09:58:00Z', acceptedAt: null, escalatedAt: null }, now)?.tone).toBe('late');
    expect(acceptState({ acceptDueAt: null, acceptedAt: '2026-11-03T09:40:00Z', escalatedAt: null }, now)?.tone).toBe('ok');
    expect(acceptState({ acceptDueAt: null, acceptedAt: null, escalatedAt: '2026-11-03T09:40:00Z' }, now)?.text).toBe('Escalated to the supervisor');
    expect(acceptState(null, now)).toBeNull();
  });

  it('treats an empty list from an older server as no data', () => {
    expect(isObj([])).toBe(false);
    expect(isObj(null)).toBe(false);
    expect(isObj({ workTaskId: 'x' })).toBe(true);
  });
});
