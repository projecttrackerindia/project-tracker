import type { MailRow } from './useMail';
import { addressOf } from '../mailbox/mailboxApi';

const RE_BULK_FROM = /(^|[._+-])(no-?reply|do-?not-?reply|donotreply|newsletters?|news|notifications?|notify|alerts?|mailer(-daemon)?|marketing|promo(tions)?|updates?|digest|bounces?|info|hello|team|support|billing|offers?)([._+-]|@)/i;
const RE_BULK_BODY = /\b(unsubscribe|view (this|it) in (your|a) browser|manage (your )?(email )?preferences|you are receiving this|newsletter|webinar|% off|limited time offer)\b/i;

/** Newsletters, no-reply senders and bulk mail go to Other; people stay in Focused. */
export function isBulk(r: Pick<MailRow, 'from' | 'subject' | 'snippet'>): boolean {
  const a = addressOf(r.from).toLowerCase();
  return RE_BULK_FROM.test(a) || RE_BULK_BODY.test(`${r.subject} ${r.snippet}`);
}

/** The assistant's order: urgent first, then mail waiting for your reply, then unread, then the rest. */
export function aiRank(r: Pick<MailRow, 'priority' | 'tags' | 'unread'>): number {
  return (r.priority === 'high' ? 0 : r.priority === 'low' ? 6 : 3) + (r.tags.includes('needs-reply') ? 0 : 2) + (r.unread ? 0 : 1);
}

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Who owns an action item and when it is due, read from its wording ("Leo to confirm the fix by Wed"). */
export function actionMeta(text: string, people: string[], now = new Date()): { title: string; owner: string | null; due: string | null; dueIso: string | null } {
  let owner: string | null = null;
  const lead = text.match(/^\s*([A-Z][a-z]+)(?:\s+[A-Z][a-z]+)?\s*(?::|—|-|to|will|should|must|needs to)\s/);
  const firsts = people.map((p) => p.split(/\s+/)[0]).filter((f) => f.length > 1);
  if (/^\s*(you|your|we|i)\b/i.test(text) || /\b(you|your team)\b/i.test(text)) owner = 'You';
  else if (lead && firsts.includes(lead[1])) owner = lead[1];
  else { const hit = firsts.find((f) => new RegExp(`\\b(with|from|by|ask|for)\\s+${f}\\b`).test(text)) ?? firsts.find((f) => new RegExp(`\\b${f}\\b`).test(text)); if (hit) owner = /^\s*(confirm|book|send|share|reply|follow|check|review|add|update|schedule|call|ask|chase)\b/i.test(text) ? 'You' : hit; }
  if (!owner && /^\s*(confirm|book|send|share|reply|follow|check|review|add|update|schedule|call|ask|chase|prepare|export)\b/i.test(text)) owner = 'You';
  let due: Date | null = null; let label: string | null = null;
  const t = text.toLowerCase();
  if (/\b(today|eod|end of day)\b/.test(t)) { due = new Date(now); label = 'Today'; }
  else if (/\btomorrow\b/.test(t)) { due = new Date(now); due.setDate(due.getDate() + 1); label = 'Tomorrow'; }
  else {
    const wd = t.match(/\b(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(day|nesday|rsday|urday)?\b/);
    const dm = t.match(/\b(\d{1,2})\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/) ?? t.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})\b/);
    if (dm) {
      const day = Number(/^\d/.test(dm[1]) ? dm[1] : dm[2]); const mon = MONTHS.indexOf((/^\d/.test(dm[1]) ? dm[2] : dm[1]).slice(0, 3));
      due = new Date(now.getFullYear(), mon, day); if (due.getTime() < now.getTime() - 864e5 * 60) due.setFullYear(due.getFullYear() + 1);
      label = due.toLocaleDateString([], { day: 'numeric', month: 'short' });
    } else if (wd) {
      const idx = DAYS.findIndex((d) => d.startsWith(wd[1].slice(0, 3)));
      due = new Date(now); due.setDate(due.getDate() + (((idx - now.getDay()) + 7) % 7 || 7));
      label = due.toLocaleDateString([], { weekday: 'short' });
    }
  }
  const title = text.replace(/\s*[—-]\s*(due|by)\s.*$/i, '').trim();
  return { title: title || text, owner, due: label, dueIso: due ? iso(due) : null };
}
