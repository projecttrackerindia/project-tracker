import { expect, it, vi } from 'vitest';
import { hasPushReceipt, recordPushReceipt, waitForPushReceipt } from './pushReceipts';

it('waits for actual worker delivery rather than a server registration', async () => {
  vi.useFakeTimers();
  try {
    const fallback = waitForPushReceipt('missing');
    await vi.advanceTimersByTimeAsync(1500);
    expect(await fallback).toBe(false);
    const delivered = waitForPushReceipt('arriving');
    recordPushReceipt('arriving');
    await vi.advanceTimersByTimeAsync(1500);
    expect(await delivered).toBe(true);
  } finally { vi.useRealTimers(); }
});

it('expires and bounds receipts, retaining the newest notification', () => {
  recordPushReceipt('expires', 1000);
  expect(hasPushReceipt('expires', 120999)).toBe(true);
  expect(hasPushReceipt('expires', 121000)).toBe(false);
  for (let i = 0; i < 300; i++) recordPushReceipt(`bounded-${i}`, 200000);
  expect(hasPushReceipt('bounded-0', 200001)).toBe(false);
  expect(hasPushReceipt('bounded-299', 200001)).toBe(true);
});
