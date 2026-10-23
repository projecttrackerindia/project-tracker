import { createContext, useContext } from 'react';
import { Link } from 'react-router-dom';
import { Mark, mergeAttributes, Node } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import { taskApi } from '../../../api/endpoints';
import { formatDate } from '../../../lib/format';
import { useWsQuery } from '../../../lib/hooks';

/** The project of the page around the editor: a new live task list shows its tasks. */
export const PageProjectContext = createContext<{ projectId: string | null; projects: { id: string; name: string }[] }>({ projectId: null, projects: [] });

const FILTERS: { id: string; label: string }[] = [
  { id: 'open', label: 'Open' }, { id: 'mine', label: 'Mine' }, { id: 'overdue', label: 'Overdue' }, { id: 'done', label: 'Done' }, { id: 'all', label: 'All' },
];

function LiveTasksView({ node, updateAttributes, editor, selected, deleteNode }: NodeViewProps) {
  const page = useContext(PageProjectContext);
  const projectId = (node.attrs.projectId as string) || page.projectId || '';
  const filter = (node.attrs.filter as string) || 'open';
  const limit = Number(node.attrs.limit) || 10;
  const q = useWsQuery(['tasks', 'live', projectId, filter, limit], () => taskApi.listForProject(projectId, {
    pageSize: limit, sort: 'due',
    ...(filter === 'open' ? { openOnly: true } : filter === 'mine' ? { mine: true, openOnly: true } : filter === 'overdue' ? { overdue: true } : filter === 'done' ? { category: 'Done' } : {}),
  }), { enabled: !!projectId, staleTime: 30_000 });
  const editable = editor.isEditable;
  const tasks = q.data?.items ?? [];
  return (
    <NodeViewWrapper className={`live-tasks${selected ? ' selected' : ''}`} contentEditable={false} data-live-tasks="">
      <div className="live-tasks-head">
        <b>Tasks{page.projects.find((p) => p.id === projectId) ? ` · ${page.projects.find((p) => p.id === projectId)!.name}` : ''}</b>
        <span className="live-tasks-live" title="Always shows the tasks as they are now">Live</span>
        {editable && (
          <span className="live-tasks-tools">
            {page.projects.length > 1 && (
              <select aria-label="Project" value={projectId} onChange={(e) => updateAttributes({ projectId: e.target.value })}>
                {!projectId && <option value="">Choose a project</option>}
                {page.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            )}
            <select aria-label="Which tasks" value={filter} onChange={(e) => updateAttributes({ filter: e.target.value })}>
              {FILTERS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
            </select>
            <select aria-label="How many" value={limit} onChange={(e) => updateAttributes({ limit: Number(e.target.value) })}>
              {[5, 10, 20, 50].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            <button type="button" className="live-tasks-x" aria-label="Remove the task list" onClick={() => deleteNode()}>×</button>
          </span>
        )}
      </div>
      {!projectId ? <p className="live-tasks-empty">Choose the project whose tasks this list shows.</p>
        : q.isLoading ? <p className="live-tasks-empty">Loading tasks…</p>
          : q.isError ? <p className="live-tasks-empty">These tasks are not available to you.</p>
            : tasks.length === 0 ? <p className="live-tasks-empty">No {filter === 'all' ? '' : FILTERS.find((f) => f.id === filter)?.label.toLowerCase()} tasks.</p>
              : (
                <ul className="live-tasks-list">
                  {tasks.map((t) => (
                    <li key={t.id}>
                      <span className="live-dot" style={{ background: t.statusColor }} aria-hidden="true" />
                      <Link to={`/tasks/${t.id}`} className="live-key">{t.key}</Link>
                      <span className="live-title">{t.title}</span>
                      <span className="live-meta">{t.statusName}{t.assignee ? ` · ${t.assignee.name}` : ''}{t.dueDate ? ` · ${formatDate(t.dueDate)}` : ''}{t.isOverdue ? ' · overdue' : ''}</span>
                    </li>
                  ))}
                </ul>
              )}
    </NodeViewWrapper>
  );
}

/** A live list of a project's tasks inside a page: stored as which project and which tasks, read fresh every time it is shown. */
export const LiveTasks = Node.create({
  name: 'liveTasks', group: 'block', atom: true, draggable: true, selectable: true,
  addAttributes() { return { projectId: { default: '' }, filter: { default: 'open' }, limit: { default: 10 } }; },
  parseHTML() { return [{ tag: 'div[data-live-tasks]' }]; },
  renderHTML({ HTMLAttributes }) { return ['div', mergeAttributes({ 'data-live-tasks': '' }, { 'data-project': HTMLAttributes.projectId })]; },
  addNodeView() { return ReactNodeViewRenderer(LiveTasksView); },
});

/** Text a comment thread is about: highlighted, and clicking it opens the thread. Stored as the thread's id only. */
export const CommentMark = Mark.create({
  name: 'comment',
  inclusive: false,
  excludes: '',
  addAttributes() {
    return { id: { default: null, parseHTML: (el) => el.getAttribute('data-comment-id'), renderHTML: (a) => (a.id ? { 'data-comment-id': a.id } : {}) } };
  },
  parseHTML() { return [{ tag: 'span[data-comment-id]' }]; },
  renderHTML({ HTMLAttributes }) { return ['span', mergeAttributes(HTMLAttributes, { class: 'rte-comment' }), 0]; },
});
