import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  addEdge, getNodesBounds, getViewportForBounds, ReactFlowProvider, useEdgesState, useNodesState, useReactFlow,
  type Connection, type OnSelectionChangeParams,
} from '@xyflow/react';
import { toPng, toSvg } from 'html-to-image';
import { ApiError } from '../../../../api/client';
import { docTrackerApi } from '../../../../api/endpoints';
import { Icon } from '../../../../components/Icon';
import { confirmDialog, toast } from '../../../../stores/ui';
import { ARCH_ICONS, CATEGORIES, SWATCHES, iconByKey } from './archIcons';
import { ArchCanvas, CTYPES, edgeFor, fromFlow, IconGlyph, toFlow, type ArchData, type ArchLevel, type ArchEdgeData, type ArchFlowEdge, type ArchFlowNode, type ArchNodeData } from './ArchCanvas';
import { TEMPLATES } from './archTemplates';
import { capacityOf, fmtSeconds, simulate as runSim, type SimResult } from './archSim';
import './arch.css';

/**
 * Boxes from the assistant with a C4 level each: a new one it left without a level goes on the tab the person is on (boxes that were
 * already there keep theirs, or none). Returns the level most of the
 * new boxes (ids not in `before`) are on, so the studio can switch to it.
 */
export function withLevels(data: ArchData, current: ArchLevel, before: Set<string>): { data: ArchData; level: ArchLevel | null } {
  const nodes = data.nodes.map((n) => (n.level || n.kind === 'text' || before.has(n.id) ? n : { ...n, level: current }));
  const count = new Map<ArchLevel, number>();
  for (const n of nodes) if (!before.has(n.id) && n.level) count.set(n.level, (count.get(n.level) ?? 0) + 1);
  const top = [...count.entries()].sort((a, b) => b[1] - a[1] || (a[0] === current ? -1 : b[0] === current ? 1 : 0))[0];
  return { data: { ...data, nodes }, level: top ? top[0] : null };
}

