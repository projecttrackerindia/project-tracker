import { Extension, Node, mergeAttributes, type Editor, type Range } from '@tiptap/core';
import Mention from '@tiptap/extension-mention';
import Suggestion from '@tiptap/suggestion';
import { PluginKey } from '@tiptap/pm/state';
import { suggestRenderer, type SuggestItem } from './SuggestMenu';

/** What the editor can look up while typing: people for @, tasks for #, pages for [[. Supplied by the page around the editor. */
export interface EditorLookups {
  people: (q: string) => SuggestItem[] | Promise<SuggestItem[]>;
  tasks: (q: string) => Promise<SuggestItem[]>;
  pages: (q: string) => Promise<SuggestItem[]>;
}

/** A coloured note block ("Read this first", "Warning"): any blocks inside, a tone of info, warning, success or danger. */
export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,
  addAttributes() {
    return { tone: { default: 'info', parseHTML: (el) => el.getAttribute('data-tone') ?? 'info', renderHTML: (a) => ({ 'data-tone': a.tone }) } };
  },
  parseHTML() { return [{ tag: 'div[data-callout]' }]; },
  renderHTML({ HTMLAttributes }) { return ['div', mergeAttributes(HTMLAttributes, { 'data-callout': '', class: 'rte-callout' }), 0]; },
});

const KIND_ICON: Record<string, string> = { person: '@', task: '#', page: '▤' };

/**
 * One mention node for three kinds: @person, #task and [[page]]. It is stored as data (kind, id, label: the server keeps nothing else) and shown
 * as a chip; a page chip is a link to the page, a task chip opens the task.
 */
export function mentionExtension(lookups: { current: EditorLookups | null }) {
  const pick = (kind: string) => ({ editor, range, props }: { editor: Editor; range: Range; props: unknown }) => {
    const item = props as SuggestItem;
    editor.chain().focus().insertContentAt(range, [
      { type: 'mention', attrs: { kind, id: item.id, label: item.title } },
      { type: 'text', text: ' ' },
    ]).run();
  };
  return Mention.extend({
    addAttributes() {
      return {
        ...this.parent?.(),
        kind: { default: 'person', parseHTML: (el) => el.getAttribute('data-kind') ?? 'person', renderHTML: (a) => ({ 'data-kind': a.kind }) },
      };
    },
  }).configure({
    deleteTriggerWithBackspace: true,
    renderText: ({ node }) => `${node.attrs.kind === 'task' ? '#' : node.attrs.kind === 'page' ? '' : '@'}${node.attrs.label ?? ''}`,
    renderHTML: ({ node }) => {
      const kind = String(node.attrs.kind ?? 'person');
      const label = String(node.attrs.label ?? '');
      const href = kind === 'page' ? `/documents/${node.attrs.id}` : kind === 'task' ? `/tasks/${node.attrs.id}` : undefined;
      return [href ? 'a' : 'span', { class: `mention mention-${kind}`, 'data-kind': kind, 'data-id': node.attrs.id, ...(href ? { href, 'data-href': href } : {}) },
        `${kind === 'page' ? '' : kind === 'task' ? '#' : '@'}${label}`];
    },
    suggestions: [
      { char: '@', pluginKey: new PluginKey('mention-person'), items: async ({ query }) => (await lookups.current?.people(query)) ?? [], command: pick('person'), render: suggestRenderer('Nobody by that name') },
      { char: '#', pluginKey: new PluginKey('mention-task'), items: async ({ query }) => (query.length < 1 ? [] : (await lookups.current?.tasks(query)) ?? []), command: pick('task'), render: suggestRenderer('Type to find a task') },
      { char: '[[', pluginKey: new PluginKey('mention-page'), allowSpaces: true, items: async ({ query }) => (await lookups.current?.pages(query)) ?? [], command: pick('page'), render: suggestRenderer('No page by that name') },
    ],
  });
}
export { KIND_ICON };

/** The commands of the "/" menu. `image` and `table` appear only where they can be used. */
export interface SlashExtras { onImage?: () => void; onAiWrite?: () => void; onAiContinue?: () => void; liveTasks?: boolean }

