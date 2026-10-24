import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PageHead } from '../../components/ui';
import { usePersonPicker } from '../../lib/hooks';
import { useAuth } from '../../stores/auth';
import { TaskModal } from '../tasks/TaskModal';
import { WorkTaskModal } from '../work/WorkTaskModal';
import { CalendarView } from './CalendarView';
import { CalendarSubscribe } from '../settings/IntegrationSettings';
import { Select } from '../../components/Select';
import { microsoftApi, personalCalendarApi } from '../../api/endpoints';
import { useWsQuery } from '../../lib/hooks';
import { OutlookAvailability } from '../settings/OutlookAvailability';
import { PersonalCalendarProposals } from '../settings/PersonalCalendarProposals';

/** Regular users only ever see their own calendar; managers/admins can additionally pick someone in their reach. */
export function CalendarPage() {
  const nav = useNavigate();
  const me = useAuth((s) => s.ctx!.user);
  const [mine, setMine] = useState(false);
  const [userId, setUserId] = useState('');
  const [modal, setModal] = useState<{ id?: string } | null>(null);
  const [work, setWork] = useState<string | null>(null);
  const { canPick, choices } = usePersonPicker();

  return (
    <>
      <PageHead title="Calendar" sub="Tasks, action items, operational work, deadlines, stages and meetings by date">
        <div className="cal-filters">
          {canPick && (
            <Select className="select" value={userId} onChange={(e) => setUserId(e.target.value)} aria-label="Person">
              <option value="">Everyone I can see</option>
              <option value={me.id}>{me.displayName} (me)</option>
              {choices.filter((c) => c.id !== me.id).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          )}
          {!userId && <label className="cal-mine"><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Only my work</label>}
          <CalendarSubscribe />
        </div>
      </PageHead>
      <CalendarView mine={mine} userId={userId || undefined} onOpenTask={(taskId, projectId) => { if (projectId) nav(`/projects/${projectId}?task=${taskId}`); else setModal({ id: taskId }); }} onOpenWork={setWork} />
      <CalendarPlanning />
      {modal && <TaskModal taskId={modal.id} onClose={() => setModal(null)} />}
      {work && <WorkTaskModal taskId={work} onClose={() => setWork(null)} />}
    </>
  );
}

/**
 * Planning with your own calendars, under the calendar it belongs to: Outlook free/busy, and private time blocks for your Google
 * Calendar. Each shows only when it can be used here (set up by the administrator), never as an "awaiting setup" box.
 */
function CalendarPlanning() {
  const ms = useWsQuery(['account', 'microsoft-status'], microsoftApi.status, { staleTime: 60_000 });
  const gcal = useWsQuery(['account', 'calendar-options'], personalCalendarApi.options, { staleTime: 60_000 });
  const outlook = !!ms.data?.enabled && !!ms.data.configured && !!ms.data.calendarsEnabled;
  const google = !!gcal.data?.enabled;
  if (!outlook && !google) return null;
  return (
    <section className="cal-planning" aria-label="Plan with your calendars" style={{ display: 'grid', gap: 16, marginTop: 22 }}>
      {outlook && <OutlookAvailability />}
      {google && <PersonalCalendarProposals />}
    </section>
  );
}
