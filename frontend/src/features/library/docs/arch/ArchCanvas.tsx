import { memo, type CSSProperties } from 'react';
import {
  Background, BackgroundVariant, ConnectionMode, Controls, Handle, MarkerType, MiniMap, NodeResizer, Position, ReactFlow,
  type Edge, type Node, type NodeProps, type ReactFlowProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { iconByKey } from './archIcons';

/** What is stored in the document: plain positions and labels (the server rebuilds it from these fields only). */
/** C4 details (all optional, so older diagrams load unchanged): level (which tab shows the box; none = every tab), ctype (person, web, api…), tech, owner, repo, runsOn, replicas, capacity (requests/s one replica handles). */
export type ArchLevel = 'context' | 'containers' | 'components' | 'deployment';
export type ArchMeta = { level?: ArchLevel; ctype?: string; tech?: string; owner?: string; repo?: string; runsOn?: string; replicas?: number; capacity?: number };
export interface ArchNodeData extends ArchMeta { id: string; kind: 'icon' | 'shape' | 'text' | 'frame'; label: string; x: number; y: number; w: number; h: number; icon?: string; shape?: string; color?: string; notes?: string }
export interface ArchEdgeData { id: string; source: string; target: string; label: string; line: 'solid' | 'dashed' | 'dotted'; animated?: boolean; both?: boolean; sourceHandle?: string; targetHandle?: string; color?: string; protocol?: string; rps?: number }
const META_KEYS = ['level', 'ctype', 'tech', 'owner', 'repo', 'runsOn', 'replicas', 'capacity'] as const;

/** C4 element types: the tag shown on the box, its icon and colour, and defaults the load simulation uses (capacity per replica, base latency in ms). */
export const CTYPES: Record<string, { tag: string; name: string; icon: string; color: string; group: string; cap: number; ms: number; level: ArchLevel }> = {
  person: { tag: 'PERSON', name: 'Person', icon: 'user', color: '#5e5ce6', group: 'Person', cap: Infinity, ms: 0, level: 'context' },
  external: { tag: 'EXTERNAL', name: 'External system', icon: 'partner', color: '#8e8e93', group: 'External system', cap: 60, ms: 700, level: 'context' },
  web: { tag: 'WEB', name: 'Web app', icon: 'web', color: '#0a84ff', group: 'Container', cap: 400, ms: 60, level: 'containers' },
  api: { tag: 'API', name: 'API service', icon: 'api', color: '#30d158', group: 'Container', cap: 150, ms: 90, level: 'containers' },
  queue: { tag: 'QUEUE', name: 'Queue', icon: 'queue', color: '#ff9f0a', group: 'Container', cap: 5000, ms: 8, level: 'containers' },
  db: { tag: 'DB', name: 'Database', icon: 'database', color: '#bf5af2', group: 'Container', cap: 600, ms: 15, level: 'containers' },
  cache: { tag: 'CACHE', name: 'Cache', icon: 'cache', color: '#ff375f', group: 'Container', cap: 20000, ms: 2, level: 'containers' },
  zone: { tag: 'ZONE', name: 'Network zone', icon: 'vpn', color: '#35b8c9', group: 'Boundary', cap: Infinity, ms: 0, level: 'containers' },
  group: { tag: 'GROUP', name: 'Group', icon: 'box', color: '#5c7cfa', group: 'Boundary', cap: Infinity, ms: 0, level: 'containers' },
};
/** "REST · 120 rps": what an arrow shows, from its label or protocol plus its throughput. */
export const edgeText = (e: Pick<ArchEdgeData, 'label' | 'protocol' | 'rps'>) => [e.label, e.protocol, e.rps ? `${e.rps} rps` : ''].filter(Boolean).join(' · ');
export interface ArchData { nodes: ArchNodeData[]; edges: ArchEdgeData[] }
export const EMPTY: ArchData = { nodes: [], edges: [] };

type NData = ArchMeta & { label: string; icon?: string; shape?: string; color?: string; notes?: string; readOnly?: boolean; load?: { pct: number; hot: boolean } };
export type ArchFlowNode = Node<NData>;
export type ArchFlowEdge = Edge<{ line: ArchEdgeData['line']; both?: boolean; color?: string; label?: string; protocol?: string; rps?: number }>;
const pickMeta = (m: ArchMeta) => Object.fromEntries(META_KEYS.filter((k) => m[k] !== undefined && m[k] !== '' && m[k] !== null).map((k) => [k, m[k]])) as ArchMeta;

const DASH: Record<string, string | undefined> = { solid: undefined, dashed: '7 5', dotted: '2 4' };

export function toFlow(d: ArchData, readOnly = false): { nodes: ArchFlowNode[]; edges: ArchFlowEdge[] } {
  return {
    nodes: (d.nodes ?? []).map((n) => ({
      id: n.id, type: n.kind, position: { x: n.x, y: n.y }, width: n.w, height: n.h, zIndex: n.kind === 'frame' ? -1 : 0,
      data: { label: n.label, icon: n.icon, shape: n.shape, color: n.color, notes: n.notes, ...pickMeta(n), readOnly }, draggable: !readOnly, connectable: !readOnly, selectable: !readOnly,
    })),
    edges: (d.edges ?? []).map((e) => edgeFor(e)),
  };
}

export function edgeFor(e: ArchEdgeData): ArchFlowEdge {
  const color = e.color ?? 'var(--arch-edge, #7c8aa5)';
  return {
    id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle, targetHandle: e.targetHandle, label: edgeText(e) || undefined, type: 'smoothstep',
    animated: !!e.animated, data: { line: e.line, both: e.both, color: e.color, label: e.label, protocol: e.protocol, rps: e.rps },
    style: { stroke: color, strokeWidth: 1.8, strokeDasharray: DASH[e.line] },
    markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16 },
    markerStart: e.both ? { type: MarkerType.ArrowClosed, color, width: 16, height: 16, orient: 'auto-start-reverse' } : undefined,
    labelStyle: { fontSize: 11.5, fontWeight: 600, fill: 'var(--arch-text, #1f2937)' }, labelBgStyle: { fill: 'var(--arch-label-bg, #fff)' }, labelBgPadding: [6, 3], labelBgBorderRadius: 4,
  };
}

