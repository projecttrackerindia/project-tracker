const DAY = 24 * 60 * 60 * 1000;
const dayStart = (d = new Date()) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };

/** "14:00": Meetings reads in the 24-hour clock, as the design. */
export const hm = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });

/** "Today", "Yesterday", "Tomorrow", "Mon" (within a week), or "29 Oct". */
export const dayWord = (iso: string) => {
  const diff = Math.round((dayStart(new Date(iso)).getTime() - dayStart().getTime()) / DAY);
  if (diff === 0) return 'Today';
  if (diff === -1) return 'Yesterday';
  if (diff === 1) return 'Tomorrow';
  if (diff > -7 && diff < 7) return new Date(iso).toLocaleDateString('en-GB', { weekday: 'short' });
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
};
