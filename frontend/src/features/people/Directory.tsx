import { useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { Member, Role } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Select } from '../../components/Select';
import { Avatar, EmptyState, ErrorState, PageLoader } from '../../components/ui';
import { useIsMobile } from '../../lib/mobile';
import { useAuth, useCan, useEntitlement } from '../../stores/auth';
import { CreateUserModal, InviteModal, PeopleKpis } from '../members/MembersPage';
import { LEVELS, RANK, departmentOf, isSuspended, useMembers, useOrgStructure, useTeams } from './peopleData';

type Sort = 'name' | 'level' | 'joined' | 'role';
const ROW = 64;
const ROW_PHONE = 72;

/**
 * People: everyone in the workspace as one fast list. Search and filters (access level, job role, team, manager, status) and sort are kept in
 * the address, so a filtered list can be shared. Only the rows on screen are drawn, so thousands of people scroll smoothly. A row opens the
 * person's profile.
 */
export function Directory() {
  const nav = useNavigate();
  const phone = useIsMobile();
  const [params, setParams] = useSearchParams();
  const members = useMembers();
  const teams = useTeams();
  const org = useOrgStructure();
  const canInvite = useCan('members.invite');
  const canCreate = useCan('members.manage');
  const myId = useAuth((s) => s.ctx?.user.id);
  const seats = useEntitlement('MAX_MEMBERS');
  const [inviting, setInviting] = useState(false);
  const [creating, setCreating] = useState(false);

  const p = (k: string) => params.get(k) ?? '';
  const set = (k: string, v: string) => setParams((prev) => { const n = new URLSearchParams(prev); if (v) n.set(k, v); else n.delete(k); return n; }, { replace: true });
  const [term, setTerm] = useState(p('q'));
  const search = useDeferredValue(term);   // typing stays instant; the list catches up
  const level = p('level') as Role | '';
  const role = p('role'); const team = p('team'); const manager = p('manager'); const status = p('status'); const sort = (p('sort') || 'name') as Sort;

  const teamById = useMemo(() => new Map((teams.data ?? []).map((t) => [t.id, t])), [teams.data]);
  const byId = useMemo(() => new Map((members.data ?? []).map((m) => [m.userId, m])), [members.data]);
  const managers = useMemo(() => {
    const ids = new Set((members.data ?? []).map((m) => m.reportsToUserId).filter(Boolean) as string[]);
    return [...ids].map((id) => byId.get(id)).filter(Boolean).sort((a, b) => a!.displayName.localeCompare(b!.displayName)) as Member[];
  }, [members.data, byId]);
  const jobRoles = useMemo(() => (org.data?.roles ?? []).filter((r) => !r.isDeleted).sort((a, b) => a.name.localeCompare(b.name)), [org.data]);

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = (members.data ?? []).filter((m) =>
      (!q || m.displayName.toLowerCase().includes(q) || m.email.toLowerCase().includes(q) || (m.jobRole ?? '').toLowerCase().includes(q))
      && (!level || m.role === level)
      && (!role || (role === 'none' ? !m.orgRoleId : m.orgRoleId === role))
      && (!team || (team === 'none' ? !(m.teamIds ?? []).length : (m.teamIds ?? []).some((id) => id === team || teamById.get(id)?.parentTeamId === team)))
      && (!manager || (manager === 'none' ? !m.reportsToUserId : m.reportsToUserId === manager))
      && (!status || (status === 'suspended' ? isSuspended(m) : !isSuspended(m))));
    const cmp: Record<Sort, (a: Member, b: Member) => number> = {
      name: (a, b) => a.displayName.localeCompare(b.displayName),
      level: (a, b) => RANK[b.role] - RANK[a.role] || a.displayName.localeCompare(b.displayName),
      role: (a, b) => (a.jobRole ?? '￿').localeCompare(b.jobRole ?? '￿') || a.displayName.localeCompare(b.displayName),
      joined: (a, b) => b.joinedAt.localeCompare(a.joinedAt),
    };
    return list.sort(cmp[sort]);
  }, [members.data, search, level, role, team, manager, status, sort, teamById]);

  const filtered = !!(term || level || role || team || manager || status);
  const suspended = (members.data ?? []).filter(isSuspended).length;

  return (
    <div className="pr-dir">
      {members.data && <PeopleKpis members={members.data} seats={seats} canInvite={canInvite} />}
      <div className="pr-toolbar">
        <div className="pr-search"><Icon name="search" size={15} />
          <input type="search" placeholder="Search name, email or job title" value={term} onChange={(e) => { setTerm(e.target.value); set('q', e.target.value); }} aria-label="Search people" data-testid="people-search" />
        </div>
        <div className="pr-actions">
          {canCreate && <button className="btn btn-ghost" onClick={() => setCreating(true)}><Icon name="userPlus" /> <span className="pr-hide-phone">Create user</span></button>}
          {canInvite && <button className="btn btn-primary" onClick={() => setInviting(true)}><Icon name="plus" /> Invite</button>}
        </div>
      </div>
      <div className="pr-filters" role="group" aria-label="Filters">
        <Select className="select pr-chip-select" value={level} onChange={(e) => set('level', e.target.value)} aria-label="Access level">
          <option value="">Any access level</option>{LEVELS.map((l) => <option key={l.id} value={l.id}>{l.id}</option>)}
        </Select>
        {jobRoles.length > 0 && <Select className="select pr-chip-select" value={role} onChange={(e) => set('role', e.target.value)} aria-label="Job role">
          <option value="">Any job role</option><option value="none">No job role</option>{jobRoles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </Select>}
        {(teams.data?.length ?? 0) > 0 && <Select className="select pr-chip-select" value={team} onChange={(e) => set('team', e.target.value)} aria-label="Team">
          <option value="">Any team</option><option value="none">In no team</option>
          {(teams.data ?? []).slice().sort((a, b) => a.name.localeCompare(b.name)).map((t) => <option key={t.id} value={t.id}>{t.parentTeamId ? `${teamById.get(t.parentTeamId)?.name ?? ''} › ` : ''}{t.name}</option>)}
        </Select>}
        <Select className="select pr-chip-select" value={manager} onChange={(e) => set('manager', e.target.value)} aria-label="Manager">
          <option value="">Any manager</option><option value="none">No manager</option>{managers.map((m) => <option key={m.userId} value={m.userId}>Reports to {m.displayName}</option>)}
        </Select>
        <Select className="select pr-chip-select" value={status} onChange={(e) => set('status', e.target.value)} aria-label="Status">
          <option value="">Any status</option><option value="active">Active</option><option value="suspended">Suspended{suspended ? ` (${suspended})` : ''}</option>
        </Select>
        <Select className="select pr-chip-select" value={sort} onChange={(e) => set('sort', e.target.value === 'name' ? '' : e.target.value)} aria-label="Sort by">
          <option value="name">Sort: Name</option><option value="level">Sort: Access level</option><option value="role">Sort: Job role</option><option value="joined">Sort: Newest</option>
        </Select>
        {filtered && <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setTerm(''); setParams(new URLSearchParams(), { replace: true }); }}>Clear</button>}
      </div>

      {members.isLoading ? <PageLoader />
        : members.isError ? <ErrorState error={members.error} retry={() => members.refetch()} />
        : (
          <>
            <p className="pr-count" data-testid="people-count" aria-live="polite">{rows.length === (members.data?.length ?? 0) ? `${rows.length} ${rows.length === 1 ? 'person' : 'people'}` : `${rows.length} of ${members.data!.length}`}</p>
            {rows.length === 0
              ? <EmptyState icon="users" title={filtered ? 'Nobody matches' : 'No one here yet'} text={filtered ? 'Try fewer filters or a different search.' : 'Invite people to start working together.'} />
              : <VirtualRows rows={rows} height={phone ? ROW_PHONE : ROW} render={(m) => (
                  <PersonRow m={m} me={m.userId === myId} manager={m.reportsToUserId ? byId.get(m.reportsToUserId)?.displayName : undefined}
                    teams={(m.teamIds ?? []).map((id) => teamById.get(id)).filter(Boolean).map((t) => t!.name)}
                    dept={departmentOf(teamById.get((m.teamIds ?? [])[0] ?? ''), teamById)?.name}
                    onOpen={() => nav(`/people/${m.userId}`)} />
                )} />}
          </>
        )}
      {inviting && <InviteModal onClose={() => setInviting(false)} />}
      {creating && <CreateUserModal onClose={() => setCreating(false)} onInviteInstead={() => { setCreating(false); setInviting(true); }} />}
    </div>
  );
}

