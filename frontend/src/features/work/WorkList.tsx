import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { WorkKind, WorkListFilters, WorkRow, WorkStatusFilter } from '../../api/workItemsApi';
import { Icon } from '../../components/Icon';
import { EmptyState, ErrorState, PageLoader } from '../../components/ui';
import { dateOffset, todayISO } from '../../lib/format';
import { useDebounced } from '../../lib/hooks';
import { SlaRing } from './Desk';
import { Due, KIND_LABEL, KindChip, Owner, PRIORITY_ORDER, PriorityDot, useWorkList } from './workUi';
import './work.css';

type Group = 'due' | 'status' | 'kind' | 'project' | 'owner' | 'none';
type Sort = 'priority' | 'due' | 'updated' | 'key';
type Show = 'open' | 'closed' | 'all';
const GROUPS: { id: Group; label: string }[] = [
  { id: 'due', label: 'due date' }, { id: 'status', label: 'status' }, { id: 'kind', label: 'kind' }, { id: 'project', label: 'project' }, { id: 'owner', label: 'owner' }, { id: 'none', label: 'none' },
];
const SORTS: { id: Sort; label: string }[] = [{ id: 'priority', label: 'priority' }, { id: 'due', label: 'due date' }, { id: 'updated', label: 'last changed' }, { id: 'key', label: 'key' }];
const SHOWS: { id: Show; label: string }[] = [{ id: 'open', label: 'open' }, { id: 'closed', label: 'done' }, { id: 'all', label: 'all' }];
/** Filters appear only when the list is longer than this (V2-SPEC §1.8). */
export const FILTER_AT = 10;

interface Prefs { group: Group; sort: Sort; show: Show }
const readPrefs = (key: string, fallback: Prefs): Prefs => {
  try { const v = JSON.parse(localStorage.getItem(`pm_work_view_${key}`) ?? 'null') as Partial<Prefs> | null; return { ...fallback, ...(v ?? {}) }; } catch { return fallback; }
};
const writePrefs = (key: string, p: Prefs) => { try { localStorage.setItem(`pm_work_view_${key}`, JSON.stringify(p)); } catch { /* private window */ } };

const DUE_BUCKETS = ['Overdue', 'Today', 'Next 7 days', 'Later', 'No due date'];
const STATUS_ORDER = ['Active', 'Todo', 'Done', 'Cancelled'];
const STATUS_GROUP: Record<string, string> = { Active: 'In progress', Todo: 'To do', Done: 'Done', Cancelled: 'Cancelled' };

function groupOf(w: WorkRow, g: Group, today: string, weekEnd: string): string {
  switch (g) {
    case 'due': return w.isOverdue ? 'Overdue' : !w.dueDate ? 'No due date' : w.dueDate === today ? 'Today' : w.dueDate <= weekEnd ? 'Next 7 days' : 'Later';
    case 'status': return STATUS_GROUP[w.category] ?? w.status;
    case 'kind': return `${KIND_LABEL[w.kind]}s`;
    case 'project': return w.projectName ?? 'No project';
    case 'owner': return w.assignee?.name ?? 'Nobody yet';
    default: return '';
  }
}
function groupRank(g: Group, title: string): number | string {
  if (g === 'due') return DUE_BUCKETS.indexOf(title);
  if (g === 'status') return STATUS_ORDER.map((s) => STATUS_GROUP[s]).indexOf(title);
  if (g === 'kind') return ['Tasks', 'Issues', 'Actions', 'Tickets'].indexOf(title);
  return title === 'No project' || title === 'Nobody yet' ? '￿' : title.toLowerCase();
}
function compare(s: Sort) {
  const due = (w: WorkRow) => w.dueDate ?? '9999-12-31';
  return (a: WorkRow, b: WorkRow) => {
    const byPriority = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
    const byDue = due(a).localeCompare(due(b));
    if (s === 'priority') return byPriority || byDue || a.key.localeCompare(b.key, undefined, { numeric: true });
    if (s === 'due') return byDue || byPriority;
    if (s === 'updated') return b.updatedAt.localeCompare(a.updatedAt);
    return a.key.localeCompare(b.key, undefined, { numeric: true });
  };
}

/**
 * The one Work list (V2-SPEC §3.3): every kind of work in one list, each row with its priority dot, key, title, kind chip, owner and due
 * date (red when late), grouped and sorted as the person chooses. The kind chips narrow it; search, project, owner and "Overdue" appear
 * only when the list is long enough to need them. A row opens the item in the side panel.
 */
