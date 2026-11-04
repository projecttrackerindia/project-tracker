import { QueryClient } from '@tanstack/react-query';
import { optimisticMutationCache } from '../lib/optimistic';
import { create } from 'zustand';
import { get as apiGet, refreshWasRefused, setAccessToken, setAuthLostHandler, refreshSession, setTabWorkspace, setWorkspaceMismatchHandler, transientStatus } from '../api/client';
import { authApi, meApi, pushApi, workspaceApi } from '../api/endpoints';
import { isApprovalStart, type ApprovalStart } from '../api/endpoints.sessionApproval';
import { disableNativePush } from '../lib/native';
import { setAppZones } from '../lib/zone';
import type { AppContext, AuthResponse } from '../api/types';
import { clearOfflineData, readOfflineSnapshot } from '../features/offline/storage';
import { clearWarmStart, hydrateWarm, readWarmStart, saveWarmStart } from '../lib/warmStart';

// Someone signed in on this device before (pm_hint): the session check and the warm-start read start as this module loads, before React
// renders anything, so they overlap the rest of the scripts instead of following them.
let earlyRefresh: Promise<AuthResponse | null> | null = null;
if (typeof window !== 'undefined') {
  let hint = false;
  try { hint = localStorage.getItem('pm_hint') === '1'; } catch { /* storage unavailable */ }
  if (hint && !/^\/(login|register|verify-email|forgot-password|reset-password|invite|auth|approve|unsubscribe|s|r)(\/|$)/.test(window.location.pathname)) {
    earlyRefresh = refreshSession();
    void readWarmStart();
  }
}

/**
 * The frame's numbers in one call (/shell/summary: bell and tab badges, Approvals, chat unread, reminders), fetched beside /me and put in
 * the cache under the same keys those badges read, so they do not each make their own first request.
 */
interface ShellSummary { workspaceId: string; notifications: unknown; approvals: unknown; chatUnread: unknown; reminders: unknown }
let pendingSummary: Promise<ShellSummary | null> | null = null;
function seedSummary(s: ShellSummary | null, wid: string | undefined) {
  if (!s || !wid || s.workspaceId !== wid) return;   // only ever into the workspace it was read for
  const put = (key: unknown[], v: unknown) => { if (v !== null && v !== undefined) queryClient.setQueryData(key, v); };
  put([wid, 'notifications', 'counts'], s.notifications);
  put([wid, 'approvals', 'counts'], s.approvals);
  put([wid, 'chat', 'unread'], s.chatUnread);
  put([wid, 'reminders', 'counts'], s.reminders);
}

// Every mutation in the app shares one MutationCache: optimistic cache updates, rollback on error and the "✓ Saved" tick (lib/optimistic.ts).
export const queryClient: QueryClient = new QueryClient({
  mutationCache: optimisticMutationCache(() => queryClient),
  defaultOptions: {
    queries: {
      // Answers stay in memory for 30 minutes (the default is 5), so going back to a page paints at once from the cache and refreshes
      // behind it instead of showing a spinner while everything is read again.
      staleTime: 20_000, gcTime: 30 * 60_000, refetchOnWindowFocus: true, refetchOnReconnect: true,
      retry: (count, err: any) => count < 1 && !(err?.status >= 400 && err?.status < 500),
    },
  },
});

