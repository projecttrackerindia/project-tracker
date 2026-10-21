import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Icon, type IconName } from '../../components/Icon';
import { documentApi, projectApi } from '../../api/endpoints';
import type { DocumentDetail, DocumentItem, DocumentStatus } from '../../api/types';
import { useWsQuery } from '../../lib/hooks';
import { avatarColor } from './docUi';

export type DocumentsView = 'all' | 'inbox' | 'attention' | 'recent' | 'mine' | 'shared' | 'restricted' | 'trash';

const PINNED: { id: DocumentsView; label: string; icon: IconName }[] = [
  { id: 'all', label: 'Control center', icon: 'grid' },
  { id: 'mine', label: 'My documents', icon: 'user' },
  { id: 'shared', label: 'Shared with me', icon: 'users' },
  { id: 'inbox', label: 'Waiting for me', icon: 'inbox' },
  { id: 'attention', label: 'Needs attention', icon: 'alert' },
  { id: 'recent', label: 'Recently viewed', icon: 'clock' },
  { id: 'restricted', label: 'Restricted', icon: 'shield' },
  { id: 'trash', label: 'Trash', icon: 'trash' },
];

/** 'general' is a synthetic id for the "no project" group - not a real project id, and never collides with one (uuids). */
const GENERAL_ID = 'general';
const STATUS_DOT: Record<DocumentStatus, string> = { Draft: 'draft', InReview: 'review', ChangesRequested: 'changes', Approved: 'ok', Published: 'ok', Archived: 'off' };

const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

/**
 * The Documents tree, as in DocTracker: pinned views, then every project you can see - open one to see its documents grouped by type,
 * and the document you are reading opens to its sections. A project's documents load the first time it is opened. Typing in the filter
 * searches document titles across everything. Used on the library and on every document, so you never lose your place.
 */
export function DocumentsSidebar({ view, onSelectView, waiting, attention = 0, activeProject, onSelectProject, activeDoc }: {
  view: DocumentsView | null; onSelectView: (v: DocumentsView) => void; waiting: number; attention?: number;
  activeProject: string | null; onSelectProject: (id: string | null) => void;
  /** The document being read: its project opens, its row is highlighted and its sections are listed. */
  activeDoc?: DocumentDetail | null;
}) {
  const [q, setQ] = useState('');
  const projects = useWsQuery(['projects', 'options'], () => projectApi.list({ pageSize: 100 }));
  const dq = q.trim().toLowerCase();
  const searching = dq.length >= 2;
  const found = useWsQuery(['documents', 'tree-search', dq], () => documentApi.list({ q: dq, limit: 30 }), { enabled: searching, staleTime: 30_000 });
  const pinned = dq ? PINNED.filter((v) => v.label.toLowerCase().includes(dq)) : PINNED;
  const docProject = activeDoc ? (activeDoc.item.projectId ?? GENERAL_ID) : null;
  const groups = useMemo(() => {
    const all = [...(projects.data?.items ?? []).map((p) => ({ id: p.id, key: p.key as string | null, name: p.name as string })), { id: GENERAL_ID, key: null, name: 'General' }];
    return dq && !searching ? all.filter((g) => g.name.toLowerCase().includes(dq) || (g.key ?? '').toLowerCase().includes(dq)) : all;
  }, [projects.data, dq, searching]);

  return (
    <nav className="doc-sidebar ds-rail ds-tree" aria-label="Documents">
      <div className="ds-rail-search">
        <Icon name="search" size={14} />
        <input type="search" placeholder="Search documents…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search documents and projects" />
      </div>

      <ul className="ds-rail-list">
        {pinned.map((v) => (
          <li key={v.id}>
            <button type="button" className={`ds-rail-row${view === v.id && !activeProject && !activeDoc ? ' active' : ''}`} aria-current={view === v.id && !activeProject && !activeDoc ? 'page' : undefined} onClick={() => onSelectView(v.id)}>
              <span className="ds-rail-ic"><Icon name={v.icon} size={14} /></span>
              <span className="ds-rail-label">{v.label}</span>
              {v.id === 'inbox' && waiting > 0 && <span className="ds-rail-count warn">{waiting}</span>}
              {v.id === 'attention' && attention > 0 && <span className="ds-rail-count">{attention}</span>}
            </button>
          </li>
        ))}
      </ul>

      {searching ? (
        <>
          <div className="ds-rail-heading">Documents matching “{q.trim()}”</div>
          <ul className="ds-rail-list ds-tree-docs">
            {found.isLoading && <li className="ds-rail-empty">Searching…</li>}
            {(found.data?.items ?? []).map((d) => <DocRow key={d.id} d={d} active={activeDoc?.item.id === d.id} showProject />)}
            {found.data && found.data.items.length === 0 && <li className="ds-rail-empty">No document title matches.</li>}
          </ul>
        </>
      ) : (
        <>
          <div className="ds-rail-heading">Projects</div>
          <ul className="ds-rail-list ds-rail-projects ds-tree-projects">
            {groups.map((g) => (
              <ProjectNode key={g.id} g={g} selected={activeProject === g.id} containsActive={docProject === g.id} activeDoc={activeDoc ?? null}
                onSelect={() => onSelectProject(activeProject === g.id ? null : g.id)} />
            ))}
            {groups.length === 0 && pinned.length === 0 && <li className="ds-rail-empty">No matches for “{q}”.</li>}
          </ul>
        </>
      )}
    </nav>
  );
}

