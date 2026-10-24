import { get, post } from '../../api/client';
import type { MeetingProvider } from '../../api/types';

export type Rsvp = 'Organizer' | 'Accepted' | 'Tentative' | 'Declined' | 'NeedsAction';

/**
 * One session of a meeting on the Meet page. `ref` is "p:{id}" (a project meeting) or "w:{id}" (a meeting for the workspace), the form the
 * links in notifications and reminders use (/meet?open=p:…). `joinUrl` is the Google Meet or Teams address, or this app's path for a
 * Project Tracker call. `notes`: the notetaker's state for this session when it came (scheduled, in_call, done, failed).
 */
export interface MeetItem {
  ref: string; kind: 'project' | 'workspace'; id: string; title: string; description: string | null; start: string; end: string; timeZone: string;
  projectId: string | null; projectName: string | null; projectKey: string | null; provider: MeetingProvider; providerName: string; joinUrl: string; calendarUrl: string | null;
  isScrum: boolean; recurring: boolean; sessionsLeft: number | null; notetaker: 'off' | 'transcript' | 'voice' | 'project'; myRsvp: Rsvp; isOrganizer: boolean; canManage: boolean;
  organizerName: string; invited: number; accepted: number; declined: number; status: string; notes: string | null; live: boolean;
}
export interface MeetFeed { items: MeetItem[]; from: string; to: string; truncated: boolean }
export interface NotetakerReadiness { available: boolean; reason: string | null; voiceAvailable: boolean; voiceReason: string | null; canSwitchOn: boolean }

export const meetApi = {
  feed: (p: { from?: string; to?: string; projectId?: string | null }) =>
    get<MeetFeed>('/meet', { from: p.from, to: p.to, projectId: p.projectId ?? undefined }),
  series: (projectId?: string | null) => get<MeetItem[]>('/meet/series', { projectId: projectId ?? undefined }),
  notetaker: (projectId: string) => get<NotetakerReadiness>('/meet/notetaker', { projectId }),
  rsvp: (item: Pick<MeetItem, 'kind' | 'id'>, response: 'accepted' | 'tentative' | 'declined') =>
    post<{ rsvp: string }>(`/meet/${item.kind === 'workspace' ? 'w' : 'p'}/${item.id}/rsvp`, { response }),
};

/** "p:{id}" / "w:{id}" from a link, or null. */
export function parseRef(ref: string | null): { kind: 'project' | 'workspace'; id: string } | null {
  const m = /^([pw]):([0-9a-f-]{36})$/i.exec(ref ?? '');
  return m ? { kind: m[1].toLowerCase() === 'w' ? 'workspace' : 'project', id: m[2] } : null;
}

/** Google Meet and Teams open in their own tab; a Project Tracker call opens here. */
export const isOurs = (i: Pick<MeetItem, 'provider'>) => i.provider === 'ours';
