/**
 * Time for reminders, the way people think about it: wall-clock times in the device's own time zone ("tomorrow at 9" means 9 here),
 * turned into what the server needs. Local date-times are carried as "naive" Dates whose UTC fields hold the wall-clock values, so
 * calendar arithmetic never trips over daylight saving; the server turns them into instants in the right zone.
 */

const CURRENT_NAMES: Record<string, string> = {
  'Asia/Calcutta': 'Asia/Kolkata', 'Asia/Katmandu': 'Asia/Kathmandu', 'Asia/Saigon': 'Asia/Ho_Chi_Minh', 'Asia/Rangoon': 'Asia/Yangon',
  'Europe/Kiev': 'Europe/Kyiv', 'America/Buenos_Aires': 'America/Argentina/Buenos_Aires', 'Atlantic/Faeroe': 'Atlantic/Faroe', 'Pacific/Truk': 'Pacific/Chuuk',
};
/** This device's time zone, by its current IANA name (browsers still report some old ones, like Asia/Calcutta). */
export const deviceZone = (): string => {
  try { const z = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; return CURRENT_NAMES[z] ?? z; } catch { return 'UTC'; }
};

/** Day-first (15/10) or month-first (10/15) numeric dates, from the browser's language. */
export const dayFirst = (): boolean => {
  try { return !/^en-(US|PH|CA)$/i.test(navigator.language) && !/^(fil|tl)/i.test(navigator.language); } catch { return true; }
};

/** The wall-clock reading of an instant in a zone, as a naive date. */
export function wall(instant: Date, zone = deviceZone()): Date {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
    .formatToParts(instant).reduce<Record<string, number>>((a, p) => { if (p.type !== 'literal') a[p.type] = Number(p.value); return a; }, {});
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, parts.second));
}

export const naive = (y: number, m: number, d: number, h = 0, mi = 0) => new Date(Date.UTC(y, m, d, h, mi));
export const addDays = (n: Date, days: number) => new Date(n.getTime() + days * 86_400_000);
export const addMinutes = (n: Date, minutes: number) => new Date(n.getTime() + minutes * 60_000);
export const atTime = (day: Date, h: number, mi = 0) => naive(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), h, mi);
export const sameDay = (a: Date, b: Date) => a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth() && a.getUTCDate() === b.getUTCDate();
const pad = (n: number) => String(n).padStart(2, '0');

