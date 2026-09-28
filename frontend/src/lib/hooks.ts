import { useEffect, useState } from 'react';
import { useQuery, type UseQueryOptions } from '@tanstack/react-query';
import { teamViewApi, workspaceApi } from '../api/endpoints';
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
  const team = useWsQuery(['my-team'], () => teamViewApi.get(), { enabled: !canSeeOthers && hasReports });
  const choices: PersonChoice[] = canSeeOthers
    ? (members.data ?? []).map((m) => ({ id: m.userId, name: m.displayName }))
    : (team.data?.members ?? []).map((m) => ({ id: m.userId, name: m.name }));
  return { canPick: canSeeOthers || hasReports, choices };
}
