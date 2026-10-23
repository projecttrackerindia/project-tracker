import { createContext, useState } from 'react';
import type { Editor, JSONContent } from '@tiptap/core';
import { ApiError } from '../../../api/client';
import { Modal } from '../../../components/ui';
import { toast } from '../../../stores/ui';
import { docAiApi, LANGUAGES, type AiAction, type AiLanguage, type DocTransform } from '../docAi';

/** The page the editor writes into, so AI can read its title and the credits are counted for the right workspace. Absent: no AI in the editor. */
export const EditorAiContext = createContext<{ documentId: string } | null>(null);

export const AI_ACTIONS: { id: AiAction; label: string; icon: string }[] = [
  { id: 'rewrite', label: 'Rewrite', icon: '✍️' },
  { id: 'shorten', label: 'Shorter', icon: '➖' },
  { id: 'expand', label: 'Longer', icon: '➕' },
  { id: 'fix', label: 'Fix spelling & grammar', icon: '✔️' },
  { id: 'simpler', label: 'Simpler words', icon: '🙂' },
  { id: 'formal', label: 'More formal', icon: '👔' },
  { id: 'friendly', label: 'More friendly', icon: '🤝' },
];

const parseBlocks = (json: string | null | undefined): JSONContent[] => {
  try { const v = JSON.parse(json ?? '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
};

/** What an AI answer puts in the page: inside the line for one plain paragraph (formatting kept), otherwise as blocks. */
export function answerContent(r: DocTransform): JSONContent[] | string {
  const blocks = parseBlocks(r.blocks);
  if (r.inline && blocks.length === 1) return blocks[0].content ?? [{ type: 'text', text: r.text }];
  return blocks.length ? blocks : r.text;
}

/** Where a top-level block ends: AI text "inserted below" goes after the block the selection ends in. */
function afterBlock(editor: Editor, pos: number) {
  const $p = editor.state.doc.resolve(Math.min(pos, editor.state.doc.content.size));
  return $p.depth >= 1 ? $p.after(1) : $p.pos;
}

export interface SelectionAi { from: number; to: number; text: string; action: AiAction; language?: AiLanguage; busy: boolean; result: DocTransform | null; error: string | null }

/**
 * AI on the selected text, in the bar over the selection: rewrite, shorten, expand, fix, a tone, or translate (Telugu, Hindi, English).
 * The answer is shown first - replace the selection with it, insert it below, try again or discard - nothing changes in the page until then.
 */
export function SelectionAiPanel({ editor, documentId, state, setState }: { editor: Editor; documentId: string; state: SelectionAi | null; setState: (s: SelectionAi | null) => void }) {
  const [menu, setMenu] = useState(false);
  const run = async (action: AiAction, language?: AiLanguage, base?: SelectionAi) => {
    setMenu(false);
    const { from, to } = base ?? editor.state.selection;
    const text = base?.text ?? editor.state.doc.textBetween(from, to, '\n\n', ' ');
    if (!text.trim()) return;
    const next: SelectionAi = { from, to, text, action, language, busy: true, result: null, error: null };
    setState(next);
    try {
      const r = await docAiApi.transform(text, action, language, documentId);
      setState({ ...next, busy: false, result: r });
    } catch (e) {
      setState({ ...next, busy: false, error: e instanceof ApiError ? e.message : 'The AI could not answer. Try again in a moment.' });
    }
  };
  // The selection may have moved while the AI wrote (someone else typing above it): use it only while its words are still there.
  const range = (s: SelectionAi) => {
    const size = editor.state.doc.content.size;
    if (s.to <= size && editor.state.doc.textBetween(s.from, s.to, '\n\n', ' ') === s.text) return { from: s.from, to: s.to };
    return { from: editor.state.selection.from, to: editor.state.selection.to };
  };
  const replace = () => {
    if (!state?.result) return;
    editor.chain().focus().insertContentAt(range(state), answerContent(state.result)).run();
    setState(null);
  };
  const below = () => {
    if (!state?.result) return;
    const blocks = parseBlocks(state.result.blocks);
    editor.chain().focus().insertContentAt(afterBlock(editor, range(state).to), blocks.length ? blocks : [{ type: 'paragraph', content: [{ type: 'text', text: state.result.text }] }]).run();
    setState(null);
  };

  if (state) {
    const label = state.action === 'translate' ? `Translate to ${LANGUAGES.find((l) => l.id === state.language)?.label ?? ''}` : AI_ACTIONS.find((a) => a.id === state.action)?.label;
    return (
      <div className="ai-sel" role="dialog" aria-label="AI suggestion" onMouseDown={(e) => { if ((e.target as HTMLElement).tagName !== 'TEXTAREA') e.preventDefault(); }}>
        <div className="ai-sel-head"><span>✨ {label}</span><button type="button" className="ai-x" aria-label="Discard" onClick={() => setState(null)}>×</button></div>
        {state.busy ? <p className="ai-sel-wait"><span className="spinner" /> Writing…</p>
          : state.error ? <p className="ai-sel-err" role="alert">{state.error}</p>
            : <div className="ai-sel-out" aria-live="polite">{state.result?.text}</div>}
        <div className="ai-sel-actions">
          {state.result && <button type="button" className="btn btn-primary btn-sm" onClick={replace}>Replace</button>}
          {state.result && <button type="button" className="btn btn-ghost btn-sm" onClick={below}>Insert below</button>}
          {!state.busy && <button type="button" className="btn btn-ghost btn-sm" onClick={() => void run(state.action, state.language, state)}>Try again</button>}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setState(null)}>Discard</button>
        </div>
      </div>
    );
  }
  return (
    <span className="ai-sel-wrap">
      <button type="button" className={`rte-btn rte-ai${menu ? ' on' : ''}`} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)} title="Ask AI to change the selected text">✨ AI</button>
      {menu && (
        <div className="ai-menu" role="menu" onMouseDown={(e) => e.preventDefault()}>
          {AI_ACTIONS.map((a) => <button key={a.id} type="button" role="menuitem" onClick={() => void run(a.id)}><span aria-hidden="true">{a.icon}</span>{a.label}</button>)}
          <div className="ai-menu-sep">Translate to</div>
          {LANGUAGES.map((l) => <button key={l.id} type="button" role="menuitem" onClick={() => void run('translate', l.id)}><span aria-hidden="true">🌐</span>{l.label}</button>)}
        </div>
      )}
    </span>
  );
}

