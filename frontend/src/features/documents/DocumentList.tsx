import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useInfiniteQuery } from '@tanstack/react-query';
import { documentApi, projectApi } from '../../api/endpoints';
import type { DocumentItem, DocumentStatus } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Select } from '../../components/Select';
import { Avatar, EmptyState, ErrorState, PageLoader } from '../../components/ui';
import { timeAgo } from '../../lib/format';
import { useDebounced, useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { DocStatusBadge, TypeChip, VISIBILITY } from './docUi';

const STATUSES: DocumentStatus[] = ['Draft', 'InReview', 'ChangesRequested', 'Approved', 'Published', 'Archived'];

function Row({ d, showProject }: { d: DocumentItem; showProject: boolean }) {
  const place = d.projectName ? `${d.projectKey} · ${d.projectName}` : d.teamName ?? 'General';
  return (
    <Link className="doc-row" to={`/documents/${d.id}`}>
      <TypeChip doc={d} />
      <div className="doc-row-main">
        <div className="doc-row-title"><span className="doc-key">{d.key}</span><b>{d.title}</b></div>
        <div className="doc-row-sub">
          <span>{d.typeName}</span>
          {showProject && <span>{place}</span>}
          {d.tags.slice(0, 3).map((t) => <span className="doc-tag" key={t}>{t}</span>)}
        </div>
      </div>
      <div className="doc-row-meta">
        {d.linkedCount > 0 && <span className="doc-links" title={`${d.linkedCount} linked`}><Icon name="git" size={14} /> {d.linkedCount}</span>}
        <span className="doc-vis" title={VISIBILITY[d.visibility].hint}><Icon name={VISIBILITY[d.visibility].icon} size={14} /></span>
        <DocStatusBadge status={d.status} />
        <span className="doc-owner"><Avatar name={d.owner.name} /><span>{d.owner.name}</span></span>
        <span className="muted doc-when">{timeAgo(d.updatedAt)}</span>
      </div>
    </Link>
  );
}

/** The documents a person may open, filtered and paged. Used on the Documents page and on a project's Documents tab (then fixed to that project). */
export function DocumentList({ projectId, onNew, canCreate }: { projectId?: string; onNew?: () => void; canCreate: boolean }) {
  const wid = useWorkspaceId();
  const [q, setQ] = useState('');
  const [typeId, setTypeId] = useState('');
  const [status, setStatus] = useState('');
  const [scope, setScope] = useState('');   // '' all, 'general', or a project id
  const dq = useDebounced(q.trim(), 300);
  const types = useWsQuery(['document-types'], documentApi.types);
  const projects = useWsQuery(['projects', 'options'], () => projectApi.list({ pageSize: 100 }), { enabled: !projectId });

  const query = useInfiniteQuery({
    queryKey: [wid, 'documents', { projectId, dq, typeId, status, scope }],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => documentApi.list({ projectId: projectId ?? (scope && scope !== 'general' ? scope : undefined), general: scope === 'general' ? true : undefined, q: dq || undefined, typeId: typeId || undefined, status: status || undefined, cursor: pageParam, limit: 25 }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: !!wid,
  });
  const items = query.data?.pages.flatMap((p) => p.items) ?? [];
  const total = query.data?.pages[0]?.total ?? null;
  const filtered = !!(dq || typeId || status || scope);

  return (
    <div className="doc-list">
      <div className="doc-filters">
        <div className="doc-search"><Icon name="search" size={16} /><input className="input" type="search" placeholder="Search titles, text and tags, or DOC-12…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search documents" /></div>
        <Select className="select" value={typeId} onChange={(e) => setTypeId(e.target.value)} aria-label="Kind"><option value="">All kinds</option>{types.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select>
        <Select className="select" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status"><option value="">Any status</option>{STATUSES.map((s) => <option key={s} value={s}>{s.replace(/([A-Z])/g, ' $1').trim()}</option>)}</Select>
        {!projectId && (
          <Select className="select" value={scope} onChange={(e) => setScope(e.target.value)} aria-label="Project">
            <option value="">Everywhere</option><option value="general">General (no project)</option>
            {projects.data?.items.map((p) => <option key={p.id} value={p.id}>{p.key} · {p.name}</option>)}
          </Select>
        )}
      </div>

      {query.isLoading ? <PageLoader /> : query.isError ? <ErrorState error={query.error} retry={() => query.refetch()} /> : items.length === 0 ? (
        <EmptyState icon="note" title={filtered ? 'No documents match' : 'No documents yet'}
          text={filtered ? 'Try fewer filters or a different word.' : 'Write a requirement document, API documentation or a test plan, and link it to the work that delivers it.'}
          action={canCreate && !filtered ? <button className="btn btn-primary" onClick={onNew}><Icon name="plus" /> New document</button> : undefined} />
      ) : (
        <>
          <div className="doc-rows">{items.map((d) => <Row key={d.id} d={d} showProject={!projectId} />)}</div>
          <div className="doc-foot">
            <span className="muted">{total !== null ? `${items.length} of ${total}` : `${items.length} shown`}</span>
            {query.hasNextPage && <button className="btn btn-ghost btn-sm" onClick={() => query.fetchNextPage()} disabled={query.isFetchingNextPage}>{query.isFetchingNextPage ? 'Loading…' : 'Show more'}</button>}
          </div>
        </>
      )}
    </div>
  );
}
