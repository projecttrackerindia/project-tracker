import { PlaceTabs } from '../../components/v2/PlaceTabs';
import { useTabParam } from '../../components/v2/state';
import { useAuth, useModule } from '../../stores/auth';
import { CalendarPage } from '../calendar/CalendarPage';
import { CommandCenterPage } from '../command/CommandCenterPage';
import { DashboardPage } from '../dashboard/DashboardPage';

/**
 * PLACEHOLDER (v2 shell, wave 1): Home with its two tabs, For you · Calendar, showing today's pages until the Home builder's inbox and week
 * view replace this file. Contract: export `HomePage`; `/?tab=calendar` opens Calendar; `/?c=<id>` is the assistant's conversation.
 */
export function HomePage() {
  const mProjects = useModule('projects') > 0, mCalendar = useModule('calendar') > 0;
  const guest = useAuth((s) => s.ctx?.current?.role === 'Guest');
  const tabs = [{ id: 'foryou' as const, label: 'For you' }, ...(mCalendar ? [{ id: 'calendar' as const, label: 'Calendar' }] : [])];
  const [tab, setTab] = useTabParam(tabs.map((t) => t.id), 'foryou');
  return (
    <>
      <PlaceTabs label="Home" options={tabs} value={tab} onChange={setTab} />
      {tab === 'calendar' ? <CalendarPage /> : mProjects && !guest ? <CommandCenterPage /> : <DashboardPage />}
    </>
  );
}