export function fromFlow(nodes: ArchFlowNode[], edges: ArchFlowEdge[]): ArchData {
  return {
    nodes: nodes.map((n) => ({
      id: n.id, kind: (n.type ?? 'icon') as ArchNodeData['kind'], label: n.data.label ?? '', x: Math.round(n.position.x), y: Math.round(n.position.y),
      w: Math.round(n.width ?? n.measured?.width ?? 150), h: Math.round(n.height ?? n.measured?.height ?? 64),
      ...(n.data.icon ? { icon: n.data.icon } : {}), ...(n.data.shape ? { shape: n.data.shape } : {}), ...(n.data.color ? { color: n.data.color } : {}), ...(n.data.notes ? { notes: n.data.notes } : {}), ...pickMeta(n.data),
    })),
    edges: edges.map((e) => ({
      id: e.id, source: e.source, target: e.target, label: e.data?.label ?? (typeof e.label === 'string' ? e.label : ''), line: e.data?.line ?? 'solid',
      ...(e.data?.protocol ? { protocol: e.data.protocol } : {}), ...(e.data?.rps ? { rps: e.data.rps } : {}),
      ...(e.animated ? { animated: true } : {}), ...(e.data?.both ? { both: true } : {}), ...(e.data?.color ? { color: e.data.color } : {}),
      ...(e.sourceHandle ? { sourceHandle: e.sourceHandle } : {}), ...(e.targetHandle ? { targetHandle: e.targetHandle } : {}),
    })),
  };
}

function Handles({ hidden }: { hidden?: boolean }) {
  const cls = `arch-h${hidden ? ' hidden' : ''}`;
  return <>
    <Handle id="t" type="source" position={Position.Top} className={cls} />
    <Handle id="r" type="source" position={Position.Right} className={cls} />
    <Handle id="b" type="source" position={Position.Bottom} className={cls} />
    <Handle id="l" type="source" position={Position.Left} className={cls} />
  </>;
}

export function IconGlyph({ icon, size = 22, color }: { icon?: string; size?: number; color?: string }) {
  const def = icon ? iconByKey.get(icon) : undefined;
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke={color ?? def?.color ?? 'currentColor'} strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden
      dangerouslySetInnerHTML={{ __html: def?.paths ?? '<rect x="4" y="4" width="16" height="16" rx="3"/>' }} />
  );
}