interface AuthState {
  /** offline: started without a connection - the saved My work is shown until it is back. */
  status: 'loading' | 'authenticated' | 'anonymous' | 'offline';
  /** Shown from this device's saved copy because the session could not be checked (no connection): renewed when it is back. */
  offlineSession?: boolean;
  ctx: AppContext | null;
  bootstrap: () => Promise<void>;
  /** Resolves with a challenge when two-step verification is on (finish with `loginMfa`), or with a request to approve on the signed-in device. */
  login: (email: string, password: string) => Promise<{ mfaChallenge?: string; approval?: ApprovalStart }>;
  completeSession: (auth: AuthResponse) => Promise<void>;
  loginMfa: (challenge: string, code: string) => Promise<{ approval?: ApprovalStart }>;
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
    // Warm start: what this device knew last time is on the screen at once (stale), while the session is checked and every read refreshes.
    const refresh = earlyRefresh ?? refreshSession();
    earlyRefresh = null;
    const warm = await readWarmStart();
    const slug = window.location.pathname.split('/').filter(Boolean)[0];
    const sameAddress = warm && (!slug || slug === warm.ctx.current?.slug);
    if (warm && sameAddress && get().status === 'loading') {
      hydrateWarm(queryClient, warm);
      set({ ctx: warm.ctx, status: 'authenticated' });
    }
    const auth = await refresh;
    if (!auth) {
      // No connection (not a refused session): keep showing the saved copy, readable and editable through the outbox, until it is back.
      if (warm && sameAddress && !refreshWasRefused() && get().status === 'authenticated') { set({ offlineSession: true }); return; }
      if (warm) { clearWarmStart(); queryClient.clear(); }
      // Not answered (a release restarting, a blip) is not "signed out": with saved work the offline view shows, and it is tried again.
      const unreachable = !refreshWasRefused();
      set({ status: (!navigator.onLine || unreachable) && readOfflineSnapshot() ? 'offline' : 'anonymous', ctx: null });
      return;
    }
    pendingSummary = apiGet<ShellSummary>('/shell/summary').catch(() => null);
    // The session is good; loading the context can still hit a passing server error - try again before giving up on it.
    for (let attempt = 0; ; attempt++) {
      try {
        const ctx = await get().reloadContext();
        // Someone else signed in on this device since: nothing of the previous person's stays in the cache.
        if (warm && (ctx.user.id !== warm.userId || ctx.current?.id !== warm.workspaceId)) { queryClient.clear(); clearWarmStart(); }
        return;
      }
      catch (e) {
        const status = (e as { status?: number })?.status ?? 0;
        if (attempt >= 2 || !transientStatus(status)) { setAccessToken(null); set({ status: 'anonymous', ctx: null }); return; }
        await new Promise((r) => setTimeout(r, attempt === 0 ? 600 : 1800));
      }
    }
  },

  login: async (email, password) => {
    const res = await authApi.login({ email, password });
    if ('mfaRequired' in res) return { mfaChallenge: res.challenge };
    if (isApprovalStart(res)) return { approval: res };
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
    if (isApprovalStart(auth)) return { approval: auth };
    setAccessToken(auth.accessToken);
    queryClient.clear();
    await get().reloadContext();
    return {};
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
    if (pendingSummary) {
      // At most a short wait: the summary normally lands with /me; a slow one must not hold the page back.
      const summary = await Promise.race([pendingSummary, new Promise<null>((r) => setTimeout(() => r(null), 400))]);
      pendingSummary = null;
      seedSummary(summary, ctx.current?.id);
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
  clearWarmStart();
  queryClient.clear();
  useAuth.setState({ status: 'anonymous', ctx: null });
});

// Keep the warm-start copy current: after reads settle (debounced) and at once when the tab is hidden (a phone closing the app).
if (typeof window !== 'undefined') {
  queryClient.getQueryCache().subscribe((e) => {
    if (e.type === 'updated' && e.action.type === 'success') { const st = useAuth.getState(); if (st.status === 'authenticated') saveWarmStart(queryClient, st.ctx); }
  });
  document.addEventListener('visibilitychange', () => {
    const st = useAuth.getState();
    if (document.visibilityState === 'hidden' && st.status === 'authenticated') saveWarmStart(queryClient, st.ctx, true);
  });
}

// Every refresh names this tab's workspace; keep the API client told which one that is.
useAuth.subscribe((s) => setTabWorkspace(s.ctx?.current?.id ?? null));

/**
 * A refresh came back for another workspace than this tab shows (the person was removed from it, or it was suspended). Load the context
 * the token now carries; the organization router then either re-activates the workspace in the address or moves to one that works. One at a
 * time, so overlapping refreshes cannot bounce between workspaces.
 */
let reconciling = false;
setWorkspaceMismatchHandler(() => {
  if (reconciling || useAuth.getState().status !== 'authenticated') return;
  reconciling = true;
  queueMicrotask(() => {
    queryClient.clear();
    useAuth.getState().reloadContext().catch(() => undefined).finally(() => { reconciling = false; });
  });
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
// Pure, so they're unit-testable without rendering a component or touching the Zustand store;
// the hooks below are thin wrappers that just supply the current ctx.
// Keep the app-wide time zone (lib/zone) in step with whoever is signed in and the workspace they are in.
useAuth.subscribe((s) => setAppZones(s.ctx?.user.timeZone, s.ctx?.current?.timeZone, s.ctx?.timeZone, s.ctx?.timeZoneChosen));

export const hasPermission = (ctx: AppContext | null | undefined, permission: string) => ctx?.current?.permissions.includes(permission) ?? false;
export const entitlementOf = (ctx: AppContext | null | undefined, key: string) => ctx?.current?.entitlements[key] ?? 0;
/** Level (0 none, 1 view, 2 edit, 3 full) the signed-in user has in a module, from their job role. */
export const moduleLevelOf = (ctx: AppContext | null | undefined, id: string) => ctx?.current?.modules?.[id] ?? 0;
export const isPersonalCtx = (ctx: AppContext | null | undefined) => ctx?.current?.type === 'Personal';

export const useWorkspaceId = () => useAuth((s) => s.ctx?.current?.id ?? null);
export const useCan = (permission: string) => useAuth((s) => hasPermission(s.ctx, permission));
export const useEntitlement = (key: string) => useAuth((s) => entitlementOf(s.ctx, key));
export const useModule = (id: string) => useAuth((s) => moduleLevelOf(s.ctx, id));
export const useIsPersonal = () => useAuth((s) => isPersonalCtx(s.ctx));
