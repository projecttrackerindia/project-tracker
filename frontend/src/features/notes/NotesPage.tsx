import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { projectApi, taskApi, workspaceApi } from '../../api/endpoints';
import { CalmAvatar, CalmDot, CalmGo, CalmSheet } from '../../components/calm';
import { Icon, type IconName } from '../../components/Icon';
import { ErrorState, PageLoader } from '../../components/ui';
import { projectColor } from '../../lib/calm';
import { useIsMobile } from '../../lib/mobile';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { queryClient, useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { newBlock, notesApi, type Note, type NoteBlock, type NoteList, type NoteSharing, type NoteSummary, type NoteView } from './api';
import { NoteEditor } from './NoteEditor';
import './notes.css';

/** "09:40" today, "Mon" this week, "Oct 28" before. */
function short(iso: string) {
  const d = new Date(iso), now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (now.getTime() - d.getTime() < 6 * 86_400_000) return d.toLocaleDateString('en-GB', { weekday: 'short' });
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

const VIEWS: { id: NoteView; icon: IconName; label: string; key: 'all' | 'pinned' | 'shared' | 'meetings' }[] = [
  { id: 'all', icon: 'note', label: 'All notes', key: 'all' }, { id: 'pinned', icon: 'pin', label: 'Pinned', key: 'pinned' },
  { id: 'shared', icon: 'upload', label: 'Shared with me', key: 'shared' }, { id: 'meetings', icon: 'video', label: 'Meeting notes', key: 'meetings' },
];

/**
 * Notes: three panes - views, folders and tags with quick capture; the list (pinned first); the editor. Search across titles, text and tags.
 * A note saves itself as you type ("✓ Saved"), can be turned into a task, shared with people or the workspace, pinned, tagged and filed.
 * On a phone the panes become one column: the list (with the views as pills), then the note with a way back.
 */
export function NotesPage() {
  const wid = useWorkspaceId();
  const phone = useIsMobile();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const view = (params.get('view') ?? 'all') as NoteView;
  const folder = params.get('folder') ?? '';
  const tag = params.get('tag') ?? '';
  const openId = params.get('open');
  const [q, setQ] = useState('');
  const [dq, setDq] = useState('');
  useEffect(() => { const t = setTimeout(() => setDq(q.trim()), 220); return () => clearTimeout(t); }, [q]);
  const setP = (patch: Record<string, string | null>) => setParams((p) => { const n = new URLSearchParams(p); for (const [k, v] of Object.entries(patch)) { if (v) n.set(k, v); else n.delete(k); } return n; }, { replace: true });
  const listKey = ['notes', 'list', view, folder, tag, dq];
  const list = useWsQuery(listKey, () => notesApi.list({ view, folder: folder || undefined, tag: tag || undefined, q: dq || undefined }), { placeholderData: (p) => p });
  const selected = openId ?? (phone ? null : list.data?.items[0]?.id ?? null);
  const note = useWsQuery(['notes', 'one', selected], () => notesApi.get(selected!), { enabled: !!selected });
  const search = useRef<HTMLInputElement>(null);
  const [capture, setCapture] = useState<string | null>(null);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); search.current?.focus(); }
      if (e.altKey && e.code === 'KeyN') { e.preventDefault(); setCapture(''); }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  const patchSummary = useCallback((id: string, patch: Partial<NoteSummary>) => {
    queryClient.setQueriesData<NoteList>({ queryKey: [wid, 'notes', 'list'] }, (old) => old && { ...old, items: old.items.map((x) => (x.id === id ? { ...x, ...patch } : x)) });
  }, [wid]);

  const make = async (title = '', text = '') => {
    try {
      const n = await notesApi.create({ title, content: [newBlock('p', text)], folder: folder || undefined, tags: tag ? [tag] : undefined, pinned: view === 'pinned' || undefined });
      queryClient.setQueryData([wid, 'notes', 'one', n.id], n);
      await invalidateWorkspace(wid, 'notes', 'list');
      setP({ open: n.id });
      if (!title) requestAnimationFrame(() => document.querySelector<HTMLInputElement>('.nt-title')?.focus());
      return n;
    } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not create the note.', 'error'); return null; }
  };

  if (list.isLoading && !list.data) return <PageLoader />;
  if (list.error && !list.data) return <ErrorState error={list.error} retry={() => list.refetch()} />;
  const data = list.data!;
  const pinned = data.items.filter((n) => n.pinned);
  const earlier = data.items.filter((n) => !n.pinned);
  const showList = !phone || !openId;
  const showEditor = !phone || !!openId;

  return (
    <div className="nt-page" aria-label="Notes">
      <div className="nt-top">
        <span className="nt-crumb">Notes</span>
        <label className="nt-search"><Icon name="search" size={15} />
          <input ref={search} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search notes" aria-label="Search notes" />
          <kbd>⌘F</kbd>
        </label>
        <CalmGo onClick={() => void make()}>+ New note</CalmGo>
      </div>
      <div className={`nt-3${phone ? ' phone' : ''}`}>
        {!phone && (
          <nav className="nt-nav" aria-label="Notes views">
            {VIEWS.map((v) => (
              <button key={v.id} type="button" className={view === v.id && !folder && !tag ? 'on' : ''} onClick={() => setP({ view: v.id === 'all' ? null : v.id, folder: null, tag: null, open: null })}>
                <Icon name={v.icon} size={16} /><span>{v.label}</span><em>{data.counts[v.key]}</em>
              </button>
            ))}
            {data.folders.length > 0 && <div className="nt-ps">Folders</div>}
            {data.folders.map((f) => (
              <button key={f.name} type="button" className={folder.toLowerCase() === f.name.toLowerCase() ? 'on' : ''} onClick={() => setP({ folder: folder === f.name ? null : f.name, tag: null, open: null })}>
                <CalmDot color={projectColor(f.projectId ?? f.name)} /><span>{f.name}</span><em>{f.count}</em>
              </button>
            ))}
            {data.tags.length > 0 && <div className="nt-ps">Tags</div>}
            <div className="nt-tags">
              {data.tags.map((t) => <button key={t.tag} type="button" className={`nt-tg${tag === t.tag ? ' on' : ''}`} onClick={() => setP({ tag: tag === t.tag ? null : t.tag, folder: null, open: null })}>#{t.tag}</button>)}
            </div>
            {capture === null
              ? <button type="button" className="nt-qcap" onClick={() => setCapture('')}><Icon name="plus" size={15} /><span>Quick capture</span><kbd>⌥N</kbd></button>
              : <input className="nt-qcap-in" autoFocus value={capture} placeholder="Jot it down, Enter to save" aria-label="Quick capture" maxLength={200}
                  onChange={(e) => setCapture(e.target.value)} onBlur={() => { if (!capture.trim()) setCapture(null); }}
                  onKeyDown={(e) => { if (e.key === 'Escape') setCapture(null); if (e.key === 'Enter' && capture.trim()) { void make(capture.trim()).then(() => { setCapture(null); toast('✓ Captured', 'success'); }); } }} />}
          </nav>
        )}
        {showList && (
          <div className="nt-list" aria-label="Notes">
            {phone && (
              <div className="nt-pills" role="group" aria-label="Show">
                {VIEWS.map((v) => <button key={v.id} type="button" aria-pressed={view === v.id} onClick={() => setP({ view: v.id === 'all' ? null : v.id, folder: null, tag: null })}>{v.label} <em>{data.counts[v.key]}</em></button>)}
                {data.folders.map((f) => <button key={f.name} type="button" aria-pressed={folder === f.name} onClick={() => setP({ folder: folder === f.name ? null : f.name })}><CalmDot color={projectColor(f.projectId ?? f.name)} /> {f.name}</button>)}
              </div>
            )}
            {pinned.length > 0 && <div className="nt-ng">Pinned</div>}
            {pinned.map((n) => <Row key={n.id} n={n} on={n.id === selected} onOpen={() => setP({ open: n.id })} />)}
            {earlier.length > 0 && <div className="nt-ng">{pinned.length ? 'Earlier' : dq ? `Matching “${dq}”` : 'Notes'}</div>}
            {earlier.map((n) => <Row key={n.id} n={n} on={n.id === selected} onOpen={() => setP({ open: n.id })} />)}
            {data.items.length === 0 && (
              <div className="nt-empty"><b>{dq ? 'No notes match.' : 'No notes here yet.'}</b>{dq ? 'Try other words, or a tag.' : 'Write one with + New note, or press ⌥N to capture a thought.'}</div>
            )}
            {phone && <button type="button" className="nt-qcap phone" onClick={() => void make()}><Icon name="plus" size={15} /><span>Quick capture</span></button>}
          </div>
        )}
        {showEditor && (
          <section className="nt-pane" aria-label="Note">
            {selected && note.data
              ? <NotePane key={note.data.id} note={note.data} phone={phone} onBack={() => setP({ open: null })} onSummary={patchSummary} onGone={() => { setP({ open: null }); void invalidateWorkspace(wid, 'notes', 'list'); }} onNav={nav} />
              : selected && note.isLoading ? <PageLoader />
              : <div className="nt-empty pane"><b>Pick a note, or start one.</b><CalmGo onClick={() => void make()}>+ New note</CalmGo></div>}
          </section>
        )}
      </div>
    </div>
  );
}

function Row({ n, on, onOpen }: { n: NoteSummary; on: boolean; onOpen: () => void }) {
  return (
    <button type="button" className={`nt-row${on ? ' on' : ''}`} onClick={onOpen} aria-current={on ? 'true' : undefined}>
      <b>{n.pinned && <Icon name="pin" size={12} />}{n.title || 'Untitled note'}</b>
      <small><span>{short(n.updatedAt)}</span>{n.snippet.replace(/\*\*/g, '') || 'No text yet'}</small>
      <em>{n.folder ?? (n.mine ? 'Notes' : `From ${n.owner.name}`)}</em>
    </button>
  );
}

/** The open note: its bar (where it lives, Turn into task, Share, who has it, ⋯) over the editor, saving as it changes. */
function NotePane({ note, phone, onBack, onSummary, onGone, onNav }: {
  note: Note; phone: boolean; onBack: () => void; onSummary: (id: string, p: Partial<NoteSummary>) => void; onGone: () => void; onNav: (to: string) => void;
}) {
  const wid = useWorkspaceId();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(true);
  const [sheet, setSheet] = useState<'share' | 'task' | 'more' | null>(null);
  const [cur, setCur] = useState(note);
  const pending = useRef<{ title?: string; content?: NoteBlock[] }>({});
  const timer = useRef<number | undefined>(undefined);
  const projects = useWsQuery(['projects', 'pick'], () => projectApi.list({ pageSize: 100 }), { staleTime: 300_000, enabled: sheet !== null });
  const project = useMemo(() => projects.data?.items.find((p) => p.id === cur.projectId), [projects.data, cur.projectId]);

  const flush = useCallback(async () => {
    const body = pending.current; pending.current = {};
    if (body.title === undefined && body.content === undefined) return;
    setSaving(true);
    try {
      const out = await notesApi.update(note.id, body);
      queryClient.setQueryData([wid, 'notes', 'one', note.id], out);
      setSaved(true);
    } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not save the note.', 'error'); setSaved(false); }
    finally { setSaving(false); }
  }, [note.id, wid]);
  useEffect(() => () => { window.clearTimeout(timer.current); void flush(); }, [flush]);

  const change = (p: { title?: string; content?: NoteBlock[] }) => {
    pending.current = { ...pending.current, ...p };
    setSaved(false);
    if (p.title !== undefined) onSummary(note.id, { title: p.title });
    if (p.content) onSummary(note.id, { snippet: p.content.map((b) => b.text).filter(Boolean).join(' ').slice(0, 140) });
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void flush(), 600);
  };

  const meta = async (body: Parameters<typeof notesApi.update>[1], msg = '✓ Saved') => {
    // Instant: the note changes now; the server's answer replaces it, and a refusal puts the old one back.
    const before = cur;
    setCur((c) => ({ ...c, ...(body as Partial<Note>) }));
    try { const out = await notesApi.update(note.id, body); setCur(out); queryClient.setQueryData([wid, 'notes', 'one', note.id], out); void invalidateWorkspace(wid, 'notes', 'list'); if (msg !== '✓ Saved') toast(msg, 'success'); }
    catch (e) { setCur(before); toast(e instanceof ApiError ? e.message : 'Could not save that. Your change was undone.', 'error'); }
  };

  const crumb = [cur.folder, project?.name && project.name !== cur.folder ? project.name : null, cur.tags[0] ? `#${cur.tags[0]}` : null].filter(Boolean).join(' · ') || (cur.mine ? 'My notes' : `Shared by ${cur.owner.name}`);
  const people = [cur.owner, ...cur.sharedWith].filter((u, i, a) => a.findIndex((x) => x.id === u.id) === i).slice(0, 3);

  return (
    <>
      <div className="nt-bar">
        {phone && <button type="button" className="nt-back" onClick={onBack}><Icon name="chevronL" size={14} /> Notes</button>}
        <span className="nt-where"><CalmDot color={projectColor(cur.projectId ?? cur.folder ?? '')} />{crumb}</span>
        <span className="nt-sp" />
        <button type="button" className="nt-pill" onClick={() => setSheet('task')}><Icon name="checkCircle" size={14} /><span>Turn into task</span></button>
        {cur.mine && <button type="button" className="nt-pill" onClick={() => setSheet('share')}><Icon name="upload" size={14} /><span>Share</span></button>}
        <span className="nt-avs" aria-label={`With ${people.map((p) => p.name).join(', ')}`}>{people.map((p) => <CalmAvatar key={p.id} userId={p.id} name={p.name} size="m" />)}</span>
        <button type="button" className="nt-pill icon" aria-label="More" onClick={() => setSheet('more')}><Icon name="more" size={15} /></button>
      </div>
      <NoteEditor note={note} onChange={change} saving={saving} saved={saved} />
      <CalmSheet open={sheet === 'share'} onClose={() => setSheet(null)} title="Share" sub="Who can see and edit this note." width={480}>
        <ShareForm note={cur} onSaved={(n) => { setCur(n); setSheet(null); void invalidateWorkspace(wid, 'notes', 'list'); }} />
      </CalmSheet>
      <CalmSheet open={sheet === 'task'} onClose={() => setSheet(null)} title="Turn into task" sub="The title becomes the task; the note is linked from it." width={480}>
        <TaskForm note={cur} projects={projects.data?.items ?? []} onDone={(href, n) => { setCur(n); setSheet(null); toast('✓ Task created', 'success', { label: 'Open', onClick: () => onNav(href) }); }} />
      </CalmSheet>
      <CalmSheet open={sheet === 'more'} onClose={() => setSheet(null)} title={cur.title || 'Untitled note'} width={480}>
        <MoreForm note={cur} projects={projects.data?.items ?? []} onSave={(b, m) => void meta(b, m)} onDelete={async () => {
          try { await notesApi.remove(note.id); setSheet(null); toast('Note deleted.', 'success'); onGone(); }
          catch (e) { toast(e instanceof ApiError ? e.message : 'Could not delete it.', 'error'); }
        }} />
      </CalmSheet>
    </>
  );
}

function ShareForm({ note, onSaved }: { note: Note; onSaved: (n: Note) => void }) {
  const [mode, setMode] = useState<NoteSharing>(note.sharing);
  const [people, setPeople] = useState<string[]>(note.sharedWith.map((u) => u.id));
  const members = useWsQuery(['members'], () => workspaceApi.members(), { staleTime: 300_000 });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try { onSaved(await notesApi.share(note.id, mode, mode === 'people' ? people : [])); toast('✓ Sharing saved', 'success'); }
    catch (e) { toast(e instanceof ApiError ? e.errors[0]?.message ?? e.message : 'Could not share it.', 'error'); }
    finally { setBusy(false); }
  };
  return (
    <div className="nt-form">
      {(['private', 'people', 'workspace'] as const).map((m) => (
        <label key={m} className="nt-opt"><input type="radio" name="sharing" checked={mode === m} onChange={() => setMode(m)} />
          <span><b>{m === 'private' ? 'Only me' : m === 'people' ? 'Chosen people' : 'Everyone in the workspace'}</b><small>{m === 'private' ? 'Nobody else sees it.' : m === 'people' ? 'They can read and edit it.' : 'Anyone in the workspace can read and edit it.'}</small></span>
        </label>
      ))}
      {mode === 'people' && (
        <div className="nt-people">
          {(members.data ?? []).filter((m) => m.userId !== note.owner.id).map((m) => (
            <label key={m.userId} className="nt-person"><input type="checkbox" checked={people.includes(m.userId)} onChange={(e) => setPeople(e.target.checked ? [...people, m.userId] : people.filter((x) => x !== m.userId))} />
              <CalmAvatar userId={m.userId} name={m.displayName} /><span>{m.displayName}</span></label>
          ))}
        </div>
      )}
      <div className="nt-form-foot"><CalmGo onClick={() => void save()} disabled={busy || (mode === 'people' && people.length === 0)}>Save</CalmGo></div>
    </div>
  );
}

