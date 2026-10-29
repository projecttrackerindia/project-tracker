import { get, post } from '../../api/client';
import type { TimeEntry } from '../../api/types';
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
  /** Daily, Weekly, Monthly, Custom or Ad hoc; the rule in words; where the rule put this session; how people join; the series it belongs to. */
  cadence?: string | null; recurrence?: string | null; originalStart?: string | null; video?: string | null; seriesRef?: string | null; agenda?: string | null;
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

// ------------------------------------------------------------------ meetings connected everywhere

export interface MeetingSession { start: string; end: string; originalStart: string; title: string; changed: boolean }
export interface MeetingSessions { ref: string; seriesRef: string; title: string; cadence: string; recurrence: string; sessions: MeetingSession[] }
export interface BusyBlock { start: string; end: string; kind: 'meeting' | 'leave' }
export interface PersonBusy { userId: string; name: string; busy: BusyBlock[]; freeAtSlot: boolean }
export interface FreeBusy { from: string; to: string; people: PersonBusy[]; everyoneFree: boolean; busyCount: number }
export interface TimeProposal {
  id: string; meetingRef: string; meetingId: string; meetingTitle: string; projectId: string; projectName: string; projectKey: string | null;
  start: string; end: string; minutes: number; status: string; billable: boolean; assignedToMe: number; overlap: string | null;
}
export interface UserRef { id: string; name: string }
export interface CapturePreview { title: string; owner: UserRef | null; ownerToken: string | null; ownerAmbiguous: boolean; due: string | null; dateToken: string | null; projectId: string | null; projectName: string | null }
export interface MeetingItemRow { id: string; key: string; title: string; owner: UserRef | null; dueDate: string | null; status: string; isOverdue: boolean; occurrenceStart: string | null }
export interface MeetingItems {
  meetingRef: string; seriesRef: string; title: string; cadence: string; recurrence: string; nextSession: string | null; previousSession: string | null;
  createdHere: MeetingItemRow[]; openInSeries: number; projectId: string | null; projectName: string | null;
}
export type ReviewDecisionKind = 'done' | 'carry' | 'replan' | 'convert' | 'drop';
export interface ReviewDecision { id: string; decision: ReviewDecisionKind; reason: string | null; by: UserRef | null; at: string; fromDue: string | null; toDue: string | null; fromOwner: UserRef | null; toOwner: UserRef | null; convertedTaskId: string | null; convertedKey: string | null }
export interface ReviewItem {
  id: string; key: string; title: string; projectId: string | null; projectName: string | null; owner: UserRef | null; dueDate: string | null; isOverdue: boolean; daysOverdue: number;
  state: 'open' | 'in_progress' | 'blocked' | 'done' | 'cancelled'; statusLabel: string; sourceTitle: string | null; sourceOccurrence: string | null; seriesRef: string | null;
  latestNote: string | null; lastUpdateAt: string | null; noUpdateDays: number; noUpdate: boolean; ownerLeft: boolean; canEdit: boolean; decision: ReviewDecision | null; createdAt: string;
}
export interface ReviewCounts { total: number; reviewed: number; done: number; inProgress: number; overdue: number; blocked: number; noUpdate: number }
export interface MinutesLine { group: 'decided' | 'carried' | 'replanned' | 'new' | 'dropped'; text: string; owner: UserRef | null; date: string | null; workItemId: string | null }
export interface Review {
  sessionId: string | null; scope: 'series' | 'all' | 'mine'; seriesRef: string | null; title: string; cadence: string; occurrence: string | null; previousSession: string | null; nextSession: string | null;
  attendees: number; counts: ReviewCounts; items: ReviewItem[]; finished: boolean; sent: boolean; draft: MinutesLine[]; projectId: string | null;
}
export interface Minutes {
  sessionId: string; title: string; occurrence: string; nextSession: string | null; reviewed: number; total: number; durationMinutes: number; done: number; carried: number;
  replanned: number; dropped: number; new: number; reassignedCount: number; redatedCount: number; lines: MinutesLine[]; text: string; sent: boolean; attendees: number;
}
export interface MyActionItems { needsUpdate: ReviewItem[]; dueThisWeek: ReviewItem[]; waitingOnOthers: ReviewItem[]; done: ReviewItem[]; series: { seriesRef: string; title: string; cadence: string; nextSession: string | null }[] }
export type OwnerSignal = 'on_track' | 'need_help' | 'move_date' | 'done' | 'note';
export type OccurrenceScope = 'this' | 'following' | 'all';

const path = (ref: string) => ref.replace(':', '/');

export const connectApi = {
  sessions: (ref: string, from?: string, to?: string) => get<MeetingSessions>(`/meet/${path(ref)}/sessions`, { from, to }),
  changeOccurrence: (ref: string, b: { occurrenceStart: string; scope: OccurrenceScope; startTime?: string; endTime?: string; title?: string; cancel?: boolean }) =>
    post<{ scope: string; ref: string; start: string | null; end: string | null; newSeriesRef: string | null }>(`/meet/${path(ref)}/occurrence`, b),
  freeBusy: (p: { userIds?: string[]; teamIds?: string[]; from: string; to: string; slotStart?: string; slotEnd?: string }) =>
    get<FreeBusy>('/meet/free-busy', { userIds: p.userIds?.join(',') || undefined, teamIds: p.teamIds?.join(',') || undefined, from: p.from, to: p.to, slotStart: p.slotStart, slotEnd: p.slotEnd }),
  proposals: () => get<TimeProposal[]>('/meet/time-proposals'),
  log: (id: string, b: { minutes?: number; note?: string; billable?: boolean }) => post<TimeEntry>(`/meet/time-proposals/${id}/log`, b),
  later: (id: string) => post(`/meet/time-proposals/${id}/later`, {}),
  dismiss: (id: string, reason = 'didnt_attend') => post(`/meet/time-proposals/${id}/dismiss`, { reason }),
  preview: (ref: string, b: { text: string; projectId?: string; occurrenceStart?: string }) => post<CapturePreview>(`/meet/${path(ref)}/capture/preview`, b),
  capture: (ref: string, b: { text: string; projectId?: string; occurrenceStart?: string; assigneeId?: string; dueDate?: string }) =>
    post<{ item: { id: string; key: string; title: string }; meetingRef: string; seriesRef: string; occurrenceStart: string | null }>(`/meet/${path(ref)}/capture`, b),
  items: (ref: string, occurrence?: string | null) => get<MeetingItems>(`/meet/${path(ref)}/items`, { occurrence: occurrence ?? undefined }),
  openReview: (b: { scope: 'series' | 'all' | 'mine'; seriesRef?: string | null; occurrence?: string | null }) => post<Review>('/meet/review', b),
  decide: (sessionId: string, b: { workItemId: string; decision: ReviewDecisionKind; reason?: string; ownerId?: string; dueDate?: string; clearOwner?: boolean }) => post<Review>(`/meet/review/${sessionId}/decide`, b),
  undo: (sessionId: string, decisionId?: string) => post<Review>(`/meet/review/${sessionId}/undo`, { decisionId }),
  finish: (sessionId: string) => post<Minutes>(`/meet/review/${sessionId}/finish`, {}),
  send: (sessionId: string, text: string) => post<Minutes>(`/meet/review/${sessionId}/send`, { text }),
  nudge: (workItemId: string) => post(`/meet/action-items/${workItemId}/nudge`, {}),
  update: (workItemId: string, note: string, signal: OwnerSignal) => post(`/meet/action-items/${workItemId}/update`, { note, signal }),
  mine: () => get<MyActionItems>('/meet/my-action-items'),
};
