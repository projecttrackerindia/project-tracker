import { afterEach, expect, it, vi } from 'vitest';
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
it('downloads nothing on startup; only the intended destination, once', async () => {
  const listeners: Record<string, (event: unknown) => void> = {};
  vi.stubGlobal('window', { location: { href: 'https://example.test/acme/home', origin: 'https://example.test' } });
  vi.stubGlobal('document', { hidden: false, addEventListener: (name: string, fn: (event: unknown) => void) => { listeners[name] = fn; } });
  vi.stubGlobal('navigator', { connection: { saveData: false } });
  const { registerPage, prefetchPages } = await import('./prefetchPages');
  const projects = vi.fn(async () => undefined), work = vi.fn(async () => undefined);
  registerPage(work, ['/work']); registerPage(projects, ['/work/projects']); prefetchPages();
  expect(work).not.toHaveBeenCalled(); expect(projects).not.toHaveBeenCalled();
  const intent = { target: { closest: () => ({ href: 'https://example.test/acme/work/projects', hasAttribute: () => false }) } };
  listeners.pointerover(intent); listeners.focusin(intent);
  expect(projects).toHaveBeenCalledTimes(1); expect(work).not.toHaveBeenCalled();
  (navigator as Navigator & { connection: { saveData: boolean } }).connection.saveData = true;
  listeners.pointerover({ target: { closest: () => ({ href: 'https://example.test/acme/work', hasAttribute: () => false }) } });
  expect(work).not.toHaveBeenCalled();
});
