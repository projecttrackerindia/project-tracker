import { useEffect, useMemo, useState, type ReactNode, type RefObject } from 'react';
import { Link } from 'react-router-dom';
import { useInfiniteQuery } from '@tanstack/react-query';
import { apiDocApi } from '../../api/endpoints';
import type { ApiDefinition, DocumentItem, EndpointItem } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Spinner } from '../../components/ui';
import { useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { AUTH_LABEL } from './ApiTools';
import { Method } from './ApiView';
import './docReader.css';

/**
 * The document reader (Apple design): one centred 760px column for the text, a slim breadcrumb (Library › Project › Doc) above it, and a
 * sticky rail on the right with "On this page" and the inspector (related work, files, activity, details, margin notes). There is no
 * second sidebar: the whole project tree lives in Library › Browse all.
 */
export function ReaderCrumb({ d, trail = [] }: { d: Pick<DocumentItem, 'projectId' | 'projectName' | 'teamName' | 'title' | 'key'>; trail?: { id: string; title: string }[] }) {
  const where = d.projectId ? d.projectName ?? 'Project' : d.teamName ?? 'General';
  return (
    <nav className="rd-crumb" aria-label="Breadcrumb" data-testid="doc-crumb">
      <Link to="/library">Library</Link>
      <span aria-hidden="true">›</span>
      <Link to={`/library/p/${d.projectId ?? 'general'}`}>{where}</Link>
      {trail.map((a) => <span key={a.id} className="rd-crumb-step"><span aria-hidden="true">›</span><Link to={`/library/docs/${a.id}`}>{a.title}</Link></span>)}
      <span aria-hidden="true">›</span>
      <span aria-current="page" title={d.key}>{d.title}</span>
    </nav>
  );
}

/** Words in a document's stored text (ProseMirror JSON or plain text), for "n min read". */
export function wordsIn(raw: string): number {
  let text = raw;
  try {
    const parts: string[] = [];
    const walk = (n: unknown): void => {
      if (!n || typeof n !== 'object') return;
      const o = n as { text?: unknown; content?: unknown; rows?: unknown };
      if (typeof o.text === 'string') parts.push(o.text);
      if (Array.isArray(o.content)) o.content.forEach(walk);
      if (Array.isArray(o.rows)) o.rows.forEach((r) => parts.push(JSON.stringify(r)));
    };
    walk(JSON.parse(raw));
    text = parts.join(' ');
  } catch { /* plain text */ }
  return text.split(/\s+/).filter(Boolean).length;
}
export const readingTime = (words: number) => `${Math.max(1, Math.round(words / 230))} min read`;

export type OutlineItem = { id: string; text: string; level: number; el: HTMLElement };
/** The headings inside the reading column, found in the page (so it works for typed sections and free pages alike). */
export function useOutline(ref: RefObject<HTMLElement | null>, deps: unknown[]): OutlineItem[] {
  const [items, setItems] = useState<OutlineItem[]>([]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const scan = () => {
      const found: OutlineItem[] = [];
      el.querySelectorAll<HTMLElement>('[data-outline], h1, h2, h3').forEach((h, i) => {
        if (h.closest('.rd-skip-outline') && !h.dataset.outline) return;
        if (h.parentElement?.closest('[data-outline]')) return;
        const text = (h.dataset.outline ?? h.textContent ?? '').trim();
        if (!text) return;
        // The element is kept, never changed: an editor owns its own elements and would rebuild them (and this outline) on every change.
        found.push({ id: `rd-h-${i}`, text: text.slice(0, 80), level: h.tagName === 'H3' ? 3 : 2, el: h });
      });
      setItems((old) => (old.length === found.length && old.every((o, i) => o.el === found[i].el && o.text === found[i].text) ? old : found));
    };
    scan();
    let frame = 0;
    const mo = new MutationObserver(() => { window.cancelAnimationFrame(frame); frame = window.requestAnimationFrame(scan); });
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    return () => { mo.disconnect(); window.cancelAnimationFrame(frame); };
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  return items;
}

/** The sticky right rail: "On this page" (the heading in view is marked) over the inspector. */
export function ReaderRail({ outline, children }: { outline: OutlineItem[]; children?: ReactNode }) {
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    if (outline.length === 0 || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => {
      const top = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      const hit = top && outline.find((o) => o.el === top.target);
      if (hit) setActive(hit.id);
    }, { rootMargin: '0px 0px -70% 0px' });
    outline.forEach((o) => io.observe(o.el));
    return () => io.disconnect();
  }, [outline]);
  return (
    <aside className="rd-rail" aria-label="About this document">
      {outline.length > 1 && (
        <nav className="rd-toc" aria-label="On this page" data-testid="doc-outline">
          <div className="rd-rail-title">On this page</div>
          <ul>{outline.map((o) => (
            <li key={o.id} className={`l${o.level}${active === o.id ? ' on' : ''}`}>
              <a href={`#${o.id}`} onClick={(e) => { e.preventDefault(); o.el.scrollIntoView({ behavior: 'smooth', block: 'start' }); setActive(o.id); }}>{o.text}</a>
            </li>
          ))}</ul>
        </nav>
      )}
      {children}
    </aside>
  );
}

