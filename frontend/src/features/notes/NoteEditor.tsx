import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { attachmentApi, insightApi, workspaceApi } from '../../api/endpoints';
import { searchHitLink } from '../../components/CommandPalette';
import { Icon, type IconName } from '../../components/Icon';
import { useWsQuery } from '../../lib/hooks';
import { toast } from '../../stores/ui';
import { newBlock, type BlockType, type Note, type NoteBlock, type NoteRef } from './api';

type Menu = { kind: 'slash' | 'mention' | 'link'; block: string; query: string; at: number } | null;

const SLASH: { id: string; icon: IconName; label: string; sub: string }[] = [
  { id: 'p', icon: 'note', label: 'Text', sub: 'Just start writing' },
  { id: 'check', icon: 'checkCircle', label: 'Checklist', sub: 'Track small things' },
  { id: 'h', icon: 'list', label: 'Heading', sub: 'Big section title' },
  { id: 'mention', icon: 'user', label: 'Mention', sub: '@ a person' },
  { id: 'link', icon: 'link', label: 'Link a task or project', sub: 'ATL-482, Atlas…' },
  { id: 'image', icon: 'image', label: 'Image', sub: 'Upload or paste' },
  { id: 'file', icon: 'paperclip', label: 'Attachment', sub: 'PDF, sheet, any file' },
  { id: 'date', icon: 'calendar', label: 'Date', sub: 'Today, next Friday…' },
];

const kb = (n?: number) => (n == null ? '' : n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

/** A block's text with its mentions and work links drawn as chips, and **bold** as bold. */
function Rich({ text, refs }: { text: string; refs?: NoteRef[] }) {
  const parts = useMemo(() => {
    const tokens = (refs ?? []).map((r) => ({ r, s: `${r.type === 'mention' ? '@' : '#'}${r.label}` })).filter((x) => x.s.length > 1).sort((a, b) => b.s.length - a.s.length);
    const out: ReactNode[] = [];
    let rest = text;
    let key = 0;
    const pushText = (s: string) => {
      s.split(/(\*\*[^*]+\*\*)/g).forEach((seg) => { if (!seg) return; out.push(/^\*\*[^*]+\*\*$/.test(seg) ? <b key={key++}>{seg.slice(2, -2)}</b> : <Fragment key={key++}>{seg}</Fragment>); });
    };
    while (rest.length) {
      let best: { i: number; t: (typeof tokens)[number] } | null = null;
      for (const t of tokens) { const i = rest.indexOf(t.s); if (i >= 0 && (!best || i < best.i)) best = { i, t }; }
      if (!best) { pushText(rest); break; }
      pushText(rest.slice(0, best.i));
      const r = best.t.r;
      out.push(r.type === 'mention'
        ? <span key={key++} className="nt-men">@{r.label}</span>
        : r.href ? <Link key={key++} to={r.href} className="nt-lch" onClick={(e) => e.stopPropagation()}><Icon name="link" size={11} />{r.label}</Link> : <span key={key++} className="nt-lch"><Icon name="link" size={11} />{r.label}</span>);
      rest = rest.slice(best.i + best.t.s.length);
    }
    return out;
  }, [text, refs]);
  return <>{parts}</>;
}

/** A thumbnail of an image kept in project attachments (fetched with the token, shown from an object URL). */
function NoteImage({ id, name }: { id: string; name?: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const ctl = new AbortController();
    let made: string | null = null;
    attachmentApi.inlineBlob(id, ctl.signal).then((u) => { made = u; setUrl(u); }).catch(() => undefined);
    return () => { ctl.abort(); if (made) URL.revokeObjectURL(made); };
  }, [id]);
  return url ? <img src={url} alt={name ?? ''} className="nt-img-el" /> : <div className="nt-img-ph"><Icon name="image" size={22} /><span>{name ?? 'Image'}</span></div>;
}

