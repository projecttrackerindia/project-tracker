import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { Icon } from '../../components/Icon';

const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

/**
 * The two-column frame shared by the library and every document: the tree on the left (drag its edge to resize, collapse it to a slim
 * rail with the button or Ctrl+\), the page on the right. On phones the tree opens as a drawer from a "Browse" button.
 */
export function DocShell({ tree, children, browseLabel = 'Browse documents' }: { tree: ReactNode; children: ReactNode; browseLabel?: string }) {
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
      <button type="button" className="ds-browse btn btn-ghost btn-sm" onClick={() => setDrawer(true)}><Icon name="menu" size={14} /> {browseLabel}</button>
      {drawer && <div className="ds-drawer-scrim" onClick={() => setDrawer(false)} aria-hidden />}
      {drawer && <div className="ds-drawer" role="dialog" aria-label="Documents"><button type="button" className="ds-drawer-close" onClick={() => setDrawer(false)} aria-label="Close"><Icon name="close" size={16} /></button>{tree}</div>}
      <div className="doc-shell-main">{children}</div>
    </div>
  );
}
