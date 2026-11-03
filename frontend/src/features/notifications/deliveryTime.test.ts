import { expect, it } from 'vitest';
import { deliveryTime } from './deliveryTime';

it('does not make a quiet-hours notification eligible before its deferred delivery time', () => {
  const now = Date.parse('2026-11-02T14:00:00Z');
  expect(deliveryTime({ createdAt: '2026-11-02T13:00:00Z', deliverAfter: '2026-11-03T02:30:00Z' })).toBeGreaterThan(now);
  expect(deliveryTime({ createdAt: '2026-11-02T13:00:00Z' })).toBeLessThan(now);
});
it('can deliver after quiet hours without treating it as an old creation', () => {
  const createdAt = '2026-11-02T13:00:00Z';
  expect(deliveryTime({ createdAt, deliverAfter: '2026-11-03T02:30:00Z' })).toBe(Date.parse('2026-11-03T02:30:00Z'));
  expect(deliveryTime({ createdAt, deliverAfter: '2026-11-01T00:00:00Z' })).toBe(Date.parse(createdAt));
});
