import { CTYPES, type ArchData, type ArchNodeData } from './ArchCanvas';

export interface SimNode { id: string; name: string; load: number; cap: number; pct: number; p95: number }
export interface SimResult { mult: number; nodes: Map<string, SimNode>; bottleneck?: SimNode; busiest?: SimNode; hotEdges: Set<string>; fix?: { kind: 'queue' | 'cache' | 'replicas'; label: string }; noThroughput: boolean }

/** Requests per second one replica of a box handles: its own figure, or the default for its type. */
export const capacityOf = (n: Pick<ArchNodeData, 'ctype' | 'capacity' | 'replicas'>) => (n.capacity && n.capacity > 0 ? n.capacity : (n.ctype ? CTYPES[n.ctype]?.cap : undefined) ?? 300) * Math.max(1, n.replicas ?? 1);
const baseMs = (n: ArchNodeData) => (n.ctype ? CTYPES[n.ctype]?.ms : undefined) ?? 50;

/**
 * Load model: arrows carry their stated throughput (× the traffic multiplier); an arrow with no figure carries what reached its source.
 * A box's load is the sum of what arrives; its utilisation is load ÷ (capacity × replicas). Latency grows as 1/(1−u), then linearly once past 80%.
 * The bottleneck is the box at or past capacity with the highest utilisation.
 */
export function simulate(d: ArchData, mult: number): SimResult {
  const boxes = d.nodes.filter((n) => n.kind === 'icon' || n.kind === 'shape');
  const byId = new Map(boxes.map((n) => [n.id, n]));
  const edges = d.edges.filter((e) => byId.has(e.source) && byId.has(e.target));
  const load = new Map<string, number>(boxes.map((n) => [n.id, 0]));
  const flow = new Map<string, number>();
  const into = new Set(edges.map((e) => e.target));
  // Entry boxes emit what their outgoing arrows state.
  const queue = boxes.filter((n) => !into.has(n.id)).map((n) => n.id);
  if (!queue.length && boxes[0]) queue.push(boxes[0].id);
  const passes = new Map<string, number>();
  while (queue.length) {
    const id = queue.shift()!;
    const p = (passes.get(id) ?? 0) + 1; passes.set(id, p); if (p > 4) continue;   // cycles settle after a few passes
    const out = edges.filter((e) => e.source === id);
    for (const e of out) {
      const v = e.rps ? e.rps * mult : (load.get(id) ?? 0) / Math.max(1, out.filter((o) => !o.rps).length);
      const prev = flow.get(e.id) ?? 0; if (Math.abs(prev - v) < 0.01 && p > 1) continue;
      flow.set(e.id, v); load.set(e.target, (load.get(e.target) ?? 0) - prev + v);
      queue.push(e.target);
    }
  }
  const nodes = new Map<string, SimNode>();
  for (const n of boxes) {
    const l = load.get(n.id) ?? 0; const cap = capacityOf(n); const u = Number.isFinite(cap) ? l / cap : 0;
    const p95 = baseMs(n) * (u < 0.8 ? 1 / (1 - u) : 5 + (u - 0.8) * 3);
    nodes.set(n.id, { id: n.id, name: n.label || 'Untitled', load: Math.round(l), cap, pct: Math.round(u * 100), p95: Math.round(p95) });
  }
  const ranked = [...nodes.values()].filter((n) => n.load > 0 && Number.isFinite(n.cap)).sort((a, b) => b.pct - a.pct);
  const busiest = ranked[0];
  const bottleneck = busiest && busiest.pct >= 100 ? busiest : undefined;
  const hotEdges = new Set(bottleneck ? edges.filter((e) => e.target === bottleneck.id).map((e) => e.id) : []);
  let fix: SimResult['fix'];
  if (bottleneck) {
    const t = byId.get(bottleneck.id)?.ctype;
    fix = t === 'db' ? { kind: 'cache', label: 'Add a cache?' } : t === 'external' || t === 'queue' || !t ? { kind: 'queue', label: 'Add retry queue?' } : { kind: 'replicas', label: 'Add replicas?' };
  }
  return { mult, nodes, bottleneck, busiest, hotEdges, fix, noThroughput: !edges.some((e) => e.rps) };
}

export const fmtSeconds = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);