function TaskForm({ note, projects, onDone }: { note: Note; projects: { id: string; name: string }[]; onDone: (href: string, n: Note) => void }) {
  const [project, setProject] = useState(note.projectId ?? '');
  const [title, setTitle] = useState(note.title);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    if (!project || !title.trim()) return;
    setBusy(true);
    try {
      const text = note.content.map((b) => (b.type === 'check' ? `${b.done ? '[x]' : '[ ]'} ${b.text}` : b.text)).filter(Boolean).join('\n');
      const t = await taskApi.create(project, { title: title.trim(), description: text.slice(0, 4000) || null, priority: 'Medium' });
      const href = `/work?item=${t.id}`;
      const n = await notesApi.update(note.id, { links: [...note.links, { kind: 'task', id: t.id, label: t.key, href }], ...(note.projectId ? {} : { projectId: project }) });
      onDone(href, n);
    } catch (e) { toast(e instanceof ApiError ? e.errors[0]?.message ?? e.message : 'Could not create the task.', 'error'); }
    finally { setBusy(false); }
  };
  return (
    <div className="nt-form">
      <label className="nt-field"><span>Task</span><input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} /></label>
      <label className="nt-field"><span>Project</span>
        <select value={project} onChange={(e) => setProject(e.target.value)}><option value="">Choose a project</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
      </label>
      {note.links.length > 0 && <p className="nt-hint">Already linked: {note.links.map((l) => l.label).join(', ')}</p>}
      <div className="nt-form-foot"><CalmGo onClick={() => void go()} disabled={busy || !project || !title.trim()}>Create task</CalmGo></div>
    </div>
  );
}

