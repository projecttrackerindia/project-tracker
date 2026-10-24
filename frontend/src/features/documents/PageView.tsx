import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import type { Editor } from '@tiptap/react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { documentApi, docTrackerApi, insightApi, workspaceApi } from '../../api/endpoints';
import type { DocumentDetail } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Menu } from '../../components/Menu';
import { timeAgo, formatDateTime } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { queryClient, useAuth, useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
import { ActivityCard } from './DocumentActivity';
import { CommentThreads, threadsOf } from './CommentThreads';
import { AiDraftDialog } from './AiDraft';
import { FreshnessBanner, freshnessKey, useFreshness, VerifiedBadge } from './Freshness';
import { DocCollab } from './editor/collab';
import { EditorAiContext } from './editor/ai';
import { PageProjectContext } from './editor/LiveTasks';
import { isLiveConnected, onLiveConnected } from '../live/bus';
import { useChat } from '../chat/chatStore';
import type { DocDraft } from './docAi';
import { DocumentFiles } from './DocumentFiles';
import { HistoryModal, PublishModal } from './DocumentHistory';
import { AccessModal } from './DocumentSharing';
import { DocumentIdContext } from './DocImage';
import { DocumentSecrets } from './DocumentSecrets';
import { LinkedWork } from './LinkedWork';
import { DocStatusBadge } from './docUi';
import { EditorLookupsContext, pageSchema, removeCommentMark, RichEditor, type CommentRequest } from './RichEditor';
import type { EditorLookups } from './editor/extensions';
import { ancestors, PAGE_BODY, pageTree, useNewPage } from './pages';
import { useExportPdf } from './ExportPdf';
import './documents-ds.css';

const ICONS = ['📄', '📘', '📗', '📕', '📒', '📝', '📌', '📎', '📊', '📈', '🗂️', '🗒️', '✅', '⚠️', '💡', '🔒', '🔑', '🧭', '🚀', '🛠️', '⚙️', '🧪', '🐞', '💬', '📣', '🎯', '🏦', '💸', '🧾', '👥', '🤝', '📅', '⏱️', '🌐', '📦', '🔌', '🧩', '⭐', '🔥', '🌱'];
type Tab = 'page' | 'related' | 'activity';
/** How long a page waits for the live connection before it is edited on its own. */
const JOIN_WAIT_MS = 2500;

const isEmptyBody = (json: string) => {
  try {
    const d = JSON.parse(json) as { content?: { type: string; content?: unknown[] }[] };
    const c = d.content ?? [];
    return c.length === 0 || (c.length === 1 && c[0].type === 'paragraph' && !(c[0].content?.length));
  } catch { return !json.trim(); }
};

/**
 * Editing a page together. Joining waits briefly for the live connection; without one (or without the right to edit) the page is edited on
 * its own as before. Returns the shared text and who else is in it; `mode` says which editor to show.
 */
function useCollab(id: string, canEdit: boolean, savedText: () => unknown) {
  const user = useAuth((s) => s.ctx?.user);
  const [mode, setMode] = useState<'joining' | 'live' | 'solo'>(canEdit ? 'joining' : 'solo');
  const [collab, setCollab] = useState<DocCollab | null>(null);
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const savedRef = useRef(savedText); savedRef.current = savedText;
  useEffect(() => {
    if (!canEdit || !user) { setMode('solo'); return; }
    setMode('joining');
    const c = new DocCollab(id, pageSchema(), () => savedRef.current(), { userId: user.id, name: user.displayName });
    const off = c.subscribe(bump);
    let done = false;
    let stopWait: (() => void) | null = null;
    const finish = (live: boolean) => {
      if (done) return;
      done = true; stopWait?.(); window.clearTimeout(timer);
      if (live) { setCollab(c); setMode('live'); } else { off(); c.destroy(); setMode('solo'); }
    };
    const tryJoin = () => { void c.start().then((ok) => { if (ok) finish(true); else if (isLiveConnected()) finish(false); }); };
    const timer = window.setTimeout(() => finish(false), JOIN_WAIT_MS);
    if (isLiveConnected()) tryJoin();
    else {
      const offConnected = onLiveConnected(() => { if (isLiveConnected()) tryJoin(); });
      // No live connection to wait for (offline, or it failed to open): edit on its own at once instead of waiting.
      const offLink = useChat.subscribe((st) => { if (st.link === 'offline') finish(false); });
      stopWait = () => { offConnected(); offLink(); };
      if (useChat.getState().link === 'offline') finish(false);
    }
    return () => {
      if (!done) { done = true; window.clearTimeout(timer); stopWait?.(); off(); c.destroy(); }
      else { off(); setCollab(null); if (collabCleanup.current) collabCleanup.current(c); else c.destroy(); }
    };
  }, [id, canEdit, user?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  /** Lets the page save its last change before leaving the room (so the next editor does not save the same text again over it). */
  const collabCleanup = useRef<((c: DocCollab) => void) | null>(null);
  return { mode, collab: mode === 'live' ? collab : null, collabCleanup, me: user ? { name: user.displayName } : undefined };
}

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
  const [panel, setPanel] = useState<null | 'history' | 'access' | 'publish' | 'ai'>(null);
  const [iconOpen, setIconOpen] = useState(false);
  const [threads, setThreads] = useState<{ focus: string | null } | null>(null);
  const [pendingComment, setPendingComment] = useState<CommentRequest | null>(null);
  const editorRef = useRef<Editor | null>(null);
  const [editorReady, setEditorReady] = useState(0);
  const freshness = useFreshness(id);

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
  const bodyRef = useRef(body); bodyRef.current = body;
  const { mode, collab, collabCleanup, me } = useCollab(id, canEdit, () => { try { return JSON.parse(bodyRef.current || initialBody); } catch { return { type: 'doc', content: [{ type: 'paragraph' }] }; } });
  const collabRef = useRef<DocCollab | null>(null); collabRef.current = collab;
  /** Who saves: on its own, this page; editing together, only the first editor in the room. */
  const saver = () => !collabRef.current || collabRef.current.isLeader;

  /**
   * Takes the server's answer, keeping the page's text as this editor has it (the answer may carry masked values, which must never come
   * back into the editor). The cached text is the newest, so opening the page again - or the layout changing on a phone - shows it, not
   * the text from when the page was first opened.
   */
  const apply = useCallback((r: DocumentDetail, body?: string) => {
    rev.current = r.revision;
    queryClient.setQueryData([wid, 'documents', id], (old: DocumentDetail | undefined) => {
      const sections = (old ?? r).sections.map((x) => (body !== undefined && x.key === PAGE_BODY ? { ...x, content: body } : x));
      return { ...r, sections };
    });
  }, [wid, id]);

  // One save at a time; the newest text wins. A save that finds someone else's newer change stops and says so (nothing is overwritten).
  const flush = useCallback(async () => {
    if (busy.current || pending.current === null) return;
    const content = pending.current; pending.current = null; busy.current = true; setState('saving');
    try {
      const r = await documentApi.saveSections(id, { revision: rev.current, sections: [{ key: PAGE_BODY, content }] });
      apply(r, content);
      collabRef.current?.saved(r.revision);
      // Saving clears "may be out of date": ask again (the server decided).
      void queryClient.invalidateQueries({ queryKey: [wid, ...freshnessKey(id)] });
      setState(pending.current === null ? 'saved' : 'dirty');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'DOCUMENT_CHANGED') { setState('stale'); busy.current = false; return; }
      pending.current = pending.current ?? content; setState('error');
      toast(e instanceof ApiError ? e.message : 'Could not save. Your text is kept here; it will try again.', 'error');
    }
    busy.current = false;
    if (pending.current !== null) timer.current = window.setTimeout(() => void flush(), 800);
  }, [id, apply, wid]);
  const schedule = useCallback(() => { window.clearTimeout(timer.current); timer.current = window.setTimeout(() => void flush(), 1200); }, [flush]);
  const seen = useRef(initialBody);
  const onBody = (json: string) => {
    // The same text again (an editor opening the shared text reports it once): nothing to save.
    if (json === seen.current) return;
    seen.current = json;
    setBody(json); if (state === 'stale') return;
    pending.current = json;
    // Editing together, everyone's editor reports every change; only the one who saves saves (the others' copy is the same text).
    if (!saver()) return;
    setState('dirty'); schedule();
  };
  // The leader saved: take its revision, and the change it saved is no longer this page's to save. A new leader saves what is left.
  useEffect(() => {
    if (!collab) return;
    const offSaved = collab.onSaved((revision) => {
      rev.current = Math.max(rev.current, revision); pending.current = null; setState('saved');
      queryClient.setQueryData([wid, 'documents', id], (old: DocumentDetail | undefined) => (old ? { ...old, revision, item: { ...old.item, updatedAt: new Date().toISOString() },
        sections: old.sections.map((x) => (x.key === PAGE_BODY ? { ...x, content: bodyRef.current } : x)) } : old));
    });
    const offRoom = collab.subscribe(() => { if (collab.isLeader && pending.current !== null && !busy.current) { setState('dirty'); schedule(); } });
    return () => { offSaved(); offRoom(); };
  }, [collab, schedule, wid, id]);
  // Leaving: the last change is saved first, then the room is left (the next editor learns the revision and does not save it twice).
  collabCleanup.current = (c: DocCollab) => {
    window.clearTimeout(timer.current);
    if (pending.current !== null && c.isLeader) void flush().finally(() => c.destroy()); else c.destroy();
  };
  useEffect(() => () => { window.clearTimeout(timer.current); if (pending.current !== null && !collabRef.current) void flush(); }, [flush]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if ((pending.current !== null && saver()) || busy.current) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, []);

  // A new page opens with its title selected, ready to type over "Untitled".
  useEffect(() => { if (fresh && canEdit) { titleRef.current?.focus(); titleRef.current?.select(); } }, [fresh, canEdit, id]);
  useEffect(() => { const el = titleRef.current; if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px`; } }, [title]);

  const saveTitle = async () => saveTitleAs(title);
  const saveTitleAs = async (value: string) => {
    const t = value.trim();
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
      .map((x) => ({ id: x.id, title: x.title, hint: x.key, icon: x.icon ?? '▤' })),
  }), [members.data, allDocs, id]);

  const projectsCtx = useMemo(() => ({ projectId: d.projectId, projects: (catalog.data?.projects ?? []).filter((p): p is typeof p & { id: string } => !!p.id).map((p) => ({ id: p.id, name: p.name })) }), [d.projectId, catalog.data]);
  const aiCtx = useMemo(() => (canEdit ? { documentId: id } : null), [canEdit, id]);
  const comments = useWsQuery(['documents', id, 'comments'], () => documentApi.comments(id), { staleTime: 30_000 });
  const openThreads = useMemo(() => threadsOf(comments.data ?? []).filter((t) => !t.root.resolvedAt).length, [comments.data]);

  /** Scrolls a passage or block into view and flashes it (a comment's highlight, an answer's cited block, #b-3 in the address). */
  // The highlight is drawn over the text, not added to it: the editor owns its own elements and would undo a class put on them.
  const flashEl = (el: Element | null | undefined) => {
    if (!(el instanceof HTMLElement)) return false;
    const host = el.closest('.pg-body');
    if (!(host instanceof HTMLElement)) return false;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    host.querySelectorAll('.pg-flash-box').forEach((b) => b.remove());
    const r = el.getBoundingClientRect(), h = host.getBoundingClientRect();
    const box = document.createElement('div');
    box.className = 'pg-flash-box';
    box.setAttribute('aria-hidden', 'true');
    Object.assign(box.style, { top: `${r.top - h.top - 3}px`, left: `${r.left - h.left - 6}px`, width: `${r.width + 12}px`, height: `${r.height + 6}px` });
    host.appendChild(box);
    window.setTimeout(() => box.remove(), 2400);
    return true;
  };
  const jumpToComment = (anchorId: string) => flashEl(editorRef.current?.view.dom.querySelector(`[data-comment-id="${CSS.escape(anchorId)}"]`));
  const jumpToBlock = useCallback((n: number) => {
    const e = editorRef.current;
    if (!e || n < 0 || n >= e.state.doc.childCount) return false;
    let pos = 0;
    for (let i = 0; i < n; i++) pos += e.state.doc.child(i).nodeSize;
    return flashEl(e.view.nodeDOM(pos) as Element | null);
  }, []);
  useEffect(() => {
    const m = /^#b-(\d+)$/.exec(loc.hash);
    if (m && editorReady) window.setTimeout(() => jumpToBlock(Number(m[1])), 150);
  }, [loc.hash, editorReady, jumpToBlock]);
  const onEditor = useCallback((e: Editor | null, gone?: Editor | null) => {
    if (e) { editorRef.current = e; setEditorReady((n) => n + 1); }
    else if (!gone || editorRef.current === gone) editorRef.current = null;   // an older editor going away must not forget the current one
  }, []);

  const startComment = (r: CommentRequest) => { pendingComment?.cancel(); setPendingComment(r); setThreads({ focus: r.anchorId }); };
  const openComment = (anchorId: string) => setThreads({ focus: anchorId });

  // A page written by AI: an empty page takes it whole (and its title); otherwise it is added at the end.
  const empty = isEmptyBody(body);
  const useDraft = async (draft: DocDraft) => {
    const e = editorRef.current;
    const doc = JSON.parse(draft.body) as { content?: unknown[] };
    if (e) {
      if (isEmptyBody(JSON.stringify(e.getJSON()))) e.commands.setContent(doc as never);
      else e.chain().focus('end').insertContent((doc.content ?? []) as never).run();
    }
    if ((title.trim() === '' || title === 'Untitled') && draft.title) { setTitle(draft.title); await saveTitleAs(draft.title); }
    setPanel(null);
    toast('The draft is in the page. Change anything you like.', 'success');
  };

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
  const others = collab?.others ?? [];

  return (
    <div className="pg doc-scope" style={{ '--dc': d.typeColor } as CSSProperties}>
      <div className="pg-top">
        <nav className="dv-crumb pg-crumb" aria-label="Breadcrumb">
          <Link to={`/doctracker?p=${d.projectId ?? 'general'}`}>{where}</Link>
          {trail.map((a) => <span key={a.id} className="pg-crumb-step"><Icon name="chevronR" size={12} /><Link to={`/documents/${a.id}`}>{a.icon ? `${a.icon} ` : ''}{a.title}</Link></span>)}
        </nav>
        <div className="pg-actions">
          {collab && (
            <span className={`pg-live${collab.online ? '' : ' off'}`} title={collab.online ? (others.length ? `Editing now: ${others.map((o) => o.name).join(', ')}` : 'Live: others who open this page edit it with you') : 'Reconnecting… your changes are kept and sent when the connection is back'}>
              <span className="pg-live-dot" aria-hidden="true" />
              {others.length > 0 ? (
                <span className="pg-peers" aria-label={`${others.length} other${others.length === 1 ? '' : 's'} editing`}>
                  {others.slice(0, 4).map((o) => <span key={o.userId} className="pg-peer" style={{ background: o.color }} title={o.name}>{o.name.trim().charAt(0).toUpperCase()}</span>)}
                  {others.length > 4 && <span className="pg-peer more">+{others.length - 4}</span>}
                </span>
              ) : collab.online ? 'Live' : 'Offline'}
            </span>
          )}
          <span className={`pg-save ${state}`} title={formatDateTime(d.updatedAt)}>{collab && !collab.isLeader && state === 'saved' ? 'Saved automatically' : saveLabel}</span>
          <button type="button" className={`btn btn-ghost btn-sm pg-cmt-btn${threads ? ' on' : ''}`} aria-pressed={!!threads} onClick={() => setThreads((t) => (t ? null : { focus: null }))}>
            <Icon name="message" size={14} /> {openThreads > 0 ? openThreads : ''}<span className="sr-only">Comments</span>
          </button>
          {detail.can.share && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPanel('access')}><Icon name="users" size={14} /> Share</button>}
          <Menu label="" icon="more" items={[
            { label: 'Write with AI', hint: empty ? 'A whole page from a line, a voice note, a meeting, work or files' : 'Add an AI-written part at the end', icon: 'sparkle', onSelect: () => setPanel('ai'), hidden: !canEdit },
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

      {state === 'stale' && <div className="doc-alert" role="alert"><Icon name="alert" size={16} /><div>{collab ? 'This page was changed outside live editing (a restored version or an approved draft) while you were writing.' : 'Someone else changed this page while you were writing.'} Your text is still here: copy anything you need, then <button className="link-btn" onClick={() => window.location.reload()}>reload to see their version</button>.</div></div>}

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
          <VerifiedBadge f={freshness.data} />
        </div>
      </header>
      <FreshnessBanner id={id} />

      <div className="tabs pg-tabs" role="tablist" aria-label="Page">
        {([['page', 'Page'], ['related', 'Related'], ['activity', 'Activity']] as [Tab, string][]).map(([t, label]) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={`tab${tab === t ? ' active' : ''}`} onClick={() => setTab(t)}>{label}</button>
        ))}
      </div>

      {tab === 'page' && (
        <>
          {canEdit && empty && mode !== 'joining' && (
            <div className="pg-start-ai">
              <span className="pg-start-ai-label"><Icon name="sparkle" size={15} /> Start with AI</span>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPanel('ai')}>Write this page</button>
              <span className="muted">or type <kbd>/</kbd> for blocks</span>
            </div>
          )}
          <article className={`pg-body doc-body${collab?.waiting ? ' pg-waiting' : ''}`} aria-label={d.title} aria-busy={mode === 'joining' || !!collab?.waiting}>
            <DocumentIdContext.Provider value={id}>
              <EditorLookupsContext.Provider value={lookups}>
                <EditorAiContext.Provider value={aiCtx}>
                  <PageProjectContext.Provider value={projectsCtx}>
                    <RichEditor key={`${id}-${mode}`} minimal value={body} onChange={canEdit && mode !== 'joining' ? onBody : undefined}
                      readOnly={!canEdit || mode === 'joining' || !!collab?.waiting} label={`${d.title} text`} onPickImage={canEdit ? pickImage : undefined}
                      collab={collab} me={me} onComment={startComment} onOpenComment={openComment} onEditor={onEditor} liveTasks={projectsCtx.projects.length > 0} />
                  </PageProjectContext.Provider>
                </EditorAiContext.Provider>
              </EditorLookupsContext.Provider>
            </DocumentIdContext.Provider>
            {collab?.waiting && <p className="pg-wait-note" role="status"><span className="spinner" /> Opening the page with the others editing it…</p>}
          </article>

          <section className="pg-under" aria-label="Pages inside">
            <header><h3>Pages inside</h3>{canEdit && <button type="button" className="mb-link" onClick={() => void newPage.create({ parentId: id })}><Icon name="plus" size={13} /> Add a page</button>}</header>
            {inside.length === 0 ? <p className="pg-none">None yet.</p> : (
              <ul className="pg-list">{inside.map((c) => <li key={c.id}><Link to={`/documents/${c.id}`}><span className="pg-list-icon">{c.icon ?? <Icon name="note" size={16} />}</span>{c.title}<time>{timeAgo(c.updatedAt)}</time></Link></li>)}</ul>
            )}
          </section>
          {(backlinks.data?.length ?? 0) > 0 && (
            <section className="pg-under" aria-label="Linked from">
              <header><h3>Linked from</h3></header>
              <ul className="pg-list">{backlinks.data!.map((b) => <li key={b.id}><Link to={`/documents/${b.id}`}><span className="pg-list-icon">{b.icon ?? <Icon name="note" size={16} />}</span>{b.title}<small>{b.key}</small></Link></li>)}</ul>
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
      {tab === 'activity' && <ActivityCard id={id} title={`${d.key} · ${d.title}`} />}

      {panel === 'history' && <HistoryModal detail={detail} onClose={() => setPanel(null)} />}
      {panel === 'access' && <AccessModal detail={detail} onClose={() => setPanel(null)} />}
      {panel === 'publish' && <PublishModal detail={detail} onClose={() => setPanel(null)} />}
      {panel === 'ai' && <AiDraftDialog projects={projectsCtx.projects} projectId={d.projectId} onUse={useDraft} onClose={() => setPanel(null)} useLabel={empty ? 'Use this page' : 'Add to the end of the page'} />}
      {threads && createPortal(
        <div className="doc-scope">
          <div className="ct-backdrop" onClick={() => setThreads(null)} aria-hidden="true" />
          <CommentThreads id={id} focus={threads.focus} pending={pendingComment} onPendingDone={() => setPendingComment(null)}
            onJump={(a) => { if (!jumpToComment(a)) toast('That passage is no longer in the page.', 'info'); }}
            onResolved={(a) => { const e = editorRef.current; if (e && canEdit) removeCommentMark(e, a); }}
            onClose={() => { pendingComment?.cancel(); setPendingComment(null); setThreads(null); }} />
        </div>, document.body)}
    </div>
  );
}
