import { useEffect, useState } from 'react';
import { ApiError } from '../../api/client';
import { chatApi, statusApi } from '../../api/endpoints';
import { Modal } from '../../components/ui';
import { useWsQuery } from '../../lib/hooks';
import { toast } from '../../stores/ui';
import { useAi } from '../ai/Assistant';

/**
 * This week's status report, written from the project's data: the counts on top, the text to read and edit, then Copy or Send to the
 * project chat. "Polish" asks the assistant to smooth the wording without changing a fact.
 */
export function WeeklyReport({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const ai = useAi();
  const q = useWsQuery(['project', projectId, 'weekly'], () => statusApi.weekly(projectId), { staleTime: 0, retry: false });
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<null | 'send' | 'polish'>(null);
  useEffect(() => { if (q.data) setText(q.data.text); }, [q.data]);
  const d = q.data;
  const send = async () => {
    setBusy('send');
    try { await statusApi.sendWeekly(projectId, text); toast('Sent to the project chat.', 'success'); onClose(); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Could not send it.', 'error'); } finally { setBusy(null); }
  };
  const polish = async () => {
    setBusy('polish');
    try { const r = await chatApi.transform(text, 'rewrite'); setText(r.text); toast('Polished. Check it before sending.', 'info'); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'The assistant could not polish it.', 'error'); } finally { setBusy(null); }
  };
  return (
    <Modal title="Weekly status report" subtitle={d ? `${d.projectName} · ${d.health}` : 'Writing it from the project…'} size="lg" onClose={onClose}
      footer={<>
        {ai && <button className="btn btn-ghost" disabled={!text || busy !== null} onClick={() => void polish()}>{busy === 'polish' ? 'Polishing…' : '✦ Polish'}</button>}
        <button className="btn btn-ghost" disabled={!text} onClick={() => void navigator.clipboard?.writeText(text).then(() => toast('Copied.'))}>Copy</button>
        <button className="btn btn-primary" disabled={!d?.canSend || !text.trim() || busy !== null} title={d && !d.canSend ? 'Open the project chat once to send reports there' : undefined} onClick={() => void send()}>{busy === 'send' ? 'Sending…' : 'Send to project chat'}</button>
      </>}>
      {q.isError ? <p className="form-warn">{q.error instanceof ApiError ? q.error.message : 'Could not write the report.'}</p> : !d ? <p className="dq-empty">Reading the week…</p> : (
        <>
          <div className="wr-chips">
            <span className="wr-chip ok"><b>{d.moved}</b> moved</span><span className={`wr-chip ${d.slipped ? 'warn' : ''}`}><b>{d.slipped}</b> slipped</span>
            <span className={`wr-chip ${d.risks ? 'bad' : ''}`}><b>{d.risks}</b> risks</span><span className="wr-chip"><b>{d.next}</b> due next week</span>
          </div>
          <textarea className="wr-text" value={text} onChange={(e) => setText(e.target.value)} rows={18} maxLength={8000} aria-label="Report" />
        </>
      )}
    </Modal>
  );
}
