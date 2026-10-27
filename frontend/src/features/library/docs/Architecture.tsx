import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ReactFlowProvider } from '@xyflow/react';
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
export function Architecture({ projectId, projectName }: { projectId: string | null; projectName: string }) {
  const wid = useWorkspaceId();
  const q = useWsQuery(['documents', 'doctracker', 'architecture', projectId ?? 'general'], () => docTrackerApi.architecture(projectId));
  const [diagrams, setDiagrams] = useState<DtDiagram[] | null>(null);
  const [notes, setNotes] = useState('');
  const [editing, setEditing] = useState<{ index: number; diagram: DtDiagram } | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  useEffect(() => { if (q.data) { setDiagrams(q.data.diagrams); setNotes(q.data.notes ?? ''); } }, [q.data]);
  const save = useMutation({
    mutationFn: (b: { diagrams: DtDiagram[]; notes: string }) => docTrackerApi.saveArchitecture(projectId, { diagrams: b.diagrams, notes: b.notes || null }),
    onSuccess: (r) => { setDiagrams(r.diagrams); invalidateWorkspace(wid, 'documents'); toast('Architecture saved.'); },
    onError: (e) => { toast(e instanceof ApiError ? e.message : 'Could not save.', 'error'); if (q.data) setDiagrams(q.data.diagrams); },
  });
  if (q.isError) return <ErrorState error={q.error} retry={() => void q.refetch()} />;
  if (q.isLoading || !diagrams) return <PageLoader />;
  const canEdit = !!q.data?.canEdit;
  const commit = (next: DtDiagram[]) => { setDiagrams(next); save.mutate({ diagrams: next, notes }); };
  const add = (kind: DtDiagram['kind'], template?: ArchData) => setEditing({ index: -1, diagram: { key: newKey(), title: kind === 'flow' ? 'Request flow' : 'System architecture', kind, data: (template ?? EMPTY) as unknown as DtDiagram['data'] } });
  const remove = async (i: number) => { if (await confirmDialog({ title: `Delete “${diagrams[i].title}”?`, message: 'The diagram is removed from this project.', confirmText: 'Delete' })) commit(diagrams.filter((_, j) => j !== i)); };
  const notesChanged = notes !== (q.data?.notes ?? '');
  const shown = focus ? diagrams.filter((d) => d.key === focus) : diagrams;

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
        <div className={`dx-gallery${focus ? ' one' : ''}`}>
          {shown.map((d, n) => {
            const i = diagrams.indexOf(d);
            return (
              <figure key={d.key} className="dx-fig" style={{ '--i': n } as CSSProperties} data-outline={d.title}>
                <div className="dx-fig-canvas" onDoubleClick={() => canEdit && setEditing({ index: i, diagram: d })}><Preview data={asData(d.data)} /></div>
                <figcaption>
                  <span className={`dx-tag${d.kind === 'flow' ? ' flow' : ''}`}>{d.kind === 'flow' ? 'Request flow' : 'Architecture'}</span>
                  <b>{d.title}</b>
                  <span className="dx-fig-tools">
                    <button type="button" className="dx-ibtn" aria-label={focus ? 'Back to all diagrams' : `Focus on ${d.title}`} onClick={() => setFocus(focus ? null : d.key)}><Icon name={focus ? 'close' : 'eye'} size={13} /></button>
                    {canEdit && <button type="button" className="dx-ibtn" aria-label={`Edit ${d.title}`} onClick={() => setEditing({ index: i, diagram: d })}><Icon name="edit" size={13} /></button>}
                    {canEdit && <button type="button" className="dx-ibtn" aria-label={`Delete ${d.title}`} onClick={() => void remove(i)}><Icon name="trash" size={13} /></button>}
                  </span>
                </figcaption>
              </figure>
            );
          })}
        </div>
      )}

      <section className="dx-notes" data-outline="Notes">
        <div className="dx-sect-h"><h2 className="dx-h2">Notes</h2>{canEdit && notesChanged && <button type="button" className="dx-btn pri sm" disabled={save.isPending} onClick={() => save.mutate({ diagrams, notes })}>Save notes</button>}</div>
        {canEdit ? <textarea className="dx-notes-in" rows={5} maxLength={8000} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Environments, hosting, data stores, who owns what, links to runbooks…" aria-label="Architecture notes" />
          : <p className="dx-lede">{notes || <span className="dx-note">No notes.</span>}</p>}
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
