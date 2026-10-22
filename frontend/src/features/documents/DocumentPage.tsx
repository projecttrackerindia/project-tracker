import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
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
import { DocShell } from './DocumentsSidebar';
import { DtTreeStandalone } from '../doctracker/DocTrackerPage';
import { CLASSIFICATION, ClassificationBadge, DocStatusBadge, TypeCode, VISIBILITY } from './docUi';

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

type DocTab = 'doc' | 'api' | 'artifact' | 'related' | 'comments' | 'activity';
const DOC_TABS: DocTab[] = ['doc', 'related', 'comments', 'activity'];
/** The old separate tabs (links, requirements, files, secrets) are one "Related" tab now; their addresses open it at that card. */
const RELATED_PARTS = ['links', 'requirements', 'files', 'secrets'] as const;

/** A document with the Documents tree beside it (the tree opens on this document and lists its sections). */
export function DocumentPage() {
  const { id = '' } = useParams();
  return (
    <div className="doc-scope dv-shell-page">
      <DocShell browseLabel="Browse DocTracker" tree={<DtTreeStandalone activeDocId={id} />}>
        <DocumentView />
      </DocShell>
    </div>
  );
}

/** One document: its sections (editable by people who may edit), who and where, and the work linked to it. */
function DocumentView() {
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
  // The real values of a masked document: the editor's copy while editing, or a reader's short, audited reveal. Never put in the cache.
  const [plain, setPlain] = useState<DocumentDetail | null>(null);
  const [plainUntil, setPlainUntil] = useState<number | null>(null);
  const [askReveal, setAskReveal] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!plainUntil) return;
    const t = window.setInterval(() => { const n = Date.now(); setNow(n); if (n >= plainUntil) { setPlain(null); setPlainUntil(null); } }, 500);
    return () => window.clearInterval(t);
  }, [plainUntil]);
  const detail = q.data && plain ? { ...q.data, sections: plain.sections } : q.data;
  const dirty = Object.keys(edits).length > 0;

  const apply = useCallback((r: DocumentDetail) => { queryClient.setQueryData([wid, 'documents', id], r); invalidateWorkspace(wid, 'documents'); }, [wid, id]);
  const save = useMutation({
    mutationFn: () => documentApi.saveSections(id, { revision: detail!.revision, sections: Object.entries(edits).map(([key, content]) => ({ key, content })) }),
    onSuccess: (r) => {
      setEdits({}); setStale(false); toast('Saved.');
      if (r.revealed) { setPlain(r); queryClient.setQueryData([wid, 'documents', id], (old: DocumentDetail | undefined) => old ? { ...r, sections: old.sections, revealed: false, maskedCount: old.maskedCount } : old); void q.refetch(); invalidateWorkspace(wid, 'documents'); }
      else apply(r);
    },
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
  const setTab = (t: DocTab) => setParams(t === 'doc' ? {} : { tab: t }, { replace: true });
  // Editing works on the real values: a masked document is unlocked first (recorded in the audit trail as editing).
  const enterEdit = async () => {
    if ((q.data?.maskedCount ?? 0) > 0 && !(plain && !plainUntil)) {
      try { const r = await documentApi.revealDocument(id, { purpose: 'edit' }); setPlain(r); setPlainUntil(null); }
      catch (e) { toast(e instanceof ApiError ? e.message : 'Could not open the real values for editing.', 'error'); return; }
    }
    setMode('edit'); if (tab !== 'doc' && tab !== 'api') setTab('doc');
  };
  const masked = q.data?.maskedCount ?? 0;
  const shownSections = editable ? detail.sections : detail.sections.filter((s) => hasContent(s.kind, edits[s.key] ?? s.content));
  const set = (key: string, v: string) => setEdits((x) => {
    const orig = detail.sections.find((s) => s.key === key)?.content;
    if (v === orig) { const { [key]: _, ...rest } = x; return rest; }
    return { ...x, [key]: v };
  });

  const tab: DocTab = (() => {
    const t = params.get('tab') as DocTab | null;
    if (t === 'api') return hasApi ? 'api' : 'doc';
    if (t === 'artifact') return isArtifact ? 'artifact' : 'doc';
    if ((RELATED_PARTS as readonly string[]).includes(t ?? '')) return 'related';
    return t && (DOC_TABS as string[]).includes(t) ? t : 'doc';
  })();
  const place = d.projectId ? `${d.projectKey} · ${d.projectName}` : d.teamName ?? 'Organization';
  const tabs: { id: DocTab; label: string; count?: number }[] = [
    { id: 'doc', label: 'Document' },
    ...(hasApi ? [{ id: 'api' as const, label: 'API reference', count: apiOverview.data?.endpoints || undefined }] : []),
    ...(isArtifact ? [{ id: 'artifact' as const, label: 'Artifact' }] : []),
    { id: 'related', label: 'Related', count: d.linkedCount || undefined },
    { id: 'comments', label: 'Comments' },
    { id: 'activity', label: 'Activity' },
  ];

  return (
    <div className="dv doc-scope" style={{ '--dc': d.typeColor } as CSSProperties}>
      <nav className="dv-crumb" aria-label="Breadcrumb">
        <Link to="/doctracker">DocTracker</Link>
        <Icon name="chevronR" size={13} />
        <Link to={`/doctracker?p=${d.projectId ?? 'general'}`}>{d.projectId ? d.projectName : d.teamName ?? 'General'}</Link>
        <Icon name="chevronR" size={13} />
        <span className="dv-crumb-key">{d.key}</span>
      </nav>

      <header className="dv-head">
        <div className="dv-head-main">
          <h1>{d.title}</h1>
          <div className="dv-byline">
            <span className="dv-type" title={d.typeName}><TypeCode doc={d} /><span>{d.typeName}</span></span>
            <span className="dv-by"><Avatar name={d.owner.name} userId={d.owner.id} /><b>{d.owner.name}</b></span>
            <span title={formatDateTime(d.updatedAt)}>Updated {timeAgo(d.updatedAt)}</span>
            <span>Version {detail.versionLabel}</span>
            <DocStatusBadge status={d.status} />
            {detail.hasUnpublishedChanges && detail.publishedLabel && <span className="badge badge-info" title="The draft differs from the published version">Draft ahead of v{detail.publishedLabel}</span>}
            {(d.classification === 'Confidential' || d.classification === 'Restricted') && <ClassificationBadge classification={d.classification} />}
            {dirty && <span className="badge badge-warning">Unsaved changes</span>}
          </div>
        </div>
        <div className="dv-actions">
          {canEdit && (
            <div className="dv-mode" role="group" aria-label="Reading or editing">
              <button type="button" className={mode === 'view' ? 'on' : ''} aria-pressed={mode === 'view'} aria-label="Read" title="Read" onClick={() => { setMode('view'); if (!plainUntil) setPlain(null); }}><Icon name="eye" size={15} /><span>Read</span></button>
              <button type="button" className={mode === 'edit' ? 'on' : ''} aria-pressed={mode === 'edit'} aria-label="Edit" title="Edit" onClick={() => void enterEdit()}><Icon name="edit" size={15} /><span>Edit</span></button>
            </div>
          )}
          {editable && <button className="btn btn-primary" onClick={() => save.mutate()} disabled={!dirty || save.isPending}>{save.isPending && <span className="spinner" />}Save</button>}
          {canEdit && detail.can.publish && !workflow && !isArtifact && <button className="btn btn-ghost" disabled={dirty || (!detail.hasUnpublishedChanges && !!detail.publishedLabel)} title={dirty ? 'Save your changes first' : !detail.hasUnpublishedChanges && detail.publishedLabel ? 'Nothing new to publish' : undefined} onClick={() => setPanel('publish')}><Icon name="upload" size={15} /> Publish</button>}
          {canEdit && workflow && review.data?.canSubmit && !isArtifact && <button className="btn btn-ghost" disabled={dirty || (!detail.hasUnpublishedChanges && !!detail.publishedLabel)} title={dirty ? 'Save your changes first' : !detail.hasUnpublishedChanges && detail.publishedLabel ? 'Nothing new to submit' : undefined} onClick={() => setPanel('submit')}><Icon name="send" size={15} /> Submit for review</button>}
          <Menu label="More" icon="more" items={[
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
              try { await documentApi.remove(id); invalidateWorkspace(wid, 'documents'); toast('Document deleted.', 'warning'); nav(`/doctracker?p=${d.projectId ?? 'general'}&t=documents`); }
              catch (e) { toast(e instanceof ApiError ? e.message : 'Could not delete.', 'error'); }
            } },
          ]} />
        </div>
      </header>

      {detail.viewingPublished && <div className="doc-alert info"><Icon name="info" size={16} /><div>You are reading version {detail.publishedLabel}, the latest published one.</div></div>}
      {stale && <div className="doc-alert" role="alert"><Icon name="alert" size={16} /><div>Someone else changed this document while you were editing. <button className="link-btn" onClick={() => { setStale(false); q.refetch(); }}>Reload to see their changes</button> (your unsaved words stay here until you save or leave).</div></div>}
      {d.status === 'Archived' && <div className="doc-alert info"><Icon name="info" size={16} /><div>This document is archived and read-only.</div></div>}
      {review.data && <ReviewPanel detail={detail} review={review.data} canEdit={canEdit} onPublish={() => setPanel('publishApproved')} />}

      <div className="dv-tabs" role="tablist" aria-label="Document">
        {tabs.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)}>
            {t.label}{t.count ? <span className="dv-tab-count">{t.count.toLocaleString()}</span> : null}
          </button>
        ))}
      </div>

      {tab === 'doc' && !editable && (masked > 0 || plainUntil) && (
        plainUntil
          ? <div className="dv-mask revealed" role="status"><Icon name="eye" size={16} /><div><b>Showing the real values</b> - masked again in {Math.max(0, Math.ceil((plainUntil - now) / 1000))}s. This reveal is in the audit trail.</div>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setPlain(null); setPlainUntil(null); }}>Hide now</button></div>
          : <div className="dv-mask" role="note"><Icon name="lock" size={16} /><div><b>{masked} personal or secret value{masked === 1 ? ' is' : 's are'} masked</b> - mobile numbers, PAN, Aadhaar, account numbers, credentials and similar.</div>
              {q.data?.canReveal && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAskReveal(true)}><Icon name="eye" size={14} /> Reveal</button>}</div>
      )}
      {askReveal && <RevealModal onClose={() => setAskReveal(false)} onReveal={async (reason) => {
        const r = await documentApi.revealDocument(id, { purpose: 'read', reason });
        setPlain(r); setPlainUntil(Date.now() + Math.max(5, r.revealSeconds ?? 15) * 1000); setNow(Date.now()); setAskReveal(false);
      }} />}
      {tab === 'doc' && (
        <div className={`dv-layout${editable ? ' editing' : ''}`}>
          <article className="dv-paper doc-body" aria-label={d.title}>
            {!editable && shownSections.length === 0 && <p className="dv-blank">Nothing has been written yet.{canEdit ? ' Choose Edit to start.' : ''}</p>}
            <DocumentIdContext.Provider value={id}>
              {shownSections.map((s) => (
                <SectionEditor key={s.key} id={`sec-${s.key}`} section={s} template={tplFor.get(s.key) ?? null} value={edits[s.key] ?? s.content} onChange={editable ? (v) => set(s.key, v) : undefined} readOnly={!editable} onPickImage={editable ? pickImage : undefined} />
              ))}
            </DocumentIdContext.Provider>
          </article>
          <aside className="dv-aside" aria-label="About this document">
            {shownSections.length > 1 && (
              <nav className="dv-toc" aria-label="On this page">
                <div className="dv-aside-title">On this page</div>
                <ul>{shownSections.map((s) => <li key={s.key}><a href={`#sec-${s.key}`} onClick={(e) => { e.preventDefault(); document.getElementById(`sec-${s.key}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}>{s.title}{edits[s.key] !== undefined && <i className="dot-dirty" />}</a></li>)}</ul>
              </nav>
            )}
            <div className="dv-props">
              <div className="dv-aside-title">Details{detail.can.edit && <button type="button" className="link" onClick={() => setDetails(true)}>Edit</button>}</div>
              <dl>
                {detail.publishedLabel && detail.publishedLabel !== detail.versionLabel && <><dt>Published</dt><dd>v{detail.publishedLabel}</dd></>}
                <dt>Belongs to</dt><dd>{d.projectId ? <Link to={`/projects/${d.projectId}`}>{place}</Link> : place}</dd>
                <dt>Visible to</dt><dd title={VISIBILITY[d.visibility].hint}>{VISIBILITY[d.visibility].label}</dd>
                <dt>Sensitivity</dt><dd title={CLASSIFICATION[d.classification].hint}>{CLASSIFICATION[d.classification].label}</dd>
                <dt>Created</dt><dd title={formatDateTime(d.createdAt)}>{formatDate(d.createdAt)}</dd>
              </dl>
              {d.tags.length > 0 && <div className="dv-tags">{d.tags.map((t) => <span className="dv-tag" key={t}>{t}</span>)}</div>}
            </div>
          </aside>
        </div>
      )}
      {tab === 'api' && <ApiReference detail={detail} editable={editable} />}
      {tab !== 'doc' && tab !== 'api' && (
        // These tabs are about the document, not its text, so anyone who may edit can manage them without switching to Edit mode;
        // the server checks the same permission on every change.
        <div className="dv-panel" role="tabpanel">
          {tab === 'artifact' && <ArtifactCard detail={detail} canEdit={canEdit} />}
          {tab === 'related' && <RelatedPanel focus={params.get('tab')}>
            <div id="rel-links"><LinkedWork documentId={id} canLink={detail.can.link && canWrite} /></div>
            <div id="rel-files"><DocumentFiles documentId={id} canEdit={canEdit} /></div>
            <div id="rel-requirements"><RequirementsCard documentId={id} canEdit={canEdit} /></div>
            <div id="rel-secrets"><DocumentSecrets documentId={id} canEdit={canEdit} /></div>
          </RelatedPanel>}
          {tab === 'comments' && <CommentsCard id={id} title={`${d.key} · ${d.title}`} />}
          {tab === 'activity' && <ActivityCard id={id} title={`${d.key} · ${d.title}`} />}
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

/** Everything around the document's text - linked work, files, requirements and secrets - on one page; an old tab address scrolls to its card. */
function RelatedPanel({ focus, children }: { focus: string | null; children: ReactNode }) {
  useEffect(() => {
    if (focus && focus !== 'related') document.getElementById(`rel-${focus}`)?.scrollIntoView({ block: 'start' });
  }, [focus]);
  return <div className="dv-related">{children}</div>;
}

/** Why someone needs to see the masked values: the reason goes into the audit trail with the reveal. */
function RevealModal({ onClose, onReveal }: { onClose: () => void; onReveal: (reason: string) => Promise<void> }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    setBusy(true); setError(null);
    try { await onReveal(reason.trim()); } catch (e) { setError(e instanceof ApiError ? e.errors[0]?.message ?? e.message : 'Could not reveal.'); } finally { setBusy(false); }
  };
  return (
    <Modal title="Reveal masked values" subtitle="They show for a few seconds, then are masked again." onClose={onClose}
      onSubmit={(e) => { e.preventDefault(); void go(); }}
      footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><button type="submit" className="btn btn-primary" disabled={busy || reason.trim().length < 4}>{busy && <span className="spinner" />}Reveal</button></>}>
      {error && <div className="doc-alert" role="alert"><Icon name="alert" size={16} /><div>{error}</div></div>}
      <Field label="Why do you need to see them?" hint="Recorded in the audit trail with your name and the time.">
        <input className="input" autoFocus value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="Customer called about their EMI" />
      </Field>
    </Modal>
  );
}
