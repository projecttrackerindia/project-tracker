import { qualityApi, type ProjectCoverage } from '../../api/qualityApi';
import { useWsQuery } from '../../lib/hooks';
import { useModule } from '../../stores/auth';

/** API test coverage per project (GET /quality/coverage), keyed by project id. Empty without the Work module (Quality lives there). */
export function useCoverage(): Map<string, ProjectCoverage> {
  const work = useModule('work');
  const q = useWsQuery(['quality', 'coverage'], () => qualityApi.coverage(), { enabled: work > 0, retry: false, staleTime: 120_000 });
  return new Map((Array.isArray(q.data?.projects) ? q.data!.projects : []).map((p) => [p.projectId, p]));
}

/** "Tests 50%" with what it means: "1 of 2 endpoints passed in the last 30 days". */
export function coverageText(c: ProjectCoverage | undefined): { label: string; title: string; tone: 'good' | 'ok' | 'low' } | null {
  if (!c || c.endpoints === 0 || c.percent === null) return null;
  return {
    label: `Tests ${c.percent}%`,
    title: `${c.covered} of ${c.endpoints} endpoint${c.endpoints === 1 ? '' : 's'} passed a test in the last 30 days${c.untested ? ` · ${c.untested} without any test case` : ''}`,
    tone: c.percent >= 75 ? 'good' : c.percent >= 40 ? 'ok' : 'low',
  };
}