/** "2026-10-03T15:00", the form the API takes for a wall-clock time. */
export const iso = (n: Date) => `${n.getUTCFullYear()}-${pad(n.getUTCMonth() + 1)}-${pad(n.getUTCDate())}T${pad(n.getUTCHours())}:${pad(n.getUTCMinutes())}`;
export const isoDate = (n: Date) => iso(n).slice(0, 10);
export const hhmm = (n: Date) => iso(n).slice(11, 16);
export function fromIso(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(s);
  return m ? naive(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0)) : null;
}
export function parseHm(s: string | null | undefined): [number, number] {
  const m = /^(\d{1,2}):(\d{2})/.exec(s ?? '');
  return m ? [Math.min(23, +m[1]), Math.min(59, +m[2])] : [9, 0];
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Today 15:00", "Tomorrow 09:00", "Fri 3 Oct, 15:00", "3 Oct 2027, 09:00", for a naive local time against "now" (also naive). */
export function describeLocal(n: Date, now: Date): string {
  const time = hhmm(n);
  if (sameDay(n, now)) return `Today ${time}`;
  if (sameDay(n, addDays(now, 1))) return `Tomorrow ${time}`;
  if (sameDay(n, addDays(now, -1))) return `Yesterday ${time}`;
  const days = Math.round((atTime(n, 0).getTime() - atTime(now, 0).getTime()) / 86_400_000);
  const date = `${n.getUTCDate()} ${MONTHS[n.getUTCMonth()]}${n.getUTCFullYear() !== now.getUTCFullYear() ? ` ${n.getUTCFullYear()}` : ''}`;
  return Math.abs(days) < 7 ? `${DAY_NAMES[n.getUTCDay()]} ${date}, ${time}` : `${date}, ${time}`;
}

/** An instant (from the API) shown on this device's clock. */
export const describeInstant = (utc: string | Date, zone = deviceZone()) => describeLocal(wall(new Date(utc), zone), wall(new Date(), zone));

/** "in 2 h", "in 3 days", "5 min ago". */
export function relative(utc: string | Date, from = new Date()): string {
  const diff = new Date(utc).getTime() - from.getTime();
  const abs = Math.abs(diff);
  const m = Math.round(abs / 60_000);
  const text = m < 1 ? 'now' : m < 60 ? `${m} min` : m < 60 * 36 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} days`;
  return text === 'now' ? 'now' : diff >= 0 ? `in ${text}` : `${text} ago`;
}

// ------------------------------------------------------------------ repeat rules (same subset as the server)

export interface Rule { freq: 'DAILY' | 'WEEKLY' | 'MONTHLY'; interval: number; byDay: number[]; byMonthDay: number | null; lastWorkingDay: boolean }
const CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const WEEKDAYS = [1, 2, 3, 4, 5];

export function ruleText(r: Rule): string {
  const every = (unit: string) => (r.interval === 1 ? `every ${unit}` : `every ${r.interval} ${unit}s`);
  if (r.freq === 'DAILY') return r.interval === 1 ? 'every day' : `every ${r.interval} days`;
  if (r.freq === 'WEEKLY') {
    if (r.interval === 1 && r.byDay.length === 5 && WEEKDAYS.every((d) => r.byDay.includes(d))) return 'every weekday';
    const names = r.byDay.map((d) => DAY_LONG[d]).join(', ');
    return r.interval === 1 ? `every ${names}` : `${every('week')} on ${names}`;
  }
  const ord = (n: number) => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${every('month')} on ${r.lastWorkingDay ? 'the last working day' : r.byMonthDay === -1 ? 'the last day' : `the ${ord(r.byMonthDay ?? 1)}`}`;
}

export function toRRule(r: Rule): string {
  let s = `FREQ=${r.freq}`;
  if (r.interval > 1) s += `;INTERVAL=${r.interval}`;
  if (r.lastWorkingDay) return `${s};BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1`;
  if (r.byDay.length) s += `;BYDAY=${r.byDay.map((d) => CODES[d]).join(',')}`;
  if (r.byMonthDay != null) s += `;BYMONTHDAY=${r.byMonthDay}`;
  return s;
}

export function fromRRule(s: string | null | undefined): Rule | null {
  if (!s) return null;
  const p = Object.fromEntries(s.split(';').map((x) => x.split('=')).filter((x) => x.length === 2).map(([k, v]) => [k.toUpperCase(), v.toUpperCase()]));
  if (!['DAILY', 'WEEKLY', 'MONTHLY'].includes(p.FREQ)) return null;
  const byDay = (p.BYDAY ?? '').split(',').map((c: string) => CODES.indexOf(c)).filter((i: number) => i >= 0);
  const last = p.FREQ === 'MONTHLY' && p.BYSETPOS === '-1';
  return { freq: p.FREQ as Rule['freq'], interval: Math.max(1, Number(p.INTERVAL ?? 1)), byDay: last ? [] : byDay, byMonthDay: p.BYMONTHDAY ? Number(p.BYMONTHDAY) : null, lastWorkingDay: last };
}

const monday = (d: Date) => addDays(atTime(d, 0), -((d.getUTCDay() + 6) % 7));
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

function matches(r: Rule, d: Date, start: Date): boolean {
  if (r.freq === 'DAILY') return Math.round((atTime(d, 0).getTime() - atTime(start, 0).getTime()) / 86_400_000) % r.interval === 0;
  if (r.freq === 'WEEKLY') {
    const days = r.byDay.length ? r.byDay : [start.getUTCDay()];
    if (!days.includes(d.getUTCDay())) return false;
    return Math.round((monday(d).getTime() - monday(start).getTime()) / (7 * 86_400_000)) % r.interval === 0;
  }
  const months = d.getUTCFullYear() * 12 + d.getUTCMonth() - (start.getUTCFullYear() * 12 + start.getUTCMonth());
  if (months % r.interval !== 0) return false;
  const last = daysIn(d.getUTCFullYear(), d.getUTCMonth());
  if (r.lastWorkingDay) {
    let lw = naive(d.getUTCFullYear(), d.getUTCMonth(), last);
    while (lw.getUTCDay() === 0 || lw.getUTCDay() === 6) lw = addDays(lw, -1);
    return sameDay(d, lw);
  }
  const want = r.byMonthDay === -1 ? last : Math.min(r.byMonthDay ?? start.getUTCDate(), last);
  return d.getUTCDate() === want;
}