export function WorkList({ filters, viewKey, selectedId, onOpen, empty, kinds, defaults, showKinds = true, headExtra, kind: kindProp, onKind }: {
  /** What the server is asked for (mine, team, kind, project …); the list adds status and search. */ filters: WorkListFilters;
  /** Where the group / sort / show choice is remembered. */ viewKey: string;
  selectedId: string | null; onOpen: (id: string) => void;
  empty: { title: string; text?: string; action?: ReactNode };
  /** The kinds this person can see (the chips). */ kinds: WorkKind[];
  defaults?: Partial<Prefs>; showKinds?: boolean; headExtra?: ReactNode;
  /** The kind chip in the address (a project's ?kind=): given, the chips follow it and report changes through `onKind`. */
  kind?: WorkKind | null; onKind?: (k: WorkKind | null) => void;
}) {
  const fallback: Prefs = { group: 'due', sort: 'priority', show: 'open', ...defaults };
  const [prefs, setPrefs] = useState<Prefs>(() => readPrefs(viewKey, fallback));
  useEffect(() => { setPrefs(readPrefs(viewKey, fallback)); }, [viewKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (p: Partial<Prefs>) => setPrefs((x) => { const n = { ...x, ...p }; writePrefs(viewKey, n); return n; });

  const [ownKind, setOwnKind] = useState<WorkKind | null>(null);
  const kind = kindProp !== undefined ? kindProp : ownKind;
  const setKind = (k: WorkKind | null) => { if (onKind) onKind(k); if (kindProp === undefined) setOwnKind(k); };
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim());
  const [projectId, setProjectId] = useState('');
  const [ownerId, setOwnerId] = useState('');
  const [overdue, setOverdue] = useState(false);
  useEffect(() => { setOwnKind(null); setQ(''); setProjectId(''); setOwnerId(''); setOverdue(false); }, [viewKey]);

  const status: WorkStatusFilter = prefs.show;
  const list = useWorkList({ ...filters, kind: filters.kind ?? (showKinds ? undefined : kinds), status, q: dq || undefined });
  // How long the list is before any narrowing: decides whether the filters show at all.
  const base = useWorkList({ ...filters, kind: filters.kind ?? (showKinds ? undefined : kinds), status }, !!dq);
  const baseCount = dq ? base.items.length : list.items.length;
  const narrowed = !!(dq || projectId || ownerId || overdue);
  const showFilters = baseCount > FILTER_AT || narrowed;

  const all = list.items;
  const counts = useMemo(() => { const c: Partial<Record<WorkKind, number>> = {}; for (const w of all) c[w.kind] = (c[w.kind] ?? 0) + 1; return c; }, [all]);
  const projects = useMemo(() => [...new Map(all.filter((w) => w.projectId).map((w) => [w.projectId!, w.projectName ?? w.projectKey ?? ''])).entries()].sort((a, b) => a[1].localeCompare(b[1])), [all]);
  const owners = useMemo(() => [...new Map(all.filter((w) => w.assignee).map((w) => [w.assignee!.id, w.assignee!.name])).entries()].sort((a, b) => a[1].localeCompare(b[1])), [all]);
  const shown = useMemo(() => all.filter((w) => (!kind || w.kind === kind) && (!projectId || (projectId === 'none' ? !w.projectId : w.projectId === projectId))
    && (!ownerId || (ownerId === 'none' ? !w.assignee : w.assignee?.id === ownerId)) && (!overdue || w.isOverdue)), [all, kind, projectId, ownerId, overdue]);

  const today = todayISO();
  const weekEnd = dateOffset(7);
  const groups = useMemo(() => {
    const sorted = [...shown].sort(compare(prefs.sort));
    if (prefs.group === 'none') return [{ title: '', items: sorted }];
    const by = new Map<string, WorkRow[]>();
    for (const w of sorted) { const g = groupOf(w, prefs.group, today, weekEnd); by.set(g, [...(by.get(g) ?? []), w]); }
    return [...by.entries()].sort(([a], [b]) => { const x = groupRank(prefs.group, a), y = groupRank(prefs.group, b); return typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y)); })
      .map(([title, items]) => ({ title, items }));
  }, [shown, prefs.group, prefs.sort, today, weekEnd]);

  const reset = () => { setKind(null); setQ(''); setProjectId(''); setOwnerId(''); setOverdue(false); };
  const chips = showKinds && kinds.length > 1;
  const label = (opts: { id: string; label: string }[], id: string) => opts.find((o) => o.id === id)?.label ?? id;

  return (
    <section className="wk-card" aria-label="Work list">
      <div className="wk-bar">
        {chips ? (
          <div className="wk-kchips" role="group" aria-label="Kind">
            <button type="button" className={`wk-kchip ${kind === null ? 'on' : ''}`} aria-pressed={kind === null} onClick={() => setKind(null)}>All</button>
            {kinds.map((k) => (
              <button key={k} type="button" className={`wk-kchip ${kind === k ? 'on' : ''}`} aria-pressed={kind === k} onClick={() => setKind(kind === k ? null : k)}>
                {KIND_LABEL[k]}{(counts[k] ?? 0) > 0 && <em>{counts[k]}</em>}
              </button>
            ))}
          </div>
        ) : <div className="wk-count">{list.isLoading ? '' : `${shown.length} ${prefs.show === 'closed' ? 'done' : prefs.show === 'all' ? 'in all' : 'open'}`}</div>}
        {headExtra}
        <div className="wk-view" aria-label="Show, group and sort">
          <label className="wk-pick"><span>Show: <b>{label(SHOWS, prefs.show)}</b></span>
            <select aria-label="Show" value={prefs.show} onChange={(e) => set({ show: e.target.value as Show })}>{SHOWS.map((o) => <option key={o.id} value={o.id}>{o.label[0].toUpperCase() + o.label.slice(1)}</option>)}</select></label>
          <span aria-hidden="true">·</span>
          <label className="wk-pick"><span>Group: <b>{label(GROUPS, prefs.group)}</b></span>
            <select aria-label="Group by" value={prefs.group} onChange={(e) => set({ group: e.target.value as Group })}>{GROUPS.map((o) => <option key={o.id} value={o.id}>{o.label[0].toUpperCase() + o.label.slice(1)}</option>)}</select></label>
          <span aria-hidden="true">·</span>
          <label className="wk-pick"><span>Sort: <b>{label(SORTS, prefs.sort)}</b></span>
            <select aria-label="Sort by" value={prefs.sort} onChange={(e) => set({ sort: e.target.value as Sort })}>{SORTS.map((o) => <option key={o.id} value={o.id}>{o.label[0].toUpperCase() + o.label.slice(1)}</option>)}</select></label>
        </div>
      </div>

      {showFilters && (
        <div className="wk-filters" role="group" aria-label="Filters">
          <label className="wk-search"><Icon name="search" size={15} /><input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by title or key" aria-label="Search work" /></label>
          {projects.length > 0 && (
            <label className="wk-select"><select aria-label="Project" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">All projects</option>{projects.map(([id, name]) => <option key={id} value={id}>{name}</option>)}<option value="none">No project</option></select></label>
          )}
          {owners.length > 1 && (
            <label className="wk-select"><select aria-label="Owner" value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
              <option value="">Anyone</option>{owners.map(([id, name]) => <option key={id} value={id}>{name}</option>)}<option value="none">Nobody yet</option></select></label>
          )}
          <button type="button" className={`wk-kchip ${overdue ? 'on danger' : ''}`} aria-pressed={overdue} onClick={() => setOverdue((v) => !v)}>Overdue</button>
          {narrowed && <button type="button" className="btn btn-link btn-sm" onClick={reset}>Clear</button>}
        </div>
      )}

      {list.isLoading ? <PageLoader /> : list.isError ? <ErrorState error={list.error} retry={() => void list.refetch()} /> : shown.length === 0 ? (
        narrowed || kind
          ? <EmptyState icon="search" title="Nothing matches" action={<button type="button" className="btn btn-ghost" onClick={reset}>Clear filters</button>} />
          : <EmptyState icon="checkCircle" title={prefs.show === 'closed' ? 'Nothing done yet' : empty.title} text={prefs.show === 'closed' ? undefined : empty.text} action={empty.action} />
      ) : (
        <div className="wk-list">
          {groups.map((g) => (
            <div key={g.title || 'all'} className="wk-group" role="group" aria-label={g.title || 'Work'}>
              {g.title && <div className={`wk-group-head ${g.title === 'Overdue' ? 'late' : ''}`}><span>{g.title}</span><em>{g.items.length}</em></div>}
              {g.items.map((w) => <WorkRowButton key={w.id} w={w} on={w.id === selectedId} onOpen={onOpen} />)}
            </div>
          ))}
          {list.more && (
            <div className="wk-more">
              {list.hasNextPage
                ? <button type="button" className="btn btn-ghost btn-sm" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>{list.isFetchingNextPage ? 'Loading…' : 'Show more'}</button>
                : <span>Showing the first {all.length}. Narrow the list to see the rest.</span>}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function WorkRowButton({ w, on, onOpen }: { w: WorkRow; on: boolean; onOpen: (id: string) => void }) {
  const done = w.category === 'Done' || w.category === 'Cancelled';
  return (
    <button type="button" className={`wk-row ${on ? 'on' : ''} ${done ? 'done' : ''}`} aria-current={on ? 'true' : undefined} onClick={() => onOpen(w.id)}
      aria-label={`${w.key} ${w.title}, ${KIND_LABEL[w.kind]}, ${w.priority} priority, ${w.status}${w.assignee ? `, ${w.assignee.name}` : ', no owner'}${w.dueDate ? `, due ${w.dueDate}${w.isOverdue ? ', overdue' : ''}` : ''}`}
      title={[w.projectName, w.status, w.typeName && w.kind === 'ticket' ? w.typeName : null].filter(Boolean).join(' · ')}>
      <PriorityDot priority={w.priority} />
      <span className="wk-title">{w.slaDueAt && w.slaStartAt && !done && <SlaRing start={w.slaStartAt} due={w.slaDueAt} state={w.slaState ?? null} />}{w.title}{done && <small> · {w.status}</small>}</span>
      <span className="wk-meta"><span className="wk-key">{w.key}</span><KindChip kind={w.kind} /></span>
      <Owner person={w.assignee} />
      <Due due={w.dueDate} late={w.isOverdue} />
    </button>
  );
}
