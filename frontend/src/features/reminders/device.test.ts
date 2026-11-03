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
  vi.mocked(pushApi.subscribe).mockResolvedValue({ publicKey: 'public', devices: 1 });
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
