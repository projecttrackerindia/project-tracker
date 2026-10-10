import { useState } from 'react';
import { Link } from 'react-router-dom';
import { get, post, put } from '../../api/client';
import { useWsQuery } from '../../lib/hooks';
import { ErrorState, PageLoader } from '../../components/ui';

interface Resolution { workTaskId: string; workVersion: number; note: string | null; proposedAt: string | null; acceptedAt: string | null; current: boolean; canPropose: boolean; canAccept: boolean; documentId: string | null; documentVersion: string | null }

export function SupportResolution({ taskId, onChanged }: { taskId: string; onChanged: () => void }) {
  const query = useWsQuery(['work', 'task', taskId, 'resolution'], () => get<Resolution>(`/work-tasks/${taskId}/resolution`));
  const documents = useWsQuery(['work', 'resolution-documents'], () => get<{ items: { id: string; title: string }[] }>('/documents?status=Published&limit=100'), { enabled: query.data?.canPropose === true });
  const [note, setNote] = useState('');
  const [documentId, setDocumentId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await fn(); await query.refetch(); onChanged(); } catch (e) { setError(e instanceof Error ? e.message : 'The resolution could not be saved.'); } finally { setBusy(false); }
  };
  if (query.isLoading) return <PageLoader />;
  if (!query.data) return <ErrorState error={query.error} retry={() => void query.refetch()} />;
  const resolution = query.data;
  return <section>
    <h3>Verified support resolution</h3>
    <p>Complete and verify the work, record the fix, then ask the person who raised it to acknowledge the result. Later work edits make the acknowledgment stale.</p>
    {error && <p className="form-error" role="alert">{error}</p>}
    {resolution.note && <><p style={{ whiteSpace: 'pre-wrap' }}>{resolution.note}</p><p>{!resolution.current ? 'This proposal is stale. Verify the current work and propose the resolution again.' : resolution.acceptedAt ? `Acknowledged by the reporter on ${new Date(resolution.acceptedAt).toLocaleString()}.` : 'Awaiting reporter acknowledgment.'}</p></>}
    {resolution.documentId && <p><Link to={`/documents/${resolution.documentId}`}>Linked knowledge document</Link> · approved version {resolution.documentVersion}</p>}
    {resolution.canPropose && <div style={{ display: 'grid', gap: 10 }}>
      <label>Verified fix<textarea className="textarea" value={note} onChange={e => setNote(e.target.value)} maxLength={8000} placeholder="What changed, how it was verified, and how to avoid recurrence" /></label>
      <label>Published knowledge document (optional)<select className="select" value={documentId} onChange={e => setDocumentId(e.target.value)}><option value="">No linked document</option>{documents.data?.items.map(d => <option key={d.id} value={d.id}>{d.title}</option>)}</select></label>
      <button type="button" className="btn" disabled={busy || note.trim().length < 10} onClick={() => void run(() => put(`/work-tasks/${taskId}/resolution`, { workVersion: resolution.workVersion, note, documentId: documentId.trim() || null }))}>Propose verified resolution</button>
    </div>}
    {resolution.canAccept && <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void run(() => post(`/work-tasks/${taskId}/resolution/accept`, { workVersion: resolution.workVersion }))}>I verified this resolution</button>}
    {!resolution.note && !resolution.canPropose && <p>No resolution proposed. Complete the work before recording the verified fix.</p>}
  </section>;
}
