/**
 * Reads a task typed in plain words - "Fix login bug for Ravi by Friday, high, 3h" - into its parts: the title, who it is for, when it is
 * due, how urgent it is and how long it should take. Runs in the browser with no model call, so it is instant and free, and every part it
 * found is shown before anything is saved. Whatever it does not recognise stays in the title.
 */
export type QuickPriority = 'Critical' | 'High' | 'Medium' | 'Low';
export interface QuickPerson { id: string; name: string }
export interface QuickTask {
  title: string;
  assignee?: QuickPerson;
  dueDate?: string;          // yyyy-mm-dd
  dueLabel?: string;         // the words that set it, for the preview
  priority?: QuickPriority;
  estimatedHours?: number;
}

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const PRIORITY: Record<string, QuickPriority> = {
  critical: 'Critical', urgent: 'Critical', asap: 'Critical', blocker: 'Critical', p1: 'Critical',
  high: 'High', important: 'High', p2: 'High',
  medium: 'Medium', normal: 'Medium', p3: 'Medium',
  low: 'Low', minor: 'Low', p4: 'Low',
};

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (d: Date, n: number) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() + n); return x; };
const monthIndex = (w: string) => MONTHS.indexOf(w.slice(0, 3).toLowerCase());

/** A day and month without a year means the next time that date comes round (today counts). */
function nextDate(today: Date, month: number, day: number, year?: number): Date | null {
  if (month < 0 || month > 11 || day < 1 || day > 31) return null;
  if (year !== undefined) { const d = new Date(year < 100 ? 2000 + year : year, month, day); return d.getMonth() === month ? d : null; }
  let d = new Date(today.getFullYear(), month, day);
  if (d.getMonth() !== month) return null;
  if (d < new Date(today.getFullYear(), today.getMonth(), today.getDate())) d = new Date(today.getFullYear() + 1, month, day);
  return d;
}

