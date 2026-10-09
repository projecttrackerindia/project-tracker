import type { PresenceStatus } from '../../api/types';
import { PRESENCE_LABEL, statusOf, useChat } from './chatStore';

/** What the server last said about a person (an older server only says online or not). */
export const fallbackStatus = (p: { online: boolean; status?: PresenceStatus }): PresenceStatus => p.status ?? statusOf(p.online);

/** A person's status: the live one when we have it, otherwise what the server said when it was last asked. */
export function usePresence(userId: string | null | undefined, fallback: PresenceStatus): PresenceStatus {
  return useChat((s) => (userId ? s.status[userId] : undefined)) ?? fallback;
}

/** The small dot on an avatar: green when active, amber when away, nothing when offline. */
export function PresenceDot({ status }: { status: PresenceStatus }) {
  if (status === 'offline') return null;
  return <i className={`presence-dot ${status}`} role="img" aria-label={PRESENCE_LABEL[status]} />;
}
