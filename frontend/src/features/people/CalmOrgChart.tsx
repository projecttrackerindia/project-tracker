import { useMemo, useState, type DragEvent } from 'react';
import { Link } from 'react-router-dom';
import { orgApi, type OrgMoveImpact, type OrgTree, type OrgTreePerson } from '../../api/endpoints.work';
import { ApiError } from '../../api/client';
import { CalmCard, CalmGo, CalmLink, CalmSheet } from '../../components/calm';
import { Face } from '../../components/Face';
import { useWsQuery } from '../../lib/hooks';
import { useIsMobile } from '../../lib/mobile';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { refreshPeople } from './peopleData';
import './calm-people.css';

type Node = { p: OrgTreePerson; kids: Node[] };

/** Roots are people without a manager (owners first); a manager line that loops is drawn from a root. */
export function buildOrgNodes(people: OrgTreePerson[]): Node[] {
  const byId = new Map(people.map((p) => [p.userId, { p, kids: [] as Node[] }]));
  const roots: Node[] = [];
  for (const n of byId.values()) {
    const boss = n.p.managerId ? byId.get(n.p.managerId) : undefined;
    let loops = false; const seen = new Set<string>(); let cur: string | null = n.p.managerId;
    while (cur) { if (cur === n.p.userId || seen.has(cur)) { loops = true; break; } seen.add(cur); cur = byId.get(cur)?.p.managerId ?? null; }
    if (boss && !loops) boss.kids.push(n); else roots.push(n);
  }
  const rank = (p: OrgTreePerson) => (p.accessRole === 'Owner' ? 0 : p.accessRole === 'Admin' ? 1 : 2);
  const sort = (l: Node[]) => { l.sort((a, b) => rank(a.p) - rank(b.p) || a.p.displayName.localeCompare(b.p.displayName)); l.forEach((k) => sort(k.kids)); };
  sort(roots);
  return roots;
}

const errText = (e: unknown) => (e instanceof ApiError ? e.errors[0]?.message ?? e.message : 'Could not move them.');

