import { Icon } from '../../components/Icon';
import { Field } from '../../components/ui';
import { formatDate } from '../../lib/format';

const dayNumber = (iso: string) => Math.round(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86_400_000);

/** How the due date moves, for the form: nothing to explain when it is not changing (or is being set for the first time). */
export function dueChange(previous: string | null | undefined, revised: string) {
  if (!previous || previous === revised) return null;
  const days = revised ? dayNumber(revised) - dayNumber(previous) : null;
  return { previous, revised, days, delay: !revised || (days ?? 0) > 0 };
}

/**
 * Shown under the due date when an existing due date is changed: what moves to what, and why. Pushing a date later (or clearing it) needs a reason,
 * so anyone looking at the project later can see why the delivery slipped and what it was waiting on.
 */
export function DueChangeFields({ previous, revised, reason, dependency, onReason, onDependency, error }: {
  previous: string | null | undefined; revised: string; reason: string; dependency: string; onReason: (v: string) => void; onDependency: (v: string) => void; error?: string;
}) {
  const c = dueChange(previous, revised);
  if (!c) return null;
  return (
    <div className="due-change">
      <div className="due-change-head">
        <Icon name="clock" size={15} />
        <span>Due date moves from <s>{formatDate(c.previous)}</s> to <b>{c.revised ? formatDate(c.revised) : 'no date'}</b></span>
        {c.days !== null && c.days !== 0 && <em className={c.days > 0 ? 'late' : 'early'}>{c.days > 0 ? `+${c.days}` : c.days} day{Math.abs(c.days) === 1 ? '' : 's'}</em>}
      </div>
      <div className="form-grid">
        <Field label="Reason for the change" required={c.delay} error={error} hint={c.delay ? 'Shown on the Portfolio page, so management can see why the delivery moved.' : 'Optional when a date is brought forward.'}>
          <textarea className="textarea" rows={2} maxLength={500} value={reason} onChange={(e) => onReason(e.target.value)} placeholder="e.g. Waiting for the client to sign off the design" />
        </Field>
        <Field label="Dependency causing it" hint="Optional: a task, a client answer, a vendor…">
          <input className="input" maxLength={300} value={dependency} onChange={(e) => onDependency(e.target.value)} placeholder="e.g. Payment provider API access" />
        </Field>
      </div>
    </div>
  );
}
