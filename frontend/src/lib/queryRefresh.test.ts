import { expect, it } from 'vitest';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { refreshMutationFamilies } from './queryRefresh';
it('updates a mounted stale list while leaving another tenant and unopened screens off the network', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(['one', 'work'], ['old ticket']);
  client.setQueryData(['two', 'work'], ['other tenant']);
  client.setQueryData(['one', 'projects'], ['unopened project']);
  let reads = 0;
  const observer = new QueryObserver(client, { queryKey: ['one', 'work'], staleTime: Infinity, queryFn: async () => { reads++; return ['new ticket']; } });
  const stop = observer.subscribe(() => undefined);
  try {
    await refreshMutationFamilies(client, 'one', new Set(['work', 'projects']));
    expect(client.getQueryData(['one', 'work'])).toEqual(['new ticket']);
    expect(client.getQueryData(['two', 'work'])).toEqual(['other tenant']);
    expect(client.getQueryData(['one', 'projects'])).toEqual(['unopened project']);
    expect(client.getQueryState(['one', 'projects'])?.isInvalidated).toBe(true);
    expect(reads).toBe(1);
  } finally { stop(); client.clear(); }
});
