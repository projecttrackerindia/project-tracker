import { deskAiApi, isObj, type WhatsAppThread } from '../../api/deskAiApi';
import { useWsQuery } from '../../lib/hooks';

/** The Desk's settings when the server has them (older servers and previews answer with nothing usable). */
export function useDeskSettings() {
  const q = useWsQuery(['desk', 'ai-settings'], () => deskAiApi.settings(), { staleTime: 60_000, retry: false });
  return isObj<NonNullable<typeof q.data>>(q.data) ? q.data : null;
}

/** The ticket's WhatsApp thread (the chat that raised it), or null when it did not come from WhatsApp. */
export function useWhatsAppThread(ticketId: string, enabled: boolean) {
  const q = useWsQuery(['desk', 'wa', ticketId], () => deskAiApi.whatsapp(ticketId), { staleTime: 15_000, refetchInterval: 30_000, retry: false, enabled });
  return isObj<WhatsAppThread>(q.data) && Array.isArray(q.data.messages) ? q.data : null;
}
