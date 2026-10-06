import { QueryClient } from '@tanstack/react-query';
import { create } from 'zustand';
import { setAccessToken, setAuthLostHandler, refreshSession } from '../api/client';
import { authApi, meApi, pushApi, workspaceApi } from '../api/endpoints';
import { disableNativePush } from '../lib/native';
import type { AppContext, AuthResponse } from '../api/types';
import { clearOfflineData, readOfflineSnapshot } from '../features/offline/storage';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 20_000, refetchOnWindowFocus: false,
      retry: (count, err: any) => count < 1 && !(err?.status >= 400 && err?.status < 500),
    },
  },
});

interface AuthState {
  /** offline: started without a connection - the saved My work is shown until it is back. */
  status: 'loading' | 'authenticated' | 'anonymous' | 'offline';
  ctx: AppContext | null;
  bootstrap: () => Promise<void>;
  /** Resolves with a challenge when two-step verification is on; finish with `loginMfa`. */
  login: (email: string, password: string) => Promise<{ mfaChallenge?: string }>;
  completeSession: (auth: AuthResponse) => Promise<void>;
  loginMfa: (challenge: string, code: string) => Promise<void>;
  logout: () => Promise<void>;
  reloadContext: () => Promise<AppContext>;
  /** Moves to another organization and its address (/acme/…), for when the person chooses one, creates one or joins one. */
  switchWorkspace: (id: string) => Promise<void>;
  /** Makes an organization the active one without touching the address: the address already names it (a link, the Back button). */
  activateWorkspace: (id: string) => Promise<void>;
}

export const useAuth = create<AuthState>((set, get) => ({
  status: 'loading',
  ctx: null,

  /** On page load: trade the HttpOnly refresh cookie for an access token, then load the user's context. */
  bootstrap: async () => {
    const auth = await refreshSession();
    if (!auth) { set({ status: !navigator.onLine && readOfflineSnapshot() ? 'offline' : 'anonymous', ctx: null }); return; }
    try { await get().reloadContext(); }
    catch { setAccessToken(null); set({ status: 'anonymous', ctx: null }); }
  },

  login: async (email, password) => {
    const res = await authApi.login({ email, password });
    if ('mfaRequired' in res) return { mfaChallenge: res.challenge };
    setAccessToken(res.accessToken);
    queryClient.clear();
    await get().reloadContext();
    return {};
  },

  /** A session that was opened some other way than a password (approved on a phone): the same steps as a sign-in. */
  completeSession: async (auth) => {
    setAccessToken(auth.accessToken);
    queryClient.clear();
    await get().reloadContext();
  },

  loginMfa: async (challenge, code) => {
    const auth = await authApi.loginMfa({ challenge, code });
    setAccessToken(auth.accessToken);
    queryClient.clear();
    await get().reloadContext();
  },

  logout: async () => {
    // This phone stops receiving this person's alerts (the next person to sign in turns them on for themselves).
    await disableNativePush((e) => pushApi.unsubscribe(e)).catch(() => undefined);
    try { await authApi.logout(); } catch { /* session may already be gone */ }
    clearOfflineData();   // nothing of this person stays on the device
    setAccessToken(null);
    queryClient.clear();
    set({ status: 'anonymous', ctx: null });
  },

  reloadContext: async () => {
    let ctx = await meApi.context();
    // The saved workspace can disappear (removed from it, suspended): fall back to another one the user belongs to.
    // But if it was refused by an org security policy instead (ctx.blocked), don't silently hop away — show the
    // blocked screen so the person can recover in place (e.g. turn on two-step verification) or switch themselves.
    if (!ctx.current && !ctx.blocked && ctx.workspaces.length > 0) {
      const next = ctx.workspaces.find((w) => w.type === 'Personal') ?? ctx.workspaces[0];
      const res = await workspaceApi.switch(next.id);
      setAccessToken(res.accessToken);
      ctx = await meApi.context();
    }
    set({ ctx, status: 'authenticated' });
    return ctx;
  },

  switchWorkspace: async (id) => {
    const res = await workspaceApi.switch(id);
    setAccessToken(res.accessToken);
    queryClient.clear(); // every cached query belongs to the previous tenant
    const ctx = await meApi.context();
    // The address changes first, in the same step as the new organization, so the app never sees one without the other.
    if (ctx.current) window.history.replaceState(null, '', `/${ctx.current.slug}/`);
    set({ ctx, status: 'authenticated' });
  },

  activateWorkspace: async (id) => {
    const res = await workspaceApi.switch(id);
    setAccessToken(res.accessToken);
    queryClient.clear();
    await get().reloadContext();
  },
}));

setAuthLostHandler(() => {
  queryClient.clear();
  useAuth.setState({ status: 'anonymous', ctx: null });
});

/**
 * The home address shows the public page to someone signed out and the app to someone signed in. This remembers, on this device only,
 * that someone has signed in (no data, just a flag) so the next visit opens the app at once, and switches the page over the moment a
 * session is confirmed (index.html decides the first paint from the same flag).
 */
useAuth.subscribe((s, prev) => {
  if (s.status === prev.status) return;
  const known = s.status === 'authenticated' || s.status === 'offline';
  if (s.status !== 'loading') { try { if (known) localStorage.setItem('pm_hint', '1'); else localStorage.removeItem('pm_hint'); } catch { /* storage unavailable */ } }
  if (known) { const c = document.documentElement.classList; c.remove('landing'); c.add('app'); }
});

// ---- selectors / helpers
export const useWorkspaceId = () => useAuth((s) => s.ctx?.current?.id ?? null);
export const useCan = (permission: string) => useAuth((s) => s.ctx?.current?.permissions.includes(permission) ?? false);
export const useEntitlement = (key: string) => useAuth((s) => s.ctx?.current?.entitlements[key] ?? 0);
/** Level (0 none, 1 view, 2 edit, 3 full) the signed-in user has in a module, from their job role. */
export const useModule = (id: string) => useAuth((s) => s.ctx?.current?.modules?.[id] ?? 0);
export const useIsPersonal = () => useAuth((s) => s.ctx?.current?.type === 'Personal');
