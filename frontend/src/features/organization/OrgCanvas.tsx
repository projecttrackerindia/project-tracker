import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  applyEdgeChanges, applyNodeChanges, Background, BackgroundVariant, BaseEdge, ConnectionLineType, Controls, EdgeLabelRenderer, getSmoothStepPath,
  Handle, MarkerType, MiniMap, Position, ReactFlow, ReactFlowProvider, useReactFlow,
  type Connection, type Edge, type EdgeChange, type EdgeProps, type Node, type NodeChange, type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { OrgPerson, OrgRole, OrgStructure } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Avatar } from '../../components/ui';
import { toast, useUi } from '../../stores/ui';
import { initials, PERSON_MIME, subtreeIds, treeLayout, wouldLoopPeople } from './orgLayout';
import type { OrgActions } from './orgState';

const EDGE = '#9aa0b5';
const ADMIN_ID = 'org-admin';
const ROLE_SIZE = { w: 236, h: 142, gapX: 28, gapY: 64 };
const PERSON_SIZE = { w: 220, h: 80, gapX: 28, gapY: 60 };

export type OrgView = 'roles' | 'people';

// ------------------------------------------------------------------ node types
type RoleData = {
  role: OrgRole; people: OrgPerson[]; selected: boolean; dim: boolean; canManage: boolean;
  onAddChild: (id: string) => void; onRestore: (id: string) => void; onDropPerson: (userId: string, roleId: string) => void;
};
type RoleNodeT = Node<RoleData, 'role'>;
type PersonData = { person: OrgPerson; role: OrgRole | null; selected: boolean; dim: boolean };
type PersonNodeT = Node<PersonData, 'person'>;
type AdminData = { admins: OrgPerson[] };
type AdminNodeT = Node<AdminData, 'admin'>;

function RoleNode({ data }: NodeProps<RoleNodeT>) {
  const { role, people, selected, dim, canManage } = data;
  const [over, setOver] = useState(false);
  const droppable = canManage && !role.isDeleted;
  const connectable = canManage && !role.isDeleted;

  return (
    <div className={`org-node ${selected ? 'selected' : ''} ${role.isDeleted ? 'deleted' : ''} ${dim ? 'dim' : ''} ${over ? 'drop-over' : ''}`}
      style={{ '--node': role.color } as CSSProperties}
      onDragOver={(e) => { if (droppable && Array.from(e.dataTransfer.types).includes(PERSON_MIME)) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setOver(true); } }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        const id = e.dataTransfer.getData(PERSON_MIME);
        if (id && droppable) { e.preventDefault(); e.stopPropagation(); data.onDropPerson(id, role.id); }
      }}>
      <Handle type="target" position={Position.Top} isConnectable={connectable} />
      <div className="org-node-head">
        <div className="org-node-tile" aria-hidden="true">{initials(role.name)}</div>
        <div className="org-node-titles">
          <div className="org-node-title" title={role.name}>{role.name}{role.hasAccess && <span className="org-access-flag" title="Has its own access settings"><Icon name="shield" size={12} /></span>}</div>
          <div className="org-node-desc">{role.description || (role.isDeleted ? 'Deleted role' : 'No description')}</div>
        </div>
        {connectable && <button type="button" className="org-node-add nodrag" title="Add a sub-role" aria-label={`Add a sub-role under ${role.name}`} onClick={(e) => { e.stopPropagation(); data.onAddChild(role.id); }}><Icon name="plus" size={14} /></button>}
      </div>
      <div className="org-node-meta">
        <div className="org-avatars">
          {people.slice(0, 4).map((p) => <span key={p.userId} title={p.displayName}><Avatar name={p.displayName} size="sm" userId={p.userId} /></span>)}
          {people.length > 4 && <span className="org-more">+{people.length - 4}</span>}
        </div>
        <span className="org-count">{role.peopleCount} {role.peopleCount === 1 ? 'person' : 'people'}{role.childCount ? ` · ${role.childCount} sub-role${role.childCount === 1 ? '' : 's'}` : ''}</span>
      </div>
      {role.isDeleted
        ? canManage
          ? <button type="button" className="org-node-foot nodrag restore" onClick={(e) => { e.stopPropagation(); data.onRestore(role.id); }}><span><Icon name="undo" size={13} /> Restore role</span><Icon name="chevronR" size={14} /></button>
          : <div className="org-node-foot"><span>Deleted</span></div>
        : <div className="org-node-foot"><span>{canManage ? 'Edit role' : 'View details'}</span><Icon name="chevronR" size={14} /></div>}
      <Handle type="source" position={Position.Bottom} isConnectable={connectable} />
    </div>
  );
}

