import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { idleApi, idleLabel, type IdlePolicy } from '../../api/endpoints.idle';
import { queryClient, useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import './idlePolicy.css';

const CHOICES = [15, 30, 60, 240, 0];

/**
 * Settings › Security › Sessions: "Sign out after inactivity" for everyone in the workspace (owners and admins choose; others see it).
 * Saved at once with a tick; a refused save puts the old choice back.
 */
export function IdlePolicyRow() {
  const wid = useWorkspaceId();
  const key = ['idle-policy', wid];
  const q = useQuery({ queryKey: key, queryFn: idleApi.policy, enabled: !!wid, retry: false });
  const [saved, setSaved] = useState(false);
  if (!q.data) return null;
  const { minutes, canManage } = q.data;

  const choose = async (m: number) => {
    if (m === minutes || !canManage) return;
    const before = q.data;
    queryClient.setQueryData<IdlePolicy>(key, { ...before, minutes: m });
    setSaved(false);
    try {
      queryClient.setQueryData(key, await idleApi.setPolicy(m));
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1800);
    } catch (e) {
      queryClient.setQueryData(key, before);
      toast(e instanceof ApiError ? e.message : 'Could not save.', 'error');
    }
  };

  return (
    <div className="setting-row il-policy" data-setting="security.idle">
      <div className="setting-info">
        <h4>Sign out after inactivity {saved && <span className="il-saved" role="status">✓ Saved</span>}</h4>
        <p>After this long without use, the app locks on every device. Members unlock with their passkey or password; unsaved work stays as it was.{!canManage && ' Only owners and admins can change this.'}</p>
      </div>
      <div className="seg il-seg" role="radiogroup" aria-label="Sign out after inactivity">
        {CHOICES.map((m) => (
          <button key={m} type="button" role="radio" aria-checked={minutes === m} disabled={!canManage} onClick={() => void choose(m)}>
            {idleLabel(m).replace(' hours', ' h').replace(' hour', ' h')}{m === 30 && <span className="sr-only"> (default)</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
