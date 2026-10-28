import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useMutation } from '@tanstack/react-query';
import { ReactFlowProvider } from '@xyflow/react';
import { useSearchParams } from 'react-router-dom';
import { ApiError } from '../../../api/client';
import { docTrackerApi } from '../../../api/endpoints';
import type { DtDiagram } from '../../../api/types';
import { Icon } from '../../../components/Icon';
import { ErrorState, PageLoader } from '../../../components/ui';
import { timeAgo } from '../../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../../lib/hooks';
import { useWorkspaceId } from '../../../stores/auth';
import { confirmDialog, toast } from '../../../stores/ui';
import { ArchCanvas, EMPTY, toFlow, type ArchData } from './arch/ArchCanvas';
import { ArchStudio } from './arch/ArchStudio';
import { TEMPLATES } from './arch/archTemplates';
import { plural } from './shared';
import { docsPath } from './nav';
import './arch/arch.css';

const asData = (d: DtDiagram['data']) => (d && Array.isArray(d.nodes) ? (d as unknown as ArchData) : EMPTY);
const newKey = () => `d-${Date.now().toString(36)}`;

function Preview({ data }: { data: ArchData }) {
  const flow = useMemo(() => toFlow(data, true), [data]);
  if (data.nodes.length === 0) return <div className="dx-arch-empty"><Icon name="workflow" size={22} /><span>Empty. Open the studio to draw.</span></div>;
  return <ReactFlowProvider><ArchCanvas readOnly nodes={flow.nodes} edges={flow.edges} fitView fitViewOptions={{ padding: 0.15 }} panOnDrag={false} zoomOnPinch={false} zoomOnDoubleClick={false} /></ReactFlowProvider>;
}

/**
 * A project's architecture: system diagrams and request flows drawn in the studio (components, frames, labelled arrows; start empty or from
 * a template), shown as a gallery to read, with the project's architecture notes under them. Saved together for the project.
 */
/** The diagram being edited, kept across a remount of this page (e.g. the window crossing the phone breakpoint). */
let openStudio: { pid: string; index: number; diagram: DtDiagram } | null = null;

