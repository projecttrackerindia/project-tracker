import { useMemo, useState, type CSSProperties } from 'react';
import { Icon, type IconName } from '../../components/Icon';
import { projectApi } from '../../api/endpoints';
import { useWsQuery } from '../../lib/hooks';
import { avatarColor } from './docUi';

export type DocumentsView = 'all' | 'inbox' | 'recent' | 'mine' | 'shared' | 'restricted' | 'trash';

const PINNED: { id: DocumentsView; label: string; icon: IconName }[] = [
  { id: 'all', label: 'Control center', icon: 'grid' },
  { id: 'mine', label: 'My documents', icon: 'user' },
  { id: 'shared', label: 'Shared with me', icon: 'users' },
  { id: 'inbox', label: 'Waiting for me', icon: 'inbox' },
  { id: 'recent', label: 'Recently viewed', icon: 'clock' },
  { id: 'restricted', label: 'Restricted', icon: 'shield' },
  { id: 'trash', label: 'Trash', icon: 'trash' },
];

/** 'general' is a synthetic id for the "no project" group - not a real project id, and never collides with one (uuids). */
const GENERAL_ID = 'general';

/**
 * The Documents rail, in DocTracker's style: a filter box, the pinned views, then every project as a single row with its letter avatar.
 * One click on a project shows its documents (no expand-then-click), and the active row is tinted. This component owns no document data:
 * it only sets the page's view or project, so it can never drift from what the list shows.
 */
export function DocumentsSidebar({ view, onSelectView, waiting, activeProject, onSelectProject }: {
  view: DocumentsView; onSelectView: (v: DocumentsView) => void; waiting: number;
  activeProject: string | null; onSelectProject: (id: string | null) => void;
}) {
  const [q, setQ] = useState('');
  const projects = useWsQuery(['projects', 'options'], () => projectApi.list({ pageSize: 100 }));
  const dq = q.trim().toLowerCase();
  const pinned = dq ? PINNED.filter((v) => v.label.toLowerCase().includes(dq)) : PINNED;
  const groups = useMemo(() => {
    const all = [...(projects.data?.items ?? []).map((p) => ({ id: p.id, key: p.key as string | null, name: p.name as string })), { id: GENERAL_ID, key: null, name: 'General' }];
    return dq ? all.filter((g) => g.name.toLowerCase().includes(dq) || (g.key ?? '').toLowerCase().includes(dq)) : all;
  }, [projects.data, dq]);

  return (
    <nav className="doc-sidebar ds-rail" aria-label="Documents">
      <div className="ds-rail-search">
        <Icon name="search" size={14} />
        <input type="search" placeholder="Filter views and projects…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter views and projects" />
      </div>

      <ul className="ds-rail-list">
        {pinned.map((v) => (
          <li key={v.id}>
            <button type="button" className={`ds-rail-row${view === v.id && !activeProject ? ' active' : ''}`} aria-current={view === v.id && !activeProject ? 'page' : undefined} onClick={() => onSelectView(v.id)}>
              <span className="ds-rail-ic"><Icon name={v.icon} size={14} /></span>
              <span className="ds-rail-label">{v.label}</span>
              {v.id === 'inbox' && waiting > 0 && <span className="ds-rail-count warn">{waiting}</span>}
            </button>
          </li>
        ))}
      </ul>

      <div className="ds-rail-heading">Projects</div>
      <ul className="ds-rail-list ds-rail-projects">
        {groups.map((g) => {
          const active = activeProject === g.id;
          return (
            <li key={g.id}>
              <button type="button" className={`ds-rail-row ds-rail-project${active ? ' active' : ''}`} aria-current={active ? 'page' : undefined}
                title={g.key ? `${g.key} · ${g.name}` : g.name} onClick={() => onSelectProject(active ? null : g.id)}>
                <span className="ds-avatar" style={{ '--av': g.id === GENERAL_ID ? 'var(--ds-faint)' : avatarColor(g.id) } as CSSProperties}>{(g.key ?? g.name).charAt(0).toUpperCase()}</span>
                <span className="ds-rail-label">{g.name}</span>
                {g.key && <span className="ds-rail-key">{g.key}</span>}
              </button>
            </li>
          );
        })}
        {groups.length === 0 && pinned.length === 0 && <li className="ds-rail-empty">No matches for “{q}”.</li>}
      </ul>
    </nav>
  );
}