function ProjectNode({ g, selected, containsActive, activeDoc, onSelect }: {
  g: { id: string; key: string | null; name: string }; selected: boolean; containsActive: boolean; activeDoc: DocumentDetail | null; onSelect: () => void;
}) {
  const openKey = `pm_doc_tree_open:${g.id}`;
  const [open, setOpen] = useState(() => store.get(openKey) === '1');
  useEffect(() => { if (containsActive) setOpen(true); }, [containsActive]);
  const toggle = () => setOpen((o) => { store.set(openKey, o ? '0' : '1'); return !o; });
  const docs = useWsQuery(['documents', 'tree', g.id], () => documentApi.list(g.id === GENERAL_ID ? { general: true, limit: 100 } : { projectId: g.id, limit: 100 }),
    { enabled: open, staleTime: 60_000 });
  const byType = useMemo(() => {
    const m = new Map<string, { code: string; name: string; color: string; items: DocumentItem[] }>();
    for (const d of docs.data?.items ?? []) {
      const k = d.typeCode;
      if (!m.has(k)) m.set(k, { code: d.typeCode, name: d.typeName, color: d.typeColor, items: [] });
      m.get(k)!.items.push(d);
    }
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [docs.data]);
  return (
    <li className={`ds-node${open ? ' open' : ''}${containsActive ? ' has-active' : ''}`}>
      <div className={`ds-rail-row ds-rail-project${selected ? ' active' : ''}`}>
        <button type="button" className="ds-caret" aria-expanded={open} aria-label={`${open ? 'Close' : 'Open'} ${g.name}`} onClick={toggle}><Icon name="chevronR" size={12} /></button>
        <button type="button" className="ds-node-main" title={g.key ? `${g.key} · ${g.name}` : g.name} aria-current={selected ? 'page' : undefined} onClick={onSelect}>
          <span className="ds-avatar" style={{ '--av': g.id === GENERAL_ID ? 'var(--text-3)' : avatarColor(g.id) } as CSSProperties}>{(g.key ?? g.name).charAt(0).toUpperCase()}</span>
          <span className="ds-rail-label">{g.name}</span>
          {docs.data ? <span className="ds-rail-count soft">{docs.data.items.length}</span> : g.key ? <span className="ds-rail-key">{g.key}</span> : null}
        </button>
      </div>
      {open && (
        <ul className="ds-tree-children">
          {docs.isLoading && <li className="ds-rail-empty">Loading…</li>}
          {docs.data && byType.length === 0 && <li className="ds-rail-empty">No documents yet.</li>}
          {byType.map((t) => <TypeGroup key={t.code} projectId={g.id} t={t} activeDoc={activeDoc} />)}
        </ul>
      )}
    </li>
  );
}

function TypeGroup({ projectId, t, activeDoc }: { projectId: string; t: { code: string; name: string; color: string; items: DocumentItem[] }; activeDoc: DocumentDetail | null }) {
  const key = `pm_doc_tree_type:${projectId}:${t.code}`;
  const hasActive = !!activeDoc && t.items.some((d) => d.id === activeDoc.item.id);
  const [closed, setClosed] = useState(() => store.get(key) === '0');
  useEffect(() => { if (hasActive) setClosed(false); }, [hasActive]);
  return (
    <li className={`ds-type${closed ? '' : ' open'}`}>
      <button type="button" className="ds-type-head" aria-expanded={!closed} onClick={() => setClosed((c) => { store.set(key, c ? '1' : '0'); return !c; })}>
        <span className="ds-type-code" style={{ '--dc': t.color } as CSSProperties}>{t.code}</span>
        <span className="ds-type-name">{t.name}</span>
        <span className="ds-rail-count soft">{t.items.length}</span>
        <Icon name="chevronR" size={11} />
      </button>
      {!closed && (
        <ul className="ds-tree-docs">
          {t.items.map((d) => <DocRow key={d.id} d={d} active={activeDoc?.item.id === d.id} sections={activeDoc?.item.id === d.id ? activeDoc.sections : undefined} />)}
        </ul>
      )}
    </li>
  );
}

function DocRow({ d, active, showProject, sections }: { d: DocumentItem; active: boolean; showProject?: boolean; sections?: DocumentDetail['sections'] }) {
  return (
    <li className={`ds-doc${active ? ' active' : ''}`}>
      <Link to={`/documents/${d.id}`} className="ds-doc-row" aria-current={active ? 'page' : undefined} title={`${d.key} · ${d.title}`}>
        <span className={`ds-dot s-${STATUS_DOT[d.status]}`} aria-hidden />
        <span className="ds-doc-title">{d.title}</span>
        {showProject ? <span className="ds-rail-key">{d.projectKey ?? d.typeCode}</span> : d.classification === 'Restricted' || d.classification === 'Confidential' ? <Icon name="lock" size={11} /> : null}
      </Link>
      {active && sections && sections.length > 0 && (
        <ul className="ds-sections" aria-label="Sections">
          {sections.map((s) => (
            <li key={s.key}><a href={`#sec-${s.key}`} onClick={(e) => { e.preventDefault(); document.getElementById(`sec-${s.key}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}>{s.title}</a></li>
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * The two-column frame shared by the library and every document: the tree on the left (drag its edge to resize, collapse it to a slim
 * rail with the button or Ctrl+\), the page on the right. On phones the tree opens as a drawer from a "Browse" button.
 */
export function DocShell({ tree, children }: { tree: ReactNode; children: ReactNode }) {
  const [width, setWidth] = useState(() => Math.min(420, Math.max(220, Number(store.get('pm_doc_tree_w')) || 272)));
  const [collapsed, setCollapsed] = useState(() => store.get('pm_doc_tree_collapsed') === '1');
  const [drawer, setDrawer] = useState(false);
  const where = useLocation();
  const drag = useRef<{ x: number; w: number } | null>(null);
  const toggle = () => setCollapsed((c) => { store.set('pm_doc_tree_collapsed', c ? '0' : '1'); return !c; });
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key === '\\') { e.preventDefault(); toggle(); } };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  useEffect(() => { setDrawer(false); }, [where.pathname, where.search]);
  const startDrag = (e: RPointerEvent) => {
    drag.current = { x: e.clientX, w: width };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onDrag = (e: RPointerEvent) => {
    if (!drag.current) return;
    setWidth(Math.min(420, Math.max(220, drag.current.w + e.clientX - drag.current.x)));
  };
  const endDrag = () => { if (drag.current) { store.set('pm_doc_tree_w', String(width)); drag.current = null; } };
  return (
    <div className={`doc-shell ds-shell${collapsed ? ' collapsed' : ''}${drawer ? ' drawer-open' : ''}`} style={{ '--tree-w': `${width}px` } as CSSProperties}>
      <div className="ds-shell-side">
        <button type="button" className="ds-collapse" onClick={toggle} title={collapsed ? 'Show the document tree (Ctrl+\\)' : 'Hide the document tree (Ctrl+\\)'} aria-label={collapsed ? 'Show document tree' : 'Hide document tree'}>
          <Icon name={collapsed ? 'chevronR' : 'chevronL'} size={13} />
        </button>
        {!collapsed && tree}
        {!collapsed && <div className="ds-resize" role="separator" aria-orientation="vertical" aria-label="Resize the document tree" onPointerDown={startDrag} onPointerMove={onDrag} onPointerUp={endDrag} onPointerCancel={endDrag}
          onDoubleClick={() => { setWidth(272); store.set('pm_doc_tree_w', '272'); }} />}
      </div>
      <button type="button" className="ds-browse btn btn-ghost btn-sm" onClick={() => setDrawer(true)}><Icon name="menu" size={14} /> Browse documents</button>
      {drawer && <div className="ds-drawer-scrim" onClick={() => setDrawer(false)} aria-hidden />}
      {drawer && <div className="ds-drawer" role="dialog" aria-label="Documents"><button type="button" className="ds-drawer-close" onClick={() => setDrawer(false)} aria-label="Close"><Icon name="close" size={16} /></button>{tree}</div>}
      <div className="doc-shell-main">{children}</div>
    </div>
  );
}
