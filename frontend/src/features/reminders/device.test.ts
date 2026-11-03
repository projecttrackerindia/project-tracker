import { afterEach, expect, it, vi } from 'vitest';
import { pushApi } from '../../api/endpoints';
vi.mock('../../api/endpoints', () => ({ pushApi: { subscribe: vi.fn(), status: vi.fn(), unsubscribe: vi.fn() } }));
vi.mock('../../api/client', () => ({ ApiError: class ApiError extends Error {} }));
vi.mock('../../lib/orgPath', () => ({ orgHref: (s: string) => s }));
vi.mock('../../lib/attention', () => ({ playSound: vi.fn(), primeSound: vi.fn(), setSoundOn: vi.fn(), soundOn: vi.fn() }));
vi.mock('../../lib/desktop', () => ({ isDesktopApp: () => false }));
vi.mock('../../lib/native', () => ({ isNativeApp: () => false, enableNativePush: vi.fn(), nativeEndpoint: vi.fn(), nativePermission: vi.fn() }));
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); vi.clearAllMocks(); });
it('keeps fallback notifications until the server acknowledges an existing browser subscription', async () => {
  const sub = { toJSON: () => ({ endpoint: 'https://push.example.test/device', keys: { p256dh: 'key', auth: 'auth' } }) };
  const reg = { active: {}, pushManager: { getSubscription: async () => sub } };
  vi.stubGlobal('Notification', { permission: 'granted' });
  vi.stubGlobal('window', { PushManager: function () {}, dispatchEvent: vi.fn() });
  vi.stubGlobal('navigator', { serviceWorker: { getRegistration: async () => reg, ready: Promise.resolve(reg) } });
  const device = await import('./device');
  expect(await device.deviceAlerts()).toBe('tab-only');
  expect(device.pushCoversThisDevice()).toBe(false);
  vi.mocked(pushApi.status).mockResolvedValue({ publicKey: 'AQID', devices: 1 });
  vi.mocked(pushApi.subscribe).mockResolvedValue({ publicKey: 'AQID', devices: 1 });
  await device.enableDeviceAlerts();
  expect(pushApi.subscribe).toHaveBeenCalledWith(sub.toJSON());
  expect(device.pushCoversThisDevice()).toBe(true);
  vi.mocked(pushApi.subscribe).mockRejectedValue(new Error('offline'));
  await device.enableDeviceAlerts();
  expect(device.pushCoversThisDevice()).toBe(false);
  expect(await device.deviceAlerts()).toBe('tab-only');
  expect(device.lastDeviceError()).toContain('offline');
});


it('shows a page fallback when a registered push does not arrive, and deduplicates an existing OS notice', async () => {
  const showNotification = vi.fn().mockResolvedValue(undefined);
  const reg = { active: {}, getNotifications: vi.fn().mockResolvedValue([]), showNotification };
  vi.stubGlobal('Notification', { permission: 'granted' });
  vi.stubGlobal('window', { PushManager: function () {} });
  vi.stubGlobal('navigator', { serviceWorker: { getRegistration: async () => reg } });
  const device = await import('./device');
  vi.useFakeTimers();
  try {
    const pending = device.systemNotification('New task', 'Assigned to you', 'fallback', '/', { waitForPush: true });
    await vi.advanceTimersByTimeAsync(1500);
    expect(await pending).toBe(true);
    expect(showNotification).toHaveBeenCalledTimes(1);
    reg.getNotifications.mockResolvedValue([{ tag: 'existing' }]);
    expect(await device.systemNotification('Existing', null, 'existing')).toBe(true);
    expect(showNotification).toHaveBeenCalledTimes(1);
    expect(await device.systemNotification('Signed out', null, 'stopped', '/', { shouldShow: () => false })).toBe(false);
    expect(showNotification).toHaveBeenCalledTimes(1);
  } finally { vi.useRealTimers(); }
});

it('signs up again when the subscription was made with an older server key (the push service would refuse it: 403)', async () => {
  const unsubscribe = vi.fn().mockResolvedValue(true);
  const old = { options: { applicationServerKey: new Uint8Array([9, 9, 9]).buffer }, unsubscribe, toJSON: () => ({ endpoint: 'https://push.example.test/old', keys: { p256dh: 'k', auth: 'a' } }) };
  const fresh = { options: { applicationServerKey: new Uint8Array([1, 2, 3]).buffer }, toJSON: () => ({ endpoint: 'https://push.example.test/new', keys: { p256dh: 'k2', auth: 'a2' } }) };
  const subscribe = vi.fn().mockResolvedValue(fresh);
  const reg = { active: {}, pushManager: { getSubscription: vi.fn().mockResolvedValue(old), subscribe } };
  vi.stubGlobal('Notification', { permission: 'granted' });
  vi.stubGlobal('window', { PushManager: function () {}, dispatchEvent: vi.fn() });
  vi.stubGlobal('navigator', { serviceWorker: { getRegistration: async () => reg, ready: Promise.resolve(reg) } });
  vi.mocked(pushApi.status).mockResolvedValue({ publicKey: 'AQID', devices: 1 });   // bytes 1,2,3
  vi.mocked(pushApi.subscribe).mockResolvedValue({ publicKey: 'AQID', devices: 1 });
  const device = await import('./device');
  expect(device.sameKey(old as never, 'AQID')).toBe(false);
  expect(device.sameKey(fresh as never, 'AQID')).toBe(true);
  await device.enableDeviceAlerts();
  expect(unsubscribe).toHaveBeenCalled();
  expect(subscribe).toHaveBeenCalled();
  expect(pushApi.subscribe).toHaveBeenCalledWith(fresh.toJSON());
});

it('the desktop app hands notifications to its main process (Electron shows no service-worker notifications)', async () => {
  vi.doMock('../../lib/desktop', () => ({ isDesktopApp: () => true }));
  const notify = vi.fn();
  const showNotification = vi.fn();
  vi.stubGlobal('Notification', { permission: 'granted' });
  vi.stubGlobal('window', { PushManager: function () {}, ptDesktop: { notify } });
  vi.stubGlobal('navigator', { serviceWorker: { getRegistration: async () => ({ active: {}, showNotification }) } });
  const device = await import('./device');
  expect(await device.systemNotification('Asha mentioned you', 'in #release', 'n-1', '/chat/abc', { osSound: true })).toBe(true);
  expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: 'Asha mentioned you', link: '/chat/abc', tag: 'n-1', silent: false }));
  expect(showNotification).not.toHaveBeenCalled();
  vi.doUnmock('../../lib/desktop');
});
