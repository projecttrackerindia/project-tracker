import { afterEach, expect, it, vi } from 'vitest';
import { createRefreshQueue } from './refreshQueue';
afterEach(() => vi.useRealTimers());
it('lets a slow read finish and coalesces a burst into one follow-up', async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  const first = new Promise<void>((resolve) => { finish = resolve; });
  const refresh = vi.fn().mockReturnValueOnce(first).mockResolvedValue(undefined);
  const queue = createRefreshQueue(refresh, 150);
  queue.request(); queue.request();
  await vi.advanceTimersByTimeAsync(150);
  expect(refresh).toHaveBeenCalledTimes(1);
  for (let i = 0; i < 20; i++) queue.request();
  await vi.advanceTimersByTimeAsync(1000);
  expect(refresh).toHaveBeenCalledTimes(1);
  finish(); await vi.advanceTimersByTimeAsync(150);
  expect(refresh).toHaveBeenCalledTimes(2);
  queue.dispose();
});
it('drops scheduled work when leaving a workspace', async () => {
  vi.useFakeTimers();
  const refresh = vi.fn(async () => undefined);
  const queue = createRefreshQueue(refresh);
  queue.request(); queue.dispose(); queue.request();
  await vi.runAllTimersAsync();
  expect(refresh).not.toHaveBeenCalled();
});
