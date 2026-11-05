import { activityApi, type ActivityEntityType, type ActivityEntry } from '../../api/endpoints.history';
import { useWsQuery } from '../../lib/hooks';
import { dm } from '../projects/planSheet';
import './extension.css';

const when = (iso: string) => {
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  const t = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return days <= 0 ? `Today ${t}` : days === 1 ? `Yesterday ${t}` : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + ` ${t}`;
};
const isDate = (v: string | null) => !!v && /^\d{4}-\d{2}-\d{2}/.test(v);
const show = (v: string | null) => (v == null || v === '' ? '—' : isDate(v) ? dm(v) : v);

/**
 * The Activity tab of a task or project panel: every change, newest first, with who and when; a field change shows from → to, and a date
 * moved later shows "Extended" with the reason given (GET /activity?entityType&entityId).
 */
export function ActivityHistory({ type, id }: { type: ActivityEntityType; id: string }) {
  const q = useWsQuery(['activity', type, id], () => activityApi.list(type, id, 1, 50), { staleTime: 15_000, retry: false });
  const items: ActivityEntry[] = q.data?.items ?? [];
  if (q.isLoading) return <p className="xh-empty">Loading history…</p>;
  if (q.isError) return <p className="xh-empty">History could not be loaded.</p>;
  if (!items.length) return <p className="xh-empty">No changes yet.</p>;
  return (
    <ol className="xh" data-testid="activity-history" aria-label="Activity history">
      {items.map((e) => {
        const ext = e.action === 'date_extended';
        return (
          <li key={e.id} className={ext ? 'ext' : ''}>
            <i className="xh-dot" aria-hidden="true" />
            <div className="xh-b">
              <div className="xh-l"><b>{e.actor?.name ?? 'Someone'}</b> {ext ? <span className="xd-badge">Extended</span> : null} {e.summary}</div>
              {e.field && (e.from != null || e.to != null) && <div className="xh-ch"><s>{show(e.from)}</s> → <b>{show(e.to)}</b></div>}
              {e.reason && <div className="xh-r">“{e.reason}”</div>}
              <time className="xh-t" dateTime={e.at}>{when(e.at)}</time>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** Two tabs over a panel's body: Details and Activity. */
export function PanelTabs({ tab, setTab }: { tab: 'details' | 'activity'; setTab: (t: 'details' | 'activity') => void }) {
  return (
    <div className="xh-tabs" role="tablist" aria-label="Panel">
      {(['details', 'activity'] as const).map((t) => (
        <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} data-tab={t} onClick={() => setTab(t)}>{t === 'details' ? 'Details' : 'Activity'}</button>
      ))}
    </div>
  );
}
