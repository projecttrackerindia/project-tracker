// The service worker (public/sw.js) keeps the installed app's icon badge while no window is open: a push sets it from the count it carries,
// an open page corrects it, opening a notification takes one off. Loaded here in a sandbox with a fake worker scope.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

type Handler = (e: Record<string, unknown>) => void;

function loadWorker() {
  const handlers: Record<string, Handler> = {};
  const setAppBadge = vi.fn(() => Promise.resolve());
  const clearAppBadge = vi.fn(() => Promise.resolve());
  const showNotification = vi.fn(() => Promise.resolve());
  const self = {
    addEventListener: (type: string, h: Handler) => { handlers[type] = h; },
    navigator: { setAppBadge, clearAppBadge },
    registration: { showNotification },
    clients: { matchAll: () => Promise.resolve([]), openWindow: vi.fn(() => Promise.resolve()), claim: () => Promise.resolve() },
    location: { origin: 'https://app.example.test' },
    skipWaiting: vi.fn(),
  };
  const code = readFileSync(resolve(__dirname, '../../public/sw.js'), 'utf8');
  runInNewContext(code, { self, caches: {}, fetch: vi.fn(), URL, MessageChannel, setTimeout, clearTimeout, Promise, JSON, Math, Number, String });
  const fire = async (type: string, extra: Record<string, unknown>) => {
    const waits: Promise<unknown>[] = [];
    handlers[type]({ ...extra, waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
  };
  return { fire, setAppBadge, clearAppBadge, showNotification };
}

const push = (payload: object) => ({ data: { json: () => payload, text: () => JSON.stringify(payload) } });

describe('service worker badge', () => {
  it('sets the app badge from the count a push carries, and still shows the notification', async () => {
    const w = loadWorker();
    await w.fire('push', push({ title: 'Asha in #MuleSoft Support', body: 'Deploy is green', type: 'Message', tag: 'n1', badge: 7, category: 'messages', link: '/chat/x' }));
    expect(w.setAppBadge).toHaveBeenCalledWith(7);
    expect(w.showNotification).toHaveBeenCalledTimes(1);
  });

  it('clears the badge when a push says nothing is unread, and leaves it alone when the push has no count', async () => {
    const w = loadWorker();
    await w.fire('push', push({ title: 'x', badge: 0 }));
    expect(w.clearAppBadge).toHaveBeenCalledTimes(1);
    await w.fire('push', push({ title: 'y' }));
    expect(w.setAppBadge).not.toHaveBeenCalled();
  });

  it('follows the open page, and takes one off when a notification is opened', async () => {
    const w = loadWorker();
    await w.fire('message', { data: { type: 'pm-badge', count: 3 } });
    expect(w.setAppBadge).toHaveBeenLastCalledWith(3);
    await w.fire('notificationclick', { action: '', notification: { close: () => undefined, data: { link: '/my-work' } } });
    expect(w.setAppBadge).toHaveBeenLastCalledWith(2);
    await w.fire('message', { data: { type: 'pm-badge', count: 0 } });
    expect(w.clearAppBadge).toHaveBeenCalled();
  });
});
