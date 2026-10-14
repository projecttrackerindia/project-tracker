import { useState } from 'react';
import { useInfiniteQuery, useMutation } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { documentApi, projectApi, workspaceApi } from '../../api/endpoints';
import type { DocumentItem, DocumentStatus } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Select } from '../../components/Select';
import { Avatar, EmptyState, ErrorState, PageLoader } from '../../components/ui';
import { timeAgo } from '../../lib/format';
import { useDebounced, useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { ClassificationBadge, DocStatusBadge, TypeChip, VISIBILITY } from './docUi';

const STATUSES: DocumentStatus[] = ['Draft', 'InReview', 'ChangesRequested', 'Approved', 'Published', 'Archived'];
type SortKey = 'updated' | 'title' | 'owner';
const VIEW_KEY = 'pf_documents_view';

function sortItems(items: DocumentItem[], sort: SortKey): DocumentItem[] {
  if (sort === 'title') return [...items].sort((a, b) => a.title.localeCompare(b.title));
  if (sort === 'owner') return [...items].sort((a, b) => a.owner.name.localeCompare(b.owner.name));
  return items;   // 'updated' is already the server's own order
}

function Meta({ d }: { d: DocumentItem }) {
  return (
    <>
      <span className="doc-version muted" title="Version">v{d.versionLabel}</span>
      {d.sharedCount > 0 && <span className="doc-shared" title={`Shared with ${d.sharedCount} ${d.sharedCount === 1 ? 'grant' : 'grants'}`}><Icon name="users" size={14} /> {d.sharedCount}</span>}
      {d.linkedCount > 0 && <span className="doc-links" title={`${d.linkedCount} linked`}><Icon name="git" size={14} /> {d.linkedCount}</span>}
      {(d.classification === 'Confidential' || d.classification === 'Restricted') && <ClassificationBadge classification={d.classification} />}
      <span className="doc-vis" title={VISIBILITY[d.visibility].hint}><Icon name={VISIBILITY[d.visibility].icon} size={14} /></span>
      <DocStatusBadge status={d.status} />
      <span className="doc-owner"><Avatar name={d.owner.name} userId={d.owner.id} /><span>{d.owner.name}</span></span>
      <span className="muted doc-when">{timeAgo(d.updatedAt)}</span>
    </>
  );
}

function Card({ d, showProject }: { d: DocumentItem; showProject: boolean }) {
  const place = d.projectName ? `${d.projectKey} · ${d.projectName}` : d.teamName ?? 'General';
  return (
    <Link className="card doc-card" to={`/documents/${d.id}`}>
      <div className="doc-card-head"><TypeChip doc={d} size={30} /><span className="doc-key">{d.key}</span></div>
      <b className="doc-card-title">{d.title}</b>
      <div className="doc-row-sub">
        <span>{d.typeName}</span>
        {showProject && <span>{place}</span>}
        {d.tags.slice(0, 3).map((t) => <span className="doc-tag" key={t}>{t}</span>)}
      </div>
      <div className="doc-card-meta"><Meta d={d} /></div>
    </Link>
  );
}

function Row({ d, showProject, trash, onRestored }: { d: DocumentItem; showProject: boolean; trash?: boolean; onRestored?: () => void }) {
  const place = d.projectName ? `${d.projectKey} · ${d.projectName}` : d.teamName ?? 'General';
  const restore = useMutation({
    mutationFn: () => documentApi.restore(d.id),
    onSuccess: () => { toast(`${d.key} restored.`); onRestored?.(); },
    onError: (e) => toast(e instanceof ApiError ? e.message : 'Could not restore.', 'error'),
  });
  const content = (
    <>
      <TypeChip doc={d} />
      <div className="doc-row-main">
        <div className="doc-row-title"><span className="doc-key">{d.key}</span><b>{d.title}</b></div>
        <div className="doc-row-sub">
          <span>{d.typeName}</span>
          {showProject && <span>{place}</span>}
          {d.tags.slice(0, 3).map((t) => <span className="doc-tag" key={t}>{t}</span>)}
        </div>
      </div>
      <div className="doc-row-meta"><Meta d={d} /></div>
    </>
  );
  if (trash) {
    return (
      <div className="doc-row doc-row-trash">
        {content}
        <button className="btn btn-ghost btn-sm" disabled={restore.isPending} onClick={(e) => { e.preventDefault(); restore.mutate(); }}>
          {restore.isPending && <span className="spinner" />}<Icon name="undo" size={14} /> Restore
        </button>
      </div>
    );
  }
  return <Link className="doc-row" to={`/documents/${d.id}`}>{content}</Link>;
}

type FixedScope = 'recent' | 'shared' | 'trash';

/**
 * The documents a person may open, filtered and paged. Used on the Documents page and on a project's Documents tab (then fixed to that project).
 * `fixedScope` shows a server-ordered, un-filterable list instead (Recently viewed / Shared with me / Trash - each a fixed, usually small list,
 * which is the point). `mine` and `restricted` instead narrow the NORMAL filterable list (My Documents / Restricted Documents are still worth
 * searching and filtering within).
 */
export function DocumentList({ projectId, general, onNew, canCreate, fixedScope, mine, restricted }: {
  projectId?: string; general?: boolean; onNew?: () => void; canCreate: boolean; fixedScope?: FixedScope; mine?: string; restricted?: boolean;
}) {
  const wid = useWorkspaceId();
  const [q, setQ] = useState('');
  const [typeId, setTypeId] = useState('');
  const [status, setStatus] = useState('');
  const [scope, setScope] = useState('');   // '' all, 'general', or a project id
  const [ownerId, setOwnerId] = useState('');
  const [tag, setTag] = useState('');
  const [sort, setSort] = useState<SortKey>('updated');
  const [view, setViewState] = useState<'list' | 'grid'>(() => {
    try { return localStorage.getItem(VIEW_KEY) === 'grid' ? 'grid' : 'list'; } catch { return 'list'; }
  });
  const setView = (v: 'list' | 'grid') => { setViewState(v); try { localStorage.setItem(VIEW_KEY, v); } catch { /* storage unavailable */ } };
  const dq = useDebounced(q.trim(), 300);
  const dtag = useDebounced(tag.trim(), 300);
  const types = useWsQuery(['document-types'], documentApi.types, { enabled: !fixedScope });
  const projects = useWsQuery(['projects', 'options'], () => projectApi.list({ pageSize: 100 }), { enabled: !projectId && !general && !fixedScope });
  const members = useWsQuery(['members'], workspaceApi.members, { enabled: !fixedScope && !mine });

  const query = useInfiniteQuery({
    queryKey: fixedScope ? [wid, 'documents', fixedScope] : [wid, 'documents', { projectId, general, dq, typeId, status, scope, ownerId, dtag, mine, restricted }],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => fixedScope
      ? documentApi.list({ scope: fixedScope, limit: 50 })
      : documentApi.list({
          projectId: projectId ?? (scope && scope !== 'general' ? scope : undefined), general: general || scope === 'general' ? true : undefined,
          q: dq || undefined, typeId: typeId || undefined, status: status || undefined, ownerId: mine ?? (ownerId || undefined),
          tag: dtag || undefined, scope: restricted ? 'restricted' : undefined, cursor: pageParam, limit: 25,
        }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: !!wid,
  });
  const items = sortItems(query.data?.pages.flatMap((p) => p.items) ?? [], fixedScope ? 'updated' : sort);
  const total = query.data?.pages[0]?.total ?? null;
  const filtered = !fixedScope && !!(dq || typeId || status || scope || ownerId || dtag);
  const trash = fixedScope === 'trash';
  const grid = view === 'grid' && !fixedScope && !trash;

  const emptyCopy: Record<string, { title: string; text: string }> = {
    recent: { title: 'Nothing viewed yet', text: 'Documents you open will show up here.' },
    shared: { title: 'Nothing shared with you yet', text: 'Documents someone grants you access to will show up here.' },
    trash: { title: 'Nothing in the trash', text: 'Deleted documents stay here for 30 days before they are gone for good.' },
  };

  return (
    <div className="doc-list">
      {!fixedScope && (
        <div className="doc-filters">
          <div className="doc-search"><Icon name="search" size={16} /><input className="input" type="search" placeholder="Search titles, text and tags, or DOC-12…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search documents" /></div>
          <Select className="select" value={typeId} onChange={(e) => setTypeId(e.target.value)} aria-label="Kind"><option value="">All kinds</option>{types.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select>
          <Select className="select" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status"><option value="">Any status</option>{STATUSES.map((s) => <option key={s} value={s}>{s.replace(/([A-Z])/g, ' $1').trim()}</option>)}</Select>
          {!projectId && !general && (
            <Select className="select" value={scope} onChange={(e) => setScope(e.target.value)} aria-label="Project">
              <option value="">Everywhere</option><option value="general">General (no project)</option>
              {projects.data?.items.map((p) => <option key={p.id} value={p.id}>{p.key} · {p.name}</option>)}
            </Select>
          )}
          {!mine && (
            <Select className="select" value={ownerId} onChange={(e) => setOwnerId(e.target.value)} aria-label="Owner">
              <option value="">Any owner</option>{members.data?.map((m) => <option key={m.userId} value={m.userId}>{m.displayName}</option>)}
            </Select>
          )}
          <input className="input doc-tag-filter" placeholder="Tag…" value={tag} onChange={(e) => setTag(e.target.value)} aria-label="Tag" />
          <Select className="select" value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="Sort">
            <option value="updated">Recently updated</option><option value="title">Title A–Z</option><option value="owner">Owner A–Z</option>
          </Select>
          <div className="seg" role="group" aria-label="View">
            <button type="button" className={view === 'list' ? 'active' : ''} aria-pressed={view === 'list'} title="List view" onClick={() => setView('list')}><Icon name="list" size={15} /></button>
            <button type="button" className={view === 'grid' ? 'active' : ''} aria-pressed={view === 'grid'} title="Grid view" onClick={() => setView('grid')}><Icon name="grid" size={15} /></button>
          </div>
        </div>
      )}
      {restricted && <p className="muted doc-scope-note">Confidential and Restricted documents — files attached to these are encrypted at rest.</p>}

      {query.isLoading ? <PageLoader /> : query.isError ? <ErrorState error={query.error} retry={() => query.refetch()} /> : items.length === 0 ? (
        <EmptyState icon="note" title={fixedScope ? emptyCopy[fixedScope].title : filtered ? 'No documents match' : 'No documents yet'}
          text={fixedScope ? emptyCopy[fixedScope].text : filtered ? 'Try fewer filters or a different word.' : 'Write a requirement document, API documentation or a test plan, and link it to the work that delivers it.'}
          action={canCreate && !filtered && !fixedScope ? <button className="btn btn-primary" onClick={onNew}><Icon name="plus" /> New document</button> : undefined} />
      ) : (
        <>
          {grid ? (
            <div className="doc-grid">{items.map((d) => <Card key={d.id} d={d} showProject={!projectId} />)}</div>
          ) : (
            <div className="doc-rows">{items.map((d) => <Row key={d.id} d={d} showProject={!projectId} trash={trash} onRestored={() => query.refetch()} />)}</div>
          )}
          <div className="doc-foot">
            <span className="muted">{total !== null ? `${items.length} of ${total}` : `${items.length} shown`}</span>
            {query.hasNextPage && <button className="btn btn-ghost btn-sm" onClick={() => query.fetchNextPage()} disabled={query.isFetchingNextPage}>{query.isFetchingNextPage ? 'Loading…' : 'Show more'}</button>}
          </div>
        </>
      )}
    </div>
  );
}
