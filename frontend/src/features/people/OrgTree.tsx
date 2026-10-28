import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as KE } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { orgApi } from '../../api/endpoints';
import type { Member, OrgRole, Team } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Avatar, EmptyState, ErrorState, PageLoader, Segmented } from '../../components/ui';
import { useIsMobile } from '../../lib/mobile';
import { useCan, useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { OrgPage } from '../organization/OrgPage';
import { ImpactDialog } from './ImpactDialog';
import { RANK, isSuspended, refreshPeople, useMembers, useOrgStructure, useTeams } from './peopleData';

type View = 'lines' | 'teams' | 'canvas';
type TNode = {
  key: string; kind: 'person' | 'vacant' | 'team' | 'group'; label: string; sub?: string;
  member?: Member; role?: OrgRole; team?: Team; children: TNode[]; parent?: TNode; depth: number;
};

/** Reporting lines: roots are the Owner and everyone without a manager; vacant job roles hang under the person holding the parent role. */
export function buildReportingTree(members: Member[], roles: OrgRole[]): TNode[] {
  const byId = new Map(members.map((m) => [m.userId, m]));
  const nodes = new Map<string, TNode>();
  for (const m of members) nodes.set(m.userId, { key: `p:${m.userId}`, kind: 'person', label: m.displayName, sub: m.jobRole ?? undefined, member: m, children: [], depth: 0 });
  const roots: TNode[] = [];
  const cycles = (start: Member) => { // a manager line that loops back (should never happen; the server refuses it) is drawn from a root
    const seen = new Set<string>(); let cur: Member | undefined = start;
    while (cur?.reportsToUserId) { if (seen.has(cur.userId)) return true; seen.add(cur.userId); cur = byId.get(cur.reportsToUserId); }
    return false;
  };
  for (const m of members) {
    const n = nodes.get(m.userId)!;
    const boss = m.reportsToUserId ? nodes.get(m.reportsToUserId) : undefined;
    if (boss && boss !== n && !cycles(m)) { n.parent = boss; boss.children.push(n); } else roots.push(n);
  }
  const held = new Map<string, number>();
  for (const m of members) if (m.orgRoleId) held.set(m.orgRoleId, (held.get(m.orgRoleId) ?? 0) + 1);
  for (const r of roles.filter((x) => !x.isDeleted && !held.get(x.id))) {
    const holder = r.parentRoleId ? members.filter((m) => m.orgRoleId === r.parentRoleId).sort((a, b) => a.displayName.localeCompare(b.displayName))[0] : undefined;
    const v: TNode = { key: `v:${r.id}`, kind: 'vacant', label: `Vacant · ${r.name}`, role: r, children: [], depth: 0 };
    const at = holder ? nodes.get(holder.userId) : undefined;
    if (at) { v.parent = at; at.children.push(v); } else roots.push(v);
  }
  const order = (a: TNode, b: TNode) => (a.kind === 'vacant' ? 1 : 0) - (b.kind === 'vacant' ? 1 : 0) || a.label.localeCompare(b.label);
  const sortDeep = (list: TNode[], depth: number) => { list.sort(order); for (const n of list) { n.depth = depth; sortDeep(n.children, depth + 1); } };
  roots.sort((a, b) => (a.kind === 'vacant' ? 1 : 0) - (b.kind === 'vacant' ? 1 : 0) || (b.member ? RANK[b.member.role] : 0) - (a.member ? RANK[a.member.role] : 0) || a.label.localeCompare(b.label));
  roots.forEach((n) => { n.depth = 0; sortDeep(n.children, 1); });
  return roots;
}

/** Teams and departments: departments (top-level teams), their teams, and the people in each; people in several teams appear in each. */
export function buildTeamTree(members: Member[], teams: Team[]): TNode[] {
  const byTeam = new Map<string, TNode>();
  for (const t of teams) byTeam.set(t.id, { key: `t:${t.id}`, kind: 'team', label: t.name, sub: `${t.memberCount} ${t.memberCount === 1 ? 'person' : 'people'}`, team: t, children: [], depth: 0 });
  const roots: TNode[] = [];
  for (const t of teams) {
    const n = byTeam.get(t.id)!;
    const parent = t.parentTeamId ? byTeam.get(t.parentTeamId) : undefined;
    if (parent) { n.parent = parent; parent.children.push(n); } else roots.push(n);
  }
  const loose: Member[] = [];
  for (const m of members) {
    const ids = (m.teamIds ?? []).filter((id) => byTeam.has(id));
    if (!ids.length) { loose.push(m); continue; }
    for (const id of ids) {
      const t = byTeam.get(id)!;
      t.children.push({ key: `tm:${id}:${m.userId}`, kind: 'person', label: m.displayName, sub: m.jobRole ?? undefined, member: m, children: [], parent: t, depth: 0 });
    }
  }
  if (loose.length) {
    const g: TNode = { key: 'g:none', kind: 'group', label: 'Not in a team', sub: `${loose.length}`, children: [], depth: 0 };
    g.children = loose.map((m) => ({ key: `tm:none:${m.userId}`, kind: 'person' as const, label: m.displayName, sub: m.jobRole ?? undefined, member: m, children: [], parent: g, depth: 1 }));
    roots.push(g);
  }
  const sortDeep = (list: TNode[], depth: number) => {
    list.sort((a, b) => (a.kind === 'team' ? 0 : 1) - (b.kind === 'team' ? 0 : 1) || a.label.localeCompare(b.label));
    for (const n of list) { n.depth = depth; sortDeep(n.children, depth + 1); }
  };
  sortDeep(roots.filter((r) => r.kind !== 'group'), 0);
  roots.sort((a, b) => (a.kind === 'group' ? 1 : 0) - (b.kind === 'group' ? 1 : 0) || a.label.localeCompare(b.label));
  return roots;
}

function flatten(roots: TNode[], open: Set<string>): TNode[] {
  const out: TNode[] = [];
  const walk = (list: TNode[]) => { for (const n of list) { out.push(n); if (n.children.length && open.has(n.key)) walk(n.children); } };
  walk(roots);
  return out;
}

function allNodes(roots: TNode[]): TNode[] {
  const out: TNode[] = [];
  const walk = (list: TNode[]) => { for (const n of list) { out.push(n); walk(n.children); } };
  walk(roots);
  return out;
}

/** People › Organization: reporting lines or teams as an accessible tree, and the older canvas chart. */
export function OrgTreePage() {
  const [params, setParams] = useSearchParams();
  const view = (['lines', 'teams', 'canvas'].includes(params.get('view') ?? '') ? params.get('view') : 'lines') as View;
  const setView = (v: View) => { const n = new URLSearchParams(params); if (v === 'lines') n.delete('view'); else n.set('view', v); setParams(n, { replace: true }); };
  const canCanvas = useOrgStructure().isSuccess;
  return (
    <div className="pr-org">
      <div className="pr-org-head">
        <Segmented label="Organization view" value={view} onChange={setView}
          options={[{ id: 'lines', label: 'Reporting lines' }, { id: 'teams', label: 'Teams' }, ...(canCanvas ? [{ id: 'canvas' as View, label: 'Canvas' }] : [])]} />
      </div>
      {view === 'canvas' ? <OrgPage /> : <OrgTree mode={view} />}
    </div>
  );
}

const ROW = 56;

export function OrgTree({ mode }: { mode: 'lines' | 'teams' }) {
  const nav = useNavigate();
  const wid = useWorkspaceId();
  const phone = useIsMobile();
  const members = useMembers();
  const org = useOrgStructure();
  const teams = useTeams();
  const canDrag = useCan('org.structure') && mode === 'lines' && !phone;
  const teamName = useMemo(() => new Map((teams.data ?? []).map((t) => [t.id, t.name])), [teams.data]);

  const roots = useMemo(() => mode === 'lines'
    ? buildReportingTree(members.data ?? [], org.data?.roles ?? [])
    : buildTeamTree(members.data ?? [], teams.data ?? []), [mode, members.data, org.data, teams.data]);
  const every = useMemo(() => allNodes(roots), [roots]);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const seeded = useRef<string>('');
  useEffect(() => { // first two levels open
    const sig = `${mode}:${every.length}`;
    if (!every.length || seeded.current === sig) return;
    seeded.current = sig;
    setOpen((o) => { const n = new Set(o); for (const x of every) if (x.depth < 1 && x.children.length) n.add(x.key); return n; });
  }, [every, mode]);
  const rows = useMemo(() => flatten(roots, open), [roots, open]);
  const [focus, setFocus] = useState<string | null>(null);
  const focusKey = focus && rows.some((r) => r.key === focus) ? focus : rows[0]?.key ?? null;

  // Lazy rendering: only rows in view are in the DOM.
  const box = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(0);
  const [height, setHeight] = useState(560);
  useEffect(() => {
    const el = box.current; if (!el) return;
    const m = () => setHeight(el.clientHeight || 560); m();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(m); ro.observe(el); return () => ro.disconnect();
  }, [members.isSuccess]);
  const at = Math.min(top, Math.max(0, rows.length * ROW - height));
  useEffect(() => { const el = box.current; if (el && el.scrollTop > at) { el.scrollTop = at; setTop(at); } }, [rows.length, at]);
  const first = Math.max(0, Math.floor(at / ROW) - 8);
  const last = Math.min(rows.length, Math.ceil((at + height) / ROW) + 8);

  const reveal = useCallback((key: string, focusDom: boolean) => {
    const i = rows.findIndex((r) => r.key === key);
    const el = box.current;
    if (el && i >= 0) {
      const y = i * ROW;
      if (y < el.scrollTop) el.scrollTop = y;
      else if (y + ROW > el.scrollTop + el.clientHeight) el.scrollTop = y + ROW - el.clientHeight;
      setTop(el.scrollTop);
    }
    if (focusDom) requestAnimationFrame(() => box.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)?.focus());
  }, [rows]);

  const toggle = (n: TNode, to?: boolean) => setOpen((o) => { const s = new Set(o); if (to ?? !s.has(n.key)) s.add(n.key); else s.delete(n.key); return s; });
  const go = (key: string) => { setFocus(key); reveal(key, true); };
  const activate = (n: TNode) => {
    if (n.member) nav(`/people/${n.member.userId}`);
    else if (n.role) nav(`/people/roles/job/${n.role.id}`);
    else if (n.children.length) toggle(n);
  };

  const onKey = (e: KE<HTMLDivElement>) => {
    const i = rows.findIndex((r) => r.key === focusKey);
    if (i < 0) return;
    const n = rows[i];
    const k = e.key;
    if (k === 'ArrowDown') { e.preventDefault(); if (i < rows.length - 1) go(rows[i + 1].key); }
    else if (k === 'ArrowUp') { e.preventDefault(); if (i > 0) go(rows[i - 1].key); }
    else if (k === 'Home') { e.preventDefault(); go(rows[0].key); }
    else if (k === 'End') { e.preventDefault(); go(rows[rows.length - 1].key); }
    else if (k === 'ArrowRight') {
      e.preventDefault();
      if (n.children.length && !open.has(n.key)) toggle(n, true);
      else if (n.children.length) go(n.children[0].key);
    } else if (k === 'ArrowLeft') {
      e.preventDefault();
      if (n.children.length && open.has(n.key)) toggle(n, false);
      else if (n.parent) go(n.parent.key);
    } else if (k === 'Enter') { e.preventDefault(); activate(n); }
    else if (k === ' ') { e.preventDefault(); if (n.children.length) toggle(n); }
    else if (k === '*') { e.preventDefault(); const sibs = n.parent ? n.parent.children : roots; setOpen((o) => { const s = new Set(o); sibs.forEach((x) => x.children.length && s.add(x.key)); return s; }); }
  };

  // Search: jump to the first match, opening everything above it; Enter goes to the next one.
  const [term, setTerm] = useState('');
  const [hit, setHit] = useState(0);
  const matches = useMemo(() => {
    const t = term.trim().toLowerCase();
    if (!t) return [] as TNode[];
    return every.filter((n) => n.label.toLowerCase().includes(t) || (n.sub ?? '').toLowerCase().includes(t)
      || (n.member?.teamIds ?? []).some((id) => (teamName.get(id) ?? '').toLowerCase().includes(t)));
  }, [term, every, teamName]);
  const jump = (n: TNode | undefined) => {
    if (!n) return;
    setOpen((o) => { const s = new Set(o); for (let p = n.parent; p; p = p.parent) s.add(p.key); return s; });
    setFocus(n.key);
  };
  useEffect(() => { setHit(0); jump(matches[0]); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [matches]);
  useEffect(() => { if (focus && term) reveal(focus, false); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [rows, focus]);

  // Drag a person onto another to change who they report to (never onto someone in their own line: that would be a loop).
  const [drag, setDrag] = useState<Member | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [pending, setPending] = useState<{ who: Member; to: Member | null } | null>(null);
  const below = useMemo(() => {
    if (!drag) return new Set<string>();
    const start = every.find((n) => n.member?.userId === drag.userId);
    return new Set(start ? allNodes([start]).map((n) => n.member?.userId).filter(Boolean) as string[] : []);
  }, [drag, every]);
  const canDropOn = (n: TNode) => !!drag && !!n.member && !below.has(n.member.userId) && drag.reportsToUserId !== n.member.userId;

  if (members.isLoading) return <PageLoader />;
  if (members.isError) return <ErrorState error={members.error} retry={() => members.refetch()} />;
  if (!rows.length) return <EmptyState icon="org" title={mode === 'teams' ? 'No teams yet' : 'No one here yet'} text={mode === 'teams' ? 'Create teams to group people into departments.' : undefined} />;

  return (
    <div className="pr-tree-wrap">
      <div className="pr-toolbar">
        <div className="pr-search"><Icon name="search" size={15} />
          <input type="search" value={term} onChange={(e) => setTerm(e.target.value)} placeholder={mode === 'teams' ? 'Find a person or team' : 'Find a person, job title or team'}
            aria-label="Find in the organization" data-testid="tree-search"
            onKeyDown={(e) => { if (e.key === 'Enter' && matches.length) { e.preventDefault(); const nx = (hit + 1) % matches.length; setHit(nx); jump(matches[nx]); } if (e.key === 'ArrowDown' && focusKey) { e.preventDefault(); go(focusKey); } }} />
          {term && <span className="pr-search-count" aria-live="polite">{matches.length ? `${hit + 1} of ${matches.length}` : 'No match'}</span>}
        </div>
        <div className="pr-actions">
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(new Set(every.filter((n) => n.children.length).map((n) => n.key)))}>Expand all</button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(new Set())}>Collapse all</button>
        </div>
      </div>
      {canDrag && <p className="pr-hint muted"><Icon name="grip" size={13} /> Drag a person onto someone to change who they report to.</p>}
      {canDrag && (
        <div className={`pr-drop-root${over === 'root' ? ' over' : ''}`} style={{ visibility: drag ? 'visible' : 'hidden' }} aria-hidden={!drag} onDragOver={(e) => { e.preventDefault(); setOver('root'); }} onDragLeave={() => setOver(null)}
          onDrop={(e) => { e.preventDefault(); setOver(null); if (drag?.reportsToUserId) setPending({ who: drag, to: null }); setDrag(null); }}>Drop here: reports to nobody</div>
      )}
      <div ref={box} className="pr-tree" role="tree" aria-label={mode === 'teams' ? 'Teams and departments' : 'Reporting lines'} onKeyDown={onKey}
        onScroll={(e) => setTop((e.target as HTMLDivElement).scrollTop)} data-testid="org-tree">
        <div style={{ height: rows.length * ROW, position: 'relative' }} role="presentation">
          {rows.slice(first, last).map((n, j) => {
            const i = first + j;
            const sibs = n.parent ? n.parent.children : roots;
            const m = n.member;
            const hasKids = n.children.length > 0;
            const isOpen = open.has(n.key);
            const isHit = !!term && matches.some((x) => x.key === n.key);
            return (
              <div key={n.key} data-key={n.key} role="treeitem" aria-level={n.depth + 1} aria-setsize={sibs.length} aria-posinset={sibs.indexOf(n) + 1}
                aria-expanded={hasKids ? isOpen : undefined} aria-selected={n.key === focusKey} tabIndex={n.key === focusKey ? 0 : -1}
                className={`pr-node k-${n.kind}${n.key === focusKey ? ' focus' : ''}${isHit ? ' hit' : ''}${m && (isSuspended(m) || m.isActive === false) ? ' off' : ''}${over === n.key ? ' over' : ''}`}
                style={{ transform: `translateY(${i * ROW}px)`, height: ROW, ['--depth' as string]: n.depth }}
                onClick={() => { setFocus(n.key); }} onDoubleClick={() => activate(n)}
                draggable={canDrag && !!m} onDragStart={(e) => { if (!m) return; setDrag(m); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', m.userId); }}
                onDragEnd={() => { setDrag(null); setOver(null); }}
                onDragOver={(e) => { if (canDropOn(n)) { e.preventDefault(); setOver(n.key); } }} onDragLeave={() => setOver((o) => (o === n.key ? null : o))}
                onDrop={(e) => { e.preventDefault(); setOver(null); if (drag && canDropOn(n)) setPending({ who: drag, to: n.member! }); setDrag(null); }}
                data-testid={`node-${n.kind}`}>
                <span className="pr-node-indent" aria-hidden="true" />
                <button type="button" tabIndex={-1} className={`pr-twisty${hasKids ? '' : ' none'}`} aria-hidden="true" onClick={(e) => { e.stopPropagation(); if (hasKids) toggle(n); }}>
                  {hasKids && <Icon name={isOpen ? 'chevronD' : 'chevronR'} size={13} />}
                </button>
                {n.kind === 'person' && m ? <Avatar name={m.displayName} userId={m.userId} hasAvatar={m.hasAvatar} />
                  : n.kind === 'vacant' ? <span className="pr-vacant-av" aria-hidden="true"><Icon name="user" size={14} /></span>
                  : <span className="pr-team-av" aria-hidden="true"><Icon name={n.kind === 'group' ? 'users' : 'layers'} size={14} /></span>}
                <span className="pr-node-main">
                  <b>{n.label}</b>
                  {n.sub && <span>{n.sub}</span>}
                </span>
                {m && mode === 'lines' && (m.teamIds ?? []).length > 0 && (
                  <span className="pr-chips pr-hide-phone" data-testid="team-chips">
                    {(m.teamIds ?? []).slice(0, 2).map((id) => <span key={id} className="pr-chip">{teamName.get(id) ?? 'Team'}</span>)}
                    {(m.teamIds ?? []).length > 2 && <span className="pr-chip">+{(m.teamIds ?? []).length - 2}</span>}
                  </span>
                )}
                {m && isSuspended(m) && <span className="pr-badge warn">Suspended</span>}
                {m && (m.role === 'Owner' || m.role === 'Admin') && <span className={`pr-level lv-${m.role.toLowerCase()}`}>{m.role}</span>}
                {hasKids && n.kind === 'person' && <span className="pr-count-chip" title="Direct reports">{n.children.filter((c) => c.kind === 'person').length}</span>}
                {(m || n.role) && <button type="button" tabIndex={-1} className="pr-node-open" aria-label={`Open ${n.label}`} onClick={(e) => { e.stopPropagation(); activate(n); }}><Icon name="chevronR" size={14} /></button>}
              </div>
            );
          })}
        </div>
      </div>
      {pending && (
        <ImpactDialog title="Change manager?" request={null} confirmText="Change manager"
          extra={<p data-testid="drag-impact">{pending.who.displayName} will report to {pending.to?.displayName ?? 'nobody'}{pending.who.reportsToUserId ? ` instead of ${members.data?.find((x) => x.userId === pending.who.reportsToUserId)?.displayName ?? 'their current manager'}` : ''}. Their own reports move with them. Access does not change.</p>}
          onConfirm={async () => { await orgApi.reportsTo(pending.who.userId, pending.to?.userId ?? null); toast('Manager changed.', 'success'); refreshPeople(wid); }}
          onClose={() => setPending(null)} />
      )}
    </div>
  );
}
