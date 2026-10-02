import { create } from 'zustand';
import { useWsQuery, invalidateWorkspace } from '../../lib/hooks';
import { reminderApi, type Reminder, type ReminderSubject } from './api';

/** What the reminder form opens with: words typed elsewhere, the work it is about, or a reminder to change. */
export interface ComposerDraft { text?: string; subject?: ReminderSubject; editing?: Reminder; forUserId?: string }

/** The one reminder form, opened from anywhere: the Reminders page, "Remind me" on a task, the command palette, the assistant box. */
export const useReminderComposer = create<{ draft: ComposerDraft | null; open: (d?: ComposerDraft) => void; close: () => void }>((set) => ({
  draft: null,
  open: (d = {}) => set({ draft: d }),
  close: () => set({ draft: null }),
}));

export const openReminderComposer = (d?: ComposerDraft) => useReminderComposer.getState().open(d);

/** How many reminders need attention now (the sidebar badge) - kept fresh by live events and a slow poll. */
export function useReminderCounts(enabled = true) {
  return useWsQuery(['reminders', 'counts'], reminderApi.counts, { refetchInterval: 30_000, staleTime: 15_000, enabled });
}

export const refreshReminders = (wid: string | null | undefined) => invalidateWorkspace(wid, 'reminders');
