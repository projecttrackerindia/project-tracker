import { afterEach, describe, expect, it, vi } from 'vitest';
import { providerConnectionUrl } from './providerConnection';
import { get } from './client';
vi.mock('./client', () => ({
  get: vi.fn(),
  apiUrl: (path: string) => `/api/v1${path}`,
  ApiError: class extends Error { constructor(public status: number, message: string, public errors: { code: string; message: string }[]) { super(message); } },
}));
afterEach(() => { vi.resetAllMocks(); vi.unstubAllGlobals(); });
const consent = (origin = 'https://tracker.example') => ({ url: `https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=${encodeURIComponent(origin + '/api/v1/integrations/google/callback')}` });
describe('provider connection browser preflight', () => {
  it('checks the retained browser cookie before returning the consent URL', async () => {
    vi.stubGlobal('window', { location: { origin: 'https://tracker.example' } });
    vi.mocked(get).mockResolvedValueOnce(consent()).mockResolvedValueOnce(undefined);
    expect(await providerConnectionUrl('google', { mail: true })).toEqual(consent());
    expect(vi.mocked(get).mock.calls).toEqual([['/integrations/google/connect', { mail: true }], ['/integrations/google/callback/browser-check']]);
  });
  it('stops a callback-host mismatch before navigating to the provider', async () => {
    vi.stubGlobal('window', { location: { origin: 'https://tracker.example' } });
    vi.mocked(get).mockResolvedValueOnce(consent('https://other.example'));
    await expect(providerConnectionUrl('google', {})).rejects.toMatchObject({ status: 409, errors: [{ code: 'OAUTH_CALLBACK_ORIGIN_MISMATCH', message: expect.any(String) }] });
    expect(get).toHaveBeenCalledTimes(1);
  });
  it('surfaces blocked cookies and uses the Microsoft-specific verification endpoint', async () => {
    vi.stubGlobal('window', { location: { origin: 'https://tracker.example' } });
    vi.mocked(get).mockResolvedValueOnce(consent()).mockRejectedValueOnce(new Error('Allow cookies for Project Tracker.'));
    await expect(providerConnectionUrl('microsoft', {})).rejects.toThrow('Allow cookies');
    expect(get).toHaveBeenLastCalledWith('/integrations/microsoft/callback/browser-check');
  });
});
