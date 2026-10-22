import { afterEach, describe, expect, it, vi } from 'vitest';
import { create } from './client';

describe('create requests', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('send one request for a double submit, with an idempotency key, and reuse the key for a quick repeat', async () => {
    const calls: { url: string; key: string | null }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, key: (init.headers as Record<string, string>)['Idempotency-Key'] ?? null });
      await new Promise((r) => setTimeout(r, 10));
      return new Response(JSON.stringify({ success: true, data: { id: 't1' } }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    }));
    const body = { title: 'Five star Receipt Deed validation' };
    const [a, b] = await Promise.all([create<{ id: string }>('/projects/p1/tasks', body), create<{ id: string }>('/projects/p1/tasks', body)]);
    expect(a).toEqual(b);
    expect(calls).toHaveLength(1);
    expect(calls[0].key).toMatch(/^[A-Za-z0-9_\-:.]{8,100}$/);
    await create('/projects/p1/tasks', body);   // a second click after the first finished: same key, so the server replays it
    expect(calls[1].key).toBe(calls[0].key);
    await create('/projects/p1/tasks', { title: 'Another task' });
    expect(calls[2].key).not.toBe(calls[0].key);
  });
});
