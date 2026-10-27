import { useState } from 'react';
import { Icon } from '../../components/Icon';
import { Modal, PageLoader } from '../../components/ui';
import { useQuery } from '@tanstack/react-query';
import { formatDate } from '../../lib/format';
import { useWsQuery } from '../../lib/hooks';
import { useTeamLens } from '../../lib/teamLens';
import { aiWorkspaceApi, type ScenarioOutcome } from '../ai/aiApi';

/** The portfolio worked out by rules over the projects the person may open: no model, no credits, every plan. Shared by Portfolio and each project. */
export function usePortfolioBrief() {
  const { teamId } = useTeamLens();
  return useWsQuery(['project-status', 'brief', teamId], () => aiWorkspaceApi.portfolioBrief(teamId), { refetchInterval: 120_000, staleTime: 60_000, placeholderData: (prev) => prev });
}

const outcome = (o: ScenarioOutcome) => o.finish ? formatDate(o.finish) : 'Cannot be forecast';
const lateness = (o: ScenarioOutcome) => o.slipDays == null ? null : o.slipDays > 0 ? `${o.slipDays} day${o.slipDays === 1 ? '' : 's'} after the due date` : o.slipDays < 0 ? `${-o.slipDays} day${o.slipDays === -1 ? '' : 's'} before the due date` : 'on the due date';

/** "What if": when the project would finish if the work started later, more people joined or some tasks were cut. Arithmetic over its own pace; nothing is changed. */
export function WhatIf({ projectId, name, onClose }: { projectId: string; name: string; onClose: () => void }) {
  const { teamId } = useTeamLens();
  const [slip, setSlip] = useState(0); const [add, setAdd] = useState(0); const [cut, setCut] = useState(0);
  const q = useQuery({
    queryKey: ['scenario', projectId, slip, add, cut, teamId],
    queryFn: () => aiWorkspaceApi.scenario({ projectId, slipDays: slip, addPeople: add, cutTasks: cut, teamId }),
    placeholderData: (prev) => prev,
  });
  const d = q.data;
  const num = (v: string, max: number) => Math.max(0, Math.min(max, Math.floor(Number(v) || 0)));
  const changed = slip > 0 || add > 0 || cut > 0;
  return (
    <Modal size="lg" title={`What if… ${name}`} onClose={onClose} footer={<button type="button" className="btn btn-primary" onClick={onClose}>Close</button>}>
      <p className="muted" style={{ marginTop: 0 }}>Change one or more of these to see when the project would finish. Nothing is changed in the project.</p>
      <div className="pi-whatif-inputs">
        <label>The work starts later by<span><input className="input" type="number" min={0} max={365} value={slip} onChange={(e) => setSlip(num(e.target.value, 365))} /> days</span></label>
        <label>People added<span><input className="input" type="number" min={0} max={50} value={add} onChange={(e) => setAdd(num(e.target.value, 50))} /> people</span></label>
        <label>Tasks taken out of the plan<span><input className="input" type="number" min={0} max={d?.openTasks ?? 500} value={cut} onChange={(e) => setCut(num(e.target.value, d?.openTasks ?? 500))} /> of {d?.openTasks ?? '…'}</span></label>
      </div>
      {!d ? <PageLoader /> : (
        <div className="pi-whatif-out">
          <div className="pi-whatif-card">
            <label>Today's plan</label><b>{outcome(d.baseline)}</b>
            <small>{lateness(d.baseline) ?? `Due ${d.dueDate ? formatDate(d.dueDate) : 'not set'}`}{d.baseline.finish ? ` · ${d.baseline.confidence} confidence` : ''}</small>
          </div>
          <div className={`pi-whatif-card ${changed ? 'on' : ''} ${d.scenario.slipDays != null && d.scenario.slipDays > 0 ? 'late' : ''}`}>
            <label>With your change</label><b>{outcome(d.scenario)}</b>
            <small>{lateness(d.scenario) ?? (d.dueDate ? '' : 'No due date set')}{d.scenario.finish ? ` · ${d.scenario.confidence} confidence` : ''}</small>
            {changed && d.changeDays != null && <em className={d.changeDays > 0 ? 'late' : 'ok'}>{d.changeDays === 0 ? 'No change' : d.changeDays > 0 ? `${d.changeDays} day${d.changeDays === 1 ? '' : 's'} later` : `${-d.changeDays} day${d.changeDays === -1 ? '' : 's'} sooner`}</em>}
          </div>
        </div>
      )}
      {d?.toMeetDue && <p className="pi-whatif-need"><Icon name="target" size={15} /> {d.toMeetDue.note}</p>}
      {d && d.notes.length > 0 && <ul className="pi-whatif-notes">{d.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
      <p className="muted" style={{ fontSize: 12.5, marginBottom: 0 }}>An estimate from the pace of the last 4 weeks ({d?.finishedLast28Days ?? '…'} tasks finished), not a commitment.</p>
    </Modal>
  );
}
