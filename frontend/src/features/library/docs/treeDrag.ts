import { pageTree } from '../../documents/pages';

type Doc = { id: string; title: string; parentId?: string | null; pageOrder?: number };
export type DropWhere = 'before' | 'after' | 'inside';
export interface DropPlan { parentId: string | null; pageOrder: number }

/** Which part of a row the pointer is over: the top quarter drops before it, the bottom quarter after it, the middle inside it. */
export function dropZone(offsetY: number, height: number): DropWhere {
  if (offsetY < height * 0.28) return 'before';
  if (offsetY > height * 0.72) return 'after';
  return 'inside';
}

/** True when `id` is `ancestor` itself or one of the pages inside it (a page cannot be dropped into its own branch). */
export function inBranch<T extends Doc>(tree: ReturnType<typeof pageTree<T>>, ancestor: string, id: string): boolean {
  if (ancestor === id) return true;
  return tree.children(ancestor).some((c) => inBranch(tree, c.id, id));
}

/**
 * Where a dragged page goes when dropped on another: its new parent and its position among the new siblings (counted without the dragged page,
 * as the server places it). Null when the drop would change nothing or put the page inside itself.
 */
export function planDrop<T extends Doc>(docs: T[], draggedId: string, targetId: string, where: DropWhere): DropPlan | null {
  const tree = pageTree(docs);
  const ids = new Set(docs.map((d) => d.id));
  const dragged = docs.find((d) => d.id === draggedId);
  const target = docs.find((d) => d.id === targetId);
  if (!dragged || !target || inBranch(tree, draggedId, targetId)) return null;
  const parentOf = (d: T) => (d.parentId && ids.has(d.parentId) ? d.parentId : null);
  if (where === 'inside') {
    const kids = tree.children(target.id).filter((c) => c.id !== draggedId);
    if (parentOf(dragged) === target.id) return null;
    return { parentId: target.id, pageOrder: kids.length };
  }
  const parent = parentOf(target);
  const siblings = (parent ? tree.children(parent) : tree.roots).filter((c) => c.id !== draggedId);
  const at = siblings.findIndex((c) => c.id === target.id) + (where === 'after' ? 1 : 0);
  // Its own place: same parent, and the slot it would go into is the one it already holds.
  if (parentOf(dragged) === parent && at === (parent ? tree.children(parent) : tree.roots).findIndex((c) => c.id === draggedId)) return null;
  return { parentId: parent, pageOrder: Math.max(0, at) };
}

/** Alt+↑ / Alt+↓ from the keyboard: one place up or down among the page's siblings. */
export function planStep<T extends Doc>(docs: T[], id: string, step: -1 | 1): DropPlan | null {
  const tree = pageTree(docs);
  const ids = new Set(docs.map((d) => d.id));
  const d = docs.find((x) => x.id === id);
  if (!d) return null;
  const parent = d.parentId && ids.has(d.parentId) ? d.parentId : null;
  const siblings = parent ? tree.children(parent) : tree.roots;
  const i = siblings.findIndex((x) => x.id === id);
  const j = i + step;
  if (i < 0 || j < 0 || j >= siblings.length) return null;
  return { parentId: parent, pageOrder: j };
}