/** "/Continue writing": the next paragraphs of the page in its voice, put in at the caret (undo takes them out again). */
export async function continueWriting(editor: Editor, documentId: string, setBusy: (b: boolean) => void) {
  const at = editor.state.selection.to;
  const before = editor.state.doc.textBetween(0, at, '\n\n', ' ');
  setBusy(true);
  try {
    const r = await docAiApi.continueWriting(documentId, before);
    const blocks = parseBlocks(r.blocks);
    const pos = Math.min(at, editor.state.doc.content.size);
    const $p = editor.state.doc.resolve(pos);
    // An empty line is replaced; otherwise the new paragraphs start after the current one.
    const emptyLine = $p.parent.isTextblock && $p.parent.content.size === 0 && $p.depth >= 1;
    const range = emptyLine ? { from: $p.before($p.depth), to: $p.after($p.depth) } : afterBlock(editor, pos);
    editor.chain().focus().insertContentAt(range, blocks.length ? blocks : r.text).run();
  } catch (e) {
    toast(e instanceof ApiError ? e.message : 'The AI could not write right now.', 'error');
  } finally { setBusy(false); }
}

/** "/Write with AI": say what to write, in which language; the result goes in at the caret. */
export function AiWriteDialog({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const [prompt, setPrompt] = useState('');
  const [language, setLanguage] = useState<AiLanguage>('en');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const at = useState(() => editor.state.selection.to)[0];
  const submit = async () => {
    if (!prompt.trim() || busy) return;
    setBusy(true); setError(null);
    try {
      const d = await docAiApi.draft({ source: 'prompt', prompt: prompt.trim(), language });
      const doc = JSON.parse(d.body) as JSONContent;
      const pos = Math.min(at, editor.state.doc.content.size);
      editor.chain().focus().insertContentAt(afterBlock(editor, pos), doc.content ?? []).run();
      onClose();
    } catch (e) { setError(e instanceof ApiError ? e.message : 'The AI could not write that right now.'); setBusy(false); }
  };
  return (
    <Modal title="Write with AI" subtitle="Say what this part of the page should say. You can change every word afterwards." onClose={onClose} className="doc-scope"
      onSubmit={(e) => { e.preventDefault(); void submit(); }}
      footer={<><button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button><button type="submit" className="btn btn-primary" disabled={!prompt.trim() || busy}>{busy && <span className="spinner" />}Write it</button></>}>
      {error && <div className="doc-alert" role="alert"><div>{error}</div></div>}
      <label className="field"><span>What to write</span>
        <textarea className="input" rows={4} autoFocus maxLength={2000} value={prompt} onChange={(e) => setPrompt(e.target.value)}
          placeholder="e.g. A short onboarding checklist for new support agents: tools, first-week tasks, who to ask" /></label>
      <label className="field"><span>Language</span>
        <select className="input" value={language} onChange={(e) => setLanguage(e.target.value as AiLanguage)}>{LANGUAGES.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}</select></label>
    </Modal>
  );
}
