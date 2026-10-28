/**
 * One set of definitions for the words the app uses as numbers and states, so "at risk" or "logged" means the same on Today, Calendar, Time,
 * Projects and Library. <Term> (components/Term) shows the definition on hover and focus; the words themselves stay the screen's own.
 */
export const GLOSSARY = {
  'at risk': 'A project is at risk when its progress is more than 15 points behind the time elapsed, it is due within 7 days and under 85% done, or its owner set it at risk by hand.',
  overdue: 'Open work whose due date is before today. Finished and cancelled work is never overdue.',
  'needs you': 'Things only you can act on: work assigned to you, decisions and approvals waiting for you, mentions and your reminders. Team and portfolio signals are listed separately.',
  open: 'Work not yet finished or cancelled: To do, In progress or On hold.',
  logged: 'Time entered on your timesheet (typed in or from a timer that has stopped). A running timer is counted once it stops.',
  submitted: 'A week sent to your manager for approval. It is locked until it is approved or returned.',
  approved: 'A week your manager accepted. It stays locked; reopening it needs your manager.',
  'never published': 'A document with a draft but no published version: readers see nothing until it is published.',
  'free time': 'Working hours with no meeting, call or focus block, inside your working day.',
  target: 'Your weekly capacity (set in People, 40h when not set) over five working days, less planned leave and holidays.',
  coverage: 'The share of a project’s documented endpoints with at least one linked test case that passed in the last 30 days.',
} as const;

export type GlossaryKey = keyof typeof GLOSSARY;

export const define = (k: GlossaryKey): string => GLOSSARY[k];