/** The first time the rule comes round at or after "now", at the given time of day (counting from that day). */
export function firstOccurrence(r: Rule, now: Date, h: number, mi: number): Date {
  const start = atTime(now, 0);
  for (let i = 0; i < 800; i++) {
    const d = addDays(start, i);
    if (!matches(r, d, start)) continue;
    const at = atTime(d, h, mi);
    if (at > now) return at;
  }
  return atTime(addDays(now, 1), h, mi);
}

// ------------------------------------------------------------------ plain words → a reminder

export type Parsed =
  | { title: string; kind: 'at'; local: Date; label: string }
  | { title: string; kind: 'repeat'; local: Date; rule: Rule; label: string }
  | { title: string; kind: 'anchor'; days: number; time: string | null; label: string };

const NUM: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, fifteen: 15, twenty: 20, thirty: 30 };
const DAY_RE = '(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(?:day|sday|nesday|rsday|urday)?';
const dayIndex = (w: string) => ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(w.slice(0, 3).toLowerCase());
const MONTH_RE = '(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
const monthIndex = (w: string) => ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(w.slice(0, 3).toLowerCase());
const num = (w: string) => (/^\d+$/.test(w) ? Number(w) : NUM[w.toLowerCase()] ?? NaN);

/**
 * Reads a reminder written in plain words: "call Priya tomorrow at 3pm", "in 2 hours", "every Friday 4pm submit timesheet",
 * "last working day of the month: invoices", "2 days before due". Returns what to remember and when (in the device's zone), or null when
 * no time could be found. `now` is the naive local time; `defaultTime` is used when only a day is given.
 */
