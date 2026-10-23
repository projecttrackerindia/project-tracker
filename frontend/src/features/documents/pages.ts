import { useNavigate } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { documentApi } from '../../api/endpoints';
import type { DocumentType } from '../../api/types';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';

/** The free-form page type: one body, no fixed sections; pages nest. */
export const PAGE_CODE = 'PAGE';
export const PAGE_BODY = 'body';

type Json = Record<string, unknown>;
const text = (t: string): Json => ({ type: 'text', text: t });
const para = (t?: string): Json => (t ? { type: 'paragraph', content: [text(t)] } : { type: 'paragraph' });

/**
 * A template's sections as the starting content of a free-form page: each section becomes a heading, a table section becomes a table with
 * its columns as the header row. Nothing is locked: the person can rename, remove or add anything.
 */
export function templateBody(type: DocumentType | undefined): string {
  const content: Json[] = [];
  for (const s of type?.sections ?? []) {
    content.push({ type: 'heading', attrs: { level: 2 }, content: [text(s.title)] });
    if (s.kind === 'Table' && s.columns?.length) {
      const row = (mk: (c: string) => Json) => ({ type: 'tableRow', content: s.columns!.map(mk) });
      content.push({ type: 'table', content: [
        row((c) => ({ type: 'tableHeader', content: [para(c)] })),
        row(() => ({ type: 'tableCell', content: [para()] })),
      ] });
    } else content.push(para());
  }
  if (!content.length) content.push(para());
  return JSON.stringify({ type: 'doc', content });
}

/** Pages in a tree: the top-level ones, and each page's children, in their saved order then by title. */
export function pageTree<T extends { id: string; title: string; parentId?: string | null; pageOrder?: number }>(docs: T[]) {
  const ids = new Set(docs.map((d) => d.id));
  const byParent = new Map<string, T[]>();
  const roots: T[] = [];
  for (const d of docs) {
    if (d.parentId && ids.has(d.parentId)) (byParent.get(d.parentId) ?? byParent.set(d.parentId, []).get(d.parentId)!).push(d);
    else roots.push(d);
  }
  const order = (a: T, b: T) => (a.pageOrder ?? 0) - (b.pageOrder ?? 0) || a.title.localeCompare(b.title);
  roots.sort(order);
  for (const list of byParent.values()) list.sort(order);
  return { roots, children: (id: string) => byParent.get(id) ?? [] };
}

/** The chain of pages above one, outermost first (for the breadcrumb). */
export function ancestors<T extends { id: string; parentId?: string | null }>(docs: T[], id: string): T[] {
  const byId = new Map(docs.map((d) => [d.id, d]));
  const out: T[] = [];
  let at = byId.get(id)?.parentId;
  for (let i = 0; at && i < 50; i++) { const p = byId.get(at); if (!p) break; out.unshift(p); at = p.parentId; }
  return out;
}

/**
 * One click makes a page and opens it with its title selected, ready to type: blank, from a template (its sections become headings), inside
 * another page, or in a project.
 */
export function useNewPage() {
  const wid = useWorkspaceId();
  const navigate = useNavigate();
  const types = useWsQuery(['document-types'], documentApi.types, { staleTime: 300_000 });
  const pageType = types.data?.find((t) => t.code === PAGE_CODE);
  const create = async (o: { projectId?: string | null; parentId?: string | null; template?: DocumentType; title?: string; teamId?: string | null;
    /** Editor JSON to start with (an AI draft). */ body?: string } = {}) => {
    const t = pageType ?? (await documentApi.types()).find((x) => x.code === PAGE_CODE);
    if (!t) { toast('Pages are not available in this workspace yet.', 'error'); return; }
    try {
      const d = await documentApi.create({
        title: o.title ?? (o.template ? o.template.name : 'Untitled'), typeId: t.id, projectId: o.parentId ? undefined : o.projectId ?? null, parentId: o.parentId ?? null,
        ...(o.teamId && !o.parentId && !o.projectId ? { teamId: o.teamId } : {}),
        sections: o.body ? [{ key: PAGE_BODY, content: o.body }] : o.template ? [{ key: PAGE_BODY, content: templateBody(o.template) }] : undefined,
      });
      invalidateWorkspace(wid, 'documents');
      navigate(`/documents/${d.item.id}`, { state: { fresh: true } });
    } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not create the page.', 'error'); }
  };
  return { ready: !!pageType, create };
}
