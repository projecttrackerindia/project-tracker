import { useEffect, useMemo, useRef } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import Highlight from '@tiptap/extension-highlight';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { TableKit } from '@tiptap/extension-table';
import { emptyDoc } from './docUi';
import { DocImage } from './DocImage';

function parse(value: string) {
  try { const v = JSON.parse(value); return v && v.type === 'doc' ? v : JSON.parse(emptyDoc); } catch { return JSON.parse(emptyDoc); }
}

function Btn({ on, label, children, active, disabled }: { on: () => void; label: string; children: React.ReactNode; active?: boolean; disabled?: boolean }) {
  return <button type="button" className={`rte-btn${active ? ' on' : ''}`} onClick={on} title={label} aria-label={label} aria-pressed={active} disabled={disabled}>{children}</button>;
}

function Toolbar({ editor, onImage }: { editor: Editor; onImage?: () => void }) {
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
      <Btn label="Link" active={editor.isActive('link')} on={link}>🔗</Btn>
      {onImage && <Btn label="Insert picture" on={onImage}>🖼</Btn>}
      <Btn label="Insert table" on={() => c().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}>▦</Btn>
      {editor.isActive('table') && <>
        <Btn label="Add row below" on={() => c().addRowAfter().run()}>＋row</Btn>
        <Btn label="Add column after" on={() => c().addColumnAfter().run()}>＋col</Btn>
        <Btn label="Delete row" on={() => c().deleteRow().run()}>−row</Btn>
        <Btn label="Delete column" on={() => c().deleteColumn().run()}>−col</Btn>
        <Btn label="Delete table" on={() => c().deleteTable().run()}>✕ table</Btn>
      </>}
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
export function RichEditor({ value, onChange, readOnly, placeholder, label, onPickImage }: { value: string; onChange?: (json: string) => void; readOnly?: boolean; placeholder?: string; label: string; onPickImage?: () => Promise<{ fileId: string; alt: string } | null> }) {
  const initial = useMemo(() => parse(value), []); // eslint-disable-line react-hooks/exhaustive-deps
  const last = useRef(value);
  // Some extensions (table, list) run a transaction of their own while the editor is still being built, which can fire onUpdate once
  // before anyone has typed anything - that falsely marked a brand-new, still-empty section "unsaved" the moment its editor mounted.
  // onCreate always runs before any real keystroke could, so it is a safe place to start actually listening for edits.
  const ready = useRef(false);
  const editor = useEditor({
    editable: !readOnly,
    content: initial,
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3, 4] }, link: { openOnClick: !!readOnly, autolink: true, protocols: ['http', 'https', 'mailto'], HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank' } } }),
      Placeholder.configure({ placeholder: placeholder ?? 'Start writing…' }),
      Highlight, TaskList, TaskItem.configure({ nested: true }), TableKit.configure({ table: { resizable: false } }), DocImage,
    ],
    editorProps: { attributes: { class: 'rte-content', 'aria-label': label, role: 'textbox', 'aria-multiline': 'true' } },
    onCreate: () => { ready.current = true; },
    onUpdate: ({ editor: e }) => {
      if (!ready.current) return;
      const json = JSON.stringify(e.getJSON()); last.current = json; onChange?.(json);
    },
  });

  useEffect(() => { editor?.setEditable(!readOnly); }, [editor, readOnly]);
  // A reload (or a restore) replaces the text from outside: take it, but never fight what is being typed.
  useEffect(() => {
    if (!editor || value === last.current) return;
    last.current = value;
    editor.commands.setContent(parse(value), { emitUpdate: false });
  }, [editor, value]);

  if (!editor) return <div className="rte rte-loading" />;
  return (
    <div className={`rte${readOnly ? ' readonly' : ''}`}>
      {!readOnly && <Toolbar editor={editor} onImage={onPickImage ? async () => { const pic = await onPickImage(); if (pic) editor.chain().focus().insertContent({ type: 'docImage', attrs: pic }).run(); } : undefined} />}
      <EditorContent editor={editor} />
    </div>
  );
}
