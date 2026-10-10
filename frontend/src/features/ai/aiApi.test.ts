import { afterEach, expect, it, vi } from 'vitest';
import { askAi, type AiStreamEvent } from './aiApi';
import { streamPost } from '../../api/client';

vi.mock('../../api/client', () => ({
  del: vi.fn(), get: vi.fn(), patch: vi.fn(), post: vi.fn(), put: vi.fn(), uploadFile: vi.fn(), streamPost: vi.fn(),
}));
afterEach(() => vi.clearAllMocks());

it('preserves a provider cooldown received inside a successful HTTP stream without replaying the request', async () => {
  vi.mocked(streamPost).mockResolvedValue(new Response(
    'event: error\ndata: {"code":"AI_PROVIDER_LIMIT","message":"Wait before retrying.","retryAfterSeconds":60}\n\n',
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
  ));
  const events: AiStreamEvent[] = [];
  await askAi(null, { text: 'show overdue tasks', mode: 'auto', attachmentIds: [], timeZone: 'Asia/Kolkata' },
    (e) => events.push(e), new AbortController().signal);
  expect(events).toEqual([{ name: 'error', code: 'AI_PROVIDER_LIMIT', message: 'Wait before retrying.', retryAfterSeconds: 60 }]);
  expect(streamPost).toHaveBeenCalledOnce();
});