function MoreForm({ note, projects, onSave, onDelete }: { note: Note; projects: { id: string; name: string }[]; onSave: (b: Parameters<typeof notesApi.update>[1], msg?: string) => void; onDelete: () => void }) {
  const [folder, setFolder] = useState(note.folder ?? '');
  const [tags, setTags] = useState(note.tags.map((t) => `#${t}`).join(' '));
  return (
    <div className="nt-form">
      <button type="button" className="nt-opt-btn" onClick={() => onSave({ pinned: !note.pinned }, note.pinned ? '✓ Unpinned' : '✓ Pinned')}><Icon name={note.pinned ? 'pinOff' : 'pin'} size={15} />{note.pinned ? 'Unpin' : 'Pin to the top'}</button>
      <label className="nt-field"><span>Folder</span><input value={folder} maxLength={60} placeholder="Atlas, Personal…" onChange={(e) => setFolder(e.target.value)} onBlur={() => folder !== (note.folder ?? '') && onSave({ folder }, '✓ Moved')} /></label>
      <label className="nt-field"><span>Tags</span><input value={tags} placeholder="#release #customer" onChange={(e) => setTags(e.target.value)}
        onBlur={() => onSave({ tags: tags.split(/[\s,]+/).map((t) => t.replace(/^#/, '')).filter(Boolean) }, '✓ Tags saved')} /></label>
      {note.mine && (
        <label className="nt-field"><span>Project (keeps its images and files)</span>
          <select value={note.projectId ?? ''} onChange={(e) => onSave(e.target.value ? { projectId: e.target.value } : { clearProject: true }, '✓ Saved')}>
            <option value="">No project</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
      )}
      {note.links.length > 0 && <div className="nt-field"><span>Linked work</span><div className="nt-links">{note.links.map((l) => <a key={l.id} className="nt-lch" href={l.href ?? '#'}>{l.label}</a>)}</div></div>}
      {note.mine && <div className="nt-form-foot"><button type="button" className="nt-danger" onClick={onDelete}><Icon name="trash" size={14} /> Delete note</button></div>}
    </div>
  );
}

export default NotesPage;
