import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { createSync, type SyncEvent } from './realtimeSync';

const W = 'w1', ME = 'me', OTHER = 'u2', T1 = 'task-0001', T2 = 'task-0002';
const ev = (v: number, extra: Partial<SyncEvent> = {}): SyncEvent => ({ type: 'task', id: T1, projectId: 'p1', tenantId: W, op: 'updated', version: v, changedFields: ['title'], actorId: OTHER, ...extra });

function setup(load: (since: number) => Promise<{ version: number; reset: boolean; changes: SyncEvent[] }> = vi.fn(async () => ({ version: 10, reset: false, changes: [] as SyncEvent[] }))) {
  const client = new QueryClient();
  client.setQueryData([W, 'tasks', 'list'], { items: [{ id: T1, title: 'Old' }] });
  client.setQueryData([W, 'tasks', 'other'], { items: [{ id: T2, title: 'Other' }] });
  client.setQueryData([W, 'reminders', 'counts'], { now: 1 });
  client.setQueryData(['w2', 'tasks', 'list'], { items: [{ id: T1 }] });
  const stale = (k: unknown[]) => client.getQueryState(k)?.isInvalidated;
  const sync = createSync({ client, wid: W, me: ME, load, storage: null, ownRecent: () => true });
  return { client, sync, stale, load };
}

describe('realtime sync', () => {
  it('refreshes only the reads that hold the changed thing, in this workspace', async () => {
    const { sync, stale } = setup();
    sync.apply([ev(11)]);
    await sync.flush();
    expect(stale([W, 'tasks', 'list'])).toBe(true);
    expect(stale([W, 'tasks', 'other'])).toBe(false);
    expect(stale(['w2', 'tasks', 'list'])).toBe(false);
    expect(stale([W, 'reminders', 'counts'])).toBe(false);
  });

  it('refreshes a whole kind when a row can move between lists, and the badge counts of personal things', async () => {
    const { sync, stale } = setup();
    sync.apply([ev(11, { changedFields: ['statusId'] }), ev(12, { type: 'reminder', id: 'r1', projectId: null, op: 'created', changedFields: null })]);
    await sync.flush();
    expect(stale([W, 'tasks', 'other'])).toBe(true);
    expect(stale([W, 'reminders', 'counts'])).toBe(true);
  });

  it('applies each version once, skips my own echo, and ignores other workspaces', async () => {
    const { sync, stale, client } = setup();
    sync.apply([ev(11, { actorId: ME })]);
    sync.apply([ev(12, { tenantId: 'w2' })]);
    await sync.flush();
    expect(stale([W, 'tasks', 'list'])).toBe(false);
    sync.apply([ev(13)]);
    await sync.flush();
    client.setQueryData([W, 'tasks', 'list'], { items: [{ id: T1, title: 'New' }] });   // refetched
    sync.apply([ev(13)]);
    await sync.flush();
    expect(stale([W, 'tasks', 'list'])).toBe(false);
  });

  it('catches up exactly what was missed after being offline, and reloads screens when the gap is too old', async () => {
    const load = vi.fn(async (since: number) => since === 0 ? { version: 20, reset: false, changes: [] } : { version: 23, reset: false, changes: [ev(21), ev(22, { id: T2 })] });
    const { sync, stale } = setup(load);
    await sync.catchUp();
    expect(sync.version()).toBe(20);
    await sync.catchUp();
    expect(load).toHaveBeenLastCalledWith(20);
    await sync.flush();
    expect(stale([W, 'tasks', 'list'])).toBe(true);
    expect(stale([W, 'tasks', 'other'])).toBe(true);
    expect(sync.version()).toBe(23);

    const reset = vi.fn();
    const client = new QueryClient();
    const gap = createSync({ client, wid: W, me: ME, storage: null, onReset: reset, load: async (since) => since === 0 ? { version: 5, reset: false, changes: [] } : { version: 9000, reset: true, changes: [] } });
    await gap.catchUp(); await gap.catchUp();
    expect(reset).toHaveBeenCalledTimes(1);
    expect(gap.version()).toBe(9000);
  });
});
