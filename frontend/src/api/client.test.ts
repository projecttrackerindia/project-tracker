import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/native', () => ({ saveFile: vi.fn() }));
vi.mock('../lib/lensState', () => ({ lensHeaders: () => ({}) }));

const error = (status: number) => new Response(JSON.stringify({ errors: [{ code: `HTTP_${status}`, message: 'Refused' }] }), { status });
const session = () => new Response(JSON.stringify({ data: { accessToken: 'renewed' } }));

async function setup() {
  vi.resetModules();
  const client = await import('./client');
  const { saveFile } = await import('../lib/native');
  client.setAccessToken('expired');
  return { client, saveFile: vi.mocked(saveFile) };
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.clearAllMocks(); });

describe('AI request limits', () => {
  it('preserves the retry delay without automatically resubmitting a limited request', async () => {
    const { client } = await setup();
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ errors: [{ code: 'AI_MINUTE_LIMIT', message: 'Wait before asking again.' }] }),
      { status: 429, headers: { 'Retry-After': '23' } }));
    vi.stubGlobal('fetch', fetch);
    await expect(client.streamPost('/ai/ask', { text: 'hello' })).rejects.toMatchObject({ status: 429, code: 'AI_MINUTE_LIMIT', retryAfterSeconds: 23 });
    expect(fetch).toHaveBeenCalledOnce();
  });
});

describe('protected downloads', () => {
  it.each(['/billing/invoices/one/pdf', '/reports/exports/one/file', '/attachments/one/download', '/documents/one/files/two/download'])(
    'refreshes and retries an expired session for %s', async (path) => {
      const { client, saveFile } = await setup();
      const fetch = vi.fn().mockResolvedValueOnce(error(401)).mockResolvedValueOnce(session()).mockResolvedValueOnce(new Response('file content'));
      vi.stubGlobal('fetch', fetch);
      await client.download(path, 'file.pdf');
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(fetch.mock.calls[1][0]).toBe('/api/v1/auth/refresh');
      expect(fetch.mock.calls[2][1].headers.Authorization).toBe('Bearer renewed');
      expect(fetch.mock.calls[2][0]).toBe(`/api/v1${path}`);
      expect(saveFile).toHaveBeenCalledTimes(1);
      expect(await saveFile.mock.calls[0][0].text()).toBe('file content');
    },
  );

  it('shares one refresh between simultaneous downloads', async () => {
    vi.useFakeTimers();
    const { client, saveFile } = await setup();
    let refreshes = 0;
    const fetch = vi.fn(async (url: string, opts: RequestInit) => {
      if (url.endsWith('/auth/refresh')) { refreshes++; return session(); }
      return (opts.headers as Record<string, string>).Authorization === 'Bearer renewed' ? new Response('file') : error(401);
    });
    vi.stubGlobal('fetch', fetch);
    await Promise.all([client.download('/attachments/one', 'one'), client.download('/attachments/two', 'two')]);
    expect(refreshes).toBe(1);
    expect(saveFile).toHaveBeenCalledTimes(2);
  });

  it('stops after one retry if the renewed token is refused', async () => {
    const { client, saveFile } = await setup();
    const fetch = vi.fn().mockResolvedValueOnce(error(401)).mockResolvedValueOnce(session()).mockResolvedValueOnce(error(401));
    vi.stubGlobal('fetch', fetch);
    await expect(client.download('/file', 'file')).rejects.toMatchObject({ status: 401 });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(saveFile).not.toHaveBeenCalled();
  });

  it('ends a lost session when refresh fails', async () => {
    const { client, saveFile } = await setup();
    const lost = vi.fn();
    client.setAuthLostHandler(lost);
    const fetch = vi.fn().mockResolvedValueOnce(error(401)).mockResolvedValueOnce(error(401));
    vi.stubGlobal('fetch', fetch);
    await expect(client.download('/file', 'file')).rejects.toMatchObject({ status: 401 });
    expect(client.getAccessToken()).toBeNull();
    expect(lost).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(saveFile).not.toHaveBeenCalled();
  });

  it('preserves authorization failures without refreshing or saving error content', async () => {
    const { client, saveFile } = await setup();
    const fetch = vi.fn().mockResolvedValue(error(403));
    vi.stubGlobal('fetch', fetch);
    await expect(client.download('/file', 'file')).rejects.toMatchObject({ status: 403 });
    expect(fetch).toHaveBeenCalledOnce();
    expect(saveFile).not.toHaveBeenCalled();
  });
});
