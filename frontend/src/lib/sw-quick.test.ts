// Quick actions in the service worker (public/sw.js): which buttons a push shows, and what pressing one does with the app closed.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

type Handler = (e: Record<string, unknown>) => void;

function loadWorker(status = 200) {
  const handlers: Record<string, Handler> = {};
  const showNotification = vi.fn((..._args: unknown[]) => Promise.resolve());
  const openWindow = vi.fn(() => Promise.resolve());
  const fetch = vi.fn((..._args: unknown[]) => Promise.resolve({ ok: status < 300, status }));
  const self = {
    addEventListener: (type: string, h: Handler) => { handlers[type] = h; },
    navigator: { setAppBadge: vi.fn(() => Promise.resolve()), clearAppBadge: vi.fn(() => Promise.resolve()) },
    registration: { showNotification, getNotifications: () => Promise.resolve([]) },
    clients: { matchAll: () => Promise.resolve([]), openWindow, claim: () => Promise.resolve() },
    location: { origin: 'https://app.example.test' },
    Notification: { maxActions: 2 },
    skipWaiting: vi.fn(),
  };
  const code = readFileSync(resolve(__dirname, '../../public/sw.js'), 'utf8');
  runInNewContext(code, { self, caches: {}, fetch, URL, MessageChannel, setTimeout, clearTimeout, Promise, JSON, Math, Number, String, Array });
  const fire = async (type: string, extra: Record<string, unknown>) => {
    const waits: Promise<unknown>[] = [];
    handlers[type]({ ...extra, waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
  };
  return { fire, showNotification, fetch, openWindow };
}

const push = (payload: object) => ({ data: { json: () => payload, text: () => JSON.stringify(payload) } });
const click = (action: string, data: object, reply?: string) => ({ action, reply, notification: { close: () => undefined, data } });
const options = (w: ReturnType<typeof loadWorker>) => w.showNotification.mock.calls[0][1] as { actions: { action: string; type?: string }[]; data: Record<string, unknown> };

describe('service worker quick actions', () => {
  it('shows the buttons the server offers (at most what the browser can show), with reply as inline text', async () => {
    const w = loadWorker();
    await w.fire('push', push({ title: 'Asha', type: 'Message', tag: 'q1', qa: 'KEY', actions: ['reply', 'read'], link: '/chat/c1' }));
    const o = options(w);
    expect(o.actions.map((a) => a.action)).toEqual(['reply', 'read']);
    expect(o.actions[0].type).toBe('text');
    expect(o.data.qa).toBe('KEY');
  });

  it('keeps a normal-priority notice quiet: no buttons', async () => {
    const w = loadWorker();
    await w.fire('push', push({ title: 'Update', type: 'TaskAssigned', tag: 'q2', qa: 'KEY', actions: ['done', 'snooze'], priority: 'normal' }));
    expect(options(w).actions).toEqual([]);
  });

  it('Done calls the one-time key endpoint without credentials and does not open the app', async () => {
    const w = loadWorker();
    await w.fire('notificationclick', click('done', { qa: 'K/1', link: '/projects/p?task=t' }));
    expect(w.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = w.fetch.mock.calls[0] as [string, { credentials: string; body: string }];
    expect(url).toBe('/api/v1/notification-actions/K%2F1');
    expect(init.credentials).toBe('omit');
    expect(JSON.parse(init.body)).toEqual({ action: 'done' });
    expect(w.openWindow).not.toHaveBeenCalled();
  });

  it('Snooze sends the 1 hour preset; Reply sends the typed text', async () => {
    const w = loadWorker();
    await w.fire('notificationclick', click('snooze', { qa: 'K' }));
    expect(JSON.parse((w.fetch.mock.calls[0][1] as { body: string }).body)).toEqual({ action: 'snooze', preset: '1h' });
    await w.fire('notificationclick', click('reply', { qa: 'K' }, ' On it '));
    expect(JSON.parse((w.fetch.mock.calls[1][1] as { body: string }).body)).toEqual({ action: 'reply', text: 'On it' });
  });

  it('Reject without a reason opens the app instead of rejecting', async () => {
    const w = loadWorker();
    await w.fire('notificationclick', click('reject', { qa: 'K', link: '/approvals?open=a1' }));
    expect(w.fetch).not.toHaveBeenCalled();
    expect(w.openWindow).toHaveBeenCalledWith('https://app.example.test/approvals?open=a1');
  });

  it('Join opens the meeting (and marks the notice read)', async () => {
    const w = loadWorker();
    await w.fire('notificationclick', click('join', { qa: 'K', link: '/calls/meeting/w/m1' }));
    expect(w.openWindow).toHaveBeenCalledWith('https://app.example.test/calls/meeting/w/m1');
    expect(JSON.parse((w.fetch.mock.calls[0][1] as { body: string }).body)).toEqual({ action: 'read' });
  });

  it('opens the app when the key has expired or the person must sign in again', async () => {
    const w = loadWorker(403);
    await w.fire('notificationclick', click('approve', { qa: 'K', link: '/approvals?open=a1' }));
    expect(w.openWindow).toHaveBeenCalledWith('https://app.example.test/approvals?open=a1');
  });
});
