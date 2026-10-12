import { ApiError, apiUrl, get } from './client';

/** Confirm the callback uses this API's cookie jar and that the browser retained the HttpOnly proof before leaving. */
export async function providerConnectionUrl(provider: 'google' | 'microsoft', query: Record<string, string | boolean | undefined>) {
  const result = await get<{ url: string }>(`/integrations/${provider}/connect`, query);
  const callback = new URL(result.url).searchParams.get('redirect_uri');
  const apiOrigin = new URL(apiUrl('/'), window.location.origin).origin;
  if (!callback || new URL(callback).origin !== apiOrigin) {
    throw new ApiError(409, 'The account connection callback uses a different Project Tracker address. Ask your administrator to match the provider redirect URI to this API address.', [{ code: 'OAUTH_CALLBACK_ORIGIN_MISMATCH', message: 'The provider callback and API must use the same address to retain the browser connection cookie.' }]);
  }
  await get(`/integrations/${provider}/callback/browser-check`);
  return result;
}
