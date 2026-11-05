import { lazy, Suspense, type ComponentType, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { AgentSection } from '../agent/AgentPage';
import { PageLoader } from '../../components/ui';
import { useIsSmallPhone } from '../../lib/mobile';
import { CalmToday } from './CalmToday';
import { useClassic } from '../calm/classic';
import type { Tab, View } from './HomeClassic';
import './home.css';

/**
 * Only Today (CalmToday) is in the page's own file: it is what the app opens on, so it is what the first visit waits for. The classic
 * For me / My team view, the week calendar and the older pages still reached from Home's links each load when they are first opened.
 */
function part<K extends string>(load: () => Promise<Record<K, ComponentType<any>>>, name: K) {
  return lazy(() => load().then((m) => ({ default: m[name] })));
}
const AgentPage = part(() => import('../agent/AgentPage'), 'AgentPage');
const AiPage = part(() => import('../ai/AiPage'), 'AiPage');
const RemindersPage = part(() => import('../reminders/RemindersPage'), 'RemindersPage');
const CommandCenterPage = part(() => import('../command/CommandCenterPage'), 'CommandCenterPage');
const PhoneToday = part(() => import('./PhoneToday'), 'PhoneToday');
const ForYou = part(() => import('./HomeClassic'), 'ForYou');
const WeekCalendar = part(() => import('./HomeClassic'), 'WeekCalendar');
const Wait = ({ children }: { children: ReactNode }) => <Suspense fallback={<PageLoader />}>{children}</Suspense>;

/**
 * Home: "For me" (the briefing, your day, what needs you, up next and four numbers), "My team" (the same with the team's meetings) and
 * "Calendar" (the week; from the sidebar's Calendar, or the phone's tab). Tabs never leave Home; links with › do.
 */
const AGENT: Record<string, AgentSection> = { proposals: 'review', given: 'assigned', 'mail-agent': 'my-inbox' };
const COMMAND_TABS = ['today', 'decisions', 'audit', 'dashboard', 'work'];
const AGENT_TAB: Record<AgentSection, string> = { review: 'proposals', assigned: 'given', 'my-inbox': 'mail-agent' };

export function HomePage() {
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab') ?? '';
  // Pages that have no place of their own any more but are still reached from old links and the inbox: the project agent's proposals,
  // the reminders list, and the assistant's full page (also where an assistant conversation, ?c=<id>, opens).
  if (AGENT[raw]) return <Wait><AgentPage section={AGENT[raw]} onSection={(sec: AgentSection) => setParams({ tab: AGENT_TAB[sec] }, { replace: true })} /></Wait>;
  if (raw === 'reminders') return <Wait><RemindersPage /></Wait>;
  if (raw === 'assistant' || params.has('c')) return <Wait><AiPage /></Wait>;
  // The former Command Center's views (Today with check-ins, the brief and "what if", Decisions, the agent's audit trail, the dashboard, My
  // work), and the deep links notifications still carry (/command-center?checkin=… arrives here with its query).
  if (COMMAND_TABS.includes(raw) || ['checkin', 'delegate', 'brief', 'delegation'].some((k) => params.has(k))) return <Wait><CommandCenterPage /></Wait>;
  const tab: Tab = raw === 'calendar' ? 'calendar' : 'for-you';
  const view: View = params.get('view') === 'team' ? 'team' : 'me';
  const setTab = (t: Tab, v: View = 'me') => setParams((p) => {
    const n = new URLSearchParams(p);
    if (t === 'for-you') n.delete('tab'); else n.set('tab', t);
    if (t === 'for-you' && v === 'team') n.set('view', 'team'); else n.delete('view');
    return n;
  }, { replace: true });
  if (tab === 'calendar') return <Wait><WeekCalendar onTab={setTab} /></Wait>;
  return <ForYouOrPhone view={view} onTab={setTab} />;
}

/** A phone held upright gets the phone's own Today (apple/s-mobile, s-phone); My team stays the full view. */
function ForYouOrPhone({ view, onTab }: { view: View; onTab: (t: Tab, v?: View) => void }) {
  const small = useIsSmallPhone();
  const classic = useClassic();
  if (view === 'me' && !classic) return <CalmToday />;
  return <Wait>{small && view === 'me' ? <PhoneToday /> : <ForYou view={view} onTab={onTab} />}</Wait>;
}


