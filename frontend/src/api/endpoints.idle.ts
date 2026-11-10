import { ApiError, apiUrl, get, getTabWorkspace, post, put } from './client';
import type { ApiErrorItem, AuthResponse, PasskeyChallenge } from './types';

/** The workspace's "Sign out after inactivity" time in minutes (0 = never). */
export interface IdlePolicy { minutes: number; canManage: boolean; choices: number[] }
/** What the lock screen shows about the session behind the refresh cookie. */
export interface LockState { locked: boolean; userId: string; displayName: string; hasAvatar: boolean; hasPassword: boolean; hasPasskey: boolean; attemptsLeft: number; idleMinutes: number }

/**
 * The lock screen's calls work from the refresh cookie (the access token of a locked session is refused everywhere else), with the header
 * that proves they come from the app itself rather than a cross-site form.
 */
async function lockCall<T>(path: string, body: unknown = {}): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' };
  const ws = getTabWorkspace();
  if (ws) headers['X-Workspace-Id'] = ws;
  const res = await fetch(apiUrl(path), { method: 'POST', credentials: 'include', headers, body: JSON.stringify(body) });
  const text = await res.text();
  let json: { data?: unknown; errors?: ApiErrorItem[]; message?: string } | null = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  if (res.ok) return (json && 'data' in json ? json.data : json) as T;
  const errors: ApiErrorItem[] = json?.errors?.length ? json.errors : [{ code: `HTTP_${res.status}`, message: json?.message ?? res.statusText }];
  throw new ApiError(res.status, json?.message ?? errors[0].message, errors);
}

export const idleApi = {
  policy: () => get<IdlePolicy>('/workspace/idle-policy'),
  setPolicy: (minutes: number) => put<IdlePolicy>('/workspace/idle-policy', { minutes }),
  /** Real use of the app, at most about once a minute. Never retried and never queued: a missed ping is harmless. */
  activity: () => post<IdlePolicy>('/auth/activity', {}, { retry: false, noQueue: true }),
  lock: () => lockCall<void>('/auth/lock'),
  state: () => lockCall<LockState>('/auth/unlock/state'),
  passkeyOptions: () => lockCall<PasskeyChallenge>('/auth/unlock/passkey-options'),
  unlockWithPassword: (password: string) => lockCall<AuthResponse>('/auth/unlock', { password }),
  unlockWithPasskey: (challengeId: string, response: Record<string, unknown>) => lockCall<AuthResponse>('/auth/unlock', { challengeId, response }),
};

/** "15 min", "1 hour", "4 hours", "Never". */
export const idleLabel = (m: number) => (m === 0 ? 'Never' : m < 60 ? `${m} min` : m === 60 ? '1 hour' : `${m / 60} hours`);