/** Grows with its text, so a block never scrolls inside itself and nothing jumps. */
function AutoText({ value, onChange, onKeyDown, onBlur, className, placeholder, inputRef, label }: {
  value: string; onChange: (v: string, caret: number) => void; onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void; onBlur: () => void; className?: string; placeholder?: string;
  inputRef: (el: HTMLTextAreaElement | null) => void; label: string;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => { const el = ref.current; if (el) { el.style.height = '0px'; el.style.height = `${el.scrollHeight}px`; } }, [value]);
  return <textarea ref={(el) => { ref.current = el; inputRef(el); }} rows={1} className={className} value={value} placeholder={placeholder} aria-label={label}
    onChange={(e) => onChange(e.target.value, e.target.selectionStart ?? e.target.value.length)} onKeyDown={onKeyDown} onBlur={onBlur} />;
}

/**
 * The note editor: a title and blocks (text, headings, checklists, images, attachments). "/" opens the block menu, "@" mentions a person,
 * "#" links a task or project. Every change saves itself shortly after typing stops (the "✓ Saved" tick below).
 */
export function NoteEditor({ note, onChange, saving, saved }: { note: Note; onChange: (patch: { title?: string; content?: NoteBlock[] }) => void; saving: boolean; saved: boolean }) {
  const [title, setTitle] = useState(note.title);
  const [blocks, setBlocks] = useState<NoteBlock[]>(() => (note.content?.length ? note.content : [newBlock()]));
  const [focus, setFocus] = useState<string | null>(null);
  const [menu, setMenu] = useState<Menu>(null);
  const [sel, setSel] = useState(0);
  const inputs = useRef(new Map<string, HTMLTextAreaElement>());
  const fileRef = useRef<HTMLInputElement>(null);
  const pendingFile = useRef<{ kind: 'image' | 'file'; after: string } | null>(null);
  const members = useWsQuery(['members'], () => workspaceApi.members(), { staleTime: 300_000, enabled: menu?.kind === 'mention' });
  const hits = useWsQuery(['search', 'notes-link', menu?.kind === 'link' ? menu.query : ''], () => insightApi.search(menu!.query || 'a'), { enabled: menu?.kind === 'link', staleTime: 30_000 });

  const commit = (next: NoteBlock[]) => { setBlocks(next); onChange({ content: next }); };
  const update = (id: string, patch: Partial<NoteBlock>) => commit(blocks.map((b) => (b.id === id ? { ...b, ...patch } : b)));
  const focusBlock = (id: string, end = true) => requestAnimationFrame(() => { const el = inputs.current.get(id); if (el) { el.focus(); if (end) el.setSelectionRange(el.value.length, el.value.length); } });
  const insertAfter = (id: string, b: NoteBlock) => { const i = blocks.findIndex((x) => x.id === id); const next = [...blocks.slice(0, i + 1), b, ...blocks.slice(i + 1)]; commit(next); setFocus(b.id); focusBlock(b.id); };

  const options = useMemo(() => {
    if (!menu) return [] as { key: string; icon: IconName; label: string; sub: string; run: () => void }[];
    const q = menu.query.toLowerCase();
    if (menu.kind === 'slash') return SLASH.filter((s) => !q || s.label.toLowerCase().includes(q)).map((s) => ({ key: s.id, icon: s.icon, label: s.label, sub: s.sub, run: () => pickSlash(s.id) }));
    if (menu.kind === 'mention') return (members.data ?? []).filter((m) => m.displayName.toLowerCase().includes(q)).slice(0, 7)
      .map((m) => ({ key: m.userId, icon: 'user' as IconName, label: m.displayName, sub: m.jobRole ?? m.email, run: () => addRef({ type: 'mention', userId: m.userId, label: m.displayName }) }));
    return (hits.data?.hits ?? []).filter((h) => ['task', 'project', 'issue', 'work', 'action'].includes(h.type)).slice(0, 7)
      .map((h) => ({ key: `${h.type}:${h.id}`, icon: (h.type === 'project' ? 'folder' : 'checkCircle') as IconName, label: h.title, sub: h.subtitle ?? h.type,
        run: () => addRef({ type: 'link', kind: h.type, id: h.taskId ?? h.id, label: h.title.length > 60 ? `${h.title.slice(0, 60)}…` : h.title, href: searchHitLink(h) }) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menu, members.data, hits.data, blocks]);
  useEffect(() => setSel(0), [menu?.kind, menu?.query]);

  /** Replaces the "/query", "@query" or "#query" just typed with the choice. */
  function addRef(r: NoteRef) {
    if (!menu) return;
    const b = blocks.find((x) => x.id === menu.block); if (!b) return;
    const token = `${r.type === 'mention' ? '@' : '#'}${r.label} `;
    const text = b.text.slice(0, menu.at) + token + b.text.slice(menu.at + 1 + menu.query.length);
    update(b.id, { text, refs: [...(b.refs ?? []), r] });
    setMenu(null); focusBlock(b.id);
  }
  function pickSlash(id: string) {
    if (!menu) return;
    const b = blocks.find((x) => x.id === menu.block); if (!b) return;
    const text = b.text.slice(0, menu.at) + b.text.slice(menu.at + 1 + menu.query.length);
    setMenu(null);
    if (id === 'p' || id === 'h' || id === 'check') { update(b.id, { type: id as BlockType, text }); focusBlock(b.id); return; }
    if (id === 'mention' || id === 'link') {
      const at = text.length;
      update(b.id, { text: `${text}${id === 'mention' ? '@' : '#'}` });
      setMenu({ kind: id, block: b.id, query: '', at }); focusBlock(b.id); return;
    }
    if (id === 'date') { update(b.id, { text: `${text}${new Date().toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} ` }); focusBlock(b.id); return; }
    update(b.id, { text });
    if (!note.projectId) { toast('Link the note to a project (⋯ › Project) to keep images and files with it.', 'info'); return; }
    pendingFile.current = { kind: id as 'image' | 'file', after: b.id };
    fileRef.current?.click();
  }

  const upload = async (file: File, kind: 'image' | 'file', after: string) => {
    if (!note.projectId) return;
    try {
      const a = await attachmentApi.upload(note.projectId, file);
      const blk: NoteBlock = { ...newBlock(kind === 'image' || a.isImage ? 'image' : 'file'), text: '', fileId: a.id, name: a.fileName, size: a.sizeBytes, projectId: note.projectId };
      const i = blocks.findIndex((x) => x.id === after);
      commit([...blocks.slice(0, i + 1), blk, ...blocks.slice(i + 1)]);
    } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not upload the file.', 'error'); }
  };

  const typed = (b: NoteBlock, value: string, caret: number) => {
    update(b.id, { text: value, refs: (b.refs ?? []).filter((r) => value.includes(`${r.type === 'mention' ? '@' : '#'}${r.label}`)) });
    const before = value.slice(0, caret);
    const m = /(^|\s)([/@#])([^\s/@#]{0,30})$/.exec(before);
    if (m && (m[2] !== '/' || before.trim() === `/${m[3]}`)) setMenu({ kind: m[2] === '/' ? 'slash' : m[2] === '@' ? 'mention' : 'link', block: b.id, query: m[3], at: caret - m[3].length - 1 });
    else setMenu(null);
  };

  const keys = (b: NoteBlock, e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (menu && options.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => (s + 1) % options.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => (s - 1 + options.length) % options.length); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); options[sel]?.run(); return; }
    }
    if (e.key === 'Escape' && menu) { e.preventDefault(); setMenu(null); return; }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (b.type === 'check' && !b.text) { update(b.id, { type: 'p' }); return; }
      insertAfter(b.id, newBlock(b.type === 'check' ? 'check' : 'p'));
      return;
    }
    if (e.key === 'Backspace' && !b.text && blocks.length > 1) {
      e.preventDefault();
      if (b.type !== 'p') { update(b.id, { type: 'p' }); return; }
      const i = blocks.findIndex((x) => x.id === b.id);
      const prev = blocks[i - 1] ?? blocks[i + 1];
      commit(blocks.filter((x) => x.id !== b.id)); setFocus(prev.id); focusBlock(prev.id);
    }
  };

  const when = new Date(note.updatedAt);
  const editedBy = note.editors.map((u) => u.name.split(' ')[0]).filter((v, i, a) => a.indexOf(v) === i);
  const files = blocks.filter((b) => b.type === 'file');

  return (
    <div className="nt-ed">
      <div className="nt-body">
        <div className="nt-date">{when.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })} at {when.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}{editedBy.length ? ` · Edited by ${editedBy.join(' and ')}` : ''}</div>
        <input className="nt-title" value={title} placeholder="Title" aria-label="Title" maxLength={200} onChange={(e) => { setTitle(e.target.value); onChange({ title: e.target.value }); }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); setFocus(blocks[0].id); focusBlock(blocks[0].id, false); } }} />
        {blocks.filter((b) => b.type !== 'file').map((b) => {
          if (b.type === 'image') return (
            <figure key={b.id} className="nt-img">{b.fileId ? <NoteImage id={b.fileId} name={b.name} /> : <div className="nt-img-ph"><Icon name="image" size={22} /></div>}
              <button type="button" className="nt-blk-x" aria-label="Remove image" onClick={() => commit(blocks.filter((x) => x.id !== b.id))}><Icon name="close" size={12} /></button>
            </figure>
          );
          const editing = focus === b.id;
          return (
            <div key={b.id} className={`nt-blk is-${b.type}${b.done ? ' done' : ''}`}>
              {b.type === 'check' && <button type="button" className="nt-ck" role="checkbox" aria-checked={!!b.done} aria-label={b.done ? `Mark not done: ${b.text}` : `Mark done: ${b.text}`} onClick={() => update(b.id, { done: !b.done })} />}
              {editing
                ? <AutoText value={b.text} label={b.type === 'h' ? 'Heading' : b.type === 'check' ? 'Checklist item' : 'Text'} className="nt-in" inputRef={(el) => { if (el) { inputs.current.set(b.id, el); if (document.activeElement !== el) el.focus(); } else inputs.current.delete(b.id); }}
                    placeholder={blocks.length === 1 ? 'Type / for blocks, @ to mention, # to link work' : ''} onChange={(v, c) => typed(b, v, c)} onKeyDown={(e) => keys(b, e)} onBlur={() => { setMenu(null); setFocus((f) => (f === b.id ? null : f)); }} />
                : <div className="nt-view" role="textbox" tabIndex={0} aria-label="Edit block" onClick={() => { setFocus(b.id); focusBlock(b.id); }} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setFocus(b.id); focusBlock(b.id); } }}>
                    {b.text ? <Rich text={b.text} refs={b.refs} /> : <span className="nt-ph">{blocks.length === 1 ? 'Type / for blocks, @ to mention, # to link work' : ' '}</span>}
                  </div>}
              {menu && menu.block === b.id && options.length > 0 && (
                <div className="nt-menu" role="listbox" aria-label={menu.kind === 'slash' ? 'Blocks' : menu.kind === 'mention' ? 'People' : 'Work'}>
                  {options.map((o, i) => (
                    <button key={o.key} type="button" role="option" aria-selected={i === sel} className={i === sel ? 'on' : ''} onMouseDown={(e) => { e.preventDefault(); o.run(); }} onMouseEnter={() => setSel(i)}>
                      <Icon name={o.icon} size={16} /><span><b>{o.label}</b><small>{o.sub}</small></span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        <button type="button" className="nt-add" onClick={() => { const last = blocks[blocks.length - 1]; if (last && !last.text && last.type === 'p') { setFocus(last.id); focusBlock(last.id); } else insertAfter(last.id, newBlock()); }} aria-label="Add a line">&nbsp;</button>
        {files.length > 0 && (
          <div className="nt-atts">
            {files.map((f) => (
              <span key={f.id} className="nt-att">
                <button type="button" onClick={() => f.fileId && void attachmentApi.download(f.fileId, f.name ?? 'file')}><Icon name="paperclip" size={14} />{f.name}<small>{kb(f.size)}</small></button>
                <button type="button" className="nt-att-x" aria-label={`Remove ${f.name}`} onClick={() => commit(blocks.filter((x) => x.id !== f.id))}><Icon name="close" size={11} /></button>
              </span>
            ))}
          </div>
        )}
        <input ref={fileRef} type="file" hidden accept={pendingFile.current?.kind === 'image' ? 'image/*' : undefined}
          onChange={(e) => { const f = e.target.files?.[0]; const p = pendingFile.current; if (f && p) void upload(f, p.kind, p.after); e.target.value = ''; pendingFile.current = null; }} />
      </div>
      <div className="nt-foot">
        <span>Type <kbd>/</kbd> for blocks · <kbd>@</kbd> to mention · <kbd>#</kbd> to link work</span>
        <span className={`nt-saved${saved && !saving ? ' on' : ''}`} aria-live="polite">{saving ? 'Saving…' : saved ? '✓ Saved' : ''}</span>
      </div>
    </div>
  );
}
