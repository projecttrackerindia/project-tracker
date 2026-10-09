import { useEffect, useState } from 'react';
import { create } from 'zustand';
import type { PresenceStatus } from '../../api/types';

export type LinkState = 'connecting' | 'connected' | 'reconnecting' | 'offline';

interface Typing { name: string; until: number }
const TYPING_MS = 4000;

interface ChatState {
  /** State of the live connection, shown as a small banner when it is not connected. */
  link: LinkState;
  setLink: (l: LinkState) => void;
  /** Who has the app open (seeded from the server, then kept current by live "presence" events). */
  online: Record<string, boolean>;
  /** The same people with the finer status: active, away (open but idle) or offline. */
  status: Record<string, PresenceStatus>;
  seedOnline: (entries: { userId: string; online: boolean; status?: PresenceStatus }[]) => void;
  setOnline: (userId: string, online: boolean, status?: PresenceStatus) => void;
  /** conversation id → user id → who is typing right now. */
  typing: Record<string, Record<string, Typing>>;
  markTyping: (conversationId: string, userId: string, name: string) => void;
  clearTyping: (conversationId: string, userId: string) => void;
  /** The conversation on screen, so a message that arrives in it does not also raise a notification. */
  openConversation: string | null;
  setOpenConversation: (id: string | null) => void;
  reset: () => void;
}

/** An older server only says online or not. */
export const statusOf = (online: boolean): PresenceStatus => (online ? 'active' : 'offline');

export const PRESENCE_LABEL: Record<PresenceStatus, string> = { active: 'Active now', away: 'Away', offline: 'Offline' };

export const useChat = create<ChatState>((set) => ({
  link: 'connecting',
  setLink: (link) => set({ link }),
  online: {},
  status: {},
  seedOnline: (entries) => set((s) => {
    const next = { ...s.online };
    const nextStatus = { ...s.status };
    for (const e of entries) {
      if (e.userId in nextStatus) continue;   // live events are newer than a fetched snapshot
      next[e.userId] = e.online;
      nextStatus[e.userId] = e.status ?? statusOf(e.online);
    }
    return { online: next, status: nextStatus };
  }),
  setOnline: (userId, online, status) => set((s) => ({ online: { ...s.online, [userId]: online }, status: { ...s.status, [userId]: status ?? statusOf(online) } })),
  typing: {},
  markTyping: (conversationId, userId, name) => set((s) => ({
    typing: { ...s.typing, [conversationId]: { ...s.typing[conversationId], [userId]: { name, until: Date.now() + TYPING_MS } } },
  })),
  clearTyping: (conversationId, userId) => set((s) => {
    const room = { ...s.typing[conversationId] };
    delete room[userId];
    return { typing: { ...s.typing, [conversationId]: room } };
  }),
  openConversation: null,
  setOpenConversation: (openConversation) => set({ openConversation }),
  reset: () => set({ link: 'connecting', online: {}, status: {}, typing: {}, openConversation: null }),
}));

/** Names of the people typing in a conversation right now (entries fade after a few seconds without a new "typing" signal). */
export function useTypingNames(conversationId: string | null): string[] {
  const room = useChat((s) => (conversationId ? s.typing[conversationId] : undefined));
  const [, tick] = useState(0);
  const soonest = room ? Math.min(...Object.values(room).map((t) => t.until), Infinity) : Infinity;
  useEffect(() => {
    if (!Number.isFinite(soonest)) return;
    const id = window.setTimeout(() => tick((n) => n + 1), Math.max(50, soonest - Date.now() + 20));
    return () => window.clearTimeout(id);
  }, [soonest]);
  if (!room) return [];
  const now = Date.now();
  return Object.values(room).filter((t) => t.until > now).map((t) => t.name);
}

// Cache keys (every key starts with the workspace id, like the rest of the app).
export const chatKeys = {
  conversations: (wid: string) => [wid, 'chat', 'conversations'] as const,
  thread: (wid: string, id: string) => [wid, 'chat', 'thread', id] as const,
  files: (wid: string, id: string) => [wid, 'chat', 'files', id] as const,
  unread: (wid: string) => [wid, 'chat', 'unread'] as const,
  project: (wid: string, projectId: string) => [wid, 'chat', 'project', projectId] as const,
  projectUnread: (wid: string) => [wid, 'chat', 'project-unread'] as const,
  people: (wid: string) => [wid, 'chat', 'people'] as const,
  all: (wid: string) => [wid, 'chat'] as const,
};
