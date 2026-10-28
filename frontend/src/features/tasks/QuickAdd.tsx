import { useMemo, useState } from 'react';
import { ApiError } from '../../api/client';
import { taskApi, workspaceApi } from '../../api/endpoints';
import type { Priority } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Avatar } from '../../components/ui';
import { formatDate } from '../../lib/format';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { parseQuickTask, type QuickPart } from '../../lib/quickTask';
import { useAuth, useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { TaskModal } from './TaskModal';
import './tasks.css';

/**
 * Add a task in one line of plain words: "Fix login bug for Ravi by Friday, high, 3h". What was understood shows as chips before anything
 * is saved (dismiss one to keep those words in the title); Enter adds the task, Shift+Enter opens the full form with everything filled in.
 */
export function QuickAdd({ projectId }: { projectId: string }) {
  const wid = useWorkspaceId();
  const meUser = useAuth((s) => s.ctx?.user);
  const members = useWsQuery(['members'], workspaceApi.members, { staleTime: 300_000 });
  const [text, setText] = useState('');
  const [skip, setSkip] = useState<Set<QuickPart>>(new Set());
  const [busy, setBusy] = useState(false);
  const [full, setFull] = useState<null | Parameters<typeof TaskModal>[0]['initial']>(null);
  const people = useMemo(() => (members.data ?? []).filter((m) => m.role !== 'Guest' && m.isActive !== false).map((m) => ({ id: m.userId, name: m.displayName })), [members.data]);
  const me = meUser ? { id: meUser.id, name: meUser.displayName } : undefined;
  const t = useMemo(() => parseQuickTask(text, people, new Date(), me, skip), [text, people, me?.id, skip]); // eslint-disable-line react-hooks/exhaustive-deps

  const dismiss = (part: QuickPart) => setSkip((s) => new Set(s).add(part));
  const reset = () => { setText(''); setSkip(new Set()); };
  const fields = () => ({ title: t.title, priority: (t.priority ?? 'Medium') as Priority, assigneeId: t.assignee?.id ?? '', dueDate: t.dueDate ?? '', estimatedHours: t.estimatedHours != null ? String(t.estimatedHours) : '' });
  const add = async () => {
    if (!t.title || busy) return;
    setBusy(true);
    try {
      const task = await taskApi.create(projectId, { title: t.title, priority: t.priority ?? 'Medium', assigneeId: t.assignee?.id ?? null, dueDate: t.dueDate ?? null, estimatedHours: t.estimatedHours ?? null });
      toast(`${task.key} added.`, 'success');
      invalidateWorkspace(wid, 'tasks'); invalidateWorkspace(wid, 'projects');
      reset();
    } catch (e) { toast(e instanceof ApiError ? e.message : 'Could not add the task.', 'error'); }
    finally { setBusy(false); }
  };

  const chips: { part: QuickPart; node: React.ReactNode }[] = [];
  if (t.assignee) chips.push({ part: 'assignee', node: <><Avatar name={t.assignee.name} userId={t.assignee.id} size="sm" />{t.assignee.name}</> });
  if (t.dueDate) chips.push({ part: 'due', node: <><Icon name="calendar" size={13} />Due {formatDate(t.dueDate)}</> });
  if (t.priority) chips.push({ part: 'priority', node: <><Icon name="flag" size={13} />{t.priority}</> });
  if (t.estimatedHours != null) chips.push({ part: 'estimate', node: <><Icon name="clock" size={13} />{t.estimatedHours} h</> });

  return (
    <>
      <form className="qa" onSubmit={(e) => { e.preventDefault(); void add(); }}>
        <div className="qa-box">
          <Icon name="plus" size={16} />
          <input value={text} onChange={(e) => { setText(e.target.value); if (!e.target.value) setSkip(new Set()); }} maxLength={300} disabled={busy}
            placeholder="Add a task, e.g. “Fix login bug for Ravi by Friday, high, 3h”" aria-label="Add a task in plain words"
            onKeyDown={(e) => { if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); if (t.title) setFull(fields()); } if (e.key === 'Escape') reset(); }} />
          {text && <button type="submit" className="btn btn-primary btn-sm" disabled={!t.title || busy}>{busy && <span className="spinner" />}Add</button>}
        </div>
        {text && (
          <div className="qa-preview" aria-live="polite">
            {t.title ? <span className="qa-title" title="Title"><b>{t.title}</b></span> : <span className="qa-hint">Type what needs doing…</span>}
            {chips.map((c) => (
              <span key={c.part} className="qa-chip">{c.node}<button type="button" aria-label={`Not the ${c.part === 'due' ? 'due date' : c.part}; keep those words in the title`} onClick={() => dismiss(c.part)}><Icon name="close" size={10} /></button></span>
            ))}
            <span className="qa-keys">Enter to add · Shift+Enter for the full form</span>
          </div>
        )}
      </form>
      {full && <TaskModal projectId={projectId} initial={full} onClose={() => { setFull(null); reset(); }} />}
    </>
  );
}