/** Org chart (shot 57): the reporting tree on a dotted canvas, a person panel on the right, drag a person onto a new manager → impact sheet (57b). */
export function CalmOrgChart() {
  const wid = useWorkspaceId();
  const phone = useIsMobile();
  const tree = useWsQuery(['org', 'tree'], orgApi.tree, { staleTime: 30_000 });
  const [sel, setSel] = useState<string | null>(null);
  const [find, setFind] = useState('');
  const [zoom, setZoom] = useState(1);
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [impact, setImpact] = useState<OrgMoveImpact | null>(null);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const data: OrgTree | undefined = tree.data;
  const roots = useMemo(() => buildOrgNodes(data?.people ?? []), [data]);
  const teamName = useMemo(() => new Map((data?.teams ?? []).map((t) => [t.id, t.name])), [data]);
  const person = data?.people.find((p) => p.userId === (sel ?? roots[0]?.p.userId)) ?? null;
  const q = find.trim().toLowerCase();

  const preview = async (id: string, newParentId: string | null) => {
    if (!data?.canManage) return;
    try { setImpact(await orgApi.previewMove({ kind: 'person', id, newParentId })); }
    catch (e) { toast(errText(e), 'error'); }
  };
  const confirm = async () => {
    if (!impact) return;
    setBusy(true);
    try { await orgApi.move({ kind: 'person', id: impact.id, newParentId: impact.toParentId }); toast('✓ Saved'); setImpact(null); refreshPeople(wid); void tree.refetch(); }
    catch (e) { toast(errText(e), 'error'); }
    finally { setBusy(false); }
  };

  const card = (n: Node) => {
    const p = n.p;
    const team = p.teamIds[0] ? teamName.get(p.teamIds[0]) : null;
    const hit = q && p.displayName.toLowerCase().includes(q);
    const on = person?.userId === p.userId;
    return (
      <button type="button" data-testid="org-node"
        className={`co-node${on ? ' on' : ''}${hit ? ' hit' : ''}${over === p.userId ? ' over' : ''}${q && !hit ? ' dim' : ''}`}
        draggable={!!data?.canManage && !phone}
        onDragStart={(e: DragEvent) => { setDrag(p.userId); e.dataTransfer.setData('text/plain', p.userId); e.dataTransfer.effectAllowed = 'move'; }}
        onDragEnd={() => { setDrag(null); setOver(null); }}
        onDragOver={(e: DragEvent) => { if (drag && drag !== p.userId) { e.preventDefault(); setOver(p.userId); } }}
        onDragLeave={() => setOver((o) => (o === p.userId ? null : o))}
        onDrop={(e: DragEvent) => { e.preventDefault(); const id = e.dataTransfer.getData('text/plain') || drag; setOver(null); setDrag(null); if (id && id !== p.userId) void preview(id, p.userId); }}
        onClick={() => setSel(p.userId)} aria-pressed={on} aria-label={`${p.displayName}${p.roleName ? `, ${p.roleName}` : ''}`}>
        <Face userId={p.userId} name={p.displayName} className="co-face" />
        <span className="co-nt"><b>{p.displayName}</b><small>{p.roleName ?? p.accessRole}</small>{team && <i><span className="calm-dot" />{team}</i>}</span>
      </button>
    );
  };
  const branch = (n: Node): React.ReactNode => (
    <li key={n.p.userId}>{card(n)}{n.kids.length > 0 && <ul>{n.kids.map(branch)}</ul>}</li>
  );

  const manager = person?.managerId ? data?.people.find((p) => p.userId === person.managerId) : null;
  const reports = data?.people.filter((p) => p.managerId === person?.userId) ?? [];
  const panel = person && (
    <CalmCard className="co-panel" aria-label={`${person.displayName}'s place`}>
      <div className="co-ph"><Face userId={person.userId} name={person.displayName} className="co-face lg" /><h2>{person.displayName}</h2></div>
      <dl className="co-kv">
        <div><dt>Role</dt><dd>{person.roleName ?? '—'}</dd></div>
        <div><dt>Team</dt><dd>{person.teamIds.map((t) => teamName.get(t)).filter(Boolean)[0] ?? '—'}</dd></div>
        <div><dt>Access</dt><dd>{person.accessRole}</dd></div>
      </dl>
      <h4>Manager</h4>
      {manager ? <button type="button" className="co-mini" onClick={() => setSel(manager.userId)}><Face userId={manager.userId} name={manager.displayName} className="co-face sm" />{manager.displayName}<small>{manager.roleName}</small></button> : <p className="co-none">Reports to nobody</p>}
      <h4>Reports · {reports.length}</h4>
      {reports.length === 0 && <p className="co-none">No direct reports</p>}
      {reports.map((r) => <button key={r.userId} type="button" className="co-mini" onClick={() => setSel(r.userId)}><Face userId={r.userId} name={r.displayName} className="co-face sm" />{r.displayName}<small>{r.roleName}</small></button>)}
      {person.teamIds.length > 0 && <><h4>Teams</h4><div className="co-chips">{person.teamIds.map((t) => <span key={t}>{teamName.get(t)}</span>)}</div></>}
      <div className="co-acts">
        <CalmGo href={`/messages?to=${person.userId}`}>Message</CalmGo>
        {data?.canManage && <CalmLink onClick={() => setPicking(true)}>Change manager</CalmLink>}
        <Link className="calm-link" to={`/people/${person.userId}`}>Profile ›</Link>
      </div>
    </CalmCard>
  );

  return (
    <div className="co-wrap">
      <div className="co-main">
        <div className="co-tools">
          <input className="co-find" type="search" placeholder="Find a person" value={find} onChange={(e) => setFind(e.target.value)} aria-label="Find a person" />
          {!phone && <span className="co-zoom" role="group" aria-label="Zoom">
            <button type="button" onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.1).toFixed(1)))} aria-label="Zoom out">–</button>
            <span>{Math.round(zoom * 100)}%</span>
            <button type="button" onClick={() => setZoom((z) => Math.min(1.5, +(z + 0.1).toFixed(1)))} aria-label="Zoom in">+</button>
            <button type="button" onClick={() => setZoom(1)}>Fit</button>
          </span>}
        </div>
        <div className="co-canvas" data-testid="org-canvas">
          {tree.isLoading && <p className="co-none">Loading…</p>}
          {tree.isError && <p className="co-none">Could not load the org chart.</p>}
          <ul className="co-tree" style={{ transform: `scale(${zoom})` }}>{roots.map(branch)}</ul>
          {data?.canManage && !phone && <p className="co-hint">Drag a person onto a new manager to move them</p>}
        </div>
      </div>
      {panel}

      <CalmSheet open={!!impact} onClose={() => setImpact(null)} kind="bottom" width={560} title={impact ? `Move ${impact.name}?` : ''}
        sub={impact ? `${impact.fromParentName ?? 'Nobody'} → ${impact.toParentName ?? 'Nobody'}` : undefined}>
        {impact && (
          <div className="co-impact" data-testid="org-impact">
            <ul>{impact.effects.map((e) => <li key={e}>{e}</li>)}</ul>
            <p className="co-none">This is written to the audit log.</p>
            <div className="co-acts"><CalmGo onClick={() => void confirm()} disabled={busy}>Move {impact.name.split(' ')[0]}</CalmGo><CalmLink onClick={() => setImpact(null)}>Cancel</CalmLink></div>
          </div>
        )}
      </CalmSheet>

      <CalmSheet open={picking} onClose={() => setPicking(false)} title="Change manager" sub={person ? `Who ${person.displayName} reports to` : undefined}>
        <div className="co-pick">
          <button type="button" className="co-mini" onClick={() => { setPicking(false); if (person) void preview(person.userId, null); }}>Nobody</button>
          {data?.people.filter((p) => p.userId !== person?.userId).map((p) => (
            <button key={p.userId} type="button" className="co-mini" onClick={() => { setPicking(false); if (person) void preview(person.userId, p.userId); }}>
              <Face userId={p.userId} name={p.displayName} className="co-face sm" />{p.displayName}<small>{p.roleName}</small>
            </button>
          ))}
        </div>
      </CalmSheet>
    </div>
  );
}