export function Architecture({ projectId, projectName }: { projectId: string | null; projectName: string }) {
  const wid = useWorkspaceId();
  const q = useWsQuery(['documents', 'doctracker', 'architecture', projectId ?? 'general'], () => docTrackerApi.architecture(projectId));
  const [diagrams, setDiagrams] = useState<DtDiagram[] | null>(null);
  const [notes, setNotes] = useState('');
  const pidKey = projectId ?? 'general';
  const [editing, setEditingState] = useState<{ index: number; diagram: DtDiagram } | null>(() => (openStudio?.pid === pidKey ? { index: openStudio.index, diagram: openStudio.diagram } : null));
  const setEditing = (e: { index: number; diagram: DtDiagram } | null) => { openStudio = e && { pid: pidKey, ...e }; setEditingState(e); };
  const onDraft = useCallback((data: ArchData, title: string) => { if (openStudio) openStudio = { ...openStudio, diagram: { ...openStudio.diagram, title, data: data as unknown as DtDiagram['data'] } }; }, []);
  // ?diagram=key opens that one diagram (the link Share copies); focusing one writes it to the address, so the address is always shareable.
  const [params, setParams] = useSearchParams();
  const focus = params.get('diagram');
  const setFocus = (key: string | null) => setParams((p) => { const n = new URLSearchParams(p); if (key) n.set('diagram', key); else n.delete('diagram'); return n; }, { replace: true });
  const [walk, setWalk] = useState<DtDiagram | null>(null);
  // What the project has, for the assistant to use real names when it draws (endpoints and pages).
  const catalog = useWsQuery(['documents', 'doctracker', 'catalog'], docTrackerApi.catalog, { staleTime: 20_000 });
  const context = useMemo(() => {
    const p = catalog.data?.projects.find((x) => (x.id ?? null) === projectId);
    return p ? [...p.endpoints.slice(0, 40).map((e) => `${e.method} ${e.path} — ${e.summary}`), ...p.documents.slice(0, 20).map((d) => `Page: ${d.title}`)] : [];
  }, [catalog.data, projectId]);
  // Designs share the store: kept aside here and sent back unchanged with every save.
  const designs = useMemo(() => (q.data?.diagrams ?? []).filter((d) => d.kind === 'design'), [q.data]);
  useEffect(() => { if (q.data) { setDiagrams(q.data.diagrams.filter((d) => d.kind !== 'design')); setNotes(q.data.notes ?? ''); } }, [q.data]);
  const save = useMutation({
    mutationFn: (b: { diagrams: DtDiagram[]; notes: string }) => docTrackerApi.saveArchitecture(projectId, { diagrams: [...b.diagrams, ...designs], notes: b.notes || null }),
    onSuccess: (r) => { setDiagrams(r.diagrams.filter((d) => d.kind !== 'design')); invalidateWorkspace(wid, 'documents'); toast('Architecture saved.'); },
    onError: (e) => { toast(e instanceof ApiError ? e.message : 'Could not save.', 'error'); if (q.data) setDiagrams(q.data.diagrams.filter((d) => d.kind !== 'design')); },
  });
  if (q.isError) return <ErrorState error={q.error} retry={() => void q.refetch()} />;
  if (q.isLoading || !diagrams) return <PageLoader />;
  const canEdit = !!q.data?.canEdit;
  const commit = (next: DtDiagram[]) => { setDiagrams(next); save.mutate({ diagrams: next, notes }); };
  const add = (kind: DtDiagram['kind'], template?: ArchData) => setEditing({ index: -1, diagram: { key: newKey(), title: kind === 'flow' ? 'Request flow' : 'System architecture', kind, data: (template ?? EMPTY) as unknown as DtDiagram['data'] } });
  const remove = async (i: number) => { if (await confirmDialog({ title: `Delete “${diagrams[i].title}”?`, message: 'The diagram is removed from this project.', confirmText: 'Delete' })) commit(diagrams.filter((_, j) => j !== i)); };
  const notesChanged = notes !== (q.data?.notes ?? '');
  const linked = focus ? diagrams.find((d) => d.key === focus) ?? null : null;
  const shown = linked ? [linked] : diagrams;

  return (
    <div className="dx-arch" data-testid="architecture">
      <header className="dx-hero-p dx-reveal">
        <p className="dx-eyebrow">Architecture</p>
        <h1 className="dx-title">How {projectName} fits together</h1>
        <p className="dx-lede">{diagrams.length ? `${plural(diagrams.length, 'diagram')}${q.data?.updatedAt ? `, saved ${timeAgo(q.data.updatedAt)}${q.data.updatedBy ? ` by ${q.data.updatedBy}` : ''}` : ''}.` : 'Draw the system and how a request flows through it.'}</p>
        {canEdit && diagrams.length < 12 && (
          <div className="dx-row">
            <button type="button" className="dx-btn tint" onClick={() => add('architecture')}><Icon name="plus" size={13} /> System diagram</button>
            <button type="button" className="dx-btn" onClick={() => add('flow', TEMPLATES[0]?.data)}><Icon name="workflow" size={13} /> Request flow</button>
          </div>
        )}
      </header>

      {diagrams.length === 0 ? (
        <div className="dx-arch-blank">
          <Icon name="workflow" size={28} />
          <b>No diagrams yet</b>
          <p>The studio has clients, gateways, services, queues, databases and cloud parts, frames to group them and arrows with labels.</p>
          {canEdit && <button type="button" className="dx-btn pri" onClick={() => add('architecture')}>Open the studio</button>}
        </div>
      ) : (
        <>
        {focus && !linked && <p className="dx-note" role="status">That diagram is not here any more. Showing all of them.</p>}
        <div className={`dx-gallery${linked ? ' one' : ''}`} data-testid="arch-gallery">
          {shown.map((d, n) => {
            const i = diagrams.indexOf(d);
            return (
              <figure key={d.key} className="dx-fig" style={{ '--i': n } as CSSProperties} data-outline={d.title}>
                <div className="dx-fig-canvas" onDoubleClick={() => canEdit && setEditing({ index: i, diagram: d })}><Preview data={asData(d.data)} /></div>
                <figcaption>
                  <span className={`dx-tag${d.kind === 'flow' ? ' flow' : ''}`}>{d.kind === 'flow' ? 'Request flow' : 'Architecture'}</span>
                  <b>{d.title}</b>
                  <span className="dx-fig-tools">
                    {asData(d.data).edges.length > 0 && <button type="button" className="dx-ibtn" aria-label={`Walk through ${d.title}`} title="Walk through, step by step" onClick={() => setWalk(d)}><Icon name="play" size={13} /></button>}
                    <button type="button" className="dx-ibtn" aria-label={`Copy a link to ${d.title}`} title="Copy a link to this diagram" onClick={() => void shareDiagram(projectId, d.key)}><Icon name="link" size={13} /></button>
                    <button type="button" className="dx-ibtn" aria-label={linked ? 'Back to all diagrams' : `Focus on ${d.title}`} onClick={() => setFocus(linked ? null : d.key)}><Icon name={linked ? 'close' : 'eye'} size={13} /></button>
                    {canEdit && <button type="button" className="dx-ibtn" aria-label={`Edit ${d.title}`} onClick={() => setEditing({ index: i, diagram: d })}><Icon name="edit" size={13} /></button>}
                    {canEdit && <button type="button" className="dx-ibtn" aria-label={`Delete ${d.title}`} onClick={() => void remove(i)}><Icon name="trash" size={13} /></button>}
                  </span>
                </figcaption>
              </figure>
            );
          })}
        </div>
        </>
      )}

      <section className="dx-notes" data-outline="Notes">
        <div className="dx-sect-h"><h2 className="dx-h2">Notes</h2>{canEdit && notesChanged && <button type="button" className="dx-btn pri sm" disabled={save.isPending} onClick={() => save.mutate({ diagrams, notes })}>Save notes</button>}</div>
        {canEdit ? <textarea className="dx-notes-in" rows={5} maxLength={8000} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Environments, hosting, data stores, who owns what, links to runbooks…" aria-label="Architecture notes" />
          : <p className="dx-lede">{notes || <span className="dx-note">No notes.</span>}</p>}
      </section>

      {editing && (
        <ArchStudio title={editing.diagram.title} data={asData(editing.diagram.data)} context={context} shareUrl={editing.index >= 0 ? diagramUrl(projectId, editing.diagram.key) : undefined} onDraft={onDraft} onClose={() => setEditing(null)}
          onDone={(data, title) => {
            const d: DtDiagram = { ...editing.diagram, title: title.trim() || editing.diagram.title, data: data as unknown as DtDiagram['data'] };
            commit(editing.index < 0 ? [...diagrams, d] : diagrams.map((x, j) => (j === editing.index ? d : x)));
            setEditing(null);
          }} />
      )}
      {walk && <Walkthrough diagram={walk} onClose={() => setWalk(null)} />}
    </div>
  );
}

