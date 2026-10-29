import { todayISO } from '../../lib/format';
import { appZone } from '../../lib/zone';
import { parseMeetingSentence } from './quickLine';
import { openSchedule, type ScheduleOpen } from './scheduleStore';
import { zonedTimeToUtc } from './timezone';

/**
 * The Aura chip "Schedule a meeting" (and + New › Meeting): the words typed so far ("weekly sandbox sync with Mira and AutoPay team
 * tomorrow 11:30") read into the schedule sheet's fields, shown as "From Aura" so the person sees where they came from.
 */
export function openScheduleFromWords(words: string, extra?: Partial<ScheduleOpen>, project?: { id: string; name: string } | null) {
  const text = words.trim();
  if (!text) { openSchedule({ project: project ?? null, ...extra }); return; }
  const m = parseMeetingSentence(text, todayISO());
  let start: string | null = null;
  if (m.date || m.time) {
    const [y, mo, d] = (m.date ?? todayISO()).split('-').map(Number);
    const [h, mi] = (m.time ?? '10:00').split(':').map(Number);
    const at = zonedTimeToUtc(y, mo - 1, d, h, mi, appZone());
    if (!Number.isNaN(at.getTime()) && at.getTime() > Date.now()) start = at.toISOString();
  }
  openSchedule({ aura: text, title: m.title || null, people: m.people, repeat: m.repeat, minutes: m.minutes, start, project: project ?? null, ...extra });
}