let seq = 0;
const newId = (p: string) => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`;
const DRAG_TYPE = 'application/x-arch-item';
type PaletteItem = { kind: ArchNodeData['kind']; icon?: string; shape?: string; label: string; ctype?: string };
const LEVELS: { key: ArchLevel; label: string }[] = [{ key: 'context', label: 'Context' }, { key: 'containers', label: 'Containers' }, { key: 'components', label: 'Components' }, { key: 'deployment', label: 'Deployment' }];
const C4_PALETTE: { group: string; items: PaletteItem[] }[] = [
  { group: 'People & systems', items: [{ kind: 'icon', ctype: 'person', icon: 'user', label: 'Person' }, { kind: 'icon', ctype: 'external', icon: 'partner', label: 'External system' }] },
  { group: 'Containers', items: [
    { kind: 'icon', ctype: 'web', icon: 'web', label: 'Web app' }, { kind: 'icon', ctype: 'api', icon: 'api', label: 'API service' }, { kind: 'icon', ctype: 'queue', icon: 'queue', label: 'Queue' },
    { kind: 'icon', ctype: 'db', icon: 'database', label: 'Database' }, { kind: 'icon', ctype: 'cache', icon: 'cache', label: 'Cache' }] },
  { group: 'Boundaries', items: [{ kind: 'frame', ctype: 'zone', label: 'Network zone' }, { kind: 'frame', ctype: 'group', label: 'Group' }] },
];
const MULTS = [1, 3, 10];

/**
 * Architecture Studio: draw a system on a canvas - drag components from the library, join them with arrows (drag from a dot on a box's
 * edge), group them in frames, label everything, and style lines (dashed, animated, two-way). Undo/redo, tidy up, templates, and export to
 * PNG, SVG or JSON. "Done" hands the diagram back to the caller, which saves it.
 */
export function ArchStudio(props: { title: string; data: ArchData; onDone: (data: ArchData, title: string) => void; onClose: () => void; context?: string[]; onDraft?: (data: ArchData, title: string) => void; shareUrl?: string }) {
  return createPortal(<ReactFlowProvider><Studio {...props} /></ReactFlowProvider>, document.body);
}

function Studio({ title: initialTitle, data, onDone, onClose, context, onDraft, shareUrl }: { title: string; data: ArchData; onDone: (data: ArchData, title: string) => void; onClose: () => void; context?: string[]; onDraft?: (data: ArchData, title: string) => void; shareUrl?: string }) {
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
  // Keeps the work in progress outside this component, so a layout change that remounts the page (desktop ↔ phone) reopens it as it was.
  useEffect(() => { onDraft?.(fromFlow(nodes, edges), title); }, [nodes, edges, title, onDraft]);
  const done = () => onDone(fromFlow(flow.getNodes(), flow.getEdges()), title.trim() || 'Architecture');

  // ✦ Describe it: the assistant draws the system, or changes the current one, from a sentence. One undo step brings the old one back.
  const [ask, setAsk] = useState('');
  const [drawing, setDrawing] = useState(false);
  const draw = async () => {
    const prompt = ask.trim(); if (!prompt || drawing) return;
    setDrawing(true);
    try {
      const cur = fromFlow(flow.getNodes(), flow.getEdges());
      const r = await docTrackerApi.aiDiagram(prompt, cur.nodes.length ? cur : undefined, context, level);
      // The assistant sets each box's C4 level, type and tech; a box it left without a level goes on this tab. Then show the level most new boxes are on.
      const drawn = withLevels(r.data as unknown as ArchData, level, new Set(cur.nodes.map((n) => n.id)));
      const f = toFlow(drawn.data); setNodes(f.nodes); setEdges(f.edges); setSel({});
      if (drawn.level && drawn.level !== level) setLevel(drawn.level);
      window.setTimeout(() => { commit(); flow.fitView({ padding: 0.25, duration: 500 }); }, 30);
      setAsk(''); toast(`${r.summary} Undo with Ctrl+Z.`, 'success');
    } catch (e) { toast(e instanceof ApiError ? e.message : 'The assistant could not draw that.', 'error'); }
    finally { setDrawing(false); }
  };

  // C4 level tabs: a box with no level (older diagrams) shows on every tab; new boxes belong to the tab they were drawn on.
  const [level, setLevel] = useState<ArchLevel>('containers');
  const visible = (n: ArchFlowNode) => !n.data.level || n.data.level === level;

  // ▶ Simulate: load at 1×/3×/10× traffic, from the arrows' throughput against each box's capacity × replicas. Nothing is saved.
  const [simMult, setSimMult] = useState<number | null>(null);
  const sim: SimResult | null = useMemo(() => (simMult ? runSim(fromFlow(nodes, edges), simMult) : null), [simMult, nodes, edges]);
  const simulate = () => {
    if (simMult) { setSimMult(null); return; }
    if (!flow.getEdges().length) { toast('Draw some arrows first.', 'info'); return; }
    setSimMult(3);
  };
  const shownNodes = useMemo(() => nodes.map((n) => {
    const hidden = !visible(n); const r = sim?.nodes.get(n.id);
    return hidden === !!n.hidden && !r ? n : { ...n, hidden, data: r ? { ...n.data, load: { pct: r.pct, hot: sim?.bottleneck?.id === n.id } } : n.data };
  }), [nodes, level, sim]);   // eslint-disable-line react-hooks/exhaustive-deps
  const shownEdges = useMemo(() => {
    const show = new Set(shownNodes.filter((n) => !n.hidden).map((n) => n.id));
    return edges.map((e) => {
      const hidden = !show.has(e.source) || !show.has(e.target);
      const className = sim ? (sim.hotEdges.has(e.id) ? 'sim-hot' : 'sim-flow') : undefined;
      return hidden === !!e.hidden && className === e.className ? e : { ...e, hidden, className };
    });
  }, [edges, shownNodes, sim]);
  const applyFix = () => {
    const b = sim?.bottleneck; const fix = sim?.fix; if (!b || !fix) return;
    const target = flow.getNode(b.id); if (!target) return;
    if (fix.kind === 'replicas') {
      const r = Math.max(1, target.data.replicas ?? 1); patchNode(b.id, { replicas: Math.min(1000, Math.ceil((r * b.pct) / 75)) });
      window.setTimeout(commit, 0); return;
    }
    const ctype = fix.kind === 'queue' ? 'queue' : 'cache'; const ct = CTYPES[ctype];
    const id = newId('n');
    const n: ArchNodeData = { id, kind: 'icon', ctype, icon: ct.icon, level: target.data.level, label: fix.kind === 'queue' ? `Retry queue · ${b.name}` : `${b.name} cache`, tech: fix.kind === 'queue' ? 'Durable queue' : 'Redis',
      x: Math.round(target.position.x - 230), y: Math.round(target.position.y + 110), w: 180, h: 72 };
    const [fn] = toFlow({ nodes: [n], edges: [] }).nodes;
    const incoming = flow.getEdges().filter((e) => e.target === b.id);
    const drain = Math.max(1, Math.floor((capacityOf(target.data) * 0.8) / (sim?.mult ?? 1)));
    setNodes((ns) => [...ns, fn]);
    setEdges((es) => [...es.map((e) => (e.target === b.id ? edgeFor({ ...fromFlow([], [e]).edges[0], target: id, targetHandle: undefined }) : e)),
      edgeFor(fix.kind === 'queue' ? { id: newId('e'), source: id, target: b.id, label: 'retries', protocol: 'drain', rps: drain, line: 'dashed' }
        : { id: newId('e'), source: id, target: b.id, label: 'on miss', rps: Math.max(1, Math.round(incoming.reduce((t, e) => t + (e.data?.rps ?? 0), 0) * 0.2)), line: 'solid' })]);
    window.setTimeout(commit, 30);
    toast(fix.kind === 'queue' ? 'Added a retry queue in front of it. Undo with Ctrl+Z.' : 'Added a cache in front of it. Undo with Ctrl+Z.', 'success');
  };
  const share = async () => {
    try { await navigator.clipboard.writeText(shareUrl ?? window.location.href); toast(shareUrl ? 'Link copied. It opens this diagram for people with access to the project.' : 'Link copied. Save the diagram first to link straight to it.', 'success'); }
    catch { toast('Could not copy the link.', 'error'); }
  };

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
    const size = item.ctype && item.kind !== 'frame' ? { w: 180, h: 72 } : item.kind === 'frame' ? { w: 360, h: 240 } : item.kind === 'text' ? { w: 160, h: 32 } : item.kind === 'shape' ? { w: 150, h: 70 } : { w: 160, h: 64 };
    const n: ArchNodeData = { id: newId('n'), kind: item.kind, label: item.label, x: pos.x - size.w / 2, y: pos.y - size.h / 2, ...size, icon: item.icon, shape: item.shape, level, ...(item.ctype ? { ctype: item.ctype } : {}) };
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
        <span className="arch-brand"><Icon name="layers" size={16} /> <span className="arch-wide">Architecture Studio</span></span>
        <div className="arch-levels" role="tablist" aria-label="C4 level">{LEVELS.map((l) => <button key={l.key} type="button" role="tab" aria-selected={level === l.key} className={level === l.key ? 'on' : ''} onClick={() => { setLevel(l.key); setSel({}); }}>{l.label}</button>)}</div>
        <input className="arch-title" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Diagram title" maxLength={120} />
        <div className="arch-top-actions">
          <select className="arch-select" aria-label="Start from a template" value="" onChange={(e) => void applyTemplate(e.target.value)}>
            <option value="">Templates…</option>{TEMPLATES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
          </select>
          <button type="button" className="arch-ibtn" onClick={undo} disabled={past.current.length < 2} title="Undo (Ctrl+Z)" aria-label="Undo"><Icon name="undo" size={15} /></button>
          <button type="button" className="arch-ibtn" onClick={redo} disabled={future.current.length === 0} title="Redo (Ctrl+Shift+Z)" aria-label="Redo"><Icon name="undo" size={15} style={{ transform: 'scaleX(-1)' }} /></button>
          <button type="button" className="arch-btn" onClick={tidy} title="Tidy up: arrange the boxes left to right" aria-label="Tidy up"><Icon name="grid" size={14} /> <span className="arch-wide">Tidy up</span></button>
          <button type="button" className={`arch-btn${simMult ? ' primary' : ''}`} onClick={simulate} aria-pressed={!!simMult} title="Load the design with more traffic and find the bottleneck"><Icon name={simMult ? 'close' : 'play'} size={14} /> {simMult ? 'Stop' : 'Simulate'}</button>
          <button type="button" className="arch-btn" onClick={() => void share()} title="Copy a link to this diagram"><Icon name="link" size={14} /> Share</button>
          <details className="arch-menu">
            <summary className="arch-btn"><Icon name="download" size={14} /> <span className="arch-wide">Export</span></summary>
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
          {!q.trim() && C4_PALETTE.map((g) => (
            <section key={g.group} className="arch-c4pal">
              <h5>{g.group}</h5>
              <div className="arch-plist">{g.items.map((i) => (
                <button key={i.ctype} type="button" className="arch-prow" draggable onDragStart={(e) => dragStart(e, i)} onClick={() => add(i)} title={`Drag onto the canvas, or click to add: ${i.label}`}>
                  <i style={{ background: CTYPES[i.ctype!].color }} />{i.label}
                </button>))}
              </div>
            </section>
          ))}
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
          <ArchCanvas nodes={shownNodes} edges={shownEdges} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect} onSelectionChange={onSelection}
            onNodeDragStop={() => commit()} onNodesDelete={() => window.setTimeout(commit, 0)} onEdgesDelete={() => window.setTimeout(commit, 0)}
            fitView fitViewOptions={{ padding: 0.25, maxZoom: 1.2 }} minimap deleteKeyCode={['Delete', 'Backspace']} />
          {sim && (
            <div className="arch-simcard" role="status" aria-live="polite">
              <div className="arch-simhead"><b>Simulation</b>
                <div className="arch-seg" aria-label="Traffic">{MULTS.map((m) => <button key={m} type="button" className={simMult === m ? 'on' : ''} onClick={() => setSimMult(m)}>{m}×</button>)}</div>
              </div>
              <SimText sim={sim} />
              {sim.bottleneck && sim.fix && <button type="button" className="arch-btn primary" onClick={applyFix}>{sim.fix.label}</button>}
            </div>
          )}
          <form className={`arch-ask${drawing ? ' busy' : ''}`} onSubmit={(e) => { e.preventDefault(); void draw(); }}>
            <span className="arch-orb" aria-hidden="true" />
            <input value={ask} onChange={(e) => setAsk(e.target.value)} disabled={drawing} maxLength={1500} aria-label="Describe the system or a change"
              placeholder={nodes.length ? 'Describe a change — “Add a fraud check between the gateway and payouts”' : 'Describe the system — “Mobile app → gateway → loan service → core banking, with a cache”'} />
            <button type="submit" className="arch-btn primary" disabled={drawing || !ask.trim()}>{drawing ? 'Drawing…' : 'Draw it'}</button>
          </form>
          {nodes.length > 0 && !shownNodes.some((n) => !n.hidden) && <div className="arch-empty"><b>Nothing on the {LEVELS.find((l) => l.key === level)?.label} level yet</b><span>Drag elements from the left; they belong to this level.</span></div>}
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
          {sel.node ? <NodeInspector n={sel.node} all={nodes} edges={edges} sim={sim} onFix={applyFix} onChange={(d) => patchNode(sel.node!.id, d)} onDelete={remove} onDuplicate={duplicate} />
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

function SimText({ sim }: { sim: SimResult }) {
  if (sim.noThroughput) return <p>Add throughput to the arrows (select one, set requests per second) to see where load builds up.</p>;
  if (sim.bottleneck) return <p>At {sim.mult}× traffic <b>{sim.bottleneck.name}</b> becomes the bottleneck ({sim.bottleneck.pct}% of capacity) — p95 rises to ~{fmtSeconds(sim.bottleneck.p95)}.</p>;
  return <p>At {sim.mult}× traffic everything holds.{sim.busiest ? <> The busiest is <b>{sim.busiest.name}</b> at {sim.busiest.pct}% (p95 ~{fmtSeconds(sim.busiest.p95)}).</> : null}</p>;
}

function NodeInspector({ n, all, edges, sim, onFix, onChange, onDelete, onDuplicate }: { n: ArchFlowNode; all: ArchFlowNode[]; edges: ArchFlowEdge[]; sim: SimResult | null; onFix: () => void; onChange: (d: Partial<ArchFlowNode['data']>) => void; onDelete: () => void; onDuplicate: () => void }) {
  const kind = n.type ?? 'icon';
  const ct = n.data.ctype ? CTYPES[n.data.ctype] : undefined;
  const current = n.data.color ?? ct?.color ?? iconByKey.get(n.data.icon ?? '')?.color;
  const name = (id: string) => all.find((x) => x.id === id)?.data.label || 'Untitled';
  const ins = [...new Set(edges.filter((e) => e.target === n.id).map((e) => name(e.source)))];
  const outs = [...new Set(edges.filter((e) => e.source === n.id).map((e) => name(e.target)))];
  const r = sim?.nodes.get(n.id);
  const boxy = kind === 'icon' || kind === 'shape';
  return (
    <div className="arch-insp">
      <div className="arch-insp-head">
        <span className="arch-insp-glyph" style={{ background: current }}><IconGlyph icon={ct?.icon ?? n.data.icon} size={16} color="#fff" /></span>
        <div><b>{n.data.label || ct?.name || 'Untitled'}</b>
          <small>{ct ? `${ct.group}${ct.group === 'Container' ? ` · ${ct.name}` : ''}` : kind === 'frame' ? 'Group' : kind === 'text' ? 'Text' : kind === 'shape' ? 'Shape' : iconByKey.get(n.data.icon ?? '')?.label ?? 'Component'}</small></div>
      </div>
      <label>Name<textarea rows={2} value={n.data.label} onChange={(e) => onChange({ label: e.target.value })} autoFocus /></label>
      {kind !== 'text' && (
        <label>Type<select className="arch-select" value={n.data.ctype ?? ''} onChange={(e) => onChange({ ctype: e.target.value || undefined })}>
          <option value="">Plain {kind === 'frame' ? 'group' : 'box'}</option>
          {Object.entries(CTYPES).filter(([, c]) => (kind === 'frame') === (c.group === 'Boundary')).map(([k, c]) => <option key={k} value={k}>{c.name}</option>)}
        </select></label>
      )}
      <label>Level<select className="arch-select" value={n.data.level ?? ''} onChange={(e) => onChange({ level: (e.target.value || undefined) as ArchLevel | undefined })}>
        <option value="">Every level</option>{LEVELS.map((l) => <option key={l.key} value={l.key}>{l.label}</option>)}
      </select></label>
      {boxy && (
        <>
          <div className="arch-k">Details</div>
          <div className="arch-kv">
            <label>Tech<input value={n.data.tech ?? ''} onChange={(e) => onChange({ tech: e.target.value.slice(0, 120) || undefined })} placeholder=".NET 9, gRPC" /></label>
            <label>Owner<input value={n.data.owner ?? ''} onChange={(e) => onChange({ owner: e.target.value.slice(0, 80) || undefined })} placeholder="Team" /></label>
            <label>Repo<input value={n.data.repo ?? ''} onChange={(e) => onChange({ repo: e.target.value.slice(0, 200) || undefined })} placeholder="repository name or URL" /></label>
            <label>Runs on<input value={n.data.runsOn ?? ''} onChange={(e) => onChange({ runsOn: e.target.value.slice(0, 120) || undefined })} placeholder="k8s · 3 pods" /></label>
            <label>Replicas<input type="number" min={1} max={1000} value={n.data.replicas ?? ''} onChange={(e) => onChange({ replicas: e.target.value ? Math.min(1000, Math.max(1, Math.round(+e.target.value))) : undefined })} placeholder="1" /></label>
            <label>Capacity (req/s each)<input type="number" min={0} value={n.data.capacity ?? ''} onChange={(e) => onChange({ capacity: e.target.value ? Math.max(0, +e.target.value) : undefined })} placeholder={ct && Number.isFinite(ct.cap) ? String(ct.cap) : '300'} /></label>
          </div>
          <div className="arch-k">Connections</div>
          <div className="arch-conn"><span>In</span><b>{ins.length ? ins.join(', ') : '—'}</b></div>
          <div className="arch-conn"><span>Out</span><b>{outs.length ? outs.join(', ') : '—'}</b></div>
        </>
      )}
      {sim && boxy && (
        <>
          <div className="arch-k">Simulation</div>
          <div className="arch-simnote">
            {r && r.load > 0 ? <p>At {sim.mult}× traffic: {r.load} req/s of {Number.isFinite(r.cap) ? `${Math.round(r.cap)}` : '∞'} ({r.pct}%), p95 ~{fmtSeconds(r.p95)}.</p> : <p>No traffic reaches this box.</p>}
            <SimText sim={sim} />
            {sim.bottleneck && sim.fix && <button type="button" className="arch-btn primary" onClick={onFix}>{sim.fix.label}</button>}
          </div>
        </>
      )}
      {kind === 'shape' && (
        <label>Shape<select className="arch-select" value={n.data.shape ?? 'rounded'} onChange={(e) => onChange({ shape: e.target.value })}>
          <option value="rounded">Rounded box</option><option value="rect">Box</option><option value="ellipse">Ellipse</option><option value="diamond">Decision</option><option value="cylinder">Store</option>
        </select></label>
      )}
      <div className="arch-field">Colour
        <div className="arch-swatches">{SWATCHES.map((c) => <button key={c} type="button" className={current === c ? 'on' : ''} style={{ background: c }} aria-label={`Colour ${c}`} onClick={() => onChange({ color: c })} />)}</div>
      </div>
      {kind !== 'text' && <label>Notes<textarea rows={3} value={n.data.notes ?? ''} onChange={(e) => onChange({ notes: e.target.value })} placeholder="What it does, version, URL…" /></label>}
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
      <label>Label<input value={e.data?.label ?? (typeof e.label === 'string' ? e.label : '')} onChange={(ev) => onChange({ label: ev.target.value })} placeholder="e.g. Uses, publishes, GET /balance" autoFocus /></label>
      <label>Protocol<input value={e.data?.protocol ?? ''} onChange={(ev) => onChange({ protocol: ev.target.value.slice(0, 40) || undefined })} placeholder="HTTPS, REST, gRPC, SQL, Kafka" list="arch-protocols" /></label>
      <datalist id="arch-protocols">{['HTTPS', 'REST', 'gRPC', 'SQL', 'Kafka', 'AMQP', 'SOAP', 'WebSocket', 'SFTP'].map((p) => <option key={p} value={p} />)}</datalist>
      <label>Throughput (requests/s)<input type="number" min={0} value={e.data?.rps ?? ''} onChange={(ev) => onChange({ rps: ev.target.value ? Math.max(0, Math.round(+ev.target.value)) : undefined })} placeholder="e.g. 120" /></label>
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