const IconNode = memo(function IconNode({ data, selected }: NodeProps<ArchFlowNode>) {
  const ct = data.ctype ? CTYPES[data.ctype] : undefined;
  const color = data.color ?? ct?.color ?? iconByKey.get(data.icon ?? '')?.color ?? '#5c7cfa';
  if (ct) {
    const sub = [data.tech, data.replicas && data.replicas > 1 ? `${data.replicas} replicas` : ''].filter(Boolean).join(' · ');
    return (
      <div className={`arch-node arch-c4${selected ? ' sel' : ''}${data.load ? (data.load.hot ? ' load-hot' : data.load.pct >= 70 ? ' load-warn' : ' load-ok') : ''}`} style={{ '--c': color } as CSSProperties} title={data.notes || undefined}>
        <NodeResizer isVisible={!!selected && !data.readOnly} minWidth={120} minHeight={52} lineClassName="arch-rs-line" handleClassName="arch-rs-h" />
        <span className="arch-c4-tag">{ct.tag}</span>
        <b className="arch-c4-name">{data.label || ct.name}</b>
        {sub && <small className="arch-c4-tech">{sub}</small>}
        {data.load && <span className="arch-c4-load">{data.load.pct}%</span>}
        <Handles hidden={data.readOnly} />
      </div>
    );
  }
  return (
    <div className={`arch-node arch-icon${selected ? ' sel' : ''}`} style={{ '--c': color } as CSSProperties} title={data.notes || undefined}>
      <NodeResizer isVisible={!!selected && !data.readOnly} minWidth={90} minHeight={48} lineClassName="arch-rs-line" handleClassName="arch-rs-h" />
      <span className="arch-tile"><IconGlyph icon={data.icon} color={color} /></span>
      <span className="arch-label">{data.label || ' '}</span>
      {data.notes && <span className="arch-has-notes" aria-hidden>i</span>}
      <Handles hidden={data.readOnly} />
    </div>
  );
});

const ShapeNode = memo(function ShapeNode({ data, selected }: NodeProps<ArchFlowNode>) {
  const color = data.color ?? '#5c7cfa';
  const shape = data.shape ?? 'rounded';
  return (
    <div className={`arch-node arch-shape s-${shape}${selected ? ' sel' : ''}`} style={{ '--c': color } as CSSProperties} title={data.notes || undefined}>
      <NodeResizer isVisible={!!selected && !data.readOnly} minWidth={60} minHeight={36} lineClassName="arch-rs-line" handleClassName="arch-rs-h" />
      <svg className="arch-shape-bg" viewBox="0 0 100 60" preserveAspectRatio="none" aria-hidden>
        {shape === 'ellipse' ? <ellipse cx="50" cy="30" rx="49" ry="29" />
          : shape === 'diamond' ? <path d="M50 1 99 30 50 59 1 30z" />
          : shape === 'cylinder' ? <><path d="M1 8v44c0 4 22 7 49 7s49-3 49-7V8" /><ellipse cx="50" cy="8" rx="49" ry="7" /></>
          : <rect x="1" y="1" width="98" height="58" rx={shape === 'rect' ? 2 : 10} />}
      </svg>
      <span className="arch-label">{data.label || ' '}</span>
      <Handles hidden={data.readOnly} />
    </div>
  );
});

const TextNode = memo(function TextNode({ data, selected }: NodeProps<ArchFlowNode>) {
  return (
    <div className={`arch-node arch-text${selected ? ' sel' : ''}`} style={{ color: data.color }}>
      <NodeResizer isVisible={!!selected && !data.readOnly} minWidth={60} minHeight={24} lineClassName="arch-rs-line" handleClassName="arch-rs-h" />
      {data.label || 'Text'}
    </div>
  );
});

const FrameNode = memo(function FrameNode({ data, selected }: NodeProps<ArchFlowNode>) {
  const color = data.color ?? (data.ctype ? CTYPES[data.ctype]?.color : undefined) ?? '#5c7cfa';
  return (
    <div className={`arch-frame${data.ctype === 'zone' ? ' zone' : ''}${selected ? ' sel' : ''}`} style={{ '--c': color } as CSSProperties}>
      <NodeResizer isVisible={!!selected && !data.readOnly} minWidth={160} minHeight={100} lineClassName="arch-rs-line" handleClassName="arch-rs-h" />
      <span className="arch-frame-title">{data.label || 'Group'}</span>
    </div>
  );
});

export const NODE_TYPES = { icon: IconNode, shape: ShapeNode, text: TextNode, frame: FrameNode };

/** The canvas, shared by the read-only preview in the document and the editing Studio. */
export function ArchCanvas({ readOnly, minimap, ...props }: Omit<ReactFlowProps<ArchFlowNode, ArchFlowEdge>, 'nodeTypes'> & { readOnly?: boolean; minimap?: boolean }) {
  return (
    <ReactFlow<ArchFlowNode, ArchFlowEdge> nodeTypes={NODE_TYPES} connectionMode={ConnectionMode.Loose} snapToGrid snapGrid={[10, 10]} minZoom={0.15} maxZoom={2.5}
      proOptions={{ hideAttribution: true }} nodesDraggable={!readOnly} nodesConnectable={!readOnly} elementsSelectable={!readOnly}
      zoomOnScroll={!readOnly} panOnScroll={false} preventScrolling={!readOnly} {...props}>
      <Background variant={BackgroundVariant.Dots} gap={18} size={1.2} />
      {!readOnly && <Controls showInteractive={false} />}
      {minimap && <MiniMap pannable zoomable nodeStrokeWidth={2} />}
    </ReactFlow>
  );
}
