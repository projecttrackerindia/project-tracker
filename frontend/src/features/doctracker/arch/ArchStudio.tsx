import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  addEdge, getNodesBounds, getViewportForBounds, ReactFlowProvider, useEdgesState, useNodesState, useReactFlow,
  type Connection, type OnSelectionChangeParams,
} from '@xyflow/react';
import { toPng, toSvg } from 'html-to-image';
import { Icon } from '../../../components/Icon';
import { confirmDialog, toast } from '../../../stores/ui';
import { ARCH_ICONS, CATEGORIES, SWATCHES, iconByKey } from './archIcons';
import { ArchCanvas, edgeFor, fromFlow, IconGlyph, toFlow, type ArchData, type ArchEdgeData, type ArchFlowEdge, type ArchFlowNode, type ArchNodeData } from './ArchCanvas';
import { TEMPLATES } from './archTemplates';
import './arch.css';

let seq = 0;
const newId = (p: string) => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`;
const DRAG_TYPE = 'application/x-arch-item';
type PaletteItem = { kind: ArchNodeData['kind']; icon?: string; shape?: string; label: string };

/**
 * Architecture Studio: draw a system on a canvas - drag components from the library, join them with arrows (drag from a dot on a box's
 * edge), group them in frames, label everything, and style lines (dashed, animated, two-way). Undo/redo, tidy up, templates, and export to
 * PNG, SVG or JSON. "Done" hands the diagram back to the caller, which saves it.
 */
export function ArchStudio(props: { title: string; data: ArchData; onDone: (data: ArchData, title: string) => void; onClose: () => void }) {
  return createPortal(<ReactFlowProvider><Studio {...props} /></ReactFlowProvider>, document.body);
}

function Studio({ title: initialTitle, data, onDone, onClose }: { title: string; data: ArchData; onDone: (data: ArchData, title: string) => void; onClose: () => void }) {
  const start = useMemo(() => toFlow(data), [data]);
  const [nodes, setNodes, onNodesChange] = useNodesState<ArchFlowNode>(start.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<ArchFlowEdge>(start.edges);
  const [title, setTitle] = useState(initialTitle || 'Architecture');
  const [sel, setSel] = useState<{ node?: ArchFlowNode; edge?: ArchFlowEdge }>({});
  const [q, setQ] = useState('');
  const flow = useReactFlow<ArchFlowNode, ArchFlowEdge>();
  const wrap = useRef<HTMLDivElement>(null);

  // History: a snapshot after each finished change (drop, connect, drag end, delete, edit pause). Ctrl+Z / Ctrl+Shift+Z.
  const past = useRef<string[]>([JSON.stringify(fromFlow(start.nodes, start.edges))]);
  const future = useRef<string[]>([]);
  const [, bump] = useState(0);
  const commit = useCallback(() => {
    const snap = JSON.stringify(fromFlow(flow.getNodes(), flow.getEdges()));
    if (snap === past.current[past.current.length - 1]) return;
    past.current.push(snap); if (past.current.length > 80) past.current.shift();
    future.current = []; bump((x) => x + 1);
  }, [flow]);
  const load = (snap: string) => { const f = toFlow(JSON.parse(snap) as ArchData); setNodes(f.nodes); setEdges(f.edges); setSel({}); };
  const undo = useCallback(() => { if (past.current.length < 2) return; future.current.push(past.current.pop()!); load(past.current[past.current.length - 1]); bump((x) => x + 1); }, []);   // eslint-disable-line react-hooks/exhaustive-deps
  const redo = useCallback(() => { const s = future.current.pop(); if (!s) return; past.current.push(s); load(s); bump((x) => x + 1); }, []);   // eslint-disable-line react-hooks/exhaustive-deps
  const editTimer = useRef<number | undefined>(undefined);
  const commitSoon = () => { window.clearTimeout(editTimer.current); editTimer.current = window.setTimeout(commit, 450); };

  const dirty = () => JSON.stringify(fromFlow(flow.getNodes(), flow.getEdges())) !== JSON.stringify(fromFlow(start.nodes, start.edges)) || title !== initialTitle;
  const close = async () => { if (!dirty() || await confirmDialog({ title: 'Leave without keeping the changes?', message: 'Your changes to this diagram will be lost.', confirmText: 'Discard', danger: true })) onClose(); };
  const done = () => onDone(fromFlow(flow.getNodes(), flow.getEdges()), title.trim() || 'Architecture');

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.closest('input, textarea, select');
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y' && !typing) { e.preventDefault(); redo(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd' && !typing) { e.preventDefault(); duplicate(); }
      if (e.key === 'Escape' && !typing) { e.preventDefault(); void close(); }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });

  const add = (item: PaletteItem, at?: { x: number; y: number }) => {
    const pos = at ?? flow.screenToFlowPosition({ x: (wrap.current?.getBoundingClientRect().left ?? 0) + (wrap.current?.clientWidth ?? 800) / 2, y: (wrap.current?.getBoundingClientRect().top ?? 0) + (wrap.current?.clientHeight ?? 600) / 2 });
    const size = item.kind === 'frame' ? { w: 360, h: 240 } : item.kind === 'text' ? { w: 160, h: 32 } : item.kind === 'shape' ? { w: 150, h: 70 } : { w: 160, h: 64 };
    const n: ArchNodeData = { id: newId('n'), kind: item.kind, label: item.label, x: pos.x - size.w / 2, y: pos.y - size.h / 2, ...size, icon: item.icon, shape: item.shape };
    const [fn] = toFlow({ nodes: [n], edges: [] }).nodes;
    setNodes((ns) => [...ns.map((x) => ({ ...x, selected: false })), { ...fn, selected: true }]);
    setSel({ node: fn });
    window.setTimeout(commit, 0);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    const raw = e.dataTransfer.getData(DRAG_TYPE);
    if (!raw) return;
    add(JSON.parse(raw) as PaletteItem, flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }));
  };
  const onConnect = (c: Connection) => {
    setEdges((es) => addEdge(edgeFor({ id: newId('e'), source: c.source, target: c.target, sourceHandle: c.sourceHandle ?? undefined, targetHandle: c.targetHandle ?? undefined, label: '', line: 'solid' }), es));
    window.setTimeout(commit, 0);
  };
  const onSelection = useCallback(({ nodes: ns, edges: es }: OnSelectionChangeParams<ArchFlowNode, ArchFlowEdge>) => setSel(ns.length === 1 && es.length === 0 ? { node: ns[0] } : es.length === 1 && ns.length === 0 ? { edge: es[0] } : {}), []);

  const patchNode = (id: string, d: Partial<ArchFlowNode['data']>) => { setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...d } } : n))); setSel((s) => (s.node?.id === id ? { node: { ...s.node, data: { ...s.node.data, ...d } } } : s)); commitSoon(); };
  const patchEdge = (id: string, d: Partial<ArchEdgeData>) => {
    const cur = flow.getEdges().find((e) => e.id === id); if (!cur) return;
    const next = { ...edgeFor({ ...fromFlow([], [cur]).edges[0], ...d }), selected: true };
    setEdges((es) => es.map((e) => (e.id === id ? next : e))); setSel({ edge: next }); commitSoon();
  };
  const remove = () => {
    if (sel.node) { const id = sel.node.id; setNodes((ns) => ns.filter((n) => n.id !== id)); setEdges((es) => es.filter((e) => e.source !== id && e.target !== id)); }
    if (sel.edge) { const id = sel.edge.id; setEdges((es) => es.filter((e) => e.id !== id)); }
    setSel({}); window.setTimeout(commit, 0);
  };
  function duplicate() {
    const n = sel.node; if (!n) return;
    const copy = { ...n, id: newId('n'), position: { x: n.position.x + 30, y: n.position.y + 30 }, selected: true };
    setNodes((ns) => [...ns.map((x) => ({ ...x, selected: false })), copy]); setSel({ node: copy }); window.setTimeout(commit, 0);
  }

  // Tidy up: arrange connected boxes left to right by how far they are from a starting box; frames and text stay where they are.
  const tidy = () => {
    const ns = flow.getNodes(); const es = flow.getEdges();
    const boxes = ns.filter((n) => n.type === 'icon' || n.type === 'shape');
    const incoming = new Map(boxes.map((b) => [b.id, 0]));
    es.forEach((e) => incoming.set(e.target, (incoming.get(e.target) ?? 0) + 1));
    const layer = new Map<string, number>();
    const queue = boxes.filter((b) => !incoming.get(b.id)).map((b) => b.id);
    if (queue.length === 0 && boxes[0]) queue.push(boxes[0].id);
    queue.forEach((id) => layer.set(id, 0));
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i];
      for (const e of es.filter((x) => x.source === id)) if (!layer.has(e.target) && incoming.has(e.target)) { layer.set(e.target, (layer.get(id) ?? 0) + 1); queue.push(e.target); }
    }
    boxes.forEach((b) => { if (!layer.has(b.id)) layer.set(b.id, 0); });
    const rows = new Map<number, number>();
    setNodes(ns.map((n) => {
      if (!layer.has(n.id)) return n;
      const l = layer.get(n.id)!; const r = rows.get(l) ?? 0; rows.set(l, r + 1);
      return { ...n, position: { x: l * 240, y: r * 120 } };
    }));
    window.setTimeout(() => { flow.fitView({ padding: 0.2, duration: 300 }); commit(); }, 30);
  };

  const applyTemplate = async (key: string) => {
    const t = TEMPLATES.find((x) => x.key === key); if (!t) return;
    if (flow.getNodes().length > 0 && !(await confirmDialog({ title: `Start from "${t.label}"?`, message: 'This replaces what is on the canvas (you can undo).', confirmText: 'Replace', danger: false }))) return;
    const f = toFlow(t.data); setNodes(f.nodes); setEdges(f.edges); setSel({});
    window.setTimeout(() => { flow.fitView({ padding: 0.2 }); commit(); }, 30);
  };

  const exportImage = async (kind: 'png' | 'svg') => {
    const ns = flow.getNodes(); if (!ns.length) { toast('Nothing to export yet.', 'error'); return; }
    const b = getNodesBounds(ns); const w = Math.min(4000, Math.max(800, b.width + 160)); const h = Math.min(4000, Math.max(500, b.height + 160));
    const vp = getViewportForBounds(b, w, h, 0.2, 2, 0.08);
    const el = wrap.current?.querySelector('.react-flow__viewport') as HTMLElement | null; if (!el) return;
    const bg = getComputedStyle(wrap.current!).getPropertyValue('--arch-bg').trim() || '#ffffff';
    const opts = { backgroundColor: bg, width: w, height: h, style: { width: `${w}px`, height: `${h}px`, transform: `translate(${vp.x}px, ${vp.y}px) scale(${vp.zoom})` } };
    try {
      const url = kind === 'png' ? await toPng(el, { ...opts, pixelRatio: 2 }) : await toSvg(el, opts);
      download(url, `${slug(title)}.${kind}`);
    } catch { toast('Could not export the picture.', 'error'); }
  };
  const exportJson = () => {
    const blob = new Blob([JSON.stringify({ projectTrackerDiagram: 1, title, ...fromFlow(flow.getNodes(), flow.getEdges()) }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob); download(url, `${slug(title)}.json`); window.setTimeout(() => URL.revokeObjectURL(url), 2000);
  };
  const importJson = () => {
    const input = document.createElement('input'); input.type = 'file'; input.accept = 'application/json,.json';
    input.onchange = async () => {
      const f = input.files?.[0]; if (!f) return;
      try {
        const j = JSON.parse(await f.text()) as Partial<ArchData> & { title?: string };
        if (!Array.isArray(j.nodes) || !Array.isArray(j.edges)) throw new Error();
        const fl = toFlow({ nodes: j.nodes.slice(0, 300), edges: j.edges.slice(0, 600) }); setNodes(fl.nodes); setEdges(fl.edges); if (j.title) setTitle(j.title);
        window.setTimeout(() => { flow.fitView({ padding: 0.2 }); commit(); }, 30);
      } catch { toast('That file is not a diagram exported from here.', 'error'); }
    };
    input.click();
  };

  const filtered = q.trim() ? ARCH_ICONS.filter((i) => i.label.toLowerCase().includes(q.trim().toLowerCase())) : ARCH_ICONS;
  const dragStart = (e: DragEvent, item: PaletteItem) => { e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(item)); e.dataTransfer.effectAllowed = 'move'; };
  const Tile = ({ item, glyph }: { item: PaletteItem; glyph: ReactNode }) => (
    <button type="button" className="arch-tile-btn" draggable onDragStart={(e) => dragStart(e, item)} onClick={() => add(item)} title={`Drag onto the canvas, or click to add: ${item.label}`}>
      {glyph}<span>{item.label}</span>
    </button>
  );

  return (
    <div className="arch-studio" role="dialog" aria-modal="true" aria-label="Architecture Studio">
      <header className="arch-top">
        <span className="arch-brand"><Icon name="layers" size={16} /> Architecture Studio</span>
        <input className="arch-title" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Diagram title" maxLength={120} />
        <div className="arch-top-actions">
          <select className="arch-select" aria-label="Start from a template" value="" onChange={(e) => void applyTemplate(e.target.value)}>
            <option value="">Templates…</option>{TEMPLATES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
          </select>
          <button type="button" className="arch-ibtn" onClick={undo} disabled={past.current.length < 2} title="Undo (Ctrl+Z)" aria-label="Undo"><Icon name="undo" size={15} /></button>
          <button type="button" className="arch-ibtn" onClick={redo} disabled={future.current.length === 0} title="Redo (Ctrl+Shift+Z)" aria-label="Redo"><Icon name="undo" size={15} style={{ transform: 'scaleX(-1)' }} /></button>
          <button type="button" className="arch-btn" onClick={tidy} title="Arrange the boxes left to right"><Icon name="grid" size={14} /> Tidy up</button>
          <details className="arch-menu">
            <summary className="arch-btn"><Icon name="download" size={14} /> Export</summary>
            <div className="arch-menu-pop">
              <button type="button" onClick={() => void exportImage('png')}>Picture (PNG)</button>
              <button type="button" onClick={() => void exportImage('svg')}>Vector (SVG)</button>
              <button type="button" onClick={exportJson}>Diagram file (JSON)</button>
              <button type="button" onClick={importJson}>Import a diagram file…</button>
            </div>
          </details>
          <button type="button" className="arch-btn ghost" onClick={() => void close()}>Cancel</button>
          <button type="button" className="arch-btn primary" onClick={done}><Icon name="check" size={14} /> Done</button>
        </div>
      </header>
      <div className="arch-body">
        <aside className="arch-palette" aria-label="Components">
          <div className="arch-search"><Icon name="search" size={13} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search components…" aria-label="Search components" /></div>
          {!q.trim() && (
            <section>
              <h5>Shapes & grouping</h5>
              <div className="arch-tiles">
                <Tile item={{ kind: 'frame', label: 'Group' }} glyph={<span className="arch-mini frame" />} />
                <Tile item={{ kind: 'shape', shape: 'rounded', label: 'Box' }} glyph={<span className="arch-mini rounded" />} />
                <Tile item={{ kind: 'shape', shape: 'ellipse', label: 'Ellipse' }} glyph={<span className="arch-mini ellipse" />} />
                <Tile item={{ kind: 'shape', shape: 'diamond', label: 'Decision' }} glyph={<span className="arch-mini diamond" />} />
                <Tile item={{ kind: 'shape', shape: 'cylinder', label: 'Store' }} glyph={<IconGlyph icon="database" size={18} color="var(--arch-text-2)" />} />
                <Tile item={{ kind: 'text', label: 'Text' }} glyph={<span className="arch-mini text">T</span>} />
              </div>
            </section>
          )}
          {CATEGORIES.map((c) => {
            const items = filtered.filter((i) => i.category === c);
            if (!items.length) return null;
            return (
              <section key={c}>
                <h5>{c}</h5>
                <div className="arch-tiles">{items.map((i) => <Tile key={i.key} item={{ kind: 'icon', icon: i.key, label: i.label }} glyph={<IconGlyph icon={i.key} size={20} />} />)}</div>
              </section>
            );
          })}
          {filtered.length === 0 && <p className="arch-muted">No component matches “{q}”.</p>}
        </aside>
        <div className="arch-canvas" ref={wrap} onDrop={onDrop} onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}>
          <ArchCanvas nodes={nodes} edges={edges} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect} onSelectionChange={onSelection}
            onNodeDragStop={() => commit()} onNodesDelete={() => window.setTimeout(commit, 0)} onEdgesDelete={() => window.setTimeout(commit, 0)}
            fitView fitViewOptions={{ padding: 0.25, maxZoom: 1.2 }} minimap deleteKeyCode={['Delete', 'Backspace']} />
          {nodes.length === 0 && (
            <div className="arch-empty">
              <Icon name="layers" size={28} />
              <b>Drag components from the left, or start from a template</b>
              <span>Join boxes by dragging from the dots on their edges. Put related parts in a Group.</span>
              <div>{TEMPLATES.map((t) => <button key={t.key} type="button" className="arch-btn" onClick={() => void applyTemplate(t.key)}>{t.label}</button>)}</div>
            </div>
          )}
        </div>
        <aside className="arch-inspector" aria-label="Properties">
          {sel.node ? <NodeInspector n={sel.node} onChange={(d) => patchNode(sel.node!.id, d)} onDelete={remove} onDuplicate={duplicate} />
            : sel.edge ? <EdgeInspector e={sel.edge} onChange={(d) => patchEdge(sel.edge!.id, d)} onDelete={remove} />
            : (
              <div className="arch-help">
                <b>How it works</b>
                <ul>
                  <li>Drag a component onto the canvas (or click it).</li>
                  <li>Drag from a dot on a box to another box to draw an arrow.</li>
                  <li>Select a box or arrow to name it, colour it or style the line.</li>
                  <li>Ctrl+Z undo · Ctrl+D duplicate · Delete removes · scroll to zoom.</li>
                </ul>
                <p className="arch-muted">{nodes.length} boxes · {edges.length} arrows</p>
              </div>
            )}
        </aside>
      </div>
    </div>
  );
}

function NodeInspector({ n, onChange, onDelete, onDuplicate }: { n: ArchFlowNode; onChange: (d: Partial<ArchFlowNode['data']>) => void; onDelete: () => void; onDuplicate: () => void }) {
  const kind = n.type ?? 'icon';
  const current = n.data.color ?? iconByKey.get(n.data.icon ?? '')?.color;
  return (
    <div className="arch-insp">
      <b>{kind === 'frame' ? 'Group' : kind === 'text' ? 'Text' : kind === 'shape' ? 'Shape' : iconByKey.get(n.data.icon ?? '')?.label ?? 'Component'}</b>
      <label>Label<textarea rows={2} value={n.data.label} onChange={(e) => onChange({ label: e.target.value })} autoFocus /></label>
      {kind === 'shape' && (
        <label>Shape<select className="arch-select" value={n.data.shape ?? 'rounded'} onChange={(e) => onChange({ shape: e.target.value })}>
          <option value="rounded">Rounded box</option><option value="rect">Box</option><option value="ellipse">Ellipse</option><option value="diamond">Decision</option><option value="cylinder">Store</option>
        </select></label>
      )}
      <div className="arch-field">Colour
        <div className="arch-swatches">{SWATCHES.map((c) => <button key={c} type="button" className={current === c ? 'on' : ''} style={{ background: c }} aria-label={`Colour ${c}`} onClick={() => onChange({ color: c })} />)}</div>
      </div>
      {kind !== 'text' && <label>Notes<textarea rows={3} value={n.data.notes ?? ''} onChange={(e) => onChange({ notes: e.target.value })} placeholder="What it does, owner, version, URL…" /></label>}
      <div className="arch-insp-actions">
        <button type="button" className="arch-btn" onClick={onDuplicate}><Icon name="copy" size={13} /> Duplicate</button>
        <button type="button" className="arch-btn danger" onClick={onDelete}><Icon name="trash" size={13} /> Delete</button>
      </div>
    </div>
  );
}

function EdgeInspector({ e, onChange, onDelete }: { e: ArchFlowEdge; onChange: (d: Partial<ArchEdgeData>) => void; onDelete: () => void }) {
  const line = e.data?.line ?? 'solid';
  return (
    <div className="arch-insp">
      <b>Arrow</b>
      <label>Label<input value={typeof e.label === 'string' ? e.label : ''} onChange={(ev) => onChange({ label: ev.target.value })} placeholder="e.g. GET /balance, HTTPS, JMS" autoFocus /></label>
      <div className="arch-field">Line
        <div className="arch-seg">{(['solid', 'dashed', 'dotted'] as const).map((l) => <button key={l} type="button" className={line === l ? 'on' : ''} onClick={() => onChange({ line: l })}>{l}</button>)}</div>
      </div>
      <label className="arch-check"><input type="checkbox" checked={!!e.animated} onChange={(ev) => onChange({ animated: ev.target.checked })} /> Show the flow moving</label>
      <label className="arch-check"><input type="checkbox" checked={!!e.data?.both} onChange={(ev) => onChange({ both: ev.target.checked })} /> Arrows both ways</label>
      <div className="arch-field">Colour
        <div className="arch-swatches">{SWATCHES.map((c) => <button key={c} type="button" className={e.data?.color === c ? 'on' : ''} style={{ background: c }} aria-label={`Colour ${c}`} onClick={() => onChange({ color: c })} />)}</div>
      </div>
      <div className="arch-insp-actions"><button type="button" className="arch-btn danger" onClick={onDelete}><Icon name="trash" size={13} /> Delete arrow</button></div>
    </div>
  );
}

function download(url: string, name: string) { const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); }
const slug = (s: string) => (s.trim() || 'diagram').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'diagram';
