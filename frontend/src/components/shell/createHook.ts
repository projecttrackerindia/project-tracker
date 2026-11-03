/**
 * The floating + button's menu, and the hook page agents plug their own create sheets into.
 *
 *   // in a page or feature module (once, e.g. at import time or in an effect that returns the disposer):
 *   import { registerCreate } from '../../components/shell/createHook';
 *   useEffect(() => registerCreate('approval', () => openRequestApprovalSheet()), []);
 *
 * When + › Request approval is picked, the shell fires a cancelable `pt:create` window event ({ detail: { kind } }) first; a listener (or a
 * registered handler) that takes it calls preventDefault() and the shell's default flow does not run. Handlers registered later win.
 */
export type CreateKind = 'task' | 'project' | 'meeting' | 'doc' | 'approval';
export const CREATE_EVENT = 'pt:create';
export interface CreateDetail { kind: CreateKind }

const handlers = new Map<CreateKind, (() => void)[]>();

/** Takes over a + menu item. Returns the disposer. */
export function registerCreate(kind: CreateKind, handler: () => void): () => void {
  const list = handlers.get(kind) ?? [];
  list.push(handler);
  handlers.set(kind, list);
  return () => { const l = handlers.get(kind) ?? []; const i = l.lastIndexOf(handler); if (i >= 0) l.splice(i, 1); };
}

/** Runs a create: a registered handler, else any `pt:create` listener, else `fallback` (the existing create flow). */
export function runCreate(kind: CreateKind, fallback: () => void) {
  const l = handlers.get(kind);
  if (l && l.length) { l[l.length - 1](); return; }
  const ev = new CustomEvent<CreateDetail>(CREATE_EVENT, { detail: { kind }, cancelable: true });
  if (window.dispatchEvent(ev)) fallback();
}
