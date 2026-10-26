import { PlaceTabs } from '../../components/v2/PlaceTabs';
import { useTabParam } from '../../components/v2/state';
import { useAuth, useIsPersonal, useModule } from '../../stores/auth';
import { useAi } from '../ai/Assistant';
import { AgentPage, type AgentSection } from '../agent/AgentPage';
import { AiPage } from '../ai/AiPage';
import { CalendarPage } from '../calendar/CalendarPage';
import { CommandCenterPage } from '../command/CommandCenterPage';
import { DashboardPage } from '../dashboard/DashboardPage';
import { RemindersPage } from '../reminders/RemindersPage';

const AGENT: Record<string, AgentSection> = { proposals: 'review', given: 'assigned', 'mail-agent': 'my-inbox' };
const AGENT_TAB: Record<AgentSection, 'proposals' | 'given' | 'mail-agent'> = { review: 'proposals', assigned: 'given', 'my-inbox': 'mail-agent' };

/**
 * PLACEHOLDER (v2 shell, wave 1): Home with its two tabs, For you · Calendar, showing today's pages until the Home builder's inbox and week
 * view replace this file. Contract: export `HomePage`; `/?tab=calendar` opens Calendar; `/?c=<id>` is the assistant's conversation.
 * Until the inbox carries their rows, two old pages are reachable here too: the project agent's proposals at `/?tab=proposals|given|mail-agent`
 * (where /project-agent, /project-agent/assigned and /project-agent/my-inbox lead) and the reminders list at `/?tab=reminders` (/reminders).
 * `/?tab=assistant` (where /ai leads) is the assistant's full page: for people whose Home is not the AI-first one it is the only full-page
 * assistant (everyone also has the Ask bar); for the others it lands on the AI-first Home.
 */
export function HomePage() {
  const mProjects = useModule('projects') > 0, mCalendar = useModule('calendar') > 0;
  const guest = useAuth((s) => s.ctx?.current?.role === 'Guest');
  const personal = useIsPersonal();
  const ai = useAi();
  const agent = mProjects && !personal && !guest && ai;
  const tabs = [{ id: 'foryou' as const, label: 'For you' }, ...(mCalendar ? [{ id: 'calendar' as const, label: 'Calendar' }] : [])];
  const [tab, setTab] = useTabParam([...tabs.map((t) => t.id), 'reminders' as const, ...(ai ? (['assistant'] as const) : []), ...(agent ? (['proposals', 'given', 'mail-agent'] as const) : [])], 'foryou');
  const section = AGENT[tab];
  return (
    <>
      {(tab === 'foryou' || tab === 'calendar') && <PlaceTabs label="Home" options={tabs} value={tab} onChange={setTab} />}
      {section ? <AgentPage section={section} onSection={(s) => setTab(AGENT_TAB[s])} />
        : tab === 'reminders' ? <RemindersPage />
        : tab === 'assistant' ? <AiPage />
        : tab === 'calendar' ? <CalendarPage /> : mProjects && !guest ? <CommandCenterPage /> : <DashboardPage />}
    </>
  );
}
