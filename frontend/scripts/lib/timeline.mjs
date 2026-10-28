// GET /timeline for the UI checks, made from the older calendar fixtures (CalendarEvent[]): meetings at their start and length, open work as
// all-day "due" items, finished work as "done" at the end of its day. `extra` adds timeline events (calls, time, reminders …) as they are.
const base = { end: null, allDay: false, link: null, projectId: null, projectName: null, people: [], status: null, colour: '', key: null, approximated: false, overdue: false,
  priority: null, minutes: null, note: null, joinUrl: null, notes: false, userId: null, mode: null, running: false };
export const tev = (o) => ({ ...base, ...o });
const midnight = (d) => new Date(`${d}T00:00:00+05:30`).toISOString();
export function fromCalendar(list) {
  return list.map((e) => {
    if (e.type === 'meeting' && e.startsAt) {
      return tev({ id: `meeting:${e.id}:${e.startsAt}`, type: 'meeting', title: e.title, start: e.startsAt, end: new Date(Date.parse(e.startsAt) + (e.durationMinutes ?? 30) * 60e3).toISOString(),
        date: e.date, sourceType: e.projectId ? 'projectMeeting' : 'workspaceMeeting', sourceId: e.id, projectId: e.projectId ?? null, projectName: e.projectName ?? null, people: e.people ?? [],
        status: e.status ?? null, joinUrl: e.joinUrl ?? null, notes: !!e.notes });
    }
    const done = e.category === 'Done' || e.status === 'Completed' || e.status === 'Done';
    return done
      ? tev({ id: `done:${e.type}:${e.id}`, type: 'done', title: e.title, start: new Date(`${e.date}T17:00:00+05:30`).toISOString(), date: e.date, sourceType: e.type, sourceId: e.id, status: e.status ?? null, priority: e.priority ?? null })
      : tev({ id: `due:${e.type}:${e.id}`, type: 'due', title: e.title, allDay: true, start: midnight(e.date), date: e.date, sourceType: e.type, sourceId: e.id, projectId: e.projectId ?? null,
        projectName: e.projectName ?? null, status: e.status ?? null, priority: e.priority ?? null, overdue: !!e.overdue });
  });
}
/** The response for a request URL. */
export function timelineFor(url, list, extra = []) {
  const from = url.searchParams.get('from'), to = url.searchParams.get('to');
  return { from, to, timeZone: 'Asia/Kolkata', scope: url.searchParams.get('scope') ?? 'me', generatedAt: new Date().toISOString(),
    events: [...fromCalendar(list), ...extra].filter((t) => t.date >= from && t.date <= to) };
}
