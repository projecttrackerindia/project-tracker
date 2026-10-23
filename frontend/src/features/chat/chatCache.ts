import type { ChatMessage, ChatThread } from '../../api/types';
import { queryClient } from '../../stores/auth';
import { chatKeys } from './chatStore';

/** Writes a changed message into every open copy of it: the conversation, its thread (as the first message or a reply), the pinned list. */
export function putMessage(wid: string, m: ChatMessage) {
  queryClient.setQueryData<ChatThread>(chatKeys.thread(wid, m.conversationId), (old) => old && { ...old, items: old.items.map((x) => (x.id === m.id ? m : x)) });
  queryClient.setQueryData<{ root: ChatMessage; replies: ChatMessage[] }>(chatKeys.threadView(wid, m.id), (old) => old && { ...old, root: m });
  if (m.threadRootId) {
    queryClient.setQueryData<{ root: ChatMessage; replies: ChatMessage[] }>(chatKeys.threadView(wid, m.threadRootId), (old) => {
      if (!old) return old;
      return old.replies.some((x) => x.id === m.id) ? { ...old, replies: old.replies.map((x) => (x.id === m.id ? m : x)) } : { ...old, replies: [...old.replies, m] };
    });
  }
  void queryClient.invalidateQueries({ queryKey: chatKeys.pins(wid, m.conversationId) });
}
