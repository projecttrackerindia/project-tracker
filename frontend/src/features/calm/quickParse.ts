import { shiftIsoDate } from '../../lib/zone';
import type { Priority } from '../../api/types';

export interface QuickPerson { id: string; name: string }
export interface QuickProject { id: string; key: string; name: string }
export interface Quick { title: string; ownerId: string | null; due: string | null; projectId: string | null; priority: Priority | null }

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const dowOf = (iso: string) => new Date(`${iso}T00:00:00Z`).getUTCDay();

/** A day word ("today", "tomorrow", "fri", "friday", "next mon") as a date on or after today; null when it is not one. */
export function dayWord(word: string, today: string): string | null {
  const w = word.toLowerCase();
  if (w === 'today' || w === 'tod') return today;
  if (w === 'tomorrow' || w === 'tmr' || w === 'tom') return shiftIsoDate(today, 1);
  const i = DAYS.findIndex((d) => w === d || (w.length >= 3 && d.startsWith(w.slice(0, 3)) && /^(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(day|nesday|sday|urday|rsday)?$/.test(w)));
  if (i < 0) return null;
  const gap = (i - dowOf(today) + 7) % 7;
  return shiftIsoDate(today, gap === 0 ? 7 : gap);
}

/**
 * Quick add: "Fix refund retries @Ravi fri #atlas !high" → the title without the tokens, the owner (first name or whole name), the due day,
 * the project (key or first word of its name) and the priority. Tokens that match nothing stay in the title.
 */
export function parseQuick(text: string, today: string, people: QuickPerson[], projects: QuickProject[]): Quick {
  const out: Quick = { title: '', ownerId: null, due: null, projectId: null, priority: null };
  const keep: string[] = [];
  for (const tok of text.split(/\s+/).filter(Boolean)) {
    const low = tok.toLowerCase();
    if (low.startsWith('@') && low.length > 1) {
      const n = low.slice(1);
      const p = people.find((x) => x.name.toLowerCase() === n || x.name.toLowerCase().split(/\s+/)[0] === n || x.name.toLowerCase().replace(/\s+/g, '').startsWith(n));
      if (p) { out.ownerId = p.id; continue; }
    } else if (low.startsWith('#') && low.length > 1) {
      const n = low.slice(1);
      const p = projects.find((x) => x.key.toLowerCase() === n || x.name.toLowerCase() === n || x.name.toLowerCase().split(/\s+/)[0] === n);
      if (p) { out.projectId = p.id; continue; }
    } else if (low.startsWith('!') && low.length > 1) {
      const n = low.slice(1);
      const pr: Priority | null = /^(urgent|critical|p0|p1)$/.test(n) ? 'Critical' : /^(high|hi|p2)$/.test(n) ? 'High' : /^(med|medium|p3)$/.test(n) ? 'Medium' : /^(low|lo|p4)$/.test(n) ? 'Low' : null;
      if (pr) { out.priority = pr; continue; }
    } else if (!out.due) {
      const d = dayWord(low, today);
      if (d) { out.due = d; continue; }
    }
    keep.push(tok);
  }
  out.title = keep.join(' ');
  return out;
}
