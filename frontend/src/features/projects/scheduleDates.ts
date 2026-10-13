/** Date-only arithmetic uses UTC day numbers so timezone and DST never shift a plan. */
export function calendarDay(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000-')) return null;
  const parsed = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value ? parsed / 86400000 : null;
}
export function calendarDuration(start: string, end: string): number | null {
  const a = calendarDay(start), b = calendarDay(end);
  return a === null || b === null ? null : b - a;
}
export function calendarEnd(start: string, duration: number): string {
  const day = calendarDay(start);
  if (day === null || !Number.isInteger(duration) || duration < 0 || duration > 36500) return '';
  const date = new Date((day + duration) * 86400000).toISOString();
  return /^\d{4}-/.test(date) ? date.slice(0, 10) : '';
}
