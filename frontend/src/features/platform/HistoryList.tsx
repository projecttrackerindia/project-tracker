import { useMemo } from 'react';
import type { HistoryEntry } from '../../api/platformApi';
import { Avatar, ErrorState } from '../../components/ui';
import { formatDate, formatDateTime } from '../../lib/format';
import { useWsQuery } from '../../lib/hooks';
import './platform.css';

const DATE_FIELDS = new Set(['Due date', 'Start date']);
const show = (field: string, v: string | null) => (v === null || v === '' ? 'none' : DATE_FIELDS.has(field) && /^\d{4}-\d{2}-\d{2}$/.test(v) ? formatDate(v) : v);

function when(iso: string) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return formatDate(iso);
}

/**
 * History: every field change, newest first - one entry per save with who and when, then each field as old → new (the old value struck
 * through). `queryKey` should change when the item changes (its version), so the list follows saves made in the panel.
 */
export function HistoryList({ queryKey, load, empty = 'No changes yet. Edits to status, owner, priority, dates and the rest appear here.' }: {
  queryKey: unknown[]; load: () => Promise<HistoryEntry[]>; empty?: string;
}) {
  const q = useWsQuery(['history', ...queryKey], load, { staleTime: 15_000 });
  const groups = useMemo(() => {
    const by = new Map<string, HistoryEntry[]>();
    for (const e of q.data ?? []) { const k = `${e.id}|${e.at}`; by.set(k, [...(by.get(k) ?? []), e]); }
    return [...by.values()];
  }, [q.data]);
  if (q.isLoading) return <div className="pv-hist-skel" aria-busy="true" aria-label="Loading history"><span /><span /><span /></div>;
  if (q.isError) return <ErrorState error={q.error} retry={() => void q.refetch()} />;
  if (groups.length === 0) return <p className="pv-hist-empty">{empty}</p>;
  return (
    <ol className="pv-hist" aria-label="History">
      {groups.map((g) => {
        const first = g[0];
        const who = first.actor?.name || 'Someone';
        return (
          <li key={`${first.id}|${first.at}`} className="pv-hist-item">
            <Avatar name={who} userId={first.actor?.id} size="sm" />
            <div className="pv-hist-main">
              <p className="pv-hist-who"><b>{who}</b> changed {g.length === 1 ? first.field.toLowerCase() : `${g.length} fields`}
                <time dateTime={first.at} title={formatDateTime(first.at)}> · {when(first.at)}</time></p>
              <ul className="pv-hist-fields">
                {g.map((e) => (
                  <li key={e.field}>
                    <span className="pv-hist-f">{e.field}</span>
                    <span className="pv-hist-old">{show(e.field, e.from)}</span>
                    <span className="pv-hist-arrow" aria-label="changed to">→</span>
                    <span className="pv-hist-new">{show(e.field, e.to)}</span>
                  </li>
                ))}
              </ul>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