function PersonNode({ data }: NodeProps<PersonNodeT>) {
  const { person, role, selected, dim } = data;
  return (
    <div className={`org-person ${selected ? 'selected' : ''} ${dim ? 'dim' : ''}`} style={{ '--node': role?.color ?? '#94a3b8' } as CSSProperties}>
      <Handle type="target" position={Position.Top} />
      <Avatar name={person.displayName} size="lg" userId={person.userId} />
      <div className="org-person-text">
        <div className="org-person-name" title={person.displayName}>{person.displayName}</div>
        <div className="org-person-role"><span className="org-dot" />{role?.name ?? 'No role yet'}</div>
      </div>
      <span className="org-person-tier">{person.accessRole}</span>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

function AdminNode({ data }: NodeProps<AdminNodeT>) {
  return (
    <div className="org-node admin" style={{ '--node': '#7c3aed' } as CSSProperties}>
      <div className="org-node-head">
        <div className="org-node-tile" aria-hidden="true"><Icon name="shield" size={20} /></div>
        <div className="org-node-titles">
          <div className="org-node-title">Organization Admin</div>
          <div className="org-node-desc">Access level, not a job role. Only admins grant access and permissions.</div>
        </div>
      </div>
      <div className="org-node-meta">
        <div className="org-avatars">{data.admins.slice(0, 4).map((p) => <span key={p.userId} title={p.displayName}><Avatar name={p.displayName} size="sm" userId={p.userId} /></span>)}</div>
        <span className="org-count">{data.admins.map((a) => a.displayName.split(' ')[0]).slice(0, 3).join(', ')}{data.admins.length > 3 ? '…' : ''}</span>
      </div>
      <div className="org-node-foot"><span><Icon name="lock" size={13} /> Fixed — outside the tree</span></div>
    </div>
  );
}

type OrgEdgeT = Edge<{ onDelete?: () => void }, 'org'>;
function OrgEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, style, selected, data }: EdgeProps<OrgEdgeT>) {
  const [path, lx, ly] = getSmoothStepPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, borderRadius: 14 });
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={{ ...style, stroke: selected ? '#8b5cf6' : style?.stroke }} interactionWidth={26} />
      {selected && data?.onDelete && (
        <EdgeLabelRenderer>
          <button type="button" className="org-edge-x nodrag nopan" style={{ transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)` }}
            title="Remove this connection" aria-label="Remove this connection" onClick={data.onDelete}>×</button>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const nodeTypes = { role: RoleNode, person: PersonNode, admin: AdminNode };
const edgeTypes = { org: OrgEdge };

// ------------------------------------------------------------------ canvas
export interface OrgCanvasProps {
  data: OrgStructure; view: OrgView; selectedId: string | null; onSelect: (id: string | null) => void;
  search: string; showDeleted: boolean; actions: OrgActions;
  onAddChild: (parentId: string) => void; onRestore: (id: string) => void;
  /** Bump to re-fit the viewport (auto-arrange, view switch). */
  fitSignal: number;
  /** Bump to zoom to the search matches. */
  focusSignal: number;
}

function Canvas(p: OrgCanvasProps) {
  const { data, view, selectedId, search, showDeleted, actions } = p;
  const rf = useReactFlow();
  const theme = useUi((s) => s.theme);
  const canManage = data.canManage;
  const q = search.trim().toLowerCase();

  const roleById = useMemo(() => new Map(data.roles.map((r) => [r.id, r])), [data.roles]);
  const personById = useMemo(() => new Map(data.people.map((x) => [x.userId, x])), [data.people]);
  const byRole = useMemo(() => {
    const m = new Map<string, OrgPerson[]>();
    for (const x of data.people) if (x.roleId) m.set(x.roleId, [...(m.get(x.roleId) ?? []), x]);
    return m;
  }, [data.people]);

  // ---- graph derived from the server data
  const graph = useMemo(() => {
    const nodes: Node[] = [];
    const edges: Edge[] = [];
    const edgeBase = { type: 'org', markerEnd: { type: MarkerType.ArrowClosed, color: EDGE, width: 16, height: 16 }, style: { stroke: EDGE, strokeWidth: 2 }, selectable: canManage, deletable: canManage } as const;

    if (view === 'roles') {
      const active = data.roles.filter((r) => !r.isDeleted);
      const auto = treeLayout(active.map((r) => ({ id: r.id, parentId: r.parentRoleId })), ROLE_SIZE);
      const matches = (r: OrgRole) => !q || r.name.toLowerCase().includes(q) || (r.description ?? '').toLowerCase().includes(q)
        || (byRole.get(r.id) ?? []).some((x) => x.displayName.toLowerCase().includes(q));
      const mk = (r: OrgRole, position: { x: number; y: number }): Node => ({
        id: r.id, type: 'role', position, draggable: canManage && !r.isDeleted, deletable: false,
        data: { role: r, people: byRole.get(r.id) ?? [], selected: selectedId === r.id, dim: !!q && !matches(r), canManage, onAddChild: p.onAddChild, onRestore: p.onRestore, onDropPerson: (uid: string, rid: string) => { void actions.assign(uid, rid); } } satisfies RoleData,
      });
      for (const r of active) nodes.push(mk(r, r.posX != null && r.posY != null ? { x: r.posX, y: r.posY } : auto.get(r.id) ?? { x: 0, y: 0 }));

      if (showDeleted) {
        const maxY = Math.max(0, ...nodes.map((n) => n.position.y));
        let x = 0;
        for (const r of data.roles.filter((d) => d.isDeleted)) { nodes.push(mk(r, { x, y: maxY + ROLE_SIZE.h + ROLE_SIZE.gapY * 1.6 })); x += ROLE_SIZE.w + ROLE_SIZE.gapX; }
      }
      const topRow = active.filter((r) => !r.parentRoleId || !active.some((a) => a.id === r.parentRoleId));
      const firstRootX = Math.min(...topRow.map((r) => auto.get(r.id)?.x ?? 0), Infinity);
      const adminX = Number.isFinite(firstRootX) && firstRootX >= ROLE_SIZE.w + ROLE_SIZE.gapX ? 0 : Math.min(0, ...nodes.map((n) => n.position.x)) - ROLE_SIZE.w - ROLE_SIZE.gapX * 2;
      nodes.push({
        id: ADMIN_ID, type: 'admin', position: { x: adminX, y: 0 }, draggable: false, selectable: false, connectable: false, deletable: false,
        data: { admins: data.people.filter((x) => x.accessRole === 'Owner' || x.accessRole === 'Admin') } satisfies AdminData,
      });
      for (const r of active) if (r.parentRoleId && roleById.get(r.parentRoleId) && !roleById.get(r.parentRoleId)!.isDeleted)
        edges.push({ ...edgeBase, id: `e-${r.parentRoleId}-${r.id}`, source: r.parentRoleId, target: r.id });
    } else {
      const auto = treeLayout(data.people.map((x) => ({ id: x.userId, parentId: x.reportsToUserId })), PERSON_SIZE);
      for (const x of data.people) {
        const role = x.roleId ? roleById.get(x.roleId) ?? null : null;
        const hit = !q || x.displayName.toLowerCase().includes(q) || x.email.toLowerCase().includes(q) || (role?.name.toLowerCase().includes(q) ?? false);
        nodes.push({ id: x.userId, type: 'person', position: auto.get(x.userId) ?? { x: 0, y: 0 }, draggable: false, deletable: false,
          data: { person: x, role, selected: selectedId === x.userId, dim: !hit } satisfies PersonData });
        if (x.reportsToUserId && personById.has(x.reportsToUserId)) edges.push({ ...edgeBase, id: `e-${x.reportsToUserId}-${x.userId}`, source: x.reportsToUserId, target: x.userId });
      }
    }
    return { nodes, edges };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, view, selectedId, q, showDeleted, canManage, byRole, roleById, personById]);

  // Local copies so dragging / selecting is smooth; they reset whenever the server data changes.
  const [nodes, setNodes] = useState<Node[]>(graph.nodes);
  const [edges, setEdges] = useState<Edge[]>(graph.edges);
  useEffect(() => { setNodes(graph.nodes); }, [graph.nodes]);
  useEffect(() => { setEdges(graph.edges); }, [graph.edges]);
  const onNodesChange = useCallback((c: NodeChange[]) => setNodes((ns) => applyNodeChanges(c, ns)), []);
  const onEdgesChange = useCallback((c: EdgeChange[]) => setEdges((es) => applyEdgeChanges(c, es)), []);

  // ---- viewport
  const pendingFit = useRef(true);
  useEffect(() => { pendingFit.current = true; }, [p.fitSignal, view]);
  useEffect(() => {
    if (!pendingFit.current) return;
    pendingFit.current = false;
    setTimeout(() => { void rf.fitView({ padding: 0.12, duration: 350, minZoom: 0.45, maxZoom: 1 }); }, 90);
  }, [nodes, rf]);
  useEffect(() => {
    if (!p.focusSignal || !q) return;
    const hits = graph.nodes.filter((n) => n.id !== ADMIN_ID && !(n.data as { dim?: boolean }).dim).map((n) => ({ id: n.id }));
    if (hits.length) void rf.fitView({ nodes: hits, padding: 0.4, duration: 400, maxZoom: 1.1 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.focusSignal]);

  // ---- connections: source = the one being reported to, target = the one who reports
  const setParent = useCallback((childId: string, parentId: string | null) => {
    if (view === 'roles') {
      const child = roleById.get(childId); if (!child || child.parentRoleId === parentId) return;
      const before = child.parentRoleId; const parent = parentId ? roleById.get(parentId) : null;
      void actions.moveRole(childId, parentId).then((ok) => {
        if (ok) toast(parent ? `“${child.name}” now reports to “${parent.name}”.` : `“${child.name}” is now a top-level role.`, 'success', { label: 'Undo', onClick: () => { void actions.moveRole(childId, before); } });
      });
    } else {
      const child = personById.get(childId); if (!child || child.reportsToUserId === parentId) return;
      const before = child.reportsToUserId; const boss = parentId ? personById.get(parentId) : null;
      void actions.reportsTo(childId, parentId).then((ok) => {
        if (ok) toast(boss ? `${child.displayName} now reports to ${boss.displayName}.` : `${child.displayName} no longer reports to anyone.`, 'success', { label: 'Undo', onClick: () => { void actions.reportsTo(childId, before); } });
      });
    }
  }, [view, roleById, personById, actions]);

  const isValid = useCallback((c: Connection | Edge) => {
    if (!c.source || !c.target || c.source === c.target || c.source === ADMIN_ID || c.target === ADMIN_ID) return false;
    if (view === 'roles') return !subtreeIds(c.target, data.roles).has(c.source) && !roleById.get(c.source)?.isDeleted && !roleById.get(c.target)?.isDeleted;
    return !wouldLoopPeople(c.target, c.source, data);
  }, [view, data, roleById]);

  const onConnect = useCallback((c: Connection) => { if (c.source && c.target) setParent(c.target, c.source); }, [setParent]);
  const onEdgesDelete = useCallback((es: Edge[]) => { for (const e of es) setParent(e.target, null); }, [setParent]);

  // Remove-button on a selected edge (edges are rebuilt per render so the callback stays current).
  const edgesWithActions = useMemo(() => edges.map((e) => ({ ...e, data: { onDelete: () => setParent(e.target, null) } })), [edges, setParent]);

  const onNodeDragStop = useCallback((_: unknown, node: Node) => {
    if (view !== 'roles' || node.type !== 'role') return;
    void actions.savePositions([{ id: node.id, x: Math.round(node.position.x), y: Math.round(node.position.y) }]);
  }, [view, actions]);

  return (
    <ReactFlow
      nodes={nodes} edges={edgesWithActions} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
      onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect} onEdgesDelete={onEdgesDelete} onNodeDragStop={onNodeDragStop}
      onNodeClick={(_, n) => { if (n.id !== ADMIN_ID) p.onSelect(n.id); }} onPaneClick={() => p.onSelect(null)}
      isValidConnection={isValid} nodesDraggable={canManage && view === 'roles'} nodesConnectable={canManage}
      elementsSelectable edgesFocusable={canManage} deleteKeyCode={canManage ? ['Backspace', 'Delete'] : null}
      connectionLineType={ConnectionLineType.SmoothStep} connectionLineStyle={{ stroke: '#8b5cf6', strokeWidth: 2 }}
      fitView fitViewOptions={{ padding: 0.12, minZoom: 0.45, maxZoom: 1 }} minZoom={0.15} maxZoom={1.6} colorMode={theme}
      className="org-flow" aria-label="Organization chart"
    >
      <Background variant={BackgroundVariant.Dots} gap={22} size={1.4} />
      <Controls position="bottom-left" showInteractive={false} />
      <MiniMap position="bottom-right" pannable zoomable ariaLabel="Chart overview"
        nodeColor={(n) => (n.type === 'role' ? (n.data as RoleData).role.color : n.type === 'person' ? ((n.data as PersonData).role?.color ?? '#94a3b8') : '#7c3aed')} />
    </ReactFlow>
  );
}

export function OrgCanvas(props: OrgCanvasProps) {
  return <ReactFlowProvider><Canvas {...props} /></ReactFlowProvider>;
}