/** Draws only the rows in view (plus a few either side) inside its own scroller. */
export function VirtualRows<T>({ rows, height, render, label = 'People' }: { rows: T[]; height: number; render: (row: T, i: number) => ReactNode; label?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);
  const [view, setView] = useState(640);
  useEffect(() => {
    const el = box.current; if (!el) return;
    const measure = () => setView(el.clientHeight || 640);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure); ro.observe(el); return () => ro.disconnect();
  }, []);
  // A shorter list (a filter) clamps the scroll position; draw from where the scroller really is.
  const at = Math.min(top, Math.max(0, rows.length * height - view));
  useEffect(() => { const el = box.current; if (el && el.scrollTop !== at) { el.scrollTop = at; setTop(at); } }, [rows.length, at]);
  const first = Math.max(0, Math.floor(at / height) - 6);
  const last = Math.min(rows.length, Math.ceil((at + view) / height) + 6);
  return (
    <div ref={box} className="pr-vlist" role="list" aria-label={label} aria-rowcount={rows.length} data-testid="people-list"
      onScroll={(e) => setTop((e.target as HTMLDivElement).scrollTop)} style={{ ['--row-h' as string]: `${height}px` }}>
      <div style={{ height: rows.length * height, position: 'relative' }}>
        {rows.slice(first, last).map((r, i) => (
          <div key={first + i} role="listitem" className="pr-vrow" style={{ transform: `translateY(${(first + i) * height}px)`, height }}>{render(r, first + i)}</div>
        ))}
      </div>
    </div>
  );
}