export type InspectorPart = { id: string; label: string; count?: number; body: ReactNode };
/** The inspector: collapsible parts (related, files, activity, details…). `open` names the part to show (the toolbar's ··· can open one). */
export function Inspector({ parts, open, onOpen }: { parts: InspectorPart[]; open: string | null; onOpen: (id: string | null) => void }) {
  useEffect(() => {
    if (open) window.setTimeout(() => document.getElementById(`rd-ins-${open}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 60);
  }, [open]);
  return (
    <div className="rd-ins" data-testid="doc-inspector">
      <div className="rd-rail-title">Inspector</div>
      {parts.map((p) => {
        const on = open === p.id;
        return (
          <section key={p.id} id={`rd-ins-${p.id}`} className={`rd-ins-part${on ? ' on' : ''}`}>
            <button type="button" className="rd-ins-head" aria-expanded={on} onClick={() => onOpen(on ? null : p.id)}>
              <Icon name={on ? 'chevronD' : 'chevronR'} size={12} /><span>{p.label}</span>{p.count ? <em>{p.count}</em> : null}
            </button>
            {on && <div className="rd-ins-body">{p.body}</div>}
          </section>
        );
      })}
    </div>
  );
}

/** A plain cURL for an endpoint: the first server, the base path and the path, with the auth header shown as a placeholder. */
export function curlFor(def: ApiDefinition | undefined, ep: Pick<EndpointItem, 'method' | 'path'>): string {
  const host = (def?.servers[0] ?? 'https://api.example.com').replace(/\/$/, '');
  const base = (def?.basePath ?? '').replace(/\/$/, '');
  const lines = [`curl --request ${ep.method} "${host}${base}${ep.path.startsWith('/') ? '' : '/'}${ep.path}"`];
  const auth = def?.auth;
  if (auth === 'Bearer' || auth === 'OAuth2') lines.push('  --header "Authorization: Bearer <token>"');
  else if (auth === 'Basic') lines.push('  --user "<user>:<password>"');
  else if (auth === 'ApiKey') lines.push('  --header "X-API-Key: <key>"');
  if (['POST', 'PUT', 'PATCH'].includes(ep.method)) lines.push('  --header "Content-Type: application/json"', "  --data-raw '{}'");
  return lines.join(' \\\n');
}

/** An API reference read as clean endpoint cards: method pill, path, description, auth, and Try it with a cURL to copy. */
export function EndpointCards({ documentId, onManage }: { documentId: string; onManage?: () => void }) {
  const wid = useWorkspaceId();
  const overview = useWsQuery(['documents', documentId, 'api', ''], () => apiDocApi.overview(documentId), { retry: false });
  const defs = useMemo(() => overview.data?.definitions ?? [], [overview.data]);
  const list = useInfiniteQuery({
    queryKey: [wid, 'documents', documentId, 'api-cards'],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => apiDocApi.endpoints(documentId, { cursor: pageParam, limit: 100 }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: !!wid && defs.length > 0,
  });
  const items = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  const [trying, setTrying] = useState<string | null>(null);
  if (overview.isLoading) return <p className="rd-note"><Spinner /> Loading endpoints…</p>;
  if (defs.length === 0) return null;
  const copy = (text: string) => { void navigator.clipboard?.writeText(text).then(() => toast('cURL copied.'), () => toast('Could not copy.', 'error')); };
  return (
    <section className="rd-api" aria-label="Endpoints" data-testid="endpoint-cards">
      <header className="rd-api-head">
        <h2 data-outline="Endpoints">Endpoints</h2>
        <span className="rd-note">{(overview.data?.endpoints ?? items.length).toLocaleString()} across {defs.length} API{defs.length === 1 ? '' : 's'}</span>
        {onManage && <button type="button" className="rd-btn sm" onClick={onManage}>Full reference</button>}
      </header>
      {list.isLoading ? <p className="rd-note"><Spinner /> Loading endpoints…</p> : items.length === 0 ? <p className="rd-note">No endpoints yet.</p> : (
        <ul className="rd-eps">
          {items.map((ep) => {
            const def = defs.find((x) => x.id === ep.definitionId);
            const curl = curlFor(def, ep);
            const open = trying === ep.id;
            return (
              <li key={ep.id} className={`rd-ep${ep.deprecated ? ' dep' : ''}`} data-testid="endpoint-card">
                <div className="rd-ep-top">
                  <Method m={ep.method} />
                  <code className="rd-ep-path">{ep.path}</code>
                  {ep.deprecated && <span className="rd-pill warn">Deprecated</span>}
                  <button type="button" className={`rd-btn sm rd-ep-try${open ? ' on' : ''}`} aria-expanded={open} onClick={() => setTrying(open ? null : ep.id)}>Try it</button>
                </div>
                {ep.summary && <p className="rd-ep-desc">{ep.summary}</p>}
                <div className="rd-ep-meta">
                  <span><Icon name="lock" size={12} /> {def ? AUTH_LABEL[def.auth] : 'Auth not set'}</span>
                  {def && <span>{def.name}{def.version ? ` ${def.version}` : ''}</span>}
                  {ep.tag && <span>{ep.tag}</span>}
                </div>
                {open && (
                  <div className="rd-try">
                    <pre aria-label="cURL">{curl}</pre>
                    <button type="button" className="rd-btn sm" onClick={() => copy(curl)}><Icon name="copy" size={12} /> Copy cURL</button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {list.hasNextPage && <button type="button" className="rd-btn sm" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>{list.isFetchingNextPage ? 'Loading…' : 'Show more'}</button>}
    </section>
  );
}
