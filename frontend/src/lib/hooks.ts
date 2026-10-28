import { useEffect, useState, type RefObject } from 'react';
import { useQuery, type UseQueryOptions } from '@tanstack/react-query';
import { workItemApi, workspaceApi } from '../api/endpoints';
import { queryClient, useAuth, useCan, useWorkspaceId } from '../stores/auth';

/**
 * Query scoped to the current workspace. The workspace id is part of the cache key, so data from one tenant
 * can never be shown while another is active (the cache is also cleared on workspace switch).
 */
export function useWsQuery<T>(key: unknown[], fn: () => Promise<T>, opts?: Omit<UseQueryOptions<T, Error, T, unknown[]>, 'queryKey' | 'queryFn'>) {
  const wid = useWorkspaceId();
  return useQuery<T, Error, T, unknown[]>({ ...opts, queryKey: [wid, ...key], queryFn: fn, enabled: !!wid && (opts?.enabled ?? true) });
}

/** Refetch everything for the current workspace after a mutation. */
export function invalidateWorkspace(wid: string | null | undefined, ...keyPrefix: unknown[]) {
  if (!wid) return Promise.resolve();
  return queryClient.invalidateQueries({ queryKey: keyPrefix.length ? [wid, ...keyPrefix] : [wid] });
}

/** Debounce a rapidly changing value (e.g. a search box). */
export function useDebounced<T>(value: T, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

export interface PersonChoice { id: string; name: string }

/**
 * Whether the signed-in person can look at someone else's timesheet or calendar, and who they may pick from:
 * everyone in the workspace with broad reports access (Owner/Admin, or a job-role profile that explicitly grants
 * it), otherwise just the people who report to them (a plain manager's own team). Shared by Timesheet and Calendar.
 */
export function usePersonPicker() {
  const canSeeOthers = useCan('reports.broad');
  const hasReports = (useAuth((s) => s.ctx?.current?.reportCount) ?? 0) > 0;
  const members = useWsQuery(['members'], () => workspaceApi.members(), { enabled: canSeeOthers });
  const team = useWsQuery(['workload', 'Reports'], () => workItemApi.workload('Reports'), { enabled: !canSeeOthers && hasReports });
  const choices: PersonChoice[] = canSeeOthers
    ? (members.data ?? []).map((m) => ({ id: m.userId, name: m.displayName }))
    : (team.data?.members ?? []).map((m) => ({ id: m.userId, name: m.name }));
  return { canPick: canSeeOthers || hasReports, choices };
}

/** Closes a <details> menu on a click outside it or on Escape (focus goes back to its button). */
export function useDetailsDismiss(control: RefObject<HTMLDetailsElement | null>) {
  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (control.current?.open && event.target instanceof Node && !control.current.contains(event.target)) control.current.open = false;
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && control.current?.open) {
        control.current.open = false;
        control.current.querySelector('summary')?.focus();
      }
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [control]);
}

/**
 * useWsQuery that paints at once: the last answer for this person and workspace is kept for the browser session (sessionStorage) and
 * shown as placeholder data while the fresh one loads, so Today's "Needs you" and stats never sit behind a spinner on a return visit.
 */
export function useCachedWsQuery<T>(key: unknown[], fn: () => Promise<T>, opts?: Omit<UseQueryOptions<T, Error, T, unknown[]>, 'queryKey' | 'queryFn' | 'placeholderData'>) {
  const wid = useWorkspaceId();
  const uid = useAuth((s) => s.ctx?.user?.id ?? null);
  const store = wid && uid ? `pm_qc:${uid}:${wid}:${JSON.stringify(key)}` : null;
  const read = (): T | undefined => {
    if (!store) return undefined;
    try { const v = sessionStorage.getItem(store); return v ? (JSON.parse(v) as T) : undefined; } catch { return undefined; }
  };
  const q = useQuery<T, Error, T, unknown[]>({
    ...opts, queryKey: [wid, ...key], enabled: !!wid && (opts?.enabled ?? true),
    queryFn: async () => { const v = await fn(); if (store) { try { sessionStorage.setItem(store, JSON.stringify(v)); } catch { /* full or blocked */ } } return v; },
    // T is never a function here (query data is JSON), which is all NonFunctionGuard<T> asks for.
    placeholderData: ((prev: T | undefined) => prev ?? read()) as never,
  });
  return q;
}
