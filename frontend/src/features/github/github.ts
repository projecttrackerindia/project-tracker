import { integrationsApi } from '../../api/endpoints';
import { useWsQuery } from '../../lib/hooks';

export const safeHref = (url: string) => { try { const u = new URL(url); return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : '#'; } catch { return '#'; } };

/** The ProjectTracker GitHub App in this workspace (shared by Settings, tasks, projects and Home). */
export function useGitHubApp() {
  return useWsQuery(['github-app'], integrationsApi.gitHubApp, { staleTime: 60_000, retry: false });
}

/** Hours as people say them: "5 h", "1.5 days". */
export const hours = (h: number | null | undefined) => h == null ? '—' : h < 48 ? `${Math.round(h * 10) / 10} h` : `${Math.round(h / 2.4) / 10} days`;