interface Rule { re: RegExp; date: (m: RegExpMatchArray, today: Date) => Date | null }
const LEAD = String.raw`(?:\b(?:by|due|on|before|until|till|for)\s+)?`;
const DATE_RULES: Rule[] = [
  { re: new RegExp(`${LEAD}\\b(?:day after tomorrow)\\b`, 'i'), date: (_, t) => addDays(t, 2) },
  { re: new RegExp(`${LEAD}\\b(?:today|tonight|eod)\\b`, 'i'), date: (_, t) => t },
  { re: new RegExp(`${LEAD}\\b(?:tomorrow|tmrw|tmr)\\b`, 'i'), date: (_, t) => addDays(t, 1) },
  { re: new RegExp(`${LEAD}\\b(?:end of (?:the )?week|eow)\\b`, 'i'), date: (_, t) => addDays(t, (5 - t.getDay() + 7) % 7) },
  { re: new RegExp(`${LEAD}\\b(?:end of (?:the )?month|eom)\\b`, 'i'), date: (_, t) => new Date(t.getFullYear(), t.getMonth() + 1, 0) },
  { re: new RegExp(`${LEAD}\\bnext week\\b`, 'i'), date: (_, t) => addDays(t, ((1 - t.getDay() + 7) % 7) || 7) },
  { re: new RegExp(`${LEAD}\\bin (\\d{1,3}) (day|days|week|weeks)\\b`, 'i'), date: (m, t) => addDays(t, Number(m[1]) * (m[2].startsWith('week') ? 7 : 1)) },
  { re: new RegExp(`${LEAD}\\b(next )?(${DAYS.join('|')}|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)\\b`, 'i'), date: (m, t) => {
    const want = DAYS.findIndex((d) => d.startsWith(m[2].toLowerCase().slice(0, 3)));
    let n = (want - t.getDay() + 7) % 7;
    if (n === 0) n = 7;                       // "Friday" said on a Friday means next Friday
    if (m[1]) n += n < 7 ? 7 : 0;             // "next Friday" skips this week's
    return addDays(t, n);
  } },
  { re: new RegExp(`${LEAD}\\b(\\d{4})-(\\d{1,2})-(\\d{1,2})\\b`, 'i'), date: (m) => nextDate(new Date(0), Number(m[2]) - 1, Number(m[3]), Number(m[1])) },
  { re: new RegExp(`${LEAD}\\b(\\d{1,2})[/.-](\\d{1,2})(?:[/.-](\\d{2,4}))?\\b`, 'i'), date: (m, t) => nextDate(t, Number(m[2]) - 1, Number(m[1]), m[3] ? Number(m[3]) : undefined) },
  { re: new RegExp(`${LEAD}\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTHS.join('|')})[a-z]*\\.?(?:\\s+(\\d{4}))?\\b`, 'i'), date: (m, t) => nextDate(t, monthIndex(m[2]), Number(m[1]), m[3] ? Number(m[3]) : undefined) },
  { re: new RegExp(`${LEAD}\\b(${MONTHS.join('|')})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, 'i'), date: (m, t) => nextDate(t, monthIndex(m[1]), Number(m[2]), m[3] ? Number(m[3]) : undefined) },
];

/** The member a name refers to: the full name, then a first name, then (3+ letters) the start of a name; "me" is the person typing. */
export function matchPerson(words: string, people: QuickPerson[], me?: QuickPerson): QuickPerson | undefined {
  const w = words.trim().toLowerCase();
  if (!w) return undefined;
  if (me && (w === 'me' || w === 'myself')) return me;
  const named = [...people].sort((a, b) => b.name.length - a.name.length);
  return named.find((p) => p.name.toLowerCase() === w)
    ?? named.find((p) => p.name.toLowerCase().split(/\s+/)[0] === w)
    ?? (w.length >= 3 ? named.find((p) => p.name.toLowerCase().startsWith(w)) : undefined);
}

/** A date said in words ("Friday", "25 Oct", "next week") as yyyy-mm-dd, or undefined. */
export function parseDueWords(words: string, today: Date = new Date()): string | undefined {
  if (/^\d{4}-\d{2}-\d{2}$/.test(words.trim())) return words.trim();
  return parseQuickTask(`x by ${words}`, [], today).dueDate;
}

export type QuickPart = 'estimate' | 'priority' | 'due' | 'assignee';

/** `skip`: parts the person dismissed in the preview; their words stay in the title. */
export function parseQuickTask(text: string, people: QuickPerson[] = [], today: Date = new Date(), me?: QuickPerson, skip: ReadonlySet<QuickPart> = new Set()): QuickTask {
  let rest = ` ${text} `;
  const out: QuickTask = { title: '' };
  const cut = (m: RegExpMatchArray) => { rest = rest.slice(0, m.index!) + ' ' + rest.slice(m.index! + m[0].length); };

  // How long: "3h", "2.5 hours", "45m", "90 mins".
  const est = rest.match(/\b(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours|m|min|mins|minutes)\b/i);
  if (est && !skip.has('estimate')) {
    const n = Number(est[1]);
    const hours = /^m/i.test(est[2]) ? Math.round((n / 60) * 100) / 100 : n;
    if (hours > 0 && hours <= 1000) { out.estimatedHours = hours; cut(est); }
  }

  // How urgent: "high", "urgent", "p1", optionally followed by "priority".
  const pri = rest.match(new RegExp(`(?:\\bpriority\\s*:?\\s*)?\\b(${Object.keys(PRIORITY).join('|')})\\b(?:\\s+priority)?`, 'i'));
  if (pri && !skip.has('priority')) { out.priority = PRIORITY[pri[1].toLowerCase()]; cut(pri); }

  // When: the first date phrase found.
  for (const rule of skip.has('due') ? [] : DATE_RULES) {
    const m = rest.match(rule.re);
    if (!m) continue;
    const d = rule.date(m, today);
    if (!d) continue;
    out.dueDate = iso(d); out.dueLabel = m[0].trim(); cut(m);
    break;
  }

  // Who: "@ravi", "for Ravi", "assign to Ravi Kumar", "to me". Longest matching name wins (so "Ravi Kumar" beats "Ravi").
  const findPerson = (words: string) => matchPerson(words, people, me);
  // Each candidate in turn ("VPN down for collections team, assign to Priya": "collections team" is nobody, Priya is).
  const candidates = skip.has('assignee') ? [] : [...rest.matchAll(/(?:@([\w.-]+(?:\s[\w.-]+)?)|\b(?:assign(?:ed)?\s+to|for|to(?=\s+me\b))\s+([A-Za-z][\w.-]*(?:\s[A-Za-z][\w.-]*)?))/gi)];
  for (const who of candidates) {
    const raw = (who[1] ?? who[2]).trim();
    const two = findPerson(raw), one = findPerson(raw.split(/\s+/)[0]);
    const person = two ?? one;
    if (person) {
      out.assignee = person;
      // Only the words that named the person leave the title: "for Ravi about payments" keeps "about payments".
      const used = two ? who[0] : who[0].replace(/\s+\S+$/, '');
      rest = rest.replace(used, ' ');
      break;
    }
  }

  // Tidy what is left: runs of commas from removed parts become one ", ", and nothing dangles at either end.
  out.title = rest.replace(/\s*([,;])(?:\s*[,;])*\s*/g, '$1 ').replace(/\s{2,}/g, ' ').replace(/^[\s,;:-]+|[\s,;:-]+$/g, '').trim();
  if (out.title) out.title = out.title.charAt(0).toUpperCase() + out.title.slice(1);
  return out;
}