/** The address that opens one diagram of a project's architecture. */
export const diagramUrl = (projectId: string | null, key: string) => {
  // Keep the workspace's part of the address (/acme/library/…): the page's own path when it is the architecture page, else built from it.
  const here = window.location.pathname;
  const base = /\/architecture\/?$/.test(here) ? here.replace(/\/$/, '') : `${here.match(/^\/[^/]+(?=\/library\/)/)?.[0] ?? ''}${docsPath.architecture(projectId)}`;
  return `${window.location.origin}${base}?diagram=${encodeURIComponent(key)}`;
};
async function shareDiagram(projectId: string | null, key: string) {
  try { await navigator.clipboard.writeText(diagramUrl(projectId, key)); toast('Link copied. It opens this diagram for people with access to the project.', 'success'); }
  catch { toast('Could not copy the link.', 'error'); }
}

type Node = ArchData['nodes'][number];
type Edge = ArchData['edges'][number];

/** The order a request travels: from the boxes nothing points to, breadth first; arrows not reached that way follow at the end. */
export function travelOrder(data: ArchData): Edge[] {
  const into = new Set(data.edges.map((e) => e.target));
  const queue = data.nodes.filter((n) => !into.has(n.id) && data.edges.some((e) => e.source === n.id)).map((n) => n.id);
  const seen = new Set<string>(); const out: Edge[] = [];
  while (queue.length) { const id = queue.shift()!; for (const e of data.edges.filter((x) => x.source === id && !seen.has(x.id))) { seen.add(e.id); out.push(e); queue.push(e.target); } }
  return [...out, ...data.edges.filter((e) => !seen.has(e.id))];
}

