import type { PullChip } from '../../api/types';
import { integrationsApi } from '../../api/endpoints';
import { useWsQuery } from '../../lib/hooks';
import './prChips.css';

const STATE: Record<string, string> = { open: 'Open', draft: 'Draft', merged: 'Merged', closed: 'Closed' };
const CHECKS: Record<string, { label: string; cls: string }> = { success: { label: 'Checks passing', cls: 'ok' }, failure: { label: 'Checks failing', cls: 'bad' }, pending: { label: 'Checks running', cls: 'wait' } };

/** Pull request and build status for many work items at once, keyed by item id (items without a pull request are absent). */
export function usePrStatus(ids: string[]) {
  const key = [...new Set(ids)].sort().slice(0, 200);
  const q = useWsQuery(['dev-links', 'status', key.join(',')], () => integrationsApi.devStatus(key), { enabled: key.length > 0, staleTime: 60_000, retry: false });
  return new Map((q.data ?? []).map((d) => [d.itemId, d.pulls]));
}

/**
 * Small chips for a work item's pull requests: "#412 Open" and a dot for its checks ("Checks failing"). The newest pull request only when
 * `compact`, all three otherwise. Each opens the pull request.
 */
export function PrChips({ pulls, compact }: { pulls: PullChip[] | undefined; compact?: boolean }) {
  if (!pulls?.length) return null;
  const shown = compact ? pulls.slice(0, 1) : pulls;
  return (
    <span className={`prc${compact ? ' compact' : ''}`} data-testid="pr-chips">
      {shown.map((p) => {
        const c = p.checks ? CHECKS[p.checks] : undefined;
        return (
          <a key={`${p.repository}#${p.number}`} className={`prc-chip s-${p.state}`} href={/^https:\/\//.test(p.url) ? p.url : undefined} target="_blank" rel="noreferrer noopener"
            title={`${p.title}${p.repository ? ` · ${p.repository}` : ''}${c ? ` · ${c.label}` : ''}`} onClick={(e) => e.stopPropagation()}
            aria-label={`Pull request ${p.number}, ${STATE[p.state] ?? p.state}${c ? `, ${c.label.toLowerCase()}` : ''}`}>
            <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M5 3.25a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm0 2.122a2.25 2.25 0 1 0-1.5 0v5.256a2.25 2.25 0 1 0 1.5 0V5.372ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm7.5-1.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm-.75-5.75v4.128a2.25 2.25 0 1 0 1.5 0V4.75A2.75 2.75 0 0 0 9.75 2H8.5V.5L6 2.75 8.5 5V3.5h1.25c.69 0 1.25.56 1.25 1.25Z" /></svg>
            <b>#{p.number}</b><span>{STATE[p.state] ?? p.state}</span>
            {c && <i className={`prc-ck ${c.cls}`} aria-hidden="true" />}
            {c && !compact && <span className="prc-ck-t">{c.label}</span>}
          </a>
        );
      })}
    </span>
  );
}
