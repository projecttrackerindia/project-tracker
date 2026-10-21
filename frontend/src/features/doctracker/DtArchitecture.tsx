import { useEffect, useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ReactFlowProvider } from '@xyflow/react';
import { ApiError } from '../../api/client';
import { docTrackerApi } from '../../api/endpoints';
import type { DtDiagram } from '../../api/types';
import { Icon } from '../../components/Icon';
import { EmptyState, ErrorState, PageLoader } from '../../components/ui';
import { timeAgo } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { confirmDialog, toast } from '../../stores/ui';
import { ArchCanvas, EMPTY, toFlow, type ArchData } from './arch/ArchCanvas';
import { ArchStudio } from './arch/ArchStudio';
import { TEMPLATES } from './arch/archTemplates';

const asData = (d: DtDiagram['data']) => (d && Array.isArray(d.nodes) ? (d as unknown as ArchData) : EMPTY);
const newKey = () => `d-${Date.now().toString(36)}`;

function Preview({ data }: { data: ArchData }) {
  const flow = useMemo(() => toFlow(data, true), [data]);
  if (data.nodes.length === 0) return <div className="dt-arch-empty"><Icon name="workflow" size={22} /><span>Empty - open the studio to draw</span></div>;
  return <ReactFlowProvider><ArchCanvas readOnly nodes={flow.nodes} edges={flow.edges} fitView fitViewOptions={{ padding: 0.15 }} panOnDrag={false} zoomOnPinch={false} zoomOnDoubleClick={false} /></ReactFlowProvider>;
}

/** A project's architecture and request-flow diagrams, drawn in Architecture Studio, with notes. Saved together for the project. */
export function DtArchitecture({ projectId }: { projectId: string | null }) {
  const wid = useWorkspaceId();
  const q = useWsQuery(['documents', 'doctracker', 'architecture', projectId ?? 'general'], () => docTrackerApi.architecture(projectId));
  const [diagrams, setDiagrams] = useState<DtDiagram[] | null>(null);
  const [notes, setNotes] = useState('');
  const [editing, setEditing] = useState<{ index: number; diagram: DtDiagram } | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  useEffect(() => { if (q.data) { setDiagrams(q.data.diagrams); setNotes(q.data.notes ?? ''); } }, [q.data]);
  const save = useMutation({
    mutationFn: (b: { diagrams: DtDiagram[]; notes: string }) => docTrackerApi.saveArchitecture(projectId, { diagrams: b.diagrams, notes: b.notes || null }),
    onSuccess: (r) => { setDiagrams(r.diagrams); invalidateWorkspace(wid, 'documents'); toast('Architecture saved.'); },
    onError: (e) => { toast(e instanceof ApiError ? e.message : 'Could not save.', 'error'); if (q.data) setDiagrams(q.data.diagrams); },
  });
  if (q.isLoading || !diagrams) return q.isError ? <ErrorState error={q.error} retry={() => q.refetch()} /> : <PageLoader />;
  const canEdit = !!q.data?.canEdit;
  const commit = (next: DtDiagram[], n = notes) => { setDiagrams(next); save.mutate({ diagrams: next, notes: n }); };
  const add = (kind: DtDiagram['kind'], template?: ArchData) => setEditing({ index: -1, diagram: { key: newKey(), title: kind === 'flow' ? 'Request flow' : 'System architecture', kind, data: (template ?? EMPTY) as unknown as DtDiagram['data'] } });
  const remove = async (i: number) => { if (await confirmDialog({ title: `Delete “${diagrams[i].title}”?`, message: 'The diagram is removed from this project.', confirmText: 'Delete' })) commit(diagrams.filter((_, j) => j !== i)); };
  const notesChanged = notes !== (q.data?.notes ?? '');

  return (
    <div className="dt-arch">
      <div className="dt-arch-bar">
        <p className="muted">{diagrams.length ? `${diagrams.length} diagram${diagrams.length === 1 ? '' : 's'}${q.data?.updatedAt ? ` · saved ${timeAgo(q.data.updatedAt)}${q.data.updatedBy ? ` by ${q.data.updatedBy}` : ''}` : ''}` : 'Draw the system and how requests flow through it.'}</p>
        {canEdit && diagrams.length < 12 && (
          <div className="dt-arch-add">
            <button className="btn btn-primary btn-sm" onClick={() => add('architecture')}><Icon name="plus" size={14} /> Architecture</button>
            <button className="btn btn-ghost btn-sm" onClick={() => add('flow', TEMPLATES[0]?.data)}><Icon name="workflow" size={14} /> Request flow</button>
          </div>
        )}
      </div>
      {diagrams.length === 0 ? (
        <EmptyState icon="workflow" title="No diagrams yet" text="Architecture Studio has a library of components (clients, gateways, services, queues, databases, cloud), frames to group them and arrows with labels. Start empty or from a template."
          action={canEdit ? <button className="btn btn-primary" onClick={() => add('architecture')}><Icon name="plus" /> Open Architecture Studio</button> : undefined} />
      ) : (
        <div className={`dt-arch-grid${expanded ? ' one' : ''}`}>
          {diagrams.map((d, i) => (expanded && expanded !== d.key ? null : (
            <figure key={d.key} className={`dt-arch-card${expanded === d.key ? ' big' : ''}`}>
              <figcaption>
                <span className={`dt-arch-kind ${d.kind}`}>{d.kind === 'flow' ? 'Request flow' : 'Architecture'}</span>
                <b>{d.title}</b>
                <span className="dt-arch-tools">
                  <button className="btn-icon sm" aria-label={expanded === d.key ? 'Shrink' : 'Enlarge'} onClick={() => setExpanded(expanded === d.key ? null : d.key)}><Icon name={expanded === d.key ? 'close' : 'eye'} size={13} /></button>
                  {canEdit && <button className="btn-icon sm" aria-label={`Edit ${d.title}`} onClick={() => setEditing({ index: i, diagram: d })}><Icon name="edit" size={13} /></button>}
                  {canEdit && <button className="btn-icon sm" aria-label={`Delete ${d.title}`} onClick={() => void remove(i)}><Icon name="trash" size={13} /></button>}
                </span>
              </figcaption>
              <div className="dt-arch-canvas" onDoubleClick={() => canEdit && setEditing({ index: i, diagram: d })}><Preview data={asData(d.data)} /></div>
            </figure>
          )))}
        </div>
      )}
      <section className="dt-card dt-arch-notes">
        <div className="dt-card-head"><h3>Notes</h3>{canEdit && notesChanged && <button className="btn btn-primary btn-sm" disabled={save.isPending} onClick={() => save.mutate({ diagrams, notes })}>Save notes</button>}</div>
        {canEdit ? <textarea className="textarea" rows={4} maxLength={8000} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Environments, hosting, data stores, who owns what, links to runbooks…" aria-label="Architecture notes" />
          : <p className="dt-pad">{notes || <span className="muted">No notes.</span>}</p>}
      </section>
      {editing && (
        <ArchStudio title={editing.diagram.title} data={asData(editing.diagram.data)} onClose={() => setEditing(null)}
          onDone={(data, title) => {
            const d: DtDiagram = { ...editing.diagram, title: title.trim() || editing.diagram.title, data: data as unknown as DtDiagram['data'] };
            commit(editing.index < 0 ? [...diagrams, d] : diagrams.map((x, j) => (j === editing.index ? d : x)));
            setEditing(null);
          }} />
      )}
    </div>
  );
}
