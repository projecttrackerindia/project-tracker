import { useParams, useSearchParams } from 'react-router-dom';
import { PlaceTabs } from '../../components/v2/PlaceTabs';
import { useTabParam } from '../../components/v2/state';
import { useAuth, useIsPersonal } from '../../stores/auth';
import { ChatPage } from '../chat/ChatPage';
import { MailboxPage } from '../mailbox/MailboxPage';
import { MeetPage } from '../meet/MeetPage';

type MeetSection = 'upcoming' | 'series' | 'past' | 'notetaker';
const MEET: readonly MeetSection[] = ['upcoming', 'series', 'past', 'notetaker'];

/**
 * PLACEHOLDER (v2 shell, wave 1): Talk with its filters All · Chat · Mail · Meetings, showing today's Chat, Mailbox and Meet until the Talk
 * builder's one list replaces this file. Contract: export `TalkPage`; `/talk?f=mail|meetings|chat`; `/talk/:id` opens a conversation;
 * `/talk?f=meetings&new=schedule` schedules one; `&s=past|series|notetaker` is a meetings section.
 */
export function TalkPage() {
  const { conversationId: id } = useParams();
  const [params] = useSearchParams();
  const personal = useIsPersonal();
  const guest = useAuth((s) => s.ctx?.current?.role === 'Guest');
  const canChat = !personal && !guest;
  const tabs = [...(canChat ? [{ id: 'all' as const, label: 'All' }, { id: 'chat' as const, label: 'Chat' }] : []), { id: 'mail' as const, label: 'Mail' }, { id: 'meetings' as const, label: 'Meetings' }];
  const [f, setF] = useTabParam(tabs.map((t) => t.id), canChat ? 'all' : 'mail', 'f');
  const s = params.get('s') as MeetSection | null;
  if (id && canChat) return <ChatPage />;
  return (
    <>
      <PlaceTabs label="Talk" options={tabs} value={f} onChange={setF} />
      {f === 'mail' ? <MailboxPage /> : f === 'meetings' ? <MeetPage section={s && MEET.includes(s) ? s : 'upcoming'} /> : <ChatPage />}
    </>
  );
}
