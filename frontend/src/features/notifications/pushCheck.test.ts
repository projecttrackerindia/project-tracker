import { describe, expect, it } from 'vitest';
import { checkSteps, verdict } from './pushCheck';

const server = (o: Partial<{ thisDeviceKnown: boolean; accepted: boolean; status: number }> = {}) => ({
  keysReady: true, devices: 1, thisDeviceKnown: o.thisDeviceKnown ?? true, tag: 'pt-test-1',
  results: [{ device: 'Chrome on Windows', thisDevice: true, status: o.status ?? 201, accepted: o.accepted ?? true, message: 'Accepted by the push service.' }],
});

describe('push check steps', () => {
  it('asks for permission first and waits on the rest', () => {
    const s = checkSteps({ where: 'browser', permission: 'default', subscribed: false, pushSupported: true, server: null, shown: null });
    expect(s.map((x) => x.state)).toEqual(['fail', 'wait', 'wait', 'wait']);
    expect(s[0].fix).toBe('allow');
  });
  it('a device the server forgot is a server failure with a re-subscribe fix', () => {
    const s = checkSteps({ where: 'browser', permission: 'granted', subscribed: true, pushSupported: true, server: server({ thisDeviceKnown: false }), shown: null });
    expect(s[2]).toMatchObject({ state: 'fail', fix: 'subscribe' });
  });
  it('a 403 from the push service (old key) offers to sign up again', () => {
    const s = checkSteps({ where: 'browser', permission: 'granted', subscribed: true, pushSupported: true, server: server({ accepted: false, status: 403 }), shown: null });
    expect(s[3]).toMatchObject({ state: 'fail', fix: 'subscribe' });
  });
  it('all green when shown', () => {
    const s = checkSteps({ where: 'browser', permission: 'granted', subscribed: true, pushSupported: true, server: server(), shown: true });
    expect(s.every((x) => x.state === 'ok')).toBe(true);
    expect(verdict(s)).toMatch(/work on this device/);
  });
  it('the desktop app needs no subscription', () => {
    const s = checkSteps({ where: 'desktop', permission: 'granted', subscribed: false, pushSupported: false, server: server(), shown: true });
    expect(s[1].state).toBe('skip');
    expect(verdict(s)).toMatch(/work/);
  });
});
