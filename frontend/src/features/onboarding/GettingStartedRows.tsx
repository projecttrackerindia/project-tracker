import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { del, get, post } from '../../api/client';
import { useWsQuery } from '../../lib/hooks';
import { queryClient, useModule } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { SRow, STile } from '../settings/Grouped';
import { openTour } from './open';

interface Sample { exists: boolean; projectId: string | null; name: string | null; tasks: number }

/** Settings › Help: replay the welcome tour, and add or remove the sample project in one click. */
export function GettingStartedRows() {
  const nav = useNavigate();
  const canEdit = useModule('projects') >= 2;
  const q = useWsQuery(['onboarding', 'sample'], () => get<Sample>('/onboarding/sample-project'), { enabled: useModule('projects') > 0 });
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<Sample>, done: string) => {
    setBusy(true);
    try { await fn(); await queryClient.invalidateQueries(); toast(done); }
    catch (e) { toast(e instanceof Error ? e.message : 'That did not work. Try again.', 'error'); }
    finally { setBusy(false); }
  };
  const s = q.data;
  return (
    <>
      <SRow icon={<STile color="#34c759">▶</STile>} title="Welcome tour" sub="Four short pages: where things live and how to start" onClick={openTour} />
      {s && (
        <SRow icon={<STile color="#0a84ff">▦</STile>} title="Sample project"
          sub={s.exists ? `${s.name} · ${s.tasks} tasks` : 'A fictional project to explore with, removed in one click'}>
          {s.exists && s.projectId && <button type="button" className="sg-btn" onClick={() => nav(`/projects/${s.projectId}`)}>Open</button>}
          {canEdit && (s.exists
            ? <button type="button" className="sg-btn" disabled={busy} onClick={() => void run(() => del<Sample>('/onboarding/sample-project'), 'Sample project removed.')}>Remove</button>
            : <button type="button" className="sg-btn" disabled={busy} onClick={() => void run(() => post<Sample>('/onboarding/sample-project'), 'Sample project added.')}>Add</button>)}
        </SRow>
      )}
    </>
  );
}
