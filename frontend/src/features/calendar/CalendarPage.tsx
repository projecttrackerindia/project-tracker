import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageHead } from '../../components/ui';
import { usePersonPicker } from '../../lib/hooks';
import { useAuth } from '../../stores/auth';
import { TaskModal } from '../tasks/TaskModal';
import { CalendarView } from './CalendarView';
import { Select } from '../../components/Select';

/** Regular users only ever see their own calendar; managers/admins can additionally pick someone in their reach. */
export function CalendarPage() {
  const nav = useNavigate();
  const me = useAuth((s) => s.ctx!.user);
  const [mine, setMine] = useState(false);
  const [userId, setUserId] = useState('');
  const [modal, setModal] = useState<{ id?: string } | null>(null);
  const { canPick, choices } = usePersonPicker();

  return (
    <>
      <PageHead title="Calendar" sub="Tasks, project deadlines and lifecycle stages by date">
        <div className="cal-filters">
          {canPick && (
            <Select className="select" value={userId} onChange={(e) => setUserId(e.target.value)} aria-label="Person">
              <option value="">Everyone I can see</option>
              <option value={me.id}>{me.displayName} (me)</option>
              {choices.filter((c) => c.id !== me.id).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          )}
          {!userId && <label className="cal-mine"><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Only my tasks</label>}
        </div>
      </PageHead>
      <CalendarView mine={mine} userId={userId || undefined} onOpenTask={(taskId, projectId) => { if (projectId) nav(`/projects/${projectId}?task=${taskId}`); else setModal({ id: taskId }); }} />
      {modal && <TaskModal taskId={modal.id} onClose={() => setModal(null)} />}
    </>
  );
}
