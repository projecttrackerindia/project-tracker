import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { documentApi, docTrackerApi, insightApi, workspaceApi } from '../../api/endpoints';
import type { DocumentDetail } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Menu } from '../../components/Menu';
import { timeAgo, formatDateTime } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { queryClient, useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
import { ActivityCard } from './DocumentActivity';
import { CommentsCard } from './DocumentComments';
import { DocumentFiles } from './DocumentFiles';
import { HistoryModal, PublishModal } from './DocumentHistory';
import { AccessModal } from './DocumentSharing';
import { DocumentIdContext } from './DocImage';
import { DocumentSecrets } from './DocumentSecrets';
import { LinkedWork } from './LinkedWork';
import { DocStatusBadge } from './docUi';
import { EditorLookupsContext, RichEditor } from './RichEditor';
import type { EditorLookups } from './editor/extensions';
import { ancestors, PAGE_BODY, pageTree, useNewPage } from './pages';
import { useExportPdf } from './ExportPdf';

const ICONS = ['📄', '📘', '📗', '📕', '📒', '📝', '📌', '📎', '📊', '📈', '🗂️', '🗒️', '✅', '⚠️', '💡', '🔒', '🔑', '🧭', '🚀', '🛠️', '⚙️', '🧪', '🐞', '💬', '📣', '🎯', '🏦', '💸', '🧾', '👥', '🤝', '📅', '⏱️', '🌐', '📦', '🔌', '🧩', '⭐', '🔥', '🌱'];
type Tab = 'page' | 'related' | 'comments' | 'activity';

/**
 * A page, read and written in one place like a modern document app: the title and icon are edited where they stand, the body saves itself a
 * moment after you stop typing, "/" opens blocks and @ # [[ mention people, tasks and pages. Pages inside this one, and the pages that link
 * here, are listed under it. Versions, publishing, sharing and the audit trail are the same as every document's.
 */
export function PageView({ detail, canEdit }: { detail: DocumentDetail; canEdit: boolean }) {
  const d = detail.item;
  const id = d.id;
  const wid = useWorkspaceId();
  const nav = useNavigate();
  const loc = useLocation();
  const fresh = !!(loc.state as { fresh?: boolean } | null)?.fresh;
  const newPage = useNewPage();
  const pdf = useExportPdf(id);
  const [tab, setTab] = useState<Tab>('page');
  const [panel, setPanel] = useState<null | 'history' | 'access' | 'publish'>(null);
  const [iconOpen, setIconOpen] = useState(false);

  // The page's own copy of its text: what the editor shows is never replaced by the server's echo while someone types.
  const initialBody = useMemo(() => detail.sections.find((s) => s.key === PAGE_BODY)?.content ?? detail.sections[0]?.content ?? '', [id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [body, setBody] = useState(initialBody);
  const [title, setTitle] = useState(d.title);
  const [state, setState] = useState<'saved' | 'dirty' | 'saving' | 'error' | 'stale'>('saved');
  const rev = useRef(detail.revision);
  const pending = useRef<string | null>(null);
  const busy = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { rev.current = Math.max(rev.current, detail.revision); }, [detail.revision]);

  const apply = useCallback((r: DocumentDetail) => { rev.current = r.revision; queryClient.setQueryData([wid, 'documents', id], (old: DocumentDetail | undefined) => (old ? { ...r, sections: old.sections } : r)); }, [wid, id]);

  // One save at a time; the newest text wins. A save that finds someone else's newer change stops and says so (nothing is overwritten).
  const flush = useCallback(async () => {
    if (busy.current || pending.current === null) return;
    const content = pending.current; pending.current = null; busy.current = true; setState('saving');
    try {
      const r = await documentApi.saveSections(id, { revision: rev.current, sections: [{ key: PAGE_BODY, content }] });
      apply(r);
      setState(pending.current === null ? 'saved' : 'dirty');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'DOCUMENT_CHANGED') { setState('stale'); busy.current = false; return; }
      pending.current = pending.current ?? content; setState('error');
      toast(e instanceof ApiError ? e.message : 'Could not save. Your text is kept here; it will try again.', 'error');
    }
    busy.current = false;
    if (pending.current !== null) timer.current = window.setTimeout(() => void flush(), 800);
  }, [id, apply]);
  const onBody = (json: string) => {
    setBody(json); if (state === 'stale') return;
    pending.current = json; setState('dirty');
    window.clearTimeout(timer.current); timer.current = window.setTimeout(() => void flush(), 1200);
  };
  useEffect(() => () => { window.clearTimeout(timer.current); if (pending.current !== null) void flush(); }, [flush]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (pending.current !== null || busy.current) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, []);

  // A new page opens with its title selected, ready to type over "Untitled".
  useEffect(() => { if (fresh && canEdit) { titleRef.current?.focus(); titleRef.current?.select(); } }, [fresh, canEdit, id]);
  useEffect(() => { const el = titleRef.current; if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px`; } }, [title]);

  const saveTitle = async () => {
    const t = title.trim();
    if (!t) { setTitle(d.title); return; }
    if (t === d.title) return;
    await flush();
    try {
      const r = await documentApi.update(id, { title: t, visibility: d.visibility, classification: d.classification, tags: d.tags, revision: rev.current, teamId: d.teamId });
      apply(r); invalidateWorkspace(wid, 'documents');
    } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not rename the page.', 'error'); setTitle(d.title); }
  };
  const setIcon = async (icon: string | null) => {
    setIconOpen(false);
    try { const r = await documentApi.setIcon(id, icon); apply(r); invalidateWorkspace(wid, 'documents'); } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not change the icon.', 'error'); }
  };

  // The tree around this page (for the breadcrumb and the pages inside it) comes from the DocTracker catalog.
  const catalog = useWsQuery(['documents', 'doctracker', 'catalog'], docTrackerApi.catalog, { staleTime: 20_000 });
  const allDocs = useMemo(() => (catalog.data?.projects ?? []).flatMap((p) => p.documents.map((x) => ({ ...x, projectId: p.id }))), [catalog.data]);
  const trail = useMemo(() => ancestors(allDocs, id), [allDocs, id]);
  const inside = useMemo(() => pageTree(allDocs).children(id), [allDocs, id]);
  const backlinks = useWsQuery(['documents', id, 'backlinks'], () => documentApi.backlinks(id), { staleTime: 30_000 });

  // What @ # [[ offer: members, tasks found by search, pages found in the catalog.
  const members = useWsQuery(['members'], workspaceApi.members, { staleTime: 300_000 });
  const lookups = useMemo<EditorLookups>(() => ({
    people: (q) => (members.data ?? []).filter((m) => m.role !== 'Guest' && m.displayName.toLowerCase().includes(q.toLowerCase())).slice(0, 8)
      .map((m) => ({ id: m.userId, title: m.displayName, hint: m.email, icon: '@' })),
    tasks: async (q) => ((await insightApi.search(q)).hits ?? []).filter((h) => h.type === 'task' && h.taskId).slice(0, 8)
      .map((h) => ({ id: h.taskId!, title: h.title, hint: h.subtitle ?? undefined, icon: '#' })),
    pages: async (q) => allDocs.filter((x) => x.id !== id && `${x.title} ${x.key}`.toLowerCase().includes(q.toLowerCase())).slice(0, 8)
      .map((x) => ({ id: x.id, title: x.title, hint: x.key, icon: x.icon ?? '📄' })),
  }), [members.data, allDocs, id]);

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

  const where = d.projectId ? d.projectName ?? 'Project' : d.teamName ?? 'General';
  const saveLabel = state === 'saving' ? 'Saving…' : state === 'dirty' ? 'Editing…' : state === 'error' ? 'Not saved' : state === 'stale' ? 'Changed elsewhere' : `Saved · ${timeAgo(d.updatedAt)}`;

  return (
    <div className="pg doc-scope" style={{ '--dc': d.typeColor } as CSSProperties}>
      <div className="pg-top">
        <nav className="dv-crumb pg-crumb" aria-label="Breadcrumb">
          <Link to={`/doctracker?p=${d.projectId ?? 'general'}`}>{where}</Link>
          {trail.map((a) => <span key={a.id} className="pg-crumb-step"><Icon name="chevronR" size={12} /><Link to={`/documents/${a.id}`}>{a.icon ? `${a.icon} ` : ''}{a.title}</Link></span>)}
        </nav>
        <div className="pg-actions">
          <span className={`pg-save ${state}`} title={formatDateTime(d.updatedAt)}>{saveLabel}</span>
          {detail.can.share && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPanel('access')}><Icon name="users" size={14} /> Share</button>}
          <Menu label="" icon="more" items={[
            { label: 'Add a page inside', icon: 'plus', onSelect: () => void newPage.create({ parentId: id }), hidden: !canEdit },
            { label: 'Publish a version', hint: 'Freeze this text as the version readers see', icon: 'upload', onSelect: () => setPanel('publish'), hidden: !canEdit || !detail.can.publish },
            { label: 'History', hint: 'Versions and changes', icon: 'clock', onSelect: () => setPanel('history') },
            { label: pdf.busy ? 'Preparing the PDF…' : 'Download PDF', icon: 'download', onSelect: () => { if (!pdf.busy) void pdf.run(); } },
            { label: 'Delete', hint: 'Recoverable for 30 days; pages inside move up', icon: 'trash', danger: true, hidden: !detail.can.delete, onSelect: async () => {
              if (!(await confirmDialog({ title: 'Delete this page?', message: `“${d.title}” disappears for everyone. Pages inside it move up a level. You can bring it back for 30 days.`, confirmText: 'Delete' }))) return;
              try { await documentApi.remove(id); invalidateWorkspace(wid, 'documents'); toast('Page deleted.', 'warning'); nav(trail.length ? `/documents/${trail[trail.length - 1].id}` : `/doctracker?p=${d.projectId ?? 'general'}`); }
              catch (e) { toast(e instanceof ApiError ? e.message : 'Could not delete.', 'error'); }
            } },
          ]} />
        </div>
      </div>

      {state === 'stale' && <div className="doc-alert" role="alert"><Icon name="alert" size={16} /><div>Someone else changed this page while you were writing. Your text is still here: copy anything you need, then <button className="link-btn" onClick={() => window.location.reload()}>reload to see their version</button>.</div></div>}

      <header className="pg-head">
        <div className="pg-icon-wrap">
          {d.icon ? <button type="button" className="pg-icon" onClick={() => canEdit && setIconOpen((o) => !o)} aria-label="Change icon" disabled={!canEdit}>{d.icon}</button>
            : canEdit && <button type="button" className="pg-add-icon" onClick={() => setIconOpen((o) => !o)}><Icon name="smile" size={14} /> Add icon</button>}
          {iconOpen && (
            <div className="pg-icons" role="dialog" aria-label="Choose an icon">
              {ICONS.map((e) => <button key={e} type="button" onClick={() => void setIcon(e)} aria-label={`Icon ${e}`}>{e}</button>)}
              {d.icon && <button type="button" className="pg-icons-clear" onClick={() => void setIcon(null)}>Remove</button>}
            </div>
          )}
        </div>
        <textarea ref={titleRef} className="pg-title" rows={1} value={title} maxLength={200} readOnly={!canEdit} aria-label="Page title" placeholder="Untitled"
          onChange={(e) => setTitle(e.target.value.replace(/\n/g, ''))} onBlur={() => void saveTitle()}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); (e.currentTarget as HTMLTextAreaElement).blur(); document.querySelector<HTMLElement>('.pg-body .ProseMirror')?.focus(); } }} />
        <div className="pg-meta">
          <span>{d.owner.name}</span><span>·</span><span>{d.key}</span><DocStatusBadge status={d.status} />
          {detail.hasUnpublishedChanges && detail.publishedLabel && <span className="badge badge-info" title="Readers see the published version">Draft ahead of v{detail.publishedLabel}</span>}
        </div>
      </header>

      <div className="tabs pg-tabs" role="tablist" aria-label="Page">
        {([['page', 'Page'], ['related', 'Related'], ['comments', 'Comments'], ['activity', 'Activity']] as [Tab, string][]).map(([t, label]) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={`tab${tab === t ? ' active' : ''}`} onClick={() => setTab(t)}>{label}</button>
        ))}
      </div>

      {tab === 'page' && (
        <>
          <article className="pg-body doc-body" aria-label={d.title}>
            <DocumentIdContext.Provider value={id}>
              <EditorLookupsContext.Provider value={lookups}>
                <RichEditor key={id} minimal value={body} onChange={canEdit ? onBody : undefined} readOnly={!canEdit} label={`${d.title} text`} onPickImage={canEdit ? pickImage : undefined} />
              </EditorLookupsContext.Provider>
            </DocumentIdContext.Provider>
          </article>

          <section className="pg-under" aria-label="Pages inside">
            <header><h3>Pages inside</h3>{canEdit && <button type="button" className="mb-link" onClick={() => void newPage.create({ parentId: id })}><Icon name="plus" size={13} /> Add a page</button>}</header>
            {inside.length === 0 ? <p className="pg-none">None yet.</p> : (
              <ul className="pg-list">{inside.map((c) => <li key={c.id}><Link to={`/documents/${c.id}`}><span className="pg-list-icon">{c.icon ?? '📄'}</span>{c.title}<time>{timeAgo(c.updatedAt)}</time></Link></li>)}</ul>
            )}
          </section>
          {(backlinks.data?.length ?? 0) > 0 && (
            <section className="pg-under" aria-label="Linked from">
              <header><h3>Linked from</h3></header>
              <ul className="pg-list">{backlinks.data!.map((b) => <li key={b.id}><Link to={`/documents/${b.id}`}><span className="pg-list-icon">{b.icon ?? '📄'}</span>{b.title}<small>{b.key}</small></Link></li>)}</ul>
            </section>
          )}
        </>
      )}
      {tab === 'related' && (
        <div className="dv-related">
          <LinkedWork documentId={id} canLink={detail.can.link} />
          <DocumentFiles documentId={id} canEdit={canEdit} />
          <DocumentSecrets documentId={id} canEdit={canEdit} />
        </div>
      )}
      {tab === 'comments' && <CommentsCard id={id} title={`${d.key} · ${d.title}`} />}
      {tab === 'activity' && <ActivityCard id={id} title={`${d.key} · ${d.title}`} />}

      {panel === 'history' && <HistoryModal detail={detail} onClose={() => setPanel(null)} />}
      {panel === 'access' && <AccessModal detail={detail} onClose={() => setPanel(null)} />}
      {panel === 'publish' && <PublishModal detail={detail} onClose={() => setPanel(null)} />}
    </div>
  );
}
