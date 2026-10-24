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

/**
 * The person just wrote something: any question to them before it, at the same level (the conversation, or that thread), is answered -
 * the server's rule. Clears the ❓ marks at once and has the "Waiting for your answer" list fetched again.
 */
export function markAnswered(wid: string, mine: ChatMessage) {
  const answers = (x: ChatMessage) => !!x.asksMe && x.createdAt <= mine.createdAt
    && ((x.threadRootId ?? null) === (mine.threadRootId ?? null) || (!x.threadRootId && mine.threadRootId === x.id));
  queryClient.setQueryData<ChatThread>(chatKeys.thread(wid, mine.conversationId), (old) => old && { ...old, items: old.items.map((x) => (answers(x) ? { ...x, asksMe: false } : x)) });
  if (mine.threadRootId) {
    queryClient.setQueryData<{ root: ChatMessage; replies: ChatMessage[] }>(chatKeys.threadView(wid, mine.threadRootId), (old) => old && {
      ...old, root: answers(old.root) ? { ...old.root, asksMe: false } : old.root, replies: old.replies.map((x) => (answers(x) ? { ...x, asksMe: false } : x)),
    });
  }
  void queryClient.invalidateQueries({ queryKey: chatKeys.questions(wid) });
}

