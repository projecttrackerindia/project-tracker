import { useState } from 'react';
import type { DeliveryMethod, Stage } from '../../api/types';
import { Icon } from '../../components/Icon';
import { MilestonesPanel } from './MilestonesPanel';
import { SprintsPanel } from './SprintsPanel';

export const DELIVERY_METHODS: { id: DeliveryMethod; label: string; hint: string }[] = [
  { id: 'Phased', label: 'Phased', hint: 'Stages worked through in order, with milestones as checkpoints.' },
  { id: 'Agile', label: 'Agile', hint: 'Sprints and a backlog. The stage timeline is not shown.' },
  { id: 'Hybrid', label: 'Hybrid', hint: 'Stages and milestones, plus sprints inside them.' },
];
export const deliveryLabel = (m: DeliveryMethod) => DELIVERY_METHODS.find((x) => x.id === m)?.label ?? m;

type View = 'milestones' | 'sprints';

/**
 * A project's Plan tab. What it offers follows the project's delivery method: milestones for a phased project, sprints for an agile one,
 * both for a hybrid one. Stages are on the timeline above the tabs.
 */
export function PlanPanel({ projectId, method, stages, canEdit, canPlan, onOpenTask }: {
  projectId: string; method: DeliveryMethod; stages: Stage[]; canEdit: boolean; canPlan: boolean; onOpenTask: (id: string) => void;
}) {
  const views: View[] = method === 'Phased' ? ['milestones'] : method === 'Agile' ? ['sprints'] : ['milestones', 'sprints'];
  const [view, setView] = useState<View>(views[0]);
  const current = views.includes(view) ? view : views[0];
  return (
    <>
      {views.length > 1 && (
        <div className="row" style={{ justifyContent: 'space-between', marginBottom: 14, flexWrap: 'wrap', gap: 10 }}>
          <div className="seg" role="group" aria-label="Plan view">
            <button type="button" className={current === 'milestones' ? 'active' : ''} aria-pressed={current === 'milestones'} onClick={() => setView('milestones')}><Icon name="flag" size={14} /><span>Milestones</span></button>
            <button type="button" className={current === 'sprints' ? 'active' : ''} aria-pressed={current === 'sprints'} onClick={() => setView('sprints')}><Icon name="target" size={14} /><span>Sprints</span></button>
          </div>
          <span className="muted" style={{ fontSize: 12.5 }}>Hybrid delivery: stages and milestones, with sprints inside them. Change it under Edit details.</span>
        </div>
      )}
      {current === 'milestones' && <MilestonesPanel projectId={projectId} canEdit={canEdit} stages={stages} />}
      {current === 'sprints' && <SprintsPanel projectId={projectId} canEdit={canEdit} canPlan={canPlan} onOpenTask={onOpenTask} />}
    </>
  );
}
