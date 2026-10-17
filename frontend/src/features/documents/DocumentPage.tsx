import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { apiDocApi, documentApi, teamApi, workspaceApi } from '../../api/endpoints';
import type { DocumentClassification, DocumentDetail, DocumentVisibility } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Select } from '../../components/Select';
import { Avatar, ErrorState, Field, Modal, PageLoader, SubmitButton } from '../../components/ui';
import { formatDate, formatDateTime, timeAgo } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { queryClient, useIsPersonal, useModule, useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
import { LinkedWork } from './LinkedWork';
import { ArtifactCard } from './ArtifactHistory';
import { DocumentFiles } from './DocumentFiles';
import { DocumentIdContext } from './DocImage';
import { HistoryModal, PublishModal } from './DocumentHistory';
import { DocumentGate } from './DocumentGate';
import { PublishApprovedModal, ReviewPanel, SubmitModal } from './DocumentReview';
import { RequirementsCard } from './DocumentRequirements';
import { ActivityCard } from './DocumentActivity';
import { CommentsCard } from './DocumentComments';
import { Menu } from '../../components/Menu';
import { useExportPdf } from './ExportPdf';
import { ApiReference } from './ApiReference';
import { DocumentSecrets } from './DocumentSecrets';
import { AccessModal } from './DocumentSharing';
import { SectionEditor } from './SectionEditor';
import { CLASSIFICATION, DocStatusBadge, TypeCode, VISIBILITY } from './docUi';

/** Whether a section has anything in it (a table: a row; text: a word, a picture, a list item or a diagram). Reading hides sections that have nothing yet. */
function hasContent(kind: string, value: string): boolean {
  try {
    const v = JSON.parse(value);
    if (kind === 'Table') return Array.isArray(v?.rows) && v.rows.length > 0;
    const walk = (n: any): boolean => !!n && ((n.type === 'text' && String(n.text ?? '').trim().length > 0) || n.type === 'docImage' || n.type === 'horizontalRule' || (Array.isArray(n.content) && n.content.some(walk)));
    return walk(v);
  } catch { return value.trim().length > 0; }
}

function DetailsModal({ detail, onClose }: { detail: DocumentDetail; onClose: () => void }) {
  const wid = useWorkspaceId();
  const personal = useIsPersonal();
  const d = detail.item;
  const members = useWsQuery(['members'], workspaceApi.members);
  const teams = useWsQuery(['teams'], teamApi.list, { enabled: !personal && d.projectId === null });
  const [title, setTitle] = useState(d.title);
  const [visibility, setVisibility] = useState<DocumentVisibility>(d.visibility);
  const [classification, setClassification] = useState<DocumentClassification>(d.classification);
  const [teamId, setTeamId] = useState(d.teamId ?? '');
  const [ownerId, setOwnerId] = useState(d.owner.id);
  const [tags, setTags] = useState(d.tags.join(', '));
  const [error, setError] = useState<string | null>(null);
  const options: DocumentVisibility[] = d.projectId ? ['Project', 'Private'] : ['Team', 'Organization', 'Private'];
  const save = useMutation({
    mutationFn: () => documentApi.update(d.id, { title: title.trim(), visibility, classification, teamId: d.projectId ? null : teamId || null, ownerId, tags: tags.split(',').map((t) => t.trim()).filter(Boolean), revision: detail.revision }),
    onSuccess: (r) => { queryClient.setQueryData([wid, 'documents', d.id], r); invalidateWorkspace(wid, 'documents'); toast('Saved.'); onClose(); },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not save.'),
  });
  return (
    <Modal title="Document details" onClose={onClose} className="doc-scope" onSubmit={(e) => { e.preventDefault(); setError(null); save.mutate(); }}
      footer={<><button className="btn btn-ghost" type="button" onClick={onClose}>Cancel</button><SubmitButton busy={save.isPending}>Save</SubmitButton></>}>
      {error && <div className="doc-alert" role="alert"><Icon name="alert" size={16} /><div>{error}</div></div>}
      <Field label="Title" required><input className="input" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} /></Field>
      <Field label="Who can open it?" hint={VISIBILITY[visibility].hint}>
        <Select className="select" value={visibility} onChange={(e) => setVisibility(e.target.value as DocumentVisibility)} aria-label="Visibility">{options.map((v) => <option key={v} value={v}>{VISIBILITY[v].label}</option>)}</Select>
      </Field>
      {!d.projectId && visibility === 'Team' && (
        <Field label="Team"><Select className="select" value={teamId} onChange={(e) => setTeamId(e.target.value)} aria-label="Team"><option value="">Choose a team…</option>{teams.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></Field>
      )}
      <Field label="How sensitive is the content?" hint={CLASSIFICATION[classification].hint}>
        <Select className="select" value={classification} onChange={(e) => setClassification(e.target.value as DocumentClassification)} aria-label="Classification">
          {(Object.keys(CLASSIFICATION) as DocumentClassification[]).map((c) => <option key={c} value={c}>{CLASSIFICATION[c].label}</option>)}
        </Select>
      </Field>
      {classification !== d.classification && (classification === 'Confidential' || classification === 'Restricted') && (
        <div className="doc-alert info"><Icon name="info" size={16} /><div>Files already attached to this document won't be re-encrypted retroactively — only files added from now on will be.</div></div>
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
  const [mode, setMode] = useState<'view' | 'edit'>('view');   // a document opens for reading; people who may edit switch to editing
  const [details, setDetails] = useState(false);
  const [panel, setPanel] = useState<'publish' | 'history' | 'access' | 'submit' | 'publishApproved' | null>(null);
  const review = useWsQuery(['documents', id, 'review'], () => documentApi.review(id), { enabled: !!q.data, retry: false });
  const [stale, setStale] = useState(false);
  const [params, setParams] = useSearchParams();
  const apiOverview = useWsQuery(['documents', id, 'api', ''], () => apiDocApi.overview(id), { enabled: !!q.data, retry: false });
  const detail = q.data;
  const dirty = Object.keys(edits).length > 0;

  const apply = useCallback((r: DocumentDetail) => { queryClient.setQueryData([wid, 'documents', id], r); invalidateWorkspace(wid, 'documents'); }, [wid, id]);
  const save = useMutation({
    mutationFn: () => documentApi.saveSections(id, { revision: detail!.revision, sections: Object.entries(edits).map(([key, content]) => ({ key, content })) }),
    onSuccess: (r) => { setEdits({}); setStale(false); apply(r); toast('Saved.'); },
    onError: (e) => { if (e instanceof ApiError && e.code === 'DOCUMENT_CHANGED') setStale(true); toast(e instanceof ApiError ? e.message : 'Could not save.', 'error'); },
  });
  const pdf = useExportPdf(id);
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

  // A picture for the text: choose a file, add it to the document's files, and hand its id to the editor.
  const pickImage = useCallback(() => new Promise<{ fileId: string; alt: string } | null>((resolve) => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'image/png,image/jpeg,image/gif,image/webp';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      try { const f = await documentApi.uploadFile(id, file); invalidateWorkspace(wid, 'documents'); resolve({ fileId: f.id, alt: file.name.replace(/\.[^.]+$/, '') }); }
      catch (e) { toast(e instanceof ApiError ? e.message : 'Could not add the picture.', 'error'); resolve(null); }
    };
    input.oncancel = () => resolve(null);
    input.click();
  }), [id, wid]);

  const templates = useWsQuery(['document-types'], documentApi.types);
  const type = templates.data?.find((t) => t.id === detail?.item.typeId);
  const tplFor = useMemo(() => new Map((type?.sections ?? []).map((s) => [s.key, s])), [type]);

  if (q.isLoading) return <PageLoader />;
  if (q.error instanceof ApiError && q.error.status === 404) return <DocumentGate id={id} original={q.error} />;
  if (q.isError || !detail) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const d = detail.item;
  const canEdit = detail.can.edit && canWrite;
  const editable = canEdit && mode === 'edit';
  const workflow = !!review.data?.workflowApplies;
  // A Build Artifact document is published from its own card (ArtifactHistory.tsx) - a file, not typed section
  // text, so the generic "what changed?" Publish/Submit flow below does not apply to it.
  const isArtifact = type?.code === 'ARTIFACT';
  const hasApi = type?.code === 'API' || (apiOverview.data?.definitions.length ?? 0) > 0;
  const onApiTab = hasApi && params.get('tab') === 'api';
  const setTab = (t: 'doc' | 'api') => setParams(t === 'api' ? { tab: 'api' } : {}, { replace: true });
  const shownSections = editable ? detail.sections : detail.sections.filter((s) => hasContent(s.kind, edits[s.key] ?? s.content));
  const set = (key: string, v: string) => setEdits((x) => {
    const orig = detail.sections.find((s) => s.key === key)?.content;
    if (v === orig) { const { [key]: _, ...rest } = x; return rest; }
    return { ...x, [key]: v };
  });

  return (
    <div className="doc-page doc-scope" style={{ '--dc': d.typeColor } as CSSProperties}>
      <nav className="ds-crumb" aria-label="Breadcrumb">
        <Link to="/documents">documents</Link>
        {d.projectId && <><i>/</i><Link to={`/projects/${d.projectId}?tab=documents`}>{d.projectKey?.toLowerCase()}</Link></>}
        <i>/</i><b>{d.key}</b>
        <DocStatusBadge status={d.status} />
        {detail.hasUnpublishedChanges && detail.publishedLabel && <span className="ds-pill accent" title="The draft differs from the published version"><i />Draft ahead of v{detail.publishedLabel}</span>}
        {dirty && <span className="ds-pill warn"><i />Unsaved changes</span>}
      </nav>

      <header className="doc-head ds-doc-head">
        <div className="ds-doc-titlerow">
          <TypeCode doc={d} large />
          <h1>{d.title}</h1>
        </div>
        <div className="doc-head-actions">
          {canEdit && (
            <div className="mode-switch" role="group" aria-label="Reading or editing">
              <button type="button" className={mode === 'view' ? 'on' : ''} aria-pressed={mode === 'view'} aria-label="Read" title="Read" onClick={() => setMode('view')}><Icon name="eye" size={16} /></button>
              <button type="button" className={mode === 'edit' ? 'on' : ''} aria-pressed={mode === 'edit'} aria-label="Edit" title="Edit" onClick={() => setMode('edit')}><Icon name="edit" size={16} /></button>
            </div>
          )}
          {editable && <button className="btn btn-primary" onClick={() => save.mutate()} disabled={!dirty || save.isPending}>{save.isPending && <span className="spinner" />}Save</button>}
          {canEdit && detail.can.publish && !workflow && !isArtifact && <button className="btn btn-ghost" disabled={dirty || (!detail.hasUnpublishedChanges && !!detail.publishedLabel)} title={dirty ? 'Save your changes first' : !detail.hasUnpublishedChanges && detail.publishedLabel ? 'Nothing new to publish' : undefined} onClick={() => setPanel('publish')}><Icon name="upload" size={15} /> Publish</button>}
          {canEdit && workflow && review.data?.canSubmit && !isArtifact && <button className="btn btn-ghost" disabled={dirty || (!detail.hasUnpublishedChanges && !!detail.publishedLabel)} title={dirty ? 'Save your changes first' : !detail.hasUnpublishedChanges && detail.publishedLabel ? 'Nothing new to submit' : undefined} onClick={() => setPanel('submit')}><Icon name="send" size={15} /> Submit for review</button>}
          <Menu label="Actions" icon="more" items={[
            { label: pdf.busy ? 'Preparing the PDF…' : 'Download PDF', hint: 'Secret values are never included. Once downloaded, this app can no longer control or protect the file.', icon: 'download', onSelect: () => { if (!pdf.busy) void pdf.run(); }, hidden: isArtifact },
            { label: 'History', hint: 'Versions and changes', icon: 'clock', onSelect: () => setPanel('history'), hidden: isArtifact },
            { label: detail.can.share ? 'Share' : 'Access', hint: 'Who can open it', icon: 'users', onSelect: () => setPanel('access') },
            { label: 'Details', hint: 'Title, tags, owner, visibility', icon: 'edit', onSelect: () => setDetails(true), hidden: !detail.can.edit },
            { label: 'Archive', hint: 'Make it read-only', icon: 'folder', onSelect: async () => {
              if (!(await confirmDialog({ title: 'Archive this document?', message: `${d.key} “${d.title}” becomes read-only for everyone until it's reopened.`, confirmText: 'Archive' }))) return;
              run.mutate(() => documentApi.archive(id));
            }, hidden: d.status === 'Archived' || !detail.can.edit },
            { label: 'Reopen', icon: 'folder', onSelect: () => run.mutate(() => documentApi.reopen(id)), hidden: !(d.status === 'Archived' && detail.can.delete) },
            { label: 'Delete', hint: 'Recoverable for 30 days', icon: 'trash', danger: true, hidden: !detail.can.delete, onSelect: async () => {
              if (!(await confirmDialog({ title: 'Delete this document?', message: `${d.key} “${d.title}” disappears for everyone. You can bring it back for 30 days.`, confirmText: 'Delete', danger: false }))) return;
              try { await documentApi.remove(id); invalidateWorkspace(wid, 'documents'); toast('Document deleted.', 'warning'); nav(d.projectId ? `/projects/${d.projectId}?tab=documents` : '/documents'); }
              catch (e) { toast(e instanceof ApiError ? e.message : 'Could not delete.', 'error'); }
            } },
          ]} />
          {detail.viewingPublished && <div className="doc-alert info"><Icon name="info" size={16} /><div>You are reading version {detail.publishedLabel}, the latest published one.</div></div>}
        </div>
      </header>

      <section className="ds-summary" style={{ '--dc': d.typeColor } as CSSProperties} aria-label="About this document">
        <div className="ds-meta">
          <span className="ds-meta-chip"><i style={{ background: d.typeColor }} />Type <b>{d.typeName}</b></span>
          <span className="ds-meta-chip"><i />Version <b>{detail.versionLabel}</b>{detail.publishedLabel && detail.publishedLabel !== detail.versionLabel && <em>published {detail.publishedLabel}</em>}</span>
          <span className="ds-meta-chip" title={VISIBILITY[d.visibility].hint}><i />Visible to <b>{VISIBILITY[d.visibility].label}</b></span>
          <span className="ds-meta-chip" title={CLASSIFICATION[d.classification].hint}><i className={`cls-${d.classification.toLowerCase()}`} />Classification <b>{CLASSIFICATION[d.classification].label}</b></span>
          <span className="ds-meta-chip"><i />Belongs to <b>{d.projectId ? <Link to={`/projects/${d.projectId}`}>{d.projectKey} · {d.projectName}</Link> : d.teamName ?? 'The organization'}</b></span>
          <span className="ds-meta-chip"><Avatar name={d.owner.name} userId={d.owner.id} />Owner <b>{d.owner.name}</b></span>
          <span className="ds-meta-chip" title={formatDateTime(d.createdAt)}><i className="ok" />Added <b>{formatDate(d.createdAt)}</b></span>
          <span className="ds-meta-chip" title={formatDateTime(d.updatedAt)}><i className="warn" />Modified <b>{timeAgo(d.updatedAt)}</b></span>
          {d.tags.map((t) => <span className="ds-tag" key={t}>#{t}</span>)}
        </div>
      </section>

      {stale && <div className="doc-alert" role="alert"><Icon name="alert" size={16} /><div>Someone else changed this document while you were editing. <button className="link-btn" onClick={() => { setStale(false); q.refetch(); }}>Reload to see their changes</button> (your unsaved words stay here until you save or leave).</div></div>}
      {d.status === 'Archived' && <div className="doc-alert info"><Icon name="info" size={16} /><div>This document is archived and read-only.</div></div>}
      {review.data && <ReviewPanel detail={detail} review={review.data} canEdit={canEdit} onPublish={() => setPanel('publishApproved')} />}

      {hasApi && (
        <div className="seg doc-tabs" role="tablist" aria-label="Document view">
          <button role="tab" aria-selected={!onApiTab} className={!onApiTab ? 'on' : ''} onClick={() => setTab('doc')}>Document</button>
          <button role="tab" aria-selected={onApiTab} className={onApiTab ? 'on' : ''} onClick={() => setTab('api')}>API reference{(apiOverview.data?.endpoints ?? 0) > 0 && <span className="doc-count">{apiOverview.data!.endpoints.toLocaleString()}</span>}</button>
        </div>
      )}
      {onApiTab ? <ApiReference detail={detail} editable={editable} /> : (
      <div className={`doc-layout${editable ? '' : ' reading'}`}>
        <aside className="doc-outline" aria-label="Sections">
          <div className="ds-outline-title">On this page</div>
          <ul>{shownSections.map((s, i) => <li key={s.key}><a href={`#sec-${s.key}`} onClick={(e) => { e.preventDefault(); document.getElementById(`sec-${s.key}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}><span className="ds-outline-n">{String(i + 1).padStart(2, '0')}</span>{s.title}{edits[s.key] !== undefined && <i className="dot-dirty" />}</a></li>)}</ul>
        </aside>
        <main className="doc-body">
          {!editable && shownSections.length === 0 && <p className="muted doc-blank">Nothing has been written yet.{canEdit ? ' Choose the pencil to start.' : ''}</p>}
          <DocumentIdContext.Provider value={id}>
            {shownSections.map((s) => (
              <SectionEditor key={s.key} id={`sec-${s.key}`} section={s} template={tplFor.get(s.key) ?? null} value={edits[s.key] ?? s.content} onChange={editable ? (v) => set(s.key, v) : undefined} readOnly={!editable} onPickImage={editable ? pickImage : undefined} />
            ))}
          </DocumentIdContext.Provider>
        </main>
        <Inspector id={id} detail={detail} isArtifact={isArtifact} canEdit={canEdit} editable={editable} canLink={detail.can.link && canWrite} />
      </div>
      )}
      {details && <DetailsModal detail={detail} onClose={() => setDetails(false)} />}
      {panel === 'publish' && <PublishModal detail={detail} onClose={() => setPanel(null)} />}
      {panel === 'history' && <HistoryModal detail={detail} onClose={() => setPanel(null)} />}
      {panel === 'access' && <AccessModal detail={detail} onClose={() => setPanel(null)} />}
      {panel === 'submit' && review.data && <SubmitModal detail={detail} review={review.data} onClose={() => setPanel(null)} />}
      {panel === 'publishApproved' && review.data && <PublishApprovedModal detail={detail} review={review.data} onClose={() => setPanel(null)} />}
    </div>
  );
}

type InspectorTab = 'artifact' | 'links' | 'requirements' | 'files' | 'secrets' | 'comments' | 'activity';

/**
 * Everything around a document, in one tabbed panel instead of a column of separate cards: the build artifact (for artifact documents),
 * linked work, requirements, files, secrets, comments and activity. The open tab is remembered per browser.
 */
function Inspector({ id, detail, isArtifact, canEdit, editable, canLink }: { id: string; detail: DocumentDetail; isArtifact: boolean; canEdit: boolean; editable: boolean; canLink: boolean }) {
  const d = detail.item;
  const tabs: { id: InspectorTab; label: string; icon: 'upload' | 'git' | 'checks' | 'paperclip' | 'key' | 'message' | 'activity' }[] = [
    ...(isArtifact ? [{ id: 'artifact' as const, label: 'Artifact', icon: 'upload' as const }] : []),
    { id: 'links', label: 'Linked work', icon: 'git' },
    { id: 'requirements', label: 'Requirements', icon: 'checks' },
    { id: 'files', label: 'Files', icon: 'paperclip' },
    { id: 'secrets', label: 'Secrets', icon: 'key' },
    { id: 'comments', label: 'Comments', icon: 'message' },
    { id: 'activity', label: 'Activity', icon: 'activity' },
  ];
  const [tab, setTabState] = useState<InspectorTab>(() => {
    try { const t = localStorage.getItem('pf_doc_inspector') as InspectorTab | null; return t && tabs.some((x) => x.id === t) ? t : tabs[0].id; } catch { return tabs[0].id; }
  });
  const setTab = (t: InspectorTab) => { setTabState(t); try { localStorage.setItem('pf_doc_inspector', t); } catch { /* storage unavailable */ } };
  const current = tabs.some((t) => t.id === tab) ? tab : tabs[0].id;
  return (
    <aside className="doc-side ds-inspector" aria-label="Linked work, files and discussion">
      <div className="ds-inspector-tabs" role="tablist">
        {tabs.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={current === t.id} className={current === t.id ? 'on' : ''} title={t.label} onClick={() => setTab(t.id)}>
            <Icon name={t.icon} size={14} /><span>{t.label}</span>
          </button>
        ))}
      </div>
      <div className="ds-inspector-body" role="tabpanel">
        {current === 'artifact' && <ArtifactCard detail={detail} canEdit={canEdit} />}
        {current === 'links' && <LinkedWork documentId={id} canLink={canLink} />}
        {current === 'requirements' && <RequirementsCard documentId={id} canEdit={editable} />}
        {current === 'files' && <DocumentFiles documentId={id} canEdit={editable} />}
        {current === 'secrets' && <DocumentSecrets documentId={id} canEdit={editable} />}
        {current === 'comments' && <CommentsCard id={id} title={`${d.key} · ${d.title}`} />}
        {current === 'activity' && <ActivityCard id={id} title={`${d.key} · ${d.title}`} />}
      </div>
    </aside>
  );
}
