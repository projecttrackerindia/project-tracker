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

const tokenFor = (wid: string) => `h.${btoa(JSON.stringify({ wid })).replace(/=+$/, '')}.s`;

describe('session refresh across tabs', () => {
  it('names the tab workspace and reports a token issued for another one', async () => {
    const { client } = await setup();
    const mismatch = vi.fn();
    client.setWorkspaceMismatchHandler(mismatch);
    client.setTabWorkspace('w-tab');
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { accessToken: tokenFor('w-other') } })));
    vi.stubGlobal('fetch', fetch);
    await client.refreshSession();
    expect(fetch.mock.calls[0][1].headers['X-Workspace-Id']).toBe('w-tab');
    expect(mismatch).toHaveBeenCalledWith('w-other');
  });

  it('does not report anything when the token is for the tab workspace', async () => {
    const { client } = await setup();
    const mismatch = vi.fn();
    client.setWorkspaceMismatchHandler(mismatch);
    client.setTabWorkspace('w-tab');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { accessToken: tokenFor('w-tab') } }))));
    await client.refreshSession();
    expect(client.workspaceOfToken(client.getAccessToken())).toBe('w-tab');
    expect(mismatch).not.toHaveBeenCalled();
  });

  it('runs the refresh under the shared browser lock when there is one', async () => {
    const { client } = await setup();
    const request = vi.fn((_name: string, work: () => Promise<unknown>) => work());
    vi.stubGlobal('navigator', { locks: { request } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(session()));
    expect((await client.refreshSession())?.accessToken).toBe('renewed');
    expect(request).toHaveBeenCalledWith('pt-refresh', expect.any(Function));
  });

  it('ends a lost session when an upload cannot be renewed', async () => {
    const { client } = await setup();
    const lost = vi.fn();
    client.setAuthLostHandler(lost);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(error(401)).mockResolvedValueOnce(error(401)));
    await expect(client.uploadFile('/files', new File(['x'], 'x.txt'))).rejects.toMatchObject({ status: 401 });
    expect(lost).toHaveBeenCalledOnce();
    expect(client.getAccessToken()).toBeNull();
  });
});

describe('protected downloads', () => {
  it('passes the view cancellation signal through to the protected file request', async () => {
    const { client, saveFile } = await setup();
    const controller = new AbortController();
    const fetch = vi.fn().mockResolvedValue(new Response('private file'));
    vi.stubGlobal('fetch', fetch);
    await client.download('/me/inbox/attachments/download?token=opaque', 'review.txt', controller.signal);
    expect(fetch.mock.calls[0][1].signal).toBe(controller.signal);
    expect(saveFile).toHaveBeenCalledOnce();
  });

  it('does not save a private file if its view is retired after the response arrives', async () => {
    const { client, saveFile } = await setup();
    const controller = new AbortController();
    const response = new Response('private file');
    const original = response.blob.bind(response);
    response.blob = async () => { const blob = await original(); controller.abort(); return blob; };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    await expect(client.download('/me/inbox/attachments/download?token=opaque', 'review.txt', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(saveFile).not.toHaveBeenCalled();
  });

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

describe('stale access context', () => {
  it('asks the app to re-check its access after a permission refusal, once per burst', async () => {
    const { client } = await setup();
    const stale = vi.fn();
    client.setContextStaleHandler(stale);
    const refuse = () => new Response(JSON.stringify({ errors: [{ code: 'PERMISSION_DENIED', message: 'No' }] }), { status: 403, headers: { 'X-Context-Stale': '1' } });
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => refuse()));
    await expect(client.get('/org')).rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });
    await expect(client.get('/org')).rejects.toMatchObject({ status: 403 });
    expect(stale).toHaveBeenCalledOnce();
  });

  it('ignores other refusals', async () => {
    const { client } = await setup();
    const stale = vi.fn();
    client.setContextStaleHandler(stale);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ errors: [{ code: 'PLAN_LIMIT_REACHED', message: 'Upgrade' }] }), { status: 403 })));
    await expect(client.get('/projects')).rejects.toMatchObject({ status: 403 });
    expect(stale).not.toHaveBeenCalled();
    expect(client.isContextStale(403, 'MODULE_ACCESS_DENIED', null)).toBe(true);
    expect(client.isContextStale(404, 'PERMISSION_DENIED', '1')).toBe(false);
  });
});
