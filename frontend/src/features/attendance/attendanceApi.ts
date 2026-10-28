// Check-in / check-out (attendance), on the organization's clock. See AttendanceService on the server.
import { create, get, post, put } from '../../api/client';

export type AttendanceMode = 'Office' | 'Home' | 'ClientSite';
export interface AttendanceDay {
  id: string; userId: string; userName: string; date: string; checkInAt: string; checkOutAt: string | null; mode: AttendanceMode; place: string | null;
  note: string | null; source: string; autoClosed: boolean; minutes: number; checkInLocal: string; checkOutLocal: string | null;
}
export interface AttendancePolicy {
  enabled: boolean; hoursSource: 'workspace' | 'personal'; workDays: string; workStart: string; workEnd: string; checkInGraceMinutes: number; checkOutGraceMinutes: number;
  autoClose: boolean; autoCloseAfterHours: number; allowedModes: AttendanceMode[]; requireClientPlace: boolean; promptAtSignIn: boolean; timeZone: string;
}
export interface AttendanceToday {
  date: string; timeZone: string; localTime: string; workStart: string; workEnd: string; workingDay: boolean; onLeave: boolean; holiday: string | null;
  shouldPrompt: boolean; record: AttendanceDay | null; recentPlaces: string[]; canViewTeam: boolean; policy: AttendancePolicy;
}
export interface AttendanceCheckOut { day: AttendanceDay; minutes: number; tasksDone: number; loggedMinutes: number }
export interface AttendancePerson { userId: string; name: string; status: AttendanceMode | 'Leave' | 'NotIn'; place: string | null; checkInLocal: string | null; checkOutLocal: string | null }
export interface AttendanceTeamToday { date: string; office: number; home: number; clientSite: number; onLeave: number; notIn: number; people: AttendancePerson[] }

/** Where the check-in came from: the installed phone app, the desktop app or the web. */
export const sourceOfDevice = (): 'web' | 'phone' | 'desktop' => {
  if (typeof window === 'undefined') return 'web';
  if ((window as unknown as { __TAURI__?: unknown; electron?: unknown }).__TAURI__ || (window as unknown as { electron?: unknown }).electron) return 'desktop';
  return window.matchMedia?.('(max-width: 759px)').matches ? 'phone' : 'web';
};

export const attendanceApi = {
  today: () => get<AttendanceToday>('/me/attendance/today'),
  checkIn: (b: { mode: AttendanceMode; place?: string | null; note?: string | null; source?: string }) => create<AttendanceDay>('/me/attendance/check-in', b),
  checkOut: (b: { note?: string | null }) => post<AttendanceCheckOut>('/me/attendance/check-out', b),
  correct: (date: string, b: { mode?: AttendanceMode; place?: string | null; note?: string | null; checkIn?: string; checkOut?: string | null }) => put<AttendanceDay>(`/me/attendance/${date}`, b),
  list: (from: string, to: string, scope: 'me' | 'team' = 'me') => get<AttendanceDay[]>('/attendance', { from, to, scope }),
  teamToday: () => get<AttendanceTeamToday>('/attendance/team/today'),
  settings: () => get<AttendancePolicy>('/attendance/settings'),
  saveSettings: (b: Partial<Omit<AttendancePolicy, 'timeZone'>>) => put<AttendancePolicy>('/attendance/settings', b),
};

export const MODES: { id: AttendanceMode; emoji: string; label: string; short: string }[] = [
  { id: 'Home', emoji: '🏠', label: 'Work from home', short: 'Home' },
  { id: 'Office', emoji: '🏢', label: 'Office', short: 'Office' },
  { id: 'ClientSite', emoji: '🤝', label: 'Client office', short: 'Client' },
];
export const modeOf = (m: string) => MODES.find((x) => x.id === m) ?? MODES[1];
export const hm = (mins: number) => { const h = Math.floor(mins / 60), m = Math.round(mins % 60); return h ? `${h}h ${m}m` : `${m}m`; };
