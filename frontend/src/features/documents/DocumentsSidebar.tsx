import { useMemo, useState } from 'react';
import { Icon, type IconName } from '../../components/Icon';
import { projectApi } from '../../api/endpoints';
import { useWsQuery } from '../../lib/hooks';

export type DocumentsView = 'all' | 'inbox' | 'recent' | 'mine' | 'shared' | 'restricted' | 'trash';

const PINNED: { id: DocumentsView; label: string; icon: IconName }[] = [
  { id: 'all', label: 'All documents', icon: 'note' },
  { id: 'mine', label: 'My documents', icon: 'user' },
  { id: 'shared', label: 'Shared with me', icon: 'users' },
  { id: 'inbox', label: 'Waiting for me', icon: 'inbox' },
  { id: 'recent', label: 'Recently viewed', icon: 'clock' },
  { id: 'restricted', label: 'Restricted', icon: 'shield' },
  { id: 'trash', label: 'Trash', icon: 'trash' },
];

const EXPANDED_KEY = 'pf_docs_sidebar_expanded';
/** 'general' is a synthetic id for the "no project" group — not a real project id, and never collides with one (uuids). */
const GENERAL_ID = 'general';

function loadExpanded(): Set<string> {
  try {
    const raw = localStorage.getItem(EXPANDED_KEY);
    return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
  } catch { return new Set(); }
}

/**
 * The Documents landing page's left rail: the 7 fixed scopes pinned at top (unchanged behavior from the old tab
 * strip, including the "Waiting for me" badge), then every project as a collapsible group below it. Picking a
 * pinned row or a project's "All documents" leaf both just set the page's own view/project state — this component
 * owns no document data itself, so it can't drift from what `DocumentList` already fetches and filters.
 */
export function DocumentsSidebar({ view, onSelectView, waiting, activeProject, onSelectProject }: {
  view: DocumentsView; onSelectView: (v: DocumentsView) => void; waiting: number;
  activeProject: string | null; onSelectProject: (id: string | null) => void;
}) {
  const [q, setQ] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(loadExpanded);
  const projects = useWsQuery(['projects', 'options'], () => projectApi.list({ pageSize: 100 }));

  const toggle = (id: string) => setExpanded((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    try { localStorage.setItem(EXPANDED_KEY, JSON.stringify([...n])); } catch { /* storage unavailable */ }
    return n;
  });

  const dq = q.trim().toLowerCase();
  const pinned = dq ? PINNED.filter((v) => v.label.toLowerCase().includes(dq)) : PINNED;
  const groups = useMemo(() => {
    const projectGroups = (projects.data?.items ?? []).map((p) => ({ id: p.id, key: p.key as string | null, name: p.name as string }));
    const all = [...projectGroups, { id: GENERAL_ID, key: null, name: 'General' }];
    return dq ? all.filter((g) => g.name.toLowerCase().includes(dq) || (g.key ?? '').toLowerCase().includes(dq)) : all;
  }, [projects.data, dq]);

  return (
    <nav className="doc-sidebar" aria-label="Documents">
      <div className="doc-sidebar-search">
        <Icon name="search" size={14} />
        <input className="input" type="search" placeholder="Filter the sidebar…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter the sidebar" />
      </div>

      <ul className="doc-sidebar-pinned">
        {pinned.map((v) => (
          <li key={v.id}>
            <button type="button" className={`doc-sidebar-row${view === v.id && !activeProject ? ' active' : ''}`}
              onClick={() => onSelectView(v.id)}>
              <Icon name={v.icon} size={15} />
              <span>{v.label}</span>
              {v.id === 'inbox' && waiting > 0 && <span className="doc-count">{waiting}</span>}
            </button>
          </li>
        ))}
        {pinned.length === 0 && <li className="doc-sidebar-empty muted">No matches.</li>}
      </ul>

      <div className="doc-sidebar-tree">
        <div className="doc-sidebar-label">Projects</div>
        <ul className="doc-sidebar-groups">
          {groups.map((g) => {
            const isOpen = expanded.has(g.id);
            const isActive = activeProject === g.id;
            return (
              <li key={g.id} className="doc-sidebar-group">
                <button type="button" className={`doc-sidebar-group-head${isActive ? ' active' : ''}`}
                  aria-expanded={isOpen} onClick={() => toggle(g.id)}>
                  <Icon name={isOpen ? 'chevronD' : 'chevronR'} size={12} />
                  <span>{g.name}</span>
                </button>
                {isOpen && (
                  <ul className="doc-sidebar-children">
                    <li>
                      <button type="button" className={`doc-sidebar-row doc-sidebar-child${isActive ? ' active' : ''}`}
                        onClick={() => onSelectProject(g.id)}>
                        {g.key && <span className="doc-key">{g.key}</span>}
                        <span>All documents</span>
                      </button>
                    </li>
                  </ul>
                )}
              </li>
            );
          })}
          {groups.length === 0 && <li className="doc-sidebar-empty muted">No matches.</li>}
        </ul>
      </div>
    </nav>
  );
}