function PersonRow({ m, me, manager, teams, dept, onOpen }: { m: Member; me: boolean; manager?: string; teams: string[]; dept?: string; onOpen: () => void }) {
  const off = isSuspended(m) || m.isActive === false;
  return (
    <button type="button" className={`pr-row${off ? ' off' : ''}`} onClick={onOpen} data-testid="person-row" data-user={m.userId}>
      <Avatar name={m.displayName} userId={m.userId} hasAvatar={m.hasAvatar} />
      <span className="pr-row-main">
        <b>{m.displayName}{me && <small className="pr-you"> · You</small>}</b>
        <span>{[m.jobRole, m.email].filter(Boolean).join(' · ') || '—'}</span>
      </span>
      <span className="pr-row-col pr-hide-phone"><small>Team</small>{teams.length ? <>{dept && dept !== teams[0] ? `${dept} › ` : ''}{teams[0]}{teams.length > 1 && <em className="pr-more">+{teams.length - 1}</em>}</> : <i>—</i>}</span>
      <span className="pr-row-col pr-hide-phone"><small>Manager</small>{manager ?? <i>—</i>}</span>
      <span className="pr-row-tags">
        {isSuspended(m) && <span className="pr-badge warn" data-testid="badge-suspended">Suspended</span>}
        {!isSuspended(m) && m.isActive === false && <span className="pr-badge">Deactivated</span>}
        <span className={`pr-level lv-${m.role.toLowerCase()}`}>{m.role}</span>
      </span>
      <Icon name="chevronR" size={14} className="pr-row-go" />
    </button>
  );
}
