import { Icon } from '../../components/Icon';
import { createContext, useContext, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { getSchema } from '@tiptap/core';
import type { Schema } from '@tiptap/pm/model';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import StarterKit from '@tiptap/starter-kit';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import { Details, DetailsContent, DetailsSummary } from '@tiptap/extension-details';
import { DragHandle } from '@tiptap/extension-drag-handle-react';
import { common, createLowlight } from 'lowlight';
import { Callout, mentionExtension, slashCommands, type EditorLookups, type SlashExtras } from './editor/extensions';
import { AiWriteDialog, continueWriting, EditorAiContext, SelectionAiPanel, type SelectionAi } from './editor/ai';
import type { DocCollab } from './editor/collab';
import { CommentMark, LiveTasks } from './editor/LiveTasks';
import Placeholder from '@tiptap/extension-placeholder';
import Highlight from '@tiptap/extension-highlight';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { TableKit } from '@tiptap/extension-table';
import { emptyDoc } from './docUi';
import { DocImage } from './DocImage';
import { MotionMenu, motionExtensions } from './motion/MotionBlocks';
import { insertMotion, LottiePicker, type MotionHost, type MotionKind } from './motion/inserts';
import './documents-ds.css';

const lowlight = createLowlight(common);

/** People, tasks and pages the editor offers after @, # and [[ (provided by the document page). */
export const EditorLookupsContext = createContext<EditorLookups | null>(null);

/**
 * The node and mark types of the editor (everything but co-editing). The page's schema for co-editing is built from the same list, so the
 * shared text and the editor always agree on what a block is.
 */
function contentExtensions(o: { readOnly: boolean; collab: boolean; lookups: { current: EditorLookups | null }; slash: { current: SlashExtras }; placeholder: string }) {
  return [
    StarterKit.configure({ codeBlock: false, heading: { levels: [1, 2, 3, 4] }, link: { openOnClick: o.readOnly, autolink: true, protocols: ['http', 'https', 'mailto'], HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank' } },
      ...(o.collab ? { undoRedo: false as const } : {}) }),
    Placeholder.configure({ placeholder: ({ node }) => (node.type.name === 'heading' ? 'Heading' : node.type.name === 'detailsSummary' ? 'Toggle title' : o.placeholder), showOnlyCurrent: true, includeChildren: true }),
    Highlight, TaskList, TaskItem.configure({ nested: true }), TableKit.configure({ table: { resizable: false } }), DocImage,
    CodeBlockLowlight.configure({ lowlight }), Callout, mentionExtension(o.lookups), slashCommands(o.slash),
    Details.configure({ persist: true, HTMLAttributes: { class: 'rte-details' } }), DetailsSummary, DetailsContent, LiveTasks, CommentMark,
    ...motionExtensions,
  ];
}

let schemaCache: Schema | null = null;
/** The page editor's schema (for turning saved text into shared co-editing text before the editor opens). */
export const pageSchema = () => (schemaCache ??= getSchema(contentExtensions({ readOnly: false, collab: true, lookups: { current: null }, slash: { current: {} }, placeholder: '' })));

function parse(value: string) {
  try { const v = JSON.parse(value); return v && v.type === 'doc' ? v : JSON.parse(emptyDoc); } catch { return JSON.parse(emptyDoc); }
}

function Btn({ on, label, children, active, disabled }: { on: () => void; label: string; children: React.ReactNode; active?: boolean; disabled?: boolean }) {
  return <button type="button" className={`rte-btn${active ? ' on' : ''}`} onClick={on} title={label} aria-label={label} aria-pressed={active} disabled={disabled}>{children}</button>;
}

function askLink(editor: Editor) {
  const prev = editor.getAttributes('link').href as string | undefined;
  const url = window.prompt('Link address (https://…)', prev ?? 'https://');
  if (url === null) return;
  if (url.trim() === '') { editor.chain().focus().unsetLink().run(); return; }
  editor.chain().focus().extendMarkRange('link').setLink({ href: url.trim() }).run();
}

/** A new comment thread's mark id (letters, digits and hyphens: what the server keeps). */
const newAnchorId = () => `c-${(crypto.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`).replace(/-/g, '').slice(0, 20)}`;

/** Takes the highlight of one comment thread off the text (its thread was resolved, or the comment was never sent). */
export function removeCommentMark(editor: Editor, anchorId: string) {
  const type = editor.schema.marks.comment;
  if (!type) return;
  const tr = editor.state.tr;
  editor.state.doc.descendants((node, pos) => {
    const m = node.marks.find((x) => x.type === type && x.attrs.id === anchorId);
    if (m && node.isText) tr.removeMark(pos, pos + node.nodeSize, m);
  });
  if (tr.docChanged) editor.view.dispatch(tr);
}

export interface CommentRequest { anchorId: string | null; quote: string; cancel: () => void }

/** The small bar over selected text: the formatting people reach for most, AI on the words, and a comment on them, where the eyes already are. */
function SelectionBar({ editor, onComment }: { editor: Editor; onComment?: (r: CommentRequest) => void }) {
  const c = () => editor.chain().focus();
  const ai = useContext(EditorAiContext);
  const [aiState, setAiState] = useState<SelectionAi | null>(null);
  const [motion, setMotion] = useState(false);
  const comment = () => {
    const { from, to } = editor.state.selection;
    const quote = editor.state.doc.textBetween(from, to, ' ', ' ').trim().slice(0, 500);
    if (!editor.isEditable) { onComment?.({ anchorId: null, quote, cancel: () => {} }); return; }
    const id = newAnchorId();
    editor.chain().focus().setMark('comment', { id }).run();
    onComment?.({ anchorId: id, quote, cancel: () => removeCommentMark(editor, id) });
  };
  return (
    <BubbleMenu editor={editor} className={`rte-bubble${aiState ? ' with-ai' : ''}`} options={{ placement: 'top-start' }}
      shouldShow={({ editor: e, from, to }) => !!aiState || motion || (from !== to && (e.isEditable || !!onComment) && !e.isActive('codeBlock') && !e.isActive('mention'))}>
      {motion && editor.isEditable ? <MotionMenu editor={editor} onClose={() => setMotion(false)} /> : aiState && ai ? <SelectionAiPanel editor={editor} documentId={ai.documentId} state={aiState} setState={setAiState} /> : <>
      {ai && editor.isEditable && <><SelectionAiPanel editor={editor} documentId={ai.documentId} state={null} setState={setAiState} /><span className="rte-sep" /></>}
      {onComment && <><Btn label="Comment on this" on={comment}><Icon name="message" size={15} /></Btn>{editor.isEditable && <span className="rte-sep" />}</>}
      {editor.isEditable && <>
      <Btn label="Bold" active={editor.isActive('bold')} on={() => c().toggleBold().run()}><b>B</b></Btn>
      <Btn label="Italic" active={editor.isActive('italic')} on={() => c().toggleItalic().run()}><i>I</i></Btn>
      <Btn label="Underline" active={editor.isActive('underline')} on={() => c().toggleUnderline().run()}><u>U</u></Btn>
      <Btn label="Strikethrough" active={editor.isActive('strike')} on={() => c().toggleStrike().run()}><s>S</s></Btn>
      <Btn label="Inline code" active={editor.isActive('code')} on={() => c().toggleCode().run()}>{'<>'}</Btn>
      <Btn label="Highlight" active={editor.isActive('highlight')} on={() => c().toggleHighlight().run()}><mark>H</mark></Btn>
      <span className="rte-sep" />
      <Btn label="Heading" active={editor.isActive('heading', { level: 2 })} on={() => c().toggleHeading({ level: 2 }).run()}>H2</Btn>
      <Btn label="Link" active={editor.isActive('link')} on={() => askLink(editor)}><Icon name="link" size={15} /></Btn>
      <span className="rte-sep" />
      <Btn label="Motion of this block" on={() => setMotion(true)}>✦ Motion</Btn>
      </>}
      </>}
    </BubbleMenu>
  );
}

function Toolbar({ editor, onImage, onMotion, sandbox }: { editor: Editor; onImage?: () => void; onMotion?: (k: MotionKind) => void; sandbox?: boolean }) {
  const link = () => {
    const prev = editor.getAttributes('link').href as string | undefined;
    const url = window.prompt('Link address (https://…)', prev ?? 'https://');
    if (url === null) return;
    if (url.trim() === '') { editor.chain().focus().unsetLink().run(); return; }
    editor.chain().focus().extendMarkRange('link').setLink({ href: url.trim() }).run();
  };
  const c = () => editor.chain().focus();
  return (
    <div className="rte-bar" role="toolbar" aria-label="Formatting">
      <Btn label="Bold" active={editor.isActive('bold')} on={() => c().toggleBold().run()}><b>B</b></Btn>
      <Btn label="Italic" active={editor.isActive('italic')} on={() => c().toggleItalic().run()}><i>I</i></Btn>
      <Btn label="Underline" active={editor.isActive('underline')} on={() => c().toggleUnderline().run()}><u>U</u></Btn>
      <Btn label="Strikethrough" active={editor.isActive('strike')} on={() => c().toggleStrike().run()}><s>S</s></Btn>
      <Btn label="Highlight" active={editor.isActive('highlight')} on={() => c().toggleHighlight().run()}><mark>H</mark></Btn>
      <span className="rte-sep" />
      <Btn label="Heading" active={editor.isActive('heading', { level: 2 })} on={() => c().toggleHeading({ level: 2 }).run()}>H2</Btn>
      <Btn label="Subheading" active={editor.isActive('heading', { level: 3 })} on={() => c().toggleHeading({ level: 3 }).run()}>H3</Btn>
      <span className="rte-sep" />
      <Btn label="Bulleted list" active={editor.isActive('bulletList')} on={() => c().toggleBulletList().run()}>•</Btn>
      <Btn label="Numbered list" active={editor.isActive('orderedList')} on={() => c().toggleOrderedList().run()}>1.</Btn>
      <Btn label="Checklist" active={editor.isActive('taskList')} on={() => c().toggleTaskList().run()}>☑</Btn>
      <Btn label="Quote" active={editor.isActive('blockquote')} on={() => c().toggleBlockquote().run()}>“</Btn>
      <Btn label="Code" active={editor.isActive('codeBlock')} on={() => c().toggleCodeBlock().run()}>{'</>'}</Btn>
      <span className="rte-sep" />
      <Btn label="Insert diagram" on={() => c().insertContent({ type: 'codeBlock', attrs: { language: 'mermaid' }, content: [{ type: 'text', text: 'flowchart LR\n  A[Start] --> B{Check}\n  B -->|yes| C[Done]\n  B -->|no| A' }] }).run()}>⬡</Btn>
      <Btn label="Link" active={editor.isActive('link')} on={link}><Icon name="link" size={15} /></Btn>
      {onImage && <Btn label="Insert picture" on={onImage}><Icon name="image" size={15} /></Btn>}
      <Btn label="Insert table" on={() => c().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}>▦</Btn>
      {onMotion && <>
        <span className="rte-sep" />
        <Btn label="Insert Lottie animation" on={() => onMotion('lottie')}>◌</Btn>
        <Btn label="Insert animated SVG" on={() => onMotion('svg')}>✧</Btn>
        <Btn label="Insert video" on={() => onMotion('video')}>▶</Btn>
        <Btn label="Insert GIF or APNG" on={() => onMotion('gif')}>GIF</Btn>
        {sandbox && <Btn label="Insert interactive embed" on={() => onMotion('sandbox')}>⧉</Btn>}
      </>}
      {editor.isActive('table') && <>
        <Btn label="Add row below" on={() => c().addRowAfter().run()}>＋row</Btn>
        <Btn label="Add column after" on={() => c().addColumnAfter().run()}>＋col</Btn>
        <Btn label="Delete row" on={() => c().deleteRow().run()}>−row</Btn>
        <Btn label="Delete column" on={() => c().deleteColumn().run()}>−col</Btn>
        <Btn label="Delete table" on={() => c().deleteTable().run()}>✕ table</Btn>
      </>}
      <span className="rte-sep" />
      <Btn label="Toggle (opens to show more)" active={editor.isActive('details')} on={() => c().setDetails().run()}>▸</Btn>
      <span className="rte-sep" />
      <Btn label="Undo" on={() => c().undo().run()} disabled={!editor.can().undo()}>↶</Btn>
      <Btn label="Redo" on={() => c().redo().run()} disabled={!editor.can().redo()}>↷</Btn>
    </div>
  );
}

/**
 * Rich text for one section. The content is ProseMirror JSON (never HTML): what is typed here is stored as data, and the server drops anything
 * outside the editor's own node and mark types.
 */
export function RichEditor({ value, onChange, readOnly, placeholder, label, onPickImage, minimal, collab, me, onComment, onOpenComment, onEditor, liveTasks, motion }: { value: string; onChange?: (json: string) => void; readOnly?: boolean; placeholder?: string; label: string; onPickImage?: () => Promise<{ fileId: string; alt: string } | null>;
  /** A page: no toolbar - "/" for blocks, a bar over selected text, @ # [[ for mentions. */
  minimal?: boolean;
  /** Editing together: the shared text replaces `value`, and the others' cursors show with their names. */
  collab?: DocCollab | null; me?: { name: string };
  /** "Comment" on selected text: the thread to start (its highlight is already on the text). */
  onComment?: (r: CommentRequest) => void;
  /** A highlighted passage was clicked: open its thread. */
  onOpenComment?: (anchorId: string) => void;
  /** The editor once it exists, and null with the editor that went away (it is destroyed a moment after a newer one may have started). */
  onEditor?: (e: Editor | null, gone?: Editor | null) => void;
  /** "/Live task list" is offered (pages that belong to a project, or any page where projects can be chosen). */
  liveTasks?: boolean;
  /** Motion blocks can be added (Lottie, SVG, video, GIF, interactive embed): the page lends its file upload. */
  motion?: MotionHost }) {
  const initial = useMemo(() => parse(value), []); // eslint-disable-line react-hooks/exhaustive-deps
  const navigate = useNavigate();
  const lookups = useContext(EditorLookupsContext);
  const ai = useContext(EditorAiContext);
  const lookupsRef = useRef<EditorLookups | null>(lookups); lookupsRef.current = lookups;
  const editorRef = useRef<Editor | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiWrite, setAiWrite] = useState(false);
  const [lottie, setLottie] = useState(false);
  const onMotion = motion ? (k: MotionKind) => { if (editorRef.current) void insertMotion(editorRef.current, k, motion, () => setLottie(true)); } : undefined;
  const insertImage = onPickImage ? async () => { const pic = await onPickImage(); if (pic) editorRef.current?.chain().focus().insertContent({ type: 'docImage', attrs: pic }).run(); } : undefined;
  const extras: SlashExtras = {
    onImage: insertImage, liveTasks, onMotion, sandbox: motion?.sandbox,
    onAiWrite: ai ? () => setAiWrite(true) : undefined,
    onAiContinue: ai ? () => { if (editorRef.current) void continueWriting(editorRef.current, ai.documentId, setAiBusy); } : undefined,
  };
  const slashRef = useRef<SlashExtras>(extras); slashRef.current = extras;
  const onOpenRef = useRef(onOpenComment); onOpenRef.current = onOpenComment;
  const last = useRef(value);
  // Some extensions (table, list) run a transaction of their own while the editor is still being built, which can fire onUpdate once
  // before anyone has typed anything - that falsely marked a brand-new, still-empty section "unsaved" the moment its editor mounted.
  // onCreate always runs before any real keystroke could, so it is a safe place to start actually listening for edits.
  const ready = useRef(false);
  const editor = useEditor({
    editable: !readOnly,
    // Editing together, the shared text is the content (putting the saved text in as well would double it).
    content: collab ? undefined : initial,
    extensions: [
      ...contentExtensions({ readOnly: !!readOnly, collab: !!collab, lookups: lookupsRef, slash: slashRef,
        placeholder: placeholder ?? (ai ? 'Type / for blocks or AI, @ for people, [[ for pages…' : 'Type / for blocks, @ for people, [[ for pages…') }),
      ...(collab ? [
        Collaboration.configure({ document: collab.doc }),
        CollaborationCaret.configure({
          provider: collab,
          user: { name: me?.name ?? 'Someone', color: collab.color },
          render: (u: Record<string, unknown>) => {
            const caret = document.createElement('span'); caret.className = 'collab-caret'; caret.style.borderColor = String(u.color ?? '#2563eb');
            const tag = document.createElement('span'); tag.className = 'collab-tag'; tag.style.background = String(u.color ?? '#2563eb'); tag.textContent = String(u.name ?? 'Someone');
            caret.append(tag); return caret;
          },
          selectionRender: (u: Record<string, unknown>) => ({ nodeName: 'span', class: 'collab-sel', style: `background-color: ${String(u.color ?? '#2563eb')}33` }),
        }),
      ] : []),
    ],
    editorProps: { attributes: { class: 'rte-content', 'aria-label': label, role: 'textbox', 'aria-multiline': 'true' } },
    onCreate: ({ editor: e }) => { ready.current = true; editorRef.current = e; onEditor?.(e); },
    onDestroy: () => onEditor?.(null, editorRef.current),
    onUpdate: ({ editor: e }) => {
      if (!ready.current) return;
      const json = JSON.stringify(e.getJSON()); last.current = json; onChange?.(json);
    },
  });

  // Switching between reading and editing is not an edit (setEditable would otherwise report the old text as a change).
  useEffect(() => { editor?.setEditable(!readOnly, false); }, [editor, readOnly]);
  // A reload (or a restore) replaces the text from outside: take it, but never fight what is being typed.
  useEffect(() => {
    if (!editor || collab || value === last.current) return;
    last.current = value;
    editor.commands.setContent(parse(value), { emitUpdate: false });
  }, [editor, value, collab]);

  // A page or task chip opens it (inside the app, not a full reload).
  const openChip = (e: MouseEvent) => {
    const mark = (e.target as HTMLElement).closest<HTMLElement>('[data-comment-id]');
    // A click (not the end of selecting text) on a highlight opens its thread.
    if (mark && onOpenRef.current && (window.getSelection()?.isCollapsed ?? true)) { onOpenRef.current(mark.dataset.commentId!); }
    const a = (e.target as HTMLElement).closest<HTMLAnchorElement>('a[data-href]');
    if (!a) return;
    e.preventDefault();
    navigate(a.dataset.href!);
  };

  if (!editor) return <div className="rte rte-loading" />;
  return (
    <div className={`rte${readOnly ? ' readonly' : ''}${minimal ? ' minimal' : ''}`} onClick={openChip}>
      {!readOnly && !minimal && <Toolbar editor={editor} onImage={insertImage} onMotion={onMotion} sandbox={motion?.sandbox} />}
      {(!readOnly || onComment) && <SelectionBar editor={editor} onComment={onComment} />}
      {!readOnly && minimal && (
        <DragHandle editor={editor} className="rte-drag">
          <span className="rte-drag-grip" title="Drag to move · click to select the block" aria-label="Drag to move the block">⋮⋮</span>
        </DragHandle>
      )}
      <EditorContent editor={editor} />
      {aiBusy && <div className="rte-ai-busy" role="status"><span className="spinner" /> Writing the next part…</div>}
      {aiWrite && <AiWriteDialog editor={editor} onClose={() => setAiWrite(false)} />}
      {lottie && motion && <LottiePicker editor={editor} host={motion} onClose={() => setLottie(false)} />}
    </div>
  );
}
