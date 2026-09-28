import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import { checklistApi } from '../../api/endpoints';
import type { Checklist as ChecklistData } from '../../api/types';
import { Icon } from '../../components/Icon';
import { Progress } from '../../components/ui';
import { useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';

/** The steps of a task. Tick them off, rename by clicking the text, reorder with the arrows. */
export function Checklist({ taskId, canEdit }: { taskId: string; canEdit: boolean }) {
  const wid = useWorkspaceId();
  const qc = useQueryClient();
  const q = useWsQuery(['task', taskId, 'checklist'], () => checklistApi.get(taskId));
  const [text, setText] = useState('');
  const [editing, setEditing] = useState<{ id: string; title: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const data = q.data;

  const apply = async (fn: () => Promise<ChecklistData>) => {
    setBusy(true);
    try {
      const next = await fn();
      qc.setQueryData([wid, 'task', taskId, 'checklist'], next);
      // Cards and lists show "2/5": refresh the task figures too.
      void qc.invalidateQueries({ queryKey: [wid, 'tasks'] });
      void qc.invalidateQueries({ queryKey: [wid, 'project'] });
    } catch (e) { toast(e instanceof ApiError ? e.errors[0]?.message ?? e.message : 'Could not update the checklist.', 'error'); }
    finally { setBusy(false); }
  };

  const add = async () => {
    const title = text.trim();
    if (!title) return;
    await apply(() => checklistApi.add(taskId, title));
    setText('');
  };
  const move = (from: number, to: number) => {
    if (!data || to < 0 || to >= data.items.length) return;
    const ids = data.items.map((i) => i.id);
    [ids[from], ids[to]] = [ids[to], ids[from]];
    void apply(() => checklistApi.reorder(taskId, ids));
  };
  const saveEdit = async () => {
    if (!editing) return;
    const { id, title } = editing;
    setEditing(null);
    const current = data?.items.find((i) => i.id === id);
    if (!title.trim() || title.trim() === current?.title) return;
    await apply(() => checklistApi.update(taskId, id, { title: title.trim() }));
  };

  if (q.isLoading) return null;
  if (!data || (data.total === 0 && !canEdit)) return null;

  return (
    <div className="checklist">
      <div className="checklist-head">
        <h4><Icon name="check" size={15} /> Checklist</h4>
        {data.total > 0 && <span className="muted" style={{ fontSize: 12.5 }}>{data.done}/{data.total}</span>}
      </div>
      {data.total > 0 && <Progress value={data.progress} />}
      <div className="checklist-items">
        {data.items.map((i, idx) => (
          <div className={`checklist-item ${i.isDone ? 'done' : ''}`} key={i.id}>
            <input type="checkbox" checked={i.isDone} disabled={!canEdit || busy} aria-label={`Mark “${i.title}” ${i.isDone ? 'not done' : 'done'}`}
              onChange={(e) => void apply(() => checklistApi.update(taskId, i.id, { isDone: e.target.checked }))} />
            {editing?.id === i.id ? (
              <input className="input checklist-edit" autoFocus maxLength={200} value={editing.title} onChange={(e) => setEditing({ id: i.id, title: e.target.value })}
                onBlur={() => void saveEdit()} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void saveEdit(); } if (e.key === 'Escape') setEditing(null); }} />
            ) : (
              <span className="checklist-text" onClick={() => canEdit && setEditing({ id: i.id, title: i.title })} title={canEdit ? 'Click to rename' : undefined}>{i.title}</span>
            )}
            {canEdit && (
              <span className="checklist-actions">
                <button type="button" className="btn-icon" aria-label="Move up" disabled={idx === 0 || busy} onClick={() => move(idx, idx - 1)}><Icon name="chevronD" size={13} style={{ transform: 'rotate(180deg)' }} /></button>
                <button type="button" className="btn-icon" aria-label="Move down" disabled={idx === data.items.length - 1 || busy} onClick={() => move(idx, idx + 1)}><Icon name="chevronD" size={13} /></button>
                <button type="button" className="btn-icon danger" aria-label={`Delete “${i.title}”`} disabled={busy} onClick={() => void apply(() => checklistApi.remove(taskId, i.id))}><Icon name="trash" size={13} /></button>
              </span>
            )}
          </div>
        ))}
      </div>
      {canEdit && (
        <div className="checklist-add">
          <input className="input" placeholder="Add an item and press Enter" maxLength={200} value={text} onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void add(); } }} />
          <button type="button" className="btn btn-ghost btn-sm" disabled={busy || !text.trim()} onClick={() => void add()}>Add</button>
        </div>
      )}
    </div>
  );
}
