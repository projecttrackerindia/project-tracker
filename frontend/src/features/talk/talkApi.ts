import { get } from '../../api/client';

export type TalkKind = 'chat' | 'mail' | 'meeting';
export type TalkFilter = 'all' | 'unread' | 'chat' | 'mail' | 'meetings';
export interface TalkAvatar { initials: string; userId: string | null; hasAvatar: boolean; square: boolean }
/** One row of Talk. A chat's id is its conversation id; mail is "mail:{message id}"; a meeting "meet:{p|w}:{id}". */
export interface TalkRow {
  id: string; kind: TalkKind; title: string; sub: string | null; last: string | null; at: string | null; unread: number; avatar: TalkAvatar;
  group: boolean; account: string | null; messageId: string | null; meetingRef: string | null; sessionStart: string | null; live: boolean; upcoming: boolean; joinUrl: string | null;
}
export interface TalkMailState { state: 'connected' | 'not-connected' | 'unavailable'; account: string | null; email: string | null; provider: string | null }
export interface TalkList { items: TalkRow[]; mail: TalkMailState; chatAvailable: boolean }

export const talkApi = {
  /** Chat, mail and meetings in one list, newest first (each thread keeps its own endpoints). */
  conversations: (f: TalkFilter = 'all') => get<TalkList>('/talk/conversations', { f }),
};
