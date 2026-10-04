import { useEffect, useState } from 'react';
import { ApiError } from '../../api/client';
import { Icon } from '../../components/Icon';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { aiWorkspaceApi } from './aiApi';
import { useAiStatus } from './Assistant';

const EXAMPLE = 'We are a regional bank. Releases freeze on the last Friday of each month. "P1" means a customer-facing outage. Reports go to the Head of Delivery every Monday.';

/**
 * Settings → General (Owners and Admins): what the assistant should know about the organization. It is sent with every question, so answers
 * use the company's own words, rules and priorities.
 */
export function AiInstructionsCard() {
  const wid = useWorkspaceId();
  const status = useAiStatus();
  const q = useWsQuery(['ai', 'instructions'], aiWorkspaceApi.instructions, { enabled: !!status?.configured && !!status?.entitled, staleTime: 60_000 });
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (q.data) setText(q.data.text ?? ''); }, [q.data]);
  if (!status?.configured || !status.entitled || !q.data?.canEdit) return null;
  const dirty = text.trim() !== (q.data.text ?? '').trim();

  const save = async () => {
    setBusy(true);
    try { await aiWorkspaceApi.setInstructions(text); void invalidateWorkspace(wid, 'ai', 'instructions'); toast('Saved. The assistant will use this from the next question.'); }
    catch (e) { toast(e instanceof ApiError ? e.message : 'Could not save it.', 'error'); }
    finally { setBusy(false); }
  };

  return (
    <div className="card" style={{ marginTop: 18 }}><div className="card-body">
      <div className="setting-info" style={{ marginBottom: 10 }}>
        <h4><Icon name="sparkle" size={14} /> Tell the assistant about your organization</h4>
        <p>Describe how your organization works: its industry, rules, priorities and the terms you use. It is shared with every question anyone asks the assistant, so answers fit your way of working. Do not include passwords or personal data.</p>
      </div>
      <textarea className="textarea" rows={6} maxLength={4000} value={text} placeholder={EXAMPLE} onChange={(e) => setText(e.target.value)} aria-label="About your organization" />
      <div className="row" style={{ justifyContent: 'space-between', marginTop: 10 }}>
        <span className="muted" style={{ fontSize: 12 }}>{text.length.toLocaleString()} / 4,000</span>
        <button type="button" className="btn btn-primary" disabled={busy || !dirty} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </div></div>
  );
}
