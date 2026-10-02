import { useEffect, useState } from 'react';
import { ApiError } from '../../api/client';
import { Icon } from '../../components/Icon';
import { Select } from '../../components/Select';
import { PageLoader } from '../../components/ui';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { reminderApi } from './api';

interface Step { days: number; who: 'Manager' | 'Owner' }
const parse = (s: string): Step[] => s.split(',').map((p) => p.split(':')).filter((p) => p.length === 2).map(([d, w]) => ({ days: Number(d), who: w as Step['who'] }));

/** Settings → Reminders (Owners/Admins): the escalation ladder for overdue work (Business), and how reminders are being used. */
export function ReminderPolicySettings() {
  const wid = useWorkspaceId();
  const q = useWsQuery(['reminders', 'policy'], reminderApi.policy);
  const [on, setOn] = useState(false);
  const [steps, setSteps] = useState<Step[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (q.data) { setOn(q.data.escalationEnabled); setSteps(parse(q.data.steps)); } }, [q.data]);
  if (q.isLoading || !q.data) return <PageLoader />;
  const p = q.data;
  const locked = !p.available || !p.canManage;

  const save = async () => {
    setBusy(true);
    try {
      await reminderApi.savePolicy({ escalationEnabled: on, steps: steps.map((s) => `${s.days}:${s.who}`).join(',') });
      await invalidateWorkspace(wid, 'reminders');
      toast('Escalation saved.', 'success');
    } catch (e) { toast(e instanceof ApiError ? e.errors[0]?.message ?? e.message : 'Could not save.', 'error'); }
    finally { setBusy(false); }
  };

  return (
    <div className="rs-policy">
      <div className="rp-stats">
        <div className="rp-stat tone-primary"><span className="rp-stat-ico"><Icon name="alarm" size={17} /></span><div><b>{p.sentLast30Days}</b><span>Reminders sent</span><em>last 30 days</em></div></div>
        <div className="rp-stat tone-success"><span className="rp-stat-ico"><Icon name="checkCircle" size={17} /></span><div><b>{p.doneLast30Days}</b><span>Finished</span><em>last 30 days</em></div></div>
        <div className="rp-stat tone-warning"><span className="rp-stat-ico"><Icon name="alert" size={17} /></span><div><b>{p.escalatedLast30Days}</b><span>Escalated</span><em>last 30 days</em></div></div>
      </div>
      <div className="card"><div className="card-body">
        <div className="setting-row">
          <div className="setting-info"><h4><Icon name="flag" size={14} /> Escalate overdue work</h4>
            <p>{p.available
              ? 'When work stays overdue, the people who can help hear about it too: the assignee’s manager first, then the project’s owner (or whoever raised operational work). Everyone already gets their own reminders; this is the safety net.'
              : 'Comes with the Business plan. Everyone already gets due-date reminders for their own work on every plan.'}</p></div>
          <button type="button" className={`switch ${on ? 'on' : ''}`} role="switch" aria-checked={on} aria-label="Escalate overdue work" disabled={locked} onClick={() => setOn((v) => !v)} />
        </div>
        {on && p.available && (
          <div className="rs-steps">
            {steps.map((s, i) => (
              <div key={i} className="rs-step">
                <span className="rs-step-n">{i + 1}</span>
                <span>After</span>
                <Select className="input" value={String(s.days)} onChange={(e) => setSteps((xs) => xs.map((x, j) => j === i ? { ...x, days: Number(e.target.value) } : x))} aria-label="Days overdue" disabled={locked}>
                  {[1, 2, 3, 4, 5, 7, 10, 14].map((d) => <option key={d} value={d}>{d} day{d === 1 ? '' : 's'} overdue</option>)}
                </Select>
                <span>tell</span>
                <Select className="input" value={s.who} onChange={(e) => setSteps((xs) => xs.map((x, j) => j === i ? { ...x, who: e.target.value as Step['who'] } : x))} aria-label="Who" disabled={locked}>
                  <option value="Manager">their manager</option>
                  <option value="Owner">the project owner</option>
                </Select>
                {!locked && <button type="button" className="btn-icon" aria-label="Remove step" onClick={() => setSteps((xs) => xs.filter((_, j) => j !== i))}><Icon name="close" size={14} /></button>}
              </div>
            ))}
            {!locked && steps.length < 5 && <button type="button" className="link" onClick={() => setSteps((xs) => [...xs, { days: (xs[xs.length - 1]?.days ?? 1) + 3, who: 'Owner' }])}>+ Add a step</button>}
          </div>
        )}
        {!locked && <div className="rs-save"><button type="button" className="btn btn-primary" disabled={busy} onClick={() => void save()}>{busy && <span className="spinner" />}Save</button></div>}
      </div></div>
    </div>
  );
}
