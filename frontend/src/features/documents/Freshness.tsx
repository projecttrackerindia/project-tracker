import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { Icon } from '../../components/Icon';
import { formatDate, formatDateTime, timeAgo } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { queryClient, useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { docAiApi, type DocFreshness } from './docAi';

export const freshnessKey = (id: string) => ['documents', id, 'freshness'];
export const useFreshness = (id: string) => useWsQuery(freshnessKey(id), () => docAiApi.freshness(id), { staleTime: 60_000 });

const KIND_ICON: Record<string, string> = { task: '✅', project: '📁', sprint: '🏃', page: '📄', work: '🧩' };

/** "Verified 12 Oct" next to the page's details, while nothing it describes has changed since. */
export function VerifiedBadge({ f }: { f: DocFreshness | undefined }) {
  if (!f?.verifiedAt || f.stale) return null;
  return <span className="badge badge-success pg-verified" title={`Confirmed still right by ${f.verifiedBy ?? 'the owner'} on ${formatDateTime(f.verifiedAt)}`}><Icon name="tick" size={12} /> Verified {formatDate(f.verifiedAt)}</span>;
}

/**
 * Out of date: the work the page is about (its linked tasks, project, sprint, the pages it mentions) changed after it was last edited or
 * verified. Says what changed, links to each, and lets the owner confirm the page is still right in one click.
 */
export function FreshnessBanner({ id }: { id: string }) {
  const wid = useWorkspaceId();
  const q = useFreshness(id);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const f = q.data;
  if (!f?.stale) return null;
  const verify = async () => {
    setBusy(true);
    try {
      const r = await docAiApi.verify(id);
      queryClient.setQueryData([wid, ...freshnessKey(id)], r);
      invalidateWorkspace(wid, 'documents');
      toast('Marked as verified. Readers see it is up to date.', 'success');
    } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not mark it verified.', 'error'); }
    setBusy(false);
  };
  return (
    <div className="pg-stale" role="status">
      <div className="pg-stale-main">
        <span className="pg-stale-icon" aria-hidden="true">⏳</span>
        <div>
          <b>This page may be out of date</b>
          <p>{f.summary || `${f.reasons.length} thing${f.reasons.length === 1 ? '' : 's'} it describes changed after it was last edited${f.since ? ` (${timeAgo(f.since)})` : ''}.`}</p>
        </div>
        <div className="pg-stale-actions">
          {f.reasons.length > 0 && <button type="button" className="btn btn-ghost btn-sm" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{open ? 'Hide' : 'What changed'}</button>}
          {f.canVerify && <button type="button" className="btn btn-primary btn-sm" onClick={() => void verify()} disabled={busy}>{busy && <span className="spinner" />}Still correct</button>}
        </div>
      </div>
      {open && (
        <ul className="pg-stale-list">
          {f.reasons.map((r, i) => (
            <li key={`${r.kind}-${r.key}-${i}`}>
              <span aria-hidden="true">{KIND_ICON[r.kind] ?? '•'}</span>
              <Link to={r.link}>{r.key && r.key !== r.title ? `${r.key} · ` : ''}{r.title}</Link>
              <span className="muted">{r.detail} · {timeAgo(r.at)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
