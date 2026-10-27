import { memo, type CSSProperties } from 'react';
import {
  Background, BackgroundVariant, ConnectionMode, Controls, Handle, MarkerType, MiniMap, NodeResizer, Position, ReactFlow,
  type Edge, type Node, type NodeProps, type ReactFlowProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { iconByKey } from './archIcons';

/** What is stored in the document: plain positions and labels (the server rebuilds it from these fields only). */
export interface ArchNodeData { id: string; kind: 'icon' | 'shape' | 'text' | 'frame'; label: string; x: number; y: number; w: number; h: number; icon?: string; shape?: string; color?: string; notes?: string }
export interface ArchEdgeData { id: string; source: string; target: string; label: string; line: 'solid' | 'dashed' | 'dotted'; animated?: boolean; both?: boolean; sourceHandle?: string; targetHandle?: string; color?: string }
export interface ArchData { nodes: ArchNodeData[]; edges: ArchEdgeData[] }
export const EMPTY: ArchData = { nodes: [], edges: [] };

type NData = { label: string; icon?: string; shape?: string; color?: string; notes?: string; readOnly?: boolean };
export type ArchFlowNode = Node<NData>;
export type ArchFlowEdge = Edge<{ line: ArchEdgeData['line']; both?: boolean; color?: string }>;

const DASH: Record<string, string | undefined> = { solid: undefined, dashed: '7 5', dotted: '2 4' };

export function toFlow(d: ArchData, readOnly = false): { nodes: ArchFlowNode[]; edges: ArchFlowEdge[] } {
  return {
    nodes: (d.nodes ?? []).map((n) => ({
      id: n.id, type: n.kind, position: { x: n.x, y: n.y }, width: n.w, height: n.h, zIndex: n.kind === 'frame' ? -1 : 0,
      data: { label: n.label, icon: n.icon, shape: n.shape, color: n.color, notes: n.notes, readOnly }, draggable: !readOnly, connectable: !readOnly, selectable: !readOnly,
    })),
    edges: (d.edges ?? []).map((e) => edgeFor(e)),
  };
}

export function edgeFor(e: ArchEdgeData): ArchFlowEdge {
  const color = e.color ?? 'var(--arch-edge, #7c8aa5)';
  return {
    id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle, targetHandle: e.targetHandle, label: e.label || undefined, type: 'smoothstep',
    animated: !!e.animated, data: { line: e.line, both: e.both, color: e.color },
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
      ...(n.data.icon ? { icon: n.data.icon } : {}), ...(n.data.shape ? { shape: n.data.shape } : {}), ...(n.data.color ? { color: n.data.color } : {}), ...(n.data.notes ? { notes: n.data.notes } : {}),
    })),
    edges: edges.map((e) => ({
      id: e.id, source: e.source, target: e.target, label: typeof e.label === 'string' ? e.label : '', line: e.data?.line ?? 'solid',
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
  const color = data.color ?? iconByKey.get(data.icon ?? '')?.color ?? '#5c7cfa';
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
  const color = data.color ?? '#5c7cfa';
  return (
    <div className={`arch-frame${selected ? ' sel' : ''}`} style={{ '--c': color } as CSSProperties}>
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
