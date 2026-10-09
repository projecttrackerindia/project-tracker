import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, quote, volumePercent } from './pricing';

describe('volumePercent', () => {
  it('is 0 below the first tier, and the highest tier reached otherwise', () => {
    expect(volumePercent(DEFAULT_POLICY, 1)).toBe(0);
    expect(volumePercent(DEFAULT_POLICY, 9)).toBe(0);
    expect(volumePercent(DEFAULT_POLICY, 10)).toBe(10);
    expect(volumePercent(DEFAULT_POLICY, 24)).toBe(10);
    expect(volumePercent(DEFAULT_POLICY, 25)).toBe(15);
    expect(volumePercent(DEFAULT_POLICY, 100)).toBe(20);
    expect(volumePercent(DEFAULT_POLICY, 5000)).toBe(20);
  });
});

describe('quote', () => {
  it('charges unit x seats x months with no discount below the first volume tier, monthly', () => {
    const q = quote(DEFAULT_POLICY, 349, true, 3, 'monthly');
    expect(q.seats).toBe(3);
    expect(q.totalPercent).toBe(0);
    expect(q.chargePerCycle).toBe(349 * 3);
    expect(q.cycleMonths).toBe(1);
  });

  it('combines the volume and annual discounts, capped at maxTotalDiscountPercent', () => {
    // 100 seats = 20% volume, yearly = 20% annual -> 40% combined, capped at 30%.
    const q = quote(DEFAULT_POLICY, 349, true, 100, 'yearly');
    expect(q.volumePercent).toBe(20);
    expect(q.annualPercent).toBe(20);
    expect(q.totalPercent).toBe(30);   // capped, not 40
    const list = 349 * 100 * 12;
    expect(q.listTotalPerCycle).toBe(list);
    expect(q.chargePerCycle).toBe(Math.round(list * 0.7));
    expect(q.savedPerCycle).toBe(list - q.chargePerCycle);
  });

  it('floors and clamps the seat count to at least 1 and at most the policy max', () => {
    expect(quote(DEFAULT_POLICY, 349, true, 0, 'monthly').seats).toBe(1);
    expect(quote(DEFAULT_POLICY, 349, true, -5, 'monthly').seats).toBe(1);
    expect(quote(DEFAULT_POLICY, 349, true, 3.9, 'monthly').seats).toBe(3);
    expect(quote(DEFAULT_POLICY, 349, true, DEFAULT_POLICY.maxSeats + 500, 'monthly').seats).toBe(DEFAULT_POLICY.maxSeats);
  });

  it('a flat (non-per-seat) plan is always exactly 1 seat with no volume discount', () => {
    const q = quote(DEFAULT_POLICY, 1999, false, 50, 'monthly');
    expect(q.seats).toBe(1);
    expect(q.volumePercent).toBe(0);
    expect(q.chargePerCycle).toBe(1999);
  });

  it('effectivePerSeatMonthly divides the discounted charge back down to a monthly, per-seat figure', () => {
    const q = quote(DEFAULT_POLICY, 349, true, 10, 'yearly');   // 10% volume + 20% annual = 30%
    expect(q.totalPercent).toBe(30);
    const expectedMonthly = Math.round((q.chargePerCycle / 12 / 10) * 100) / 100;
    expect(q.effectivePerSeatMonthly).toBe(expectedMonthly);
    expect(q.effectivePerSeatMonthly).toBeLessThan(q.listPerSeatMonthly);
  });
});
