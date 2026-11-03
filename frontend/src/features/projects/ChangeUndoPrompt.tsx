import { useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ApiError } from '../../api/client';
import { confirmDialog, toast } from '../../stores/ui';
import { invalidateWorkspace } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { portfolioApi } from './portfolioApi';

/**
 * "Undo change" from a change e-mail lands here with ?undo=<signed token>: the page the link opens (the task) shows, and this asks first. Nothing is
 * undone without the person confirming, signed in, with the right to edit the task; the token names the change and who it was sent to, and expires.
 */
export function ChangeUndoPrompt() {
  const [params, setParams] = useSearchParams();
  const token = params.get('undo');
  const wid = useWorkspaceId();
  const asked = useRef<string | null>(null);
  useEffect(() => {
    if (!token || asked.current === token) return;
    asked.current = token;
    const drop = () => setParams((x) => { const n = new URLSearchParams(x); n.delete('undo'); return n; }, { replace: true });
    void (async () => {
      const ok = await confirmDialog({ title: 'Undo this change?', message: 'The task goes back to how it was before the change in the e-mail, and the people on it are told.', confirmText: 'Undo change' });
      drop();
      if (!ok) return;
      try {
        const res = await portfolioApi.sheetUndo({ token });
        if (res.changed) { toast(`Undone · ${res.rows[0]?.key ?? 'the task'} is back as it was.`); void invalidateWorkspace(wid); }
        else toast(res.rows[0]?.error ?? 'The change could not be undone.', 'error');
      } catch (e) { toast(e instanceof ApiError ? e.message : 'The change could not be undone.', 'error'); }
    })();
  }, [token, setParams, wid]);
  return null;
}
