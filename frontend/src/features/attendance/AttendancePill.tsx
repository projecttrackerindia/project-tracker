import { hm, modeOf } from './attendanceApi';
import { useAttendanceSheet, useAttendanceToday, useSince } from './AttendanceHost';

/**
 * The day's status in the top bar: "In · Office · 9:12 → 6h 40m" with Check out while checked in; "Check in" on a working day before one
 * has; the day's total once checked out. Compact (mode and hours) on a phone.
 */
export function AttendancePill({ compact = false }: { compact?: boolean }) {
  const q = useAttendanceToday();
  const show = useAttendanceSheet((s) => s.show);
  const d = q.data;
  const r = d?.record ?? null;
  const mins = useSince(r?.checkInAt, r?.checkOutAt);
  if (!d || !d.policy.enabled) return null;
  if (!r) {
    if (!d.workingDay) return null;
    return (
      <button type="button" className={`att-pill idle${compact ? ' compact' : ''}`} data-testid="att-pill" onClick={() => show('checkin')} title="Check in for today">
        <i className="att-dot" aria-hidden="true" />{compact ? 'In?' : 'Check in'}
      </button>
    );
  }
  const m = modeOf(r.mode);
  if (r.checkOutAt) {
    return (
      <span className={`att-pill out${compact ? ' compact' : ''}`} data-testid="att-pill" title={`${m.label} · ${r.checkInLocal}–${r.checkOutLocal}${r.autoClosed ? ' (closed automatically)' : ''}`}>
        <span aria-hidden="true">{m.emoji}</span>{compact ? hm(r.minutes) : `Out · ${r.checkInLocal}–${r.checkOutLocal} · ${hm(r.minutes)}`}
      </span>
    );
  }
  return (
    <span className={`att-pill in${compact ? ' compact' : ''}`} data-testid="att-pill">
      <button type="button" className="att-pill-main" onClick={() => show('checkout')} aria-label={`Checked in, ${m.label}, since ${r.checkInLocal}, ${hm(mins)}. Check out`}>
        <i className="att-dot on" aria-hidden="true" />
        {compact ? <><span aria-hidden="true">{m.emoji}</span>{hm(mins)}</> : <>In · {m.short} · {r.checkInLocal} → {hm(mins)}</>}
      </button>
      {!compact && <button type="button" className="att-pill-out" onClick={() => show('checkout')}>Check out</button>}
    </span>
  );
}
