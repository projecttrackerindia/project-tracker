import { create } from 'zustand';

/**
 * What the one schedule sheet opens with, from wherever it was asked for: the Aura chip (the sentence typed, read into the fields), a
 * Calendar drag (the start and length), a project (the project), My Work or Messages (nothing in particular).
 */
export interface ScheduleOpen {
  title?: string | null;
  /** The words typed into Aura, shown as "✦ From Aura: …". */
  aura?: string | null;
  project?: { id: string; name: string } | null;
  /** ISO instant the meeting starts at, and its length. */
  start?: string | null;
  minutes?: number | null;
  repeat?: 'Once' | 'Daily' | 'Weekly' | 'Monthly' | null;
  /** Names said in the sentence ("Mira", "AutoPay team"), matched to people and teams once the lists load. */
  people?: string[];
  agenda?: string | null;
  kind?: 'meeting' | 'scrum';
}

export const useScheduleSheet = create<{ open: ScheduleOpen | null; show: (o?: ScheduleOpen) => void; close: () => void }>((set) => ({
  open: null,
  show: (o = {}) => set({ open: o }),
  close: () => set({ open: null }),
}));

/** Opens the schedule sheet from anywhere. */
export const openSchedule = (o?: ScheduleOpen) => useScheduleSheet.getState().show(o ?? {});
