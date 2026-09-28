import type { OrgRole, OrgStructure } from '../../api/types';

/** Drag-and-drop payload for moving a person onto a role (tray, inspector -> canvas). */
export const PERSON_MIME = 'application/x-org-person';

export interface TreeItem { id: string; parentId: string | null }
export interface TreeSize { w: number; h: number; gapX: number; gapY: number }
export interface Point { x: number; y: number }

/**
 * Tidy top-down tree layout for a forest: every parent is centred over its children,
 * siblings never overlap and roots are laid out left to right.
 */
export function treeLayout(items: TreeItem[], { w, h, gapX, gapY }: TreeSize): Map<string, Point> {
  const ids = new Set(items.map((i) => i.id));
  const kids = new Map<string, string[]>();
  const roots: string[] = [];
  for (const i of items) {
    if (i.parentId && ids.has(i.parentId)) kids.set(i.parentId, [...(kids.get(i.parentId) ?? []), i.id]);
    else roots.push(i.id);
  }

  const width = new Map<string, number>();
  const seen = new Set<string>();
  const measure = (id: string): number => {
    if (seen.has(id)) return w; // defensive: a cycle can never hang the page
    seen.add(id);
    const ks = kids.get(id) ?? [];
    const total = ks.reduce((sum, k) => sum + measure(k), 0) + Math.max(0, ks.length - 1) * gapX;
    const v = Math.max(w, total);
    width.set(id, v);
    return v;
  };

  const out = new Map<string, Point>();
  const place = (id: string, left: number, depth: number) => {
    if (out.has(id)) return;
    const own = width.get(id) ?? w;
    out.set(id, { x: left + own / 2 - w / 2, y: depth * (h + gapY) });
    const ks = kids.get(id) ?? [];
    const total = ks.reduce((sum, k) => sum + (width.get(k) ?? w), 0) + Math.max(0, ks.length - 1) * gapX;
    let cursor = left + (own - total) / 2;
    for (const k of ks) { place(k, cursor, depth + 1); cursor += (width.get(k) ?? w) + gapX; }
  };

  let x = 0;
  const start = (id: string) => { measure(id); place(id, x, 0); x += (width.get(id) ?? w) + gapX; };
  roots.forEach(start);
  for (const i of items) if (!out.has(i.id)) start(i.id); // anything left over (only possible with bad data)
  return out;
}

/** parent id -> [child ids] for the active (not deleted) roles. */
export function childrenOf(roles: OrgRole[]): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const r of roles) if (!r.isDeleted && r.parentRoleId) m.set(r.parentRoleId, [...(m.get(r.parentRoleId) ?? []), r.id]);
  return m;
}

/** The role itself plus every role below it. Used to stop a role being placed under its own subtree. */
export function subtreeIds(rootId: string, roles: OrgRole[]): Set<string> {
  const kids = childrenOf(roles);
  const out = new Set<string>();
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop()!;
    if (out.has(id)) continue;
    out.add(id);
    stack.push(...(kids.get(id) ?? []));
  }
  return out;
}

/** True when making `bossId` the manager of `userId` would close a reporting loop. */
export function wouldLoopPeople(userId: string, bossId: string, data: OrgStructure): boolean {
  if (userId === bossId) return true;
  const boss = new Map(data.people.map((p) => [p.userId, p.reportsToUserId]));
  const seen = new Set<string>();
  for (let cur: string | null | undefined = bossId; cur && !seen.has(cur); cur = boss.get(cur)) {
    if (cur === userId) return true;
    seen.add(cur);
  }
  return false;
}

export function initials(name: string) {
  const parts = name.replace(/[()]/g, '').split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts.length > 1 ? parts[1][0] : '')).toUpperCase();
}
