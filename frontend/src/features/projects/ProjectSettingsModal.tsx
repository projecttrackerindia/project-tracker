import { useState } from 'react';
import type { ProjectDetail } from '../../api/types';
import { Modal, Tabs } from '../../components/ui';
import { AutomationPanel } from '../automation/AutomationPanel';
import { TeamTab, WorkflowTab } from './ProjectTabs';

export type ProjectSettingsTab = 'members' | 'workflow' | 'automation';

/**
 * Project settings: the things that are set up once and changed rarely (who is on the project, its task workflow, its automation rules),
 * kept apart from the everyday tabs. People who cannot edit the project only see its members, read-only.
 */
export function ProjectSettingsModal({ detail, canEdit, initial = 'members', onClose }: { detail: ProjectDetail; canEdit: boolean; initial?: ProjectSettingsTab; onClose: () => void }) {
  const tabs = [
    { id: 'members' as const, label: 'Members', icon: 'users' as const },
    ...(canEdit ? [{ id: 'workflow' as const, label: 'Workflow', icon: 'layers' as const }, { id: 'automation' as const, label: 'Automation', icon: 'bolt' as const }] : []),
  ];
  const [tab, setTab] = useState<ProjectSettingsTab>(tabs.some((t) => t.id === initial) ? initial : 'members');
  const p = detail.project;
  return (
    <Modal size="xl" title={canEdit ? `${p.name} · Project settings` : `${p.name} · Members`} subtitle={canEdit ? 'Members, task workflow and automation for this project.' : 'The people on this project.'}
      onClose={onClose} footer={<button type="button" className="btn btn-primary" onClick={onClose}>Done</button>}>
      <div className="project-settings">
        {tabs.length > 1 && <Tabs<ProjectSettingsTab> value={tab} onChange={setTab} tabs={tabs} />}
        {tab === 'members' && <TeamTab detail={detail} canEdit={canEdit && p.status !== 'Archived'} />}
        {tab === 'workflow' && <WorkflowTab projectId={p.id} statuses={detail.statuses} />}
        {tab === 'automation' && <AutomationPanel projectId={p.id} statuses={detail.statuses} canEdit={canEdit && p.status !== 'Archived'} />}
      </div>
    </Modal>
  );
}
