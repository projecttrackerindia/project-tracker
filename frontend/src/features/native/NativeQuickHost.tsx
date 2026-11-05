import { useEffect, useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { workItemApi } from '../../api/endpoints.planning';
import { meetApi } from '../meet/meetApi';
import { useAttendanceToday } from '../attendance/AttendanceHost';
import { callIdAt } from '../calls/CallHost';
import { buildGlance, setGlance, startTimer, stopTimer } from './nativeQuick';

const todayIso = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/**
 * Android app only (rendered when the native quick layer is there): keeps the home-screen Today widget fed from the same data as the app,
 * and shows an ongoing timer in the shade while the work day (after check-in) or a call runs. Draws nothing.
 */
export default function NativeQuickHost() {
  const today = todayIso();
  const att = useAttendanceToday();
  const work = useQuery({ queryKey: ['native', 'work', today], queryFn: () => workItemApi.mine({ open: true, dueTo: today, limit: 3 }), staleTime: 5 * 60_000, refetchInterval: 15 * 60_000 });
  const meet = useQuery({ queryKey: ['native', 'meet', today], queryFn: () => meetApi.feed({ from: new Date(Date.now() - 15 * 60000).toISOString(), to: new Date(Date.now() + 12 * 3600000).toISOString() }), staleTime: 5 * 60_000, refetchInterval: 15 * 60_000 });
  const next = useMemo(() => (meet.data?.items ?? []).filter((m) => Date.parse(m.end) > Date.now() && m.myRsvp !== 'Declined').sort((a, b) => a.start.localeCompare(b.start))[0] ?? null, [meet.data]);
  const rec = att.data?.record ?? null;

  useEffect(() => {
    if (!work.data && !meet.data && !att.data) return;
    setGlance(buildGlance(work.data ?? [], next, rec));
  }, [work.data, meet.data, att.data, next, rec]);

  // The work day: from check-in until check-out.
  useEffect(() => {
    if (rec && !rec.checkOutAt) startTimer({ kind: 'workday', title: 'Checked in', body: 'Your work day is running', since: Date.parse(rec.checkInAt), link: '/' });
    else stopTimer('workday');
  }, [rec]);

  // A call: while its page is open.
  const loc = useLocation();
  const callId = callIdAt(loc.pathname, loc.search);
  useEffect(() => {
    if (callId) startTimer({ kind: 'call', title: 'On a call', since: Date.now(), link: `/meetings?call=${encodeURIComponent(callId)}` });
    else stopTimer('call');
  }, [callId]);
  return null;
}
