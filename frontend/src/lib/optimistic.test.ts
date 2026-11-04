import { describe, expect, it, vi } from 'vitest';
import { QueryClient, MutationObserver } from '@tanstack/react-query';
import { applyOptimistic, mergeById, optimisticMutationCache, removeById, rollback, SAVED_EVENT, SAVE_FAILED_EVENT, writeSucceeded } from './optimistic';

describe('optimistic saves', () => {
  it('merges and removes by id in lists, objects and pages', () => {
    expect(mergeById([{ id: 'a', n: 1 }, { id: 'b', n: 2 }], 'b', { n: 3 })).toEqual([{ id: 'a', n: 1 }, { id: 'b', n: 3 }]);
    expect(mergeById({ id: 'a', n: 1 }, 'a', { n: 9 })).toEqual({ id: 'a', n: 9 });
    expect(mergeById({ items: [{ id: 'a', n: 1 }], total: 1 }, 'a', { n: 2 })).toEqual({ items: [{ id: 'a', n: 2 }], total: 1 });
    expect(removeById({ items: [{ id: 'a' }, { id: 'b' }] }, 'a')).toEqual({ items: [{ id: 'b' }] });
  });

  it('applies at once and rolls back exactly', async () => {
    const client = new QueryClient();
    client.setQueryData(['w', 'tasks', 'list'], [{ id: 't1', title: 'Old' }]);
    const snap = await applyOptimistic(client, [{ key: ['w', 'tasks'], apply: (old: unknown) => mergeById(old, 't1', { title: 'New' } as never) }], undefined);
    expect(client.getQueryData(['w', 'tasks', 'list'])).toEqual([{ id: 't1', title: 'New' }]);
    rollback(client, snap);
    expect(client.getQueryData(['w', 'tasks', 'list'])).toEqual([{ id: 't1', title: 'Old' }]);
  });

  it('every mutation shares it: instant change, rollback on refusal, one ✓ Saved on success', async () => {
    const events: string[] = [];
    const on = (e: Event) => events.push(e.type);
    const target = new EventTarget();
    vi.stubGlobal('window', Object.assign(target, { dispatchEvent: target.dispatchEvent.bind(target) }));
    target.addEventListener(SAVED_EVENT, on); target.addEventListener(SAVE_FAILED_EVENT, on);
    let client: QueryClient;
    client = new QueryClient({ mutationCache: optimisticMutationCache(() => client) });
    client.setQueryData(['w', 'task', 't1'], { id: 't1', title: 'Old' });
    const meta = { optimistic: [{ key: ['w', 'task', 't1'], apply: (old: unknown, v: unknown) => mergeById(old, 't1', { title: v as string } as never) }] };

    let release!: (v: unknown) => void;
    const ok = new MutationObserver<unknown, Error, string>(client, { mutationFn: () => new Promise((r) => { release = r; }), meta });
    const done = ok.mutate('Instant');
    await Promise.resolve(); await new Promise((r) => setTimeout(r, 0));
    expect(client.getQueryData(['w', 'task', 't1'])).toEqual({ id: 't1', title: 'Instant' });   // before the server answered
    release({}); await done;
    expect(events).toContain(SAVED_EVENT);

    const bad = new MutationObserver<unknown, Error, string>(client, { mutationFn: () => Promise.reject(new Error('Refused by server')), meta });
    await bad.mutate('Never').catch(() => undefined);
    expect((client.getQueryData(['w', 'task', 't1']) as { title: string }).title).toBe('Instant');
    expect(events).toContain(SAVE_FAILED_EVENT);
    vi.unstubAllGlobals();
  });

  it('plain PUT/PATCH writes tick; reads, presence and actions do not', () => {
    const target = new EventTarget(); let n = 0;
    vi.stubGlobal('window', Object.assign(target, { dispatchEvent: target.dispatchEvent.bind(target) }));
    target.addEventListener(SAVED_EVENT, () => n++);
    writeSucceeded('POST', '/tasks');
    writeSucceeded('PUT', '/chat/conversations/x/read');
    writeSucceeded('GET', '/projects');
    expect(n).toBe(0);
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 10_000);
    writeSucceeded('PUT', '/settings/profile');
    expect(n).toBe(1);
    vi.useRealTimers(); vi.unstubAllGlobals();
  });
});