function slashItems(editor: Editor, extra: SlashExtras): SuggestItem[] {
  const c = () => editor.chain().focus();
  const items: SuggestItem[] = [
    { id: 'text', title: 'Text', hint: 'Plain paragraph', icon: '¶', run: () => c().setParagraph().run() },
    { id: 'h1', title: 'Heading 1', hint: 'Big section heading', icon: 'H1', run: () => c().setHeading({ level: 1 }).run() },
    { id: 'h2', title: 'Heading 2', hint: 'Section heading', icon: 'H2', run: () => c().setHeading({ level: 2 }).run() },
    { id: 'h3', title: 'Heading 3', hint: 'Small heading', icon: 'H3', run: () => c().setHeading({ level: 3 }).run() },
    { id: 'bullets', title: 'Bulleted list', icon: '•', run: () => c().toggleBulletList().run() },
    { id: 'numbers', title: 'Numbered list', icon: '1.', run: () => c().toggleOrderedList().run() },
    { id: 'todo', title: 'To-do list', hint: 'Tick items off', icon: '☑', run: () => c().toggleTaskList().run() },
    { id: 'callout', title: 'Callout', hint: 'A note that stands out', icon: 'i', run: () => c().wrapIn('callout', { tone: 'info' }).run() },
    { id: 'warning', title: 'Warning', hint: 'A caution in amber', icon: '!', run: () => c().wrapIn('callout', { tone: 'warning' }).run() },
    { id: 'toggle', title: 'Toggle', hint: 'A heading that opens to show more', icon: '▸', run: () => c().setDetails().run() },
    { id: 'quote', title: 'Quote', icon: '“', run: () => c().toggleBlockquote().run() },
    { id: 'code', title: 'Code', hint: 'With highlighting', icon: '</>', run: () => c().toggleCodeBlock().run() },
    { id: 'table', title: 'Table', hint: '3 × 3 with a header row', icon: '▦', run: () => c().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
    { id: 'divider', title: 'Divider', icon: '—', run: () => c().setHorizontalRule().run() },
    { id: 'diagram', title: 'Diagram', hint: 'A flowchart from text', icon: '⬡', run: () => c().insertContent({ type: 'codeBlock', attrs: { language: 'mermaid' }, content: [{ type: 'text', text: 'flowchart LR\n  A[Start] --> B{Check}\n  B -->|yes| C[Done]\n  B -->|no| A' }] }).run() },
    { id: 'page', title: 'Link to a page', hint: 'Or type [[', icon: '▤', run: () => c().insertContent('[[').run() },
    { id: 'person', title: 'Mention someone', hint: 'Or type @', icon: '@', run: () => c().insertContent('@').run() },
    { id: 'task', title: 'Mention a task', hint: 'Or type #', icon: '#', run: () => c().insertContent('#').run() },
  ];
  if (extra.onImage) items.splice(14, 0, { id: 'image', title: 'Picture', hint: 'Upload an image', icon: '▣', run: extra.onImage });
  if (extra.liveTasks) items.push({ id: 'tasks', title: 'Live task list', hint: 'The project’s tasks, always up to date', icon: '☰', run: () => c().insertContent({ type: 'liveTasks', attrs: { projectId: '', filter: 'open', limit: 10 } }).run() });
  // AI first: most people would rather say what they want than type it out.
  if (extra.onAiContinue) items.unshift({ id: 'ai-continue', title: 'Continue writing', hint: 'AI writes the next paragraphs', icon: '✦', run: extra.onAiContinue });
  if (extra.onAiWrite) items.unshift({ id: 'ai', title: 'Write with AI', hint: 'Say what to write', icon: '✦', run: extra.onAiWrite });
  return items;
}

/** "/" at the start of a line or after a space opens the block menu; typing filters it. */
export function slashCommands(extra: { current: SlashExtras }) {
  return Extension.create({
    name: 'slashCommands',
    addProseMirrorPlugins() {
      return [Suggestion<SuggestItem>({
        editor: this.editor,
        char: '/',
        pluginKey: new PluginKey('slash'),
        startOfLine: false,
        allowSpaces: false,
        allow: ({ state, range }) => {
          const before = state.doc.textBetween(Math.max(0, range.from - 1), range.from, '\n', '\n');
          return range.from <= 1 || before === '' || before === ' ' || before === '\n';
        },
        items: ({ query, editor }) => {
          const q = query.toLowerCase();
          return slashItems(editor, extra.current).filter((i) => !q || i.title.toLowerCase().includes(q) || i.id.includes(q) || (q === 'ai' && i.id.startsWith('ai'))).slice(0, 14);
        },
        command: ({ editor, range, props }) => { editor.chain().focus().deleteRange(range).run(); props.run?.(); },
        render: suggestRenderer('No block by that name'),
      })];
    },
  });
}
