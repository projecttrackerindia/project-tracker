import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Icon } from './Icon';
import { useTeamLens } from '../lib/teamLens';

const hue = (name: string) => { let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/**
 * Which team's work the whole app shows: "All teams", or one team. It sits in the top bar because it applies everywhere (dashboard, projects,
 * Portfolio, reports, calendar, activity, search and the assistant), and the server decides which teams each person may pick.
 */
export function TeamLensPicker() {
  const { teams, teamId, team, setTeam, ready } = useTeamLens();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const listId = useId();

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = { id: '', name: 'All teams', projects: teams.reduce((n, t) => n + t.projects, 0), members: 0 };
    const matching = teams.filter((t) => !q || t.name.toLowerCase().includes(q));
    return (q ? matching : [all, ...matching]);
  }, [teams, query]);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  // Resets the search box and selection only when the panel opens - rows/teamId changing while it's already open should not yank the typed query.
  useEffect(() => { if (open) { setQuery(''); setActive(Math.max(0, rows.findIndex((r) => r.id === (teamId ?? '')))); setTimeout(() => search.current?.focus(), 0); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!ready || teams.length === 0) return null;

  const choose = (id: string) => { setTeam(id || null); setOpen(false); };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { setOpen(false); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(rows.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Enter' && rows[active]) { e.preventDefault(); choose(rows[active].id); }
  };

  return (
    <div className="lens" ref={root} onKeyDown={onKey}>
      <button type="button" className={`lens-btn ${team ? 'on' : ''}`} aria-haspopup="listbox" aria-expanded={open} aria-controls={listId}
        title={team ? `Showing ${team.name}. Everything on screen follows this team.` : 'Showing every team you can see. Pick one to focus the whole app on it.'} onClick={() => setOpen((o) => !o)}>
        {team ? <span className="lens-chip" style={{ '--h': hue(team.name) } as React.CSSProperties}>{initials(team.name)}</span> : <Icon name="users" size={15} />}
        <span className="lens-name">{team ? team.name : 'All teams'}</span>
        <Icon name="chevronD" size={14} />
      </button>
      {open && (
        <div className="lens-panel" role="dialog" aria-label="Choose a team">
          <div className="lens-head"><strong>Team view</strong><span>Everything you see follows this choice.</span></div>
          {teams.length > 6 && (
            <div className="lens-search"><Icon name="search" size={14} /><input ref={search} value={query} onChange={(e) => { setQuery(e.target.value); setActive(0); }} placeholder="Find a team" aria-label="Find a team" /></div>
          )}
          <ul className="lens-list" id={listId} role="listbox" aria-label="Teams">
            {rows.map((r, i) => {
              const selected = r.id === (teamId ?? '');
              return (
                <li key={r.id || 'all'} role="option" aria-selected={selected} className={`${selected ? 'sel' : ''} ${i === active ? 'act' : ''}`} onMouseEnter={() => setActive(i)} onClick={() => choose(r.id)}>
                  {r.id ? <span className="lens-chip" style={{ '--h': hue(r.name) } as React.CSSProperties}>{initials(r.name)}</span> : <span className="lens-chip all"><Icon name="layers" size={14} /></span>}
                  <span className="lens-row">
                    <b>{r.name}</b>
                    <small>{r.id ? `${plural(r.projects, 'project')} · ${plural(r.members, 'person').replace('persons', 'people')}` : `${plural(teams.length, 'team')} · everything you can see`}</small>
                  </span>
                  {selected && <Icon name="tick" size={15} />}
                </li>
              );
            })}
            {rows.length === 0 && <li className="lens-none">No team matches.</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
