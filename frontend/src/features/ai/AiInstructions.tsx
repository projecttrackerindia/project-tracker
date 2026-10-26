import { useEffect, useState } from 'react';
import { ApiError } from '../../api/client';
import { Icon } from '../../components/Icon';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { aiWorkspaceApi } from './aiApi';
import { useAiStatus } from './Assistant';

/**
 * Settings → General (everyone): what the assistant has learned about how this person likes to work. It is plain, private to them, and
 * they can add their own notes or erase it all.
 */
export function AiProfileCard() {
  const wid = useWorkspaceId();
  const status = useAiStatus();
  const q = useWsQuery(['ai', 'profile'], aiWorkspaceApi.profile, { enabled: !!status?.configured && !!status?.entitled, staleTime: 30_000 });
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (q.data) setNotes(q.data.notes ?? ''); }, [q.data]);
  if (!status?.configured || !status.entitled || !q.data) return null;
  const dirty = notes.trim() !== (q.data.notes ?? '').trim();

  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try { await fn(); void invalidateWorkspace(wid, 'ai', 'profile'); toast(done); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Could not save it.', 'error'); }
    finally { setBusy(false); }
  };

  return (
    <div className="card" style={{ marginTop: 18 }}><div className="card-body">
      <div className="setting-info" style={{ marginBottom: 10 }}>
        <h4><Icon name="sparkle" size={14} /> How the assistant works with you</h4>
        <p>It learns from your thumbs up or down, and from which suggestions you accept or decline. This is private to you; nobody else, including your administrators, can see it.</p>
      </div>
      <ul className="ai-learned">
        <li><b>Answer length:</b> {q.data.detailLabel}</li>
        {q.data.learned.filter((l) => !l.startsWith('In their own words')).map((l) => <li key={l}>{l.replace(/^They /, 'You ')}</li>)}
      </ul>
      <textarea className="textarea" rows={3} maxLength={500} value={notes} placeholder="Anything you want it to keep in mind, for example: answer in Hindi, always include risks." onChange={(e) => setNotes(e.target.value)} aria-label="Your notes for the assistant" />
      <div className="row" style={{ justifyContent: 'space-between', marginTop: 10 }}>
        <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void run(() => aiWorkspaceApi.resetProfile(), 'Erased. It starts fresh.')}>Erase what it has learned</button>
        <button type="button" className="btn btn-primary btn-sm" disabled={busy || !dirty} onClick={() => void run(() => aiWorkspaceApi.setProfileNotes(notes), 'Saved.')}>Save notes</button>
      </div>
    </div></div>
  );
}
