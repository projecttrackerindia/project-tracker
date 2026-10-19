import { ApiError } from '../../api/client';
import { projectApi } from '../../api/endpoints';
import { useWsQuery } from '../../lib/hooks';

export const errText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.errors[0]?.message ?? e.message : fallback);

/** The projects for pickers (what-if, audit filter). */
export const useProjectsLite = () => useWsQuery(['projects', 'lite'], () => projectApi.list({ pageSize: 200 }), { staleTime: 120_000 });
