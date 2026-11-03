import type { DeskAssignment } from '../../api/deskAiApi';

/** 540 → "09:00"; null → "". */
export const toTime = (m: number | null) => (m == null ? '' : `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
/** "09:30" → 570; anything else → null. */
export const fromTime = (s: string) => { const [h, m] = s.split(':').map(Number); return Number.isFinite(h) && Number.isFinite(m) && s.includes(':') ? h * 60 + m : null; };

/** What the assignment panel says about acceptance, and its tone. */
export function acceptState(a: Pick<DeskAssignment, 'acceptDueAt' | 'acceptedAt' | 'escalatedAt'> | null, now: number): { text: string; tone: '' | 'ok' | 'warn' | 'late' } | null {
  if (!a) return null;
  if (a.acceptedAt) return { text: `Accepted ${new Date(a.acceptedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}`, tone: 'ok' };
  if (a.acceptDueAt) {
    const left = Math.round((Date.parse(a.acceptDueAt) - now) / 60e3);
    return left <= 0 ? { text: 'Not accepted — escalating', tone: 'late' } : { text: `Accept within ${left}m`, tone: left <= 3 ? 'warn' : '' };
  }
  return a.escalatedAt ? { text: 'Escalated to the supervisor', tone: 'late' } : null;
}