export function parseReminder(text: string, now: Date, opts: { defaultTime?: string; dayFirst?: boolean } = {}): Parsed | null {
  let rest = ` ${text.trim()} `;
  const [dh, dm] = parseHm(opts.defaultTime ?? '09:00');
  const take = (re: RegExp): RegExpExecArray | null => {
    const m = re.exec(rest);
    if (m) rest = rest.slice(0, m.index) + ' ' + rest.slice(m.index + m[0].length);
    return m;
  };

  // ---- time of day
  let hour: number | null = null, minute = 0;
  const ampm = (h: number, mer?: string) => {
    const x = (mer ?? '').toLowerCase().replace(/\./g, '');
    if (x === 'pm' && h < 12) return h + 12;
    if (x === 'am' && h === 12) return 0;
    return h;
  };
  let t = take(/\s(?:at|@|by)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)(?=[\s,.;!?]|$)/i)
    ?? take(/\s(?:at|@|by)?\s*(\d{1,2}):(\d{2})(?=[\s,.;!?]|$)/i);
  if (t) { hour = ampm(+t[1], t[3]); minute = t[2] ? +t[2] : 0; }
  else if ((t = take(/\s(?:at|@)\s+(\d{1,2})(?=[\s,.;!?]|$)/i))) { const h = +t[1]; hour = h >= 1 && h <= 6 ? h + 12 : h; }
  else if ((t = take(/\s(noon|midday)(?=[\s,.;!?]|$)/i))) hour = 12;
  else if ((t = take(/\s(midnight)(?=[\s,.;!?]|$)/i))) { hour = 23; minute = 59; }
  if (hour !== null && (hour > 23 || minute > 59)) return null;

  // ---- repeating
  let rule: Rule | null = null;
  let m: RegExpExecArray | null;
  if ((m = take(/\s(?:on\s+)?(?:the\s+)?last\s+(?:working|business|week)\s*day\s+of\s+(?:every|each|the)\s+month(?=\W|$)/i)) || (m = take(/\s(?:every|each)\s+month\s+on\s+the\s+last\s+(?:working|business)\s+day(?=\W|$)/i)))
    rule = { freq: 'MONTHLY', interval: 1, byDay: [], byMonthDay: null, lastWorkingDay: true };
  else if ((m = take(/\s(?:every|each)\s+(?:(\d+|two|three|four|six)\s+)?months?(?:\s+on\s+the\s+(\d{1,2})(?:st|nd|rd|th)?|\s+on\s+the\s+last\s+day)?(?=\W|$)/i)) || (m = take(/\s(monthly)(?=\W|$)/i))) {
    const interval = m[1] && m[1].toLowerCase() !== 'monthly' ? num(m[1]) : 1;
    const last = /last\s+day/i.test(m[0]);
    rule = { freq: 'MONTHLY', interval: interval || 1, byDay: [], byMonthDay: last ? -1 : m[2] ? Math.min(31, +m[2]) : now.getUTCDate(), lastWorkingDay: false };
  }
  else if ((m = take(/\s(?:(?:every|each)\s+weekdays?|weekdays|(?:every|each)\s+day\s+(?:mon(?:day)?\s*(?:-|to|through)\s*fri(?:day)?))(?=\W|$)/i)))
    rule = { freq: 'WEEKLY', interval: 1, byDay: [...WEEKDAYS], byMonthDay: null, lastWorkingDay: false };
  else if ((m = take(new RegExp(`\\s(?:every|each)\\s+(?:(other|\\d+|two|three)\\s+)?(?:weeks?\\s+on\\s+)?(${DAY_RE}(?:\\s*(?:,|and|&)\\s*${DAY_RE})*)(?=\\W|$)`, 'i')))) {
    const interval = m[1] ? (m[1].toLowerCase() === 'other' ? 2 : num(m[1])) : 1;
    const days = [...m[2].matchAll(new RegExp(DAY_RE, 'gi'))].map((x) => dayIndex(x[0]));
    rule = { freq: 'WEEKLY', interval: interval || 1, byDay: [...new Set(days)].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)), byMonthDay: null, lastWorkingDay: false };
  }
  else if ((m = take(/\s(?:every|each)\s+(?:(other|\d+|two|three)\s+)?weeks?(?=\W|$)/i)) || (m = take(/\s(weekly)(?=\W|$)/i)))
    rule = { freq: 'WEEKLY', interval: m[1] && m[1].toLowerCase() !== 'weekly' ? (m[1].toLowerCase() === 'other' ? 2 : num(m[1]) || 1) : 1, byDay: [now.getUTCDay()], byMonthDay: null, lastWorkingDay: false };
  else if ((m = take(/\s(?:every|each)\s+(?:(other|\d+|two|three)\s+)?days?(?=\W|$)/i)) || (m = take(/\s(daily|every\s+morning|every\s+evening)(?=\W|$)/i))) {
    if (/morning/i.test(m[0]) && hour === null) hour = 9;
    if (/evening/i.test(m[0]) && hour === null) hour = 18;
    rule = { freq: 'DAILY', interval: m[1] && !/daily|morning|evening/i.test(m[1]) ? (m[1].toLowerCase() === 'other' ? 2 : num(m[1]) || 1) : 1, byDay: [], byMonthDay: null, lastWorkingDay: false };
  }

  // ---- relative to the due date
  let anchor: number | null = null;
  if ((m = take(/\s(\d+|a|an|one|two|three|four|five|six|seven|ten)\s+(?:working\s+)?days?\s+before\s+(?:the\s+|it'?s\s+|its\s+)?due(?:\s+date)?(?=\W|$)/i))) anchor = -num(m[1]);
  else if ((m = take(/\s(?:the\s+)?day\s+before\s+(?:the\s+|it'?s\s+|its\s+)?due(?:\s+date)?(?=\W|$)/i))) anchor = -1;
  else if ((m = take(/\s(\d+|a|one|two|three)\s+days?\s+after\s+(?:the\s+)?due(?:\s+date)?(?=\W|$)/i))) anchor = num(m[1]);
  else if ((m = take(/\s(?:on\s+the\s+due\s+date|when\s+it'?s\s+due|on\s+the\s+day\s+it'?s\s+due)(?=\W|$)/i))) anchor = 0;

  // ---- the day
  // A weekday: "on/this/next friday" always; on its own only when written out or unmistakable ("sat", "sun" and "wed" are words too).
  function takeDay(): RegExpExecArray | null {
    const tail = '(?:\\s+(morning|afternoon|evening|night))?(?=\\W|$)';
    return take(new RegExp(`\\s(?:on\\s+)?(this|next|coming)\\s+${DAY_RE}${tail}`, 'i'))
      ?? take(new RegExp(`\\s(on)\\s+${DAY_RE}${tail}`, 'i'))
      ?? take(new RegExp(`\\s()(sunday|monday|tuesday|wednesday|thursday|friday|saturday|mon|tue|tues|thu|thur|thurs|fri)${tail}`, 'i'));
  }
  let day: Date | null = null;
  let partHour: number | null = null;
  const today = atTime(now, 0);
  const nextDow = (dow: number, strictly: boolean) => { let d = addDays(today, strictly ? 1 : 0); while (d.getUTCDay() !== dow) d = addDays(d, 1); return d; };
  if ((m = take(/\sin\s+(\d+|a|an|one|two|three|four|five|six|ten|fifteen|twenty|thirty|half\s+an?)\s*(min(?:ute)?s?|h(?:ou)?rs?|hours?|days?|weeks?)(?=\W|$)/i))) {
    const n = /half/i.test(m[1]) ? 0.5 : num(m[1]);
    const unit = m[2].toLowerCase();
    const mins = unit.startsWith('m') ? n : unit.startsWith('h') ? n * 60 : unit.startsWith('d') ? n * 1440 : n * 10080;
    if (!Number.isFinite(mins)) return null;
    const at = addMinutes(now, Math.round(mins));
    if (unit.startsWith('d') || unit.startsWith('w')) { day = atTime(at, 0); }
    else { const title = clean(rest); return { title, kind: 'at', local: at, label: describeLocal(at, now) }; }
  }
  else if ((m = take(/\s(?:the\s+)?day\s+after\s+tomorrow(?=\W|$)/i))) day = addDays(today, 2);
  else if ((m = take(/\s(?:tomorrow|tmrw|tmr|tom)(?:\s+(morning|afternoon|evening|night))?(?=\W|$)/i))) { day = addDays(today, 1); partHour = part(m[1]); }
  else if ((m = take(/\s(tonight)(?=\W|$)/i))) { day = today; partHour = 20; }
  else if ((m = take(/\sthis\s+(morning|afternoon|evening)(?=\W|$)/i))) { day = today; partHour = part(m[1]); }
  else if ((m = take(/\s(today)(?=\W|$)/i))) day = today;
  else if ((m = take(/\s(?:end\s+of\s+(?:the\s+)?day|eod)(?=\W|$)/i))) { day = today; partHour = 17; }
  else if ((m = take(/\s(?:end\s+of\s+(?:the\s+)?week|eow)(?=\W|$)/i))) { day = nextDow(5, false); partHour = 17; }
  else if ((m = take(/\s(?:this\s+)?weekend(?=\W|$)/i))) { day = nextDow(6, false); partHour = 10; }
  else if ((m = take(/\snext\s+week(?=\W|$)/i))) day = addDays(today, 7 - ((today.getUTCDay() + 6) % 7));
  else if ((m = take(/\snext\s+month(?=\W|$)/i))) day = naive(today.getUTCFullYear(), today.getUTCMonth() + 1, 1);
  else if ((m = takeDay())) {
    const dow = dayIndex(m[2]);
    if (m[1]?.toLowerCase() === 'next') {
      // "next Friday": the Friday of next week.
      day = addDays(today, 7 - ((today.getUTCDay() + 6) % 7));
      while (day.getUTCDay() !== dow) day = addDays(day, 1);
    }
    else day = nextDow(dow, (dow === today.getUTCDay() && hour !== null && atTime(today, hour, minute) <= now) || (dow === today.getUTCDay() && hour === null));
    partHour = part(m[3]);
  }
  else if ((m = take(/\s(?:on\s+)?(\d{4})-(\d{1,2})-(\d{1,2})(?=\W|$)/))) day = naive(+m[1], +m[2] - 1, +m[3]);
  else if ((m = take(new RegExp(`\\s(?:on\\s+)?(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}(?:\\s+(\\d{4}))?(?=\\W|$)`, 'i'))))
    day = future(naive(m[3] ? +m[3] : today.getUTCFullYear(), monthIndex(m[2]), +m[1]), today, !m[3]);
  else if ((m = take(new RegExp(`\\s(?:on\\s+)?${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?(?=\\W|$)`, 'i'))))
    day = future(naive(m[3] ? +m[3] : today.getUTCFullYear(), monthIndex(m[1]), +m[2]), today, !m[3]);
  else if ((m = take(/\s(?:on\s+)?(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2,4}))?(?=\W|$)/))) {
    const [a, b] = [+m[1], +m[2]];
    const [d, mo] = (opts.dayFirst ?? true) ? [a, b] : [b, a];
    const y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : today.getUTCFullYear();
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) day = future(naive(y, mo - 1, d), today, !m[3]);
  }
  else if ((m = take(/\s(?:in\s+the\s+)?(morning|afternoon|evening)(?=\W|$)/i))) { partHour = part(m[1]); }
  if (day && Number.isNaN(day.getTime())) return null;

  const title = clean(rest);
  const h = hour ?? partHour;
  if (rule) {
    const [rh, rm] = h !== null ? [h, hour !== null ? minute : 0] : [dh, dm];
    const local = firstOccurrence(rule, now, rh, rm);
    const first = describeLocal(local, now);
    return { title, kind: 'repeat', local, rule, label: `${ruleText(rule)} at ${pad(rh)}:${pad(rm)} · starts ${/^(Today|Tomorrow)/.test(first) ? first[0].toLowerCase() + first.slice(1) : first}` };
  }
  if (anchor !== null) {
    const time = h !== null ? `${pad(h)}:${pad(hour !== null ? minute : 0)}` : null;
    const words = anchor === 0 ? 'on the due date' : anchor < 0 ? `${-anchor} day${anchor === -1 ? '' : 's'} before it's due` : `${anchor} day${anchor === 1 ? '' : 's'} after it's due`;
    return { title, kind: 'anchor', days: anchor, time, label: `${words}${time ? ` at ${time}` : ''}` };
  }
  if (!day && h === null) return null;
  let local: Date;
  if (day) local = atTime(day, h ?? dh, h !== null && hour !== null ? minute : h !== null ? 0 : dm);
  else { local = atTime(today, h!, hour !== null ? minute : 0); if (local <= now) local = addDays(local, 1); }
  if (local <= now) return null;
  return { title, kind: 'at', local, label: describeLocal(local, now) };
}

function part(word?: string): number | null {
  switch ((word ?? '').toLowerCase()) {
    case 'morning': return 9;
    case 'afternoon': return 14;
    case 'evening': return 18;
    case 'night': return 20;
    default: return null;
  }
}

/** A date without a year that has already gone means next year's. */
function future(d: Date, today: Date, yearless: boolean) {
  return yearless && d < today ? naive(d.getUTCFullYear() + 1, d.getUTCMonth(), d.getUTCDate()) : d;
}

/** What is left once the time words are taken out: "remind me to call Priya at" → "Call Priya". */
function clean(rest: string): string {
  let s = rest.replace(/\s+/g, ' ').trim();
  s = s.replace(/^(?:please\s+)?(?:remind\s+me\s+(?:to|about|that)?|remember\s+to|don'?t\s+forget\s+(?:to)?|reminder:?|todo:?)\s*/i, '');
  s = s.replace(/^(?:to|about|that)\s+/i, '');
  s = s.replace(/\s+(?:at|on|by|in|every|the|from|of)$/i, '').replace(/^(?:at|on|by|in|every|the)\s+/i, '');
  s = s.replace(/^[,:;.\-–—\s]+|[,:;\-–—\s]+$/g, '');
  return s ? s[0].toUpperCase() + s.slice(1) : '';
}