/**
 * Walk through: the diagram full screen, one arrow at a time in the order a request travels, with the step written out beside it
 * ("Customer app → API gateway · HTTPS"). ← → or the list to move, Esc to close. Read-only.
 */
function Walkthrough({ diagram, onClose }: { diagram: DtDiagram; onClose: () => void }) {
  const data = asData(diagram.data);
  const steps = useMemo(() => travelOrder(data), [data]);
  const [i, setI] = useState(0);
  const name = (id: string) => data.nodes.find((n: Node) => n.id === id)?.label || 'a part';
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); setI((x) => Math.min(steps.length - 1, x + 1)); }
      else if (e.key === 'ArrowLeft') setI((x) => Math.max(0, x - 1));
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, [steps.length, onClose]);
  const flow = useMemo(() => {
    const f = toFlow(data, true);
    const lit = new Set(steps.slice(0, i + 1).map((e) => e.id)); const cur = steps[i]?.id;
    const reached = new Set(steps.slice(0, i + 1).flatMap((e) => [e.source, e.target]));
    return {
      nodes: f.nodes.map((n) => ({ ...n, className: reached.has(n.id) ? 'sim sim-hit' : 'sim' })),
      edges: f.edges.map((e) => ({ ...e, className: e.id === cur ? 'sim sim-now' : lit.has(e.id) ? 'sim sim-done' : 'sim sim-wait' })),
    };
  }, [data, steps, i]);
  return createPortal(
    <div className="dx-walk" role="dialog" aria-modal="true" aria-label={`Walk through ${diagram.title}`}>
      <aside className="dx-walk-side">
        <button type="button" className="dx-walk-x" onClick={onClose} autoFocus>Esc · Close</button>
        <p className="dx-eyebrow">Walkthrough · {plural(steps.length, 'step')}</p>
        <h2>{diagram.title}</h2>
        <ol>
          {steps.map((e, k) => (
            <li key={e.id}><button type="button" className={k === i ? 'on' : k < i ? 'done' : ''} aria-current={k === i ? 'step' : undefined} onClick={() => setI(k)}>
              <b>{String(k + 1).padStart(2, '0')}</b><span>{name(e.source)} → {name(e.target)}{e.label ? <small>{e.label}</small> : null}</span>
            </button></li>
          ))}
        </ol>
        <div className="dx-walk-nav"><button type="button" className="dx-btn" disabled={i === 0} onClick={() => setI(i - 1)}>Back</button><button type="button" className="dx-btn pri" disabled={i >= steps.length - 1} onClick={() => setI(i + 1)}>Next step</button></div>
      </aside>
      <div className="dx-walk-stage"><ReactFlowProvider><ArchCanvas readOnly nodes={flow.nodes} edges={flow.edges} fitView fitViewOptions={{ padding: 0.2 }} /></ReactFlowProvider></div>
    </div>, document.body);
}
