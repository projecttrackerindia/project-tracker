import { beforeEach, describe, expect, it } from 'vitest';
import { RING_MS, callIdOf, expire, isRingNotice, onRinging, ring, ringingCalls, resetRinging, stopRinging } from './incomingCalls';

describe('incoming calls', () => {
  beforeEach(() => resetRinging());

  it('rings a call once, from whichever source told first', () => {
    const now = 1_000_000;
    let seen = 0;
    const off = onRinging(() => { seen += 1; });
    expect(ring({ callId: 'c1', title: 'Stand-up', fromName: 'Ravi', startedAt: now - 2000 }, now)).toBe(true);
    expect(ring({ callId: 'c1', title: 'Stand-up', fromName: 'Ravi' }, now + 10)).toBe(false);   // the poll finds the same call
    expect(ringingCalls()).toEqual([{ callId: 'c1', title: 'Stand-up', fromName: 'Ravi', at: now }]);
    expect(seen).toBe(1);
    off();
  });

  it('never rings again once answered or declined', () => {
    ring({ callId: 'c1' });
    stopRinging('c1');
    expect(ringingCalls()).toEqual([]);
    expect(ring({ callId: 'c1' })).toBe(false);
  });

  it('does not ring for a call that started longer ago than a ring lasts, and stops ringing after it', () => {
    const now = 5_000_000;
    expect(ring({ callId: 'old', startedAt: new Date(now - RING_MS - 1000).toISOString() }, now)).toBe(false);
    expect(ring({ callId: 'new', startedAt: new Date(now + 1500).toISOString() }, now)).toBe(true);   // a server clock a little ahead
    expect(expire(now + RING_MS - 1)).toEqual([]);
    expect(expire(now + RING_MS).map((c) => c.callId)).toEqual(['new']);
    expect(ringingCalls()).toEqual([]);
  });

  it('tells the ringing notice apart from the missed-call one', () => {
    expect(isRingNotice({ type: 'Call', title: 'Ravi Kumar is calling', link: '/calls/c1' })).toBe(true);
    expect(isRingNotice({ type: 'Call', title: 'Missed call from Ravi Kumar', link: '/calls/c1' })).toBe(false);
    expect(isRingNotice({ type: 'Meeting', title: 'Ravi Kumar is calling', link: '/calls/c1' })).toBe(false);
    expect(callIdOf('/acme/calls/0b9d-12')).toBe('0b9d-12');
    expect(callIdOf('/projects/1')).toBeNull();
  });
});
