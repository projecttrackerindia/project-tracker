import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { documentApi, teamApi, workspaceApi } from '../../api/endpoints';
import type { DocumentDetail, DocumentVisibility } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Select } from '../../components/Select';
import { Avatar, ErrorState, Field, Modal, PageLoader, SubmitButton } from '../../components/ui';
import { formatDate, timeAgo } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { queryClient, useIsPersonal, useModule, useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
import { LinkedWork } from './LinkedWork';
import { SectionEditor } from './SectionEditor';
import { DocStatusBadge, TypeChip, VISIBILITY } from './docUi';

function DetailsModal({ detail, onClose }: { detail: DocumentDetail; onClose: () => void }) {
  const wid = useWorkspaceId();
  const personal = useIsPersonal();
  const d = detail.item;
  const members = useWsQuery(['members'], workspaceApi.members);
  const teams = useWsQuery(['teams'], teamApi.list, { enabled: !personal && d.projectId === null });
  const [title, setTitle] = useState(d.title);
  const [visibility, setVisibility] = useState<DocumentVisibility>(d.visibility);
  const [teamId, setTeamId] = useState(d.teamId ?? '');
  const [ownerId, setOwnerId] = useState(d.owner.id);
  const [tags, setTags] = useState(d.tags.join(', '));
  const [error, setError] = useState<string | null>(null);
  const options: DocumentVisibility[] = d.projectId ? ['Project', 'Private'] : ['Team', 'Organization', 'Private'];
  const save = useMutation({
    mutationFn: () => documentApi.update(d.id, { title: title.trim(), visibility, teamId: d.projectId ? null : teamId || null, ownerId, tags: tags.split(',').map((t) => t.trim()).filter(Boolean), revision: detail.revision }),
    onSuccess: (r) => { queryClient.setQueryData([wid, 'documents', d.id], r); invalidateWorkspace(wid, 'documents'); toast('Saved.'); onClose(); },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not save.'),
  });
  return (
    <Modal title="Document details" onClose={onClose} onSubmit={(e) => { e.preventDefault(); setError(null); save.mutate(); }}
      footer={<><button className="btn btn-ghost" type="button" onClick={onClose}>Cancel</button><SubmitButton busy={save.isPending}>Save</SubmitButton></>}>
      {error && <div className="doc-alert" role="alert"><Icon name="alert" size={16} /><div>{error}</div></div>}
      <Field label="Title" required><input className="input" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} /></Field>
      <Field label="Who can open it?" hint={VISIBILITY[visibility].hint}>
        <Select className="select" value={visibility} onChange={(e) => setVisibility(e.target.value as DocumentVisibility)} aria-label="Visibility">{options.map((v) => <option key={v} value={v}>{VISIBILITY[v].label}</option>)}</Select>
      </Field>
      {!d.projectId && visibility === 'Team' && (
        <Field label="Team"><Select className="select" value={teamId} onChange={(e) => setTeamId(e.target.value)} aria-label="Team"><option value="">Choose a team…</option>{teams.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></Field>
      )}
      <Field label="Owner"><Select className="select" value={ownerId} onChange={(e) => setOwnerId(e.target.value)} aria-label="Owner">{members.data?.map((m) => <option key={m.userId} value={m.userId}>{m.displayName}</option>)}</Select></Field>
      <Field label="Tags" hint="Separate with commas."><input className="input" value={tags} onChange={(e) => setTags(e.target.value)} /></Field>
    </Modal>
  );
}

/** One document: its sections (editable by people who may edit), who and where, and the work linked to it. */
export function DocumentPage() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const wid = useWorkspaceId();
  const canWrite = useModule('documents') >= 2;
  const q = useWsQuery(['documents', id], () => documentApi.get(id), { retry: false });
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [details, setDetails] = useState(false);
  const [stale, setStale] = useState(false);
  const detail = q.data;
  const dirty = Object.keys(edits).length > 0;

  const apply = useCallback((r: DocumentDetail) => { queryClient.setQueryData([wid, 'documents', id], r); invalidateWorkspace(wid, 'documents'); }, [wid, id]);
  const save = useMutation({
    mutationFn: () => documentApi.saveSections(id, { revision: detail!.revision, sections: Object.entries(edits).map(([key, content]) => ({ key, content })) }),
    onSuccess: (r) => { setEdits({}); setStale(false); apply(r); toast('Saved.'); },
    onError: (e) => { if (e instanceof ApiError && e.code === 'DOCUMENT_CHANGED') setStale(true); toast(e instanceof ApiError ? e.message : 'Could not save.', 'error'); },
  });
  const run = useMutation({
    mutationFn: (fn: () => Promise<DocumentDetail | void>) => fn(),
    onSuccess: (r) => { if (r) apply(r); },
    onError: (e) => toast(e instanceof ApiError ? e.message : 'That did not work.', 'error'),
  });

  // Leaving with unsaved words asks first; Ctrl/Cmd + S saves.
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
    const key = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && dirty && !save.isPending) { e.preventDefault(); save.mutate(); } };
    window.addEventListener('beforeunload', warn); window.addEventListener('keydown', key);
    return () => { window.removeEventListener('beforeunload', warn); window.removeEventListener('keydown', key); };
  }, [dirty, save]);

  const templates = useWsQuery(['document-types'], documentApi.types);
  const type = templates.data?.find((t) => t.id === detail?.item.typeId);
  const tplFor = useMemo(() => new Map((type?.sections ?? []).map((s) => [s.key, s])), [type]);

  if (q.isLoading) return <PageLoader />;
  if (q.isError || !detail) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const d = detail.item;
  const editable = detail.can.edit && canWrite;
  const set = (key: string, v: string) => setEdits((x) => {
    const orig = detail.sections.find((s) => s.key === key)?.content;
    if (v === orig) { const { [key]: _, ...rest } = x; return rest; }
    return { ...x, [key]: v };
  });

  return (
    <div className="doc-page">
      <nav className="doc-crumbs" aria-label="Breadcrumb">
        <Link to="/documents">Documents</Link>
        {d.projectId && <><Icon name="chevronR" size={13} /><Link to={`/projects/${d.projectId}?tab=documents`}>{d.projectKey}</Link></>}
        <Icon name="chevronR" size={13} /><span>{d.key}</span>
      </nav>

      <header className="doc-head">
        <TypeChip doc={d} size={46} />
        <div className="doc-head-main">
          <h1>{d.title}</h1>
          <div className="doc-head-sub">
            <span className="doc-key">{d.key}</span><span>{d.typeName}</span><DocStatusBadge status={d.status} /><span className="muted">Version {detail.versionLabel}</span>
            {dirty && <span className="doc-dirty">Unsaved changes</span>}
          </div>
        </div>
        <div className="doc-head-actions">
          {editable && <button className="btn btn-primary" onClick={() => save.mutate()} disabled={!dirty || save.isPending}>{save.isPending && <span className="spinner" />}Save</button>}
          {detail.can.edit && <button className="btn btn-ghost" onClick={() => setDetails(true)}><Icon name="edit" size={15} /> Details</button>}
          {d.status !== 'Archived' && detail.can.edit && <button className="btn btn-ghost" onClick={() => run.mutate(() => documentApi.archive(id))}>Archive</button>}
          {d.status === 'Archived' && detail.can.delete && <button className="btn btn-ghost" onClick={() => run.mutate(() => documentApi.reopen(id))}>Reopen</button>}
          {detail.can.delete && (
            <button className="btn btn-ghost danger" onClick={async () => {
              if (!(await confirmDialog({ title: 'Delete this document?', message: `${d.key} “${d.title}” disappears for everyone. You can bring it back for 30 days.`, confirmText: 'Delete' }))) return;
              try { await documentApi.remove(id); invalidateWorkspace(wid, 'documents'); toast('Document deleted.', 'warning'); nav(d.projectId ? `/projects/${d.projectId}?tab=documents` : '/documents'); }
              catch (e) { toast(e instanceof ApiError ? e.message : 'Could not delete.', 'error'); }
            }}><Icon name="trash" size={15} /></button>
          )}
        </div>
      </header>

      {stale && <div className="doc-alert" role="alert"><Icon name="alert" size={16} /><div>Someone else changed this document while you were editing. <button className="link-btn" onClick={() => { setStale(false); q.refetch(); }}>Reload to see their changes</button> (your unsaved words stay here until you save or leave).</div></div>}
      {d.status === 'Archived' && <div className="doc-alert info"><Icon name="info" size={16} /><div>This document is archived and read-only.</div></div>}

      <div className="doc-layout">
        <aside className="doc-outline" aria-label="Sections">
          <ul>{detail.sections.map((s) => <li key={s.key}><a href={`#sec-${s.key}`} onClick={(e) => { e.preventDefault(); document.getElementById(`sec-${s.key}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}>{edits[s.key] !== undefined && <i className="dot-dirty" />}{s.title}</a></li>)}</ul>
        </aside>
        <main className="doc-body">
          {detail.sections.map((s) => (
            <SectionEditor key={s.key} id={`sec-${s.key}`} section={s} template={tplFor.get(s.key) ?? null} value={edits[s.key] ?? s.content} onChange={editable ? (v) => set(s.key, v) : undefined} readOnly={!editable} />
          ))}
        </main>
        <aside className="doc-side">
          <div className="card doc-side-card">
            <div className="card-head"><div><h3>About</h3></div></div>
            <div className="card-body">
              <dl className="doc-facts">
                <div><dt>Owner</dt><dd><Avatar name={d.owner.name} /> {d.owner.name}</dd></div>
                <div><dt>Belongs to</dt><dd>{d.projectId ? <Link to={`/projects/${d.projectId}`}>{d.projectKey} · {d.projectName}</Link> : d.teamName ?? 'The organization'}</dd></div>
                <div><dt>Visible to</dt><dd><Icon name={VISIBILITY[d.visibility].icon} size={14} /> {VISIBILITY[d.visibility].label}</dd></div>
                {d.tags.length > 0 && <div><dt>Tags</dt><dd className="doc-tags">{d.tags.map((t) => <span className="doc-tag" key={t}>{t}</span>)}</dd></div>}
                <div><dt>Updated</dt><dd title={formatDate(d.updatedAt)}>{timeAgo(d.updatedAt)}</dd></div>
                <div><dt>Created</dt><dd>{formatDate(d.createdAt)}</dd></div>
              </dl>
            </div>
          </div>
          <LinkedWork documentId={id} canLink={detail.can.link && canWrite} />
        </aside>
      </div>
      {details && <DetailsModal detail={detail} onClose={() => setDetails(false)} />}
    </div>
  );
}
