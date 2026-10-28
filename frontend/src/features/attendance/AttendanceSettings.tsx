import { useEffect, useState } from 'react';
import { ApiError } from '../../api/client';
import { ErrorState, PageLoader } from '../../components/ui';
import { invalidateWorkspace, useWsQuery } from '../../lib/hooks';
import { useWorkspaceId } from '../../stores/auth';
import { toast } from '../../stores/ui';
import { SGroup, SPaneHead, SPop, SRow, SSwitch, STile } from '../settings/Grouped';
import { attendanceApi, MODES, type AttendancePolicy } from './attendanceApi';
import './attendance.css';

const DAYS = [['1', 'M'], ['2', 'T'], ['3', 'W'], ['4', 'T'], ['5', 'F'], ['6', 'S'], ['7', 'S']] as const;
const MINUTES = [0, 15, 30, 45, 60, 90].map((n) => ({ id: String(n), label: n ? `${n} min` : 'At once' }));
const HOURS = [1, 2, 3, 4, 6, 8].map((n) => ({ id: String(n), label: `${n} h after the end` }));

/**
 * Settings › General › Attendance (owners and admins): whether people check in, the working hours it runs on (the workspace's or each
 * person's own), when Groot reminds them, which ways of working are allowed, whether a client office needs a name, and closing a
 * forgotten check-out. Every change saves at once.
 */
export function AttendanceSettings() {
  const wid = useWorkspaceId();
  const q = useWsQuery(['attendance', 'settings'], attendanceApi.settings, { staleTime: 60_000 });
  const [p, setP] = useState<AttendancePolicy | null>(null);
  useEffect(() => { if (q.data) setP(q.data); }, [q.data]);
  if (q.isLoading || (!p && !q.isError)) return <PageLoader />;
  if (q.isError || !p) return <ErrorState error={q.error} retry={() => void q.refetch()} />;

  const save = async (patch: Partial<AttendancePolicy>) => {
    const before = p;
    setP({ ...p, ...patch });
    try { setP(await attendanceApi.saveSettings(patch)); toast('Saved.'); void invalidateWorkspace(wid, 'attendance'); }
    catch (e) { setP(before); toast(e instanceof ApiError ? e.errors[0]?.message ?? e.message : 'Could not save.', 'error'); }
  };
  const days = p.workDays.split(',');
  const toggleDay = (d: string) => { const n = days.includes(d) ? days.filter((x) => x !== d) : [...days, d]; if (n.length) void save({ workDays: n.sort().join(',') }); };
  const toggleMode = (m: AttendancePolicy['allowedModes'][number]) => {
    const n = p.allowedModes.includes(m) ? p.allowedModes.filter((x) => x !== m) : [...p.allowedModes, m];
    if (n.length) void save({ allowedModes: n });
  };

  return (
    <div className="pv-pane" data-setting="workspace.attendance" data-testid="att-settings">
      <SPaneHead icon="✓" color="#34c759" title="Attendance" sub={`Check-in and check-out on the organization’s clock (${p.timeZone}). Groot asks at the first sign-in of the day and reminds people who forget.`} />
      <SGroup>
        <SRow icon={<STile color="#34c759">✓</STile>} title="Check-in and check-out" sub="People say where they work each day: office, home or a client’s office.">
          <SSwitch on={p.enabled} label="Check-in and check-out" onChange={(v) => void save({ enabled: v })} />
        </SRow>
        <SRow icon={<STile color="#5856d6">G</STile>} title="Ask at sign-in" sub="The first time someone opens the app on a working day.">
          <SSwitch on={p.promptAtSignIn} label="Ask at sign-in" disabled={!p.enabled} onChange={(v) => void save({ promptAtSignIn: v })} />
        </SRow>
      </SGroup>

      <SGroup label="Working hours">
        <SRow title="Hours from" sub={p.hoursSource === 'workspace' ? 'Everyone follows the workspace’s day.' : 'Each person’s own working hours (Notifications › Schedule).'}>
          <SPop label="Working hours source" value={p.hoursSource} onChange={(v) => void save({ hoursSource: v })}
            options={[{ id: 'workspace', label: 'Workspace hours' }, { id: 'personal', label: 'Each person’s hours' }]} />
        </SRow>
        <SRow title="Day starts and ends" sub="In the workspace’s time zone.">
          <span className="att-times">
            <input className="input" type="time" aria-label="Day starts" value={p.workStart} onChange={(e) => setP({ ...p, workStart: e.target.value })} onBlur={(e) => void save({ workStart: e.target.value })} />
            <span>–</span>
            <input className="input" type="time" aria-label="Day ends" value={p.workEnd} onChange={(e) => setP({ ...p, workEnd: e.target.value })} onBlur={(e) => void save({ workEnd: e.target.value })} />
          </span>
        </SRow>
        <SRow title="Working days" sub="No reminders on other days, holidays or planned leave.">
          <span className="att-days" role="group" aria-label="Working days">
            {DAYS.map(([id, l], i) => <button key={id} type="button" aria-pressed={days.includes(id)} aria-label={['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][i]} onClick={() => toggleDay(id)}>{l}</button>)}
          </span>
        </SRow>
      </SGroup>

      <SGroup label="Reminders">
        <SRow title="“Check in?”" sub={`After the day starts (${p.workStart}), to people who opened the app but did not check in.`}>
          <SPop label="Check-in reminder" value={String(p.checkInGraceMinutes)} options={MINUTES} onChange={(v) => void save({ checkInGraceMinutes: Number(v) })} />
        </SRow>
        <SRow title="“Still checked in?”" sub={`After the day ends (${p.workEnd}).`}>
          <SPop label="Check-out reminder" value={String(p.checkOutGraceMinutes)} options={MINUTES} onChange={(v) => void save({ checkOutGraceMinutes: Number(v) })} />
        </SRow>
        <SRow title="Close forgotten check-outs" sub={p.autoClose ? `At ${p.workEnd}, marked as closed automatically.` : 'Days stay open until the person checks out.'}>
          {p.autoClose && <SPop label="Auto-close after" value={String(p.autoCloseAfterHours)} options={HOURS} onChange={(v) => void save({ autoCloseAfterHours: Number(v) })} />}
          <SSwitch on={p.autoClose} label="Close forgotten check-outs" onChange={(v) => void save({ autoClose: v })} />
        </SRow>
      </SGroup>

      <SGroup label="Ways of working">
        {MODES.map((m) => (
          <SRow key={m.id} icon={<span className="att-set-emoji" aria-hidden="true">{m.emoji}</span>} title={m.label}>
            <SSwitch on={p.allowedModes.includes(m.id)} label={`Allow ${m.label}`} onChange={() => toggleMode(m.id)} />
          </SRow>
        ))}
        <SRow title="Client office needs a name" sub="Ask which client or place (recent ones are suggested).">
          <SSwitch on={p.requireClientPlace} label="Client office needs a name" disabled={!p.allowedModes.includes('ClientSite')} onChange={(v) => void save({ requireClientPlace: v })} />
        </SRow>
      </SGroup>
      <p className="pv-note">People correct their own day until it ends; managers see their team’s days in Calendar › Team.</p>
    </div>
  );
}
