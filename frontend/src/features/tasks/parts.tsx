import type { ReactNode } from 'react';
import type { Task } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Avatar, LabelChip, PriorityBadge, TaskStatusBadge } from '../../components/ui';
import { dueLabel } from '../../lib/format';

export function DueMeta({ task }: { task: Task }) {
  return (
    <span className={`meta-line ${task.isOverdue ? 'overdue' : ''}`}>
      <Icon name="clock" /> {task.dueDate ? dueLabel(task.dueDate) : 'No due date'}
    </span>
  );
}

export function TaskCheck({ task, onToggle, disabled }: { task: Task; onToggle: () => void; disabled?: boolean }) {
  const done = task.statusCategory === 'Done';
  return (
    <button type="button" className={`check ${done ? 'checked' : ''}`} disabled={disabled} title={done ? 'Reopen task' : 'Mark complete'}
      aria-label={done ? 'Reopen task' : 'Mark complete'} aria-pressed={done}
      onClick={(e) => { e.stopPropagation(); onToggle(); }}>
      <Icon name="tick" />
    </button>
  );
}

export function TaskCard({ task, onOpen, onToggle, archived }: { task: Task; onOpen: () => void; onToggle: () => void; archived?: boolean }) {
  const done = task.statusCategory === 'Done';
  return (
    <div className={`task-card ${done ? 'done' : ''}`} onClick={onOpen} role="button" tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') onOpen(); }}>
      <div className="task-card-top">
        <TaskCheck task={task} onToggle={onToggle} disabled={!task.canEdit || archived} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="task-key">{task.key}</div>
          <div className="task-title">{task.title}</div>
        </div>
      </div>
      {task.description && <div className="task-desc">{task.description}</div>}
      <div className="task-meta"><PriorityBadge priority={task.priority} /><TaskStatusBadge name={task.statusName} category={task.statusCategory} /></div>
      {task.labels.length > 0 && <div className="task-meta">{task.labels.map((l) => <LabelChip key={l.id} name={l.name} color={l.color} />)}</div>}
      <div className="task-meta"><span className="meta-line"><Icon name="folder" /> {task.projectName}</span></div>
      <div className="task-foot">
        <DueMeta task={task} />
        <div className="row" style={{ gap: 8 }}>
          {task.isBlocked && <span className="meta-line blocked-flag" title="Waiting on another task"><Icon name="lock" /></span>}
          {task.subtaskTotal > 0 && <span className="meta-line" title="Subtasks"><Icon name="list" /> {task.subtaskDone}/{task.subtaskTotal}</span>}
          {task.checklistTotal > 0 && <span className="meta-line" title="Checklist"><Icon name="check" /> {task.checklistDone}/{task.checklistTotal}</span>}
          {task.commentCount > 0 && <span className="meta-line" title="Comments"><Icon name="message" /> {task.commentCount}</span>}
          {task.assignee && <Avatar name={task.assignee.name} size="sm" userId={task.assignee.id} />}
        </div>
      </div>
    </div>
  );
}

export function TaskTable({ tasks, onOpen, onToggle, archived, showProject = true, showPhase = false, actions }: {
  tasks: Task[]; onOpen: (t: Task) => void; onToggle: (t: Task) => void; archived?: boolean; showProject?: boolean; showPhase?: boolean; actions?: (t: Task) => ReactNode;
}) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th style={{ width: 44 }} />
            <th>Task</th>{showProject && <th>Project</th>}{showPhase && <th>Phase</th>}<th>Assignee</th><th>Priority</th><th>Due</th><th>Status</th>{actions && <th style={{ textAlign: 'right' }}>Actions</th>}
          </tr>
        </thead>
        <tbody>
          {tasks.map((t) => (
            <tr key={t.id} className="clickable" onClick={() => onOpen(t)}>
              <td><TaskCheck task={t} onToggle={() => onToggle(t)} disabled={!t.canEdit || archived} /></td>
              <td>
                <div className="task-key">{t.key}</div>
                <div className="td-title" style={{ textDecoration: t.statusCategory === 'Done' ? 'line-through' : undefined }}>{t.title}</div>
                {t.labels.length > 0 && <div className="task-meta" style={{ marginTop: 4 }}>{t.labels.map((l) => <LabelChip key={l.id} name={l.name} color={l.color} />)}</div>}
              </td>
              {showProject && <td className="cell-muted">{t.projectName}</td>}
              {showPhase && <td className="cell-muted">{t.stageName ?? '—'}</td>}
              <td className="cell-muted">{t.assignee ? <span className="row" style={{ gap: 7 }}><Avatar name={t.assignee.name} size="sm" userId={t.assignee.id} />{t.assignee.name}</span> : '—'}</td>
              <td><PriorityBadge priority={t.priority} /></td>
              <td><DueMeta task={t} /></td>
              <td><TaskStatusBadge name={t.statusName} category={t.statusCategory} /></td>
              {actions && <td onClick={(e) => e.stopPropagation()}><div className="td-actions">{actions(t)}</div></td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
